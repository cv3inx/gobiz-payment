# GoBiz Payment Gateway — API

Self-hosted QRIS payment gateway on top of GoPay Merchant (GoBiz). Creates
dynamic QRIS, watches incoming payments, resolves them to a transaction by
amount, and fires a signed webhook.

Run: `npm start` → listens on `PORT` (default `3000`).

## Running in the background (PM2)

The GoPay watcher runs **inside** the server process — it polls every `POLL_MS`,
matches incoming payments, and fires webhooks automatically. Keeping the process
alive is all it takes; PM2 handles that + restart-on-crash + restart-on-boot.

```bash
npm i -g pm2
npm run pm2:start        # pm2 start ecosystem.config.cjs
pm2 save                 # persist the process list
pm2 startup              # print the command to run on system boot (run it once)

npm run pm2:logs         # tail logs
npm run pm2:restart      # after a code/.env change
npm run pm2:stop
```

Run a **single instance** (fork mode, already set in the config). Do not use PM2
cluster mode — duplicate pollers would double-fire webhooks.

## How matching works (read this)

Upstream GoPay history reports **only the amount** of an incoming payment — there
is no way to attach our own `trxId` to the payer's transfer. So the gateway adds a
random **unique code** (`1..UNIQUE_CODE_MAX`, default 999 rupiah) to every payment:
`amountToPay = amount + fee + uniqueCode`. That code is *always* present, so the
payer transfers a slightly-off figure the gateway can match back to exactly one
pending transaction. Example: `amount 100` → `uniqueCode 52` → payer pays `152`.

**Consequence:** `amountToPay` is up to `UNIQUE_CODE_MAX` rupiah higher than
`amount + fee`. Always render the QR for `amountToPay` and show that figure to the
payer. Up to `UNIQUE_CODE_MAX` transactions may share the same base amount while
pending before `POST /payment/create` returns `503`.

## Auth

If `API_KEY` is set in `.env`, all write endpoints, `/payments`, and `/history`
require the key in a header:

```
X-API-Key: <API_KEY>
```

`Authorization: Bearer <API_KEY>` is also accepted as a fallback. Read endpoints
(`GET /payment/:trxId`, the QR image, `/health`) are open.

## Endpoints

### `POST /payment/create`

Create a payment.

| Field            | Type   | Required | Notes                                              |
|------------------|--------|----------|----------------------------------------------------|
| `amount`         | int    | yes      | Base amount in rupiah, > 0                          |
| `fee`            | int    | no       | Added to amount (default 0), ≥ 0                    |
| `trxId`          | string | no       | Custom ID (1-64 chars `[A-Za-z0-9_.-]`); auto `TRX-xxxx` if omitted; `409` if it already exists |
| `callbackUrl`    | string | no       | Per-transaction webhook URL; overrides `WEBHOOK_URL`|
| `expireMinutes`  | int    | no       | Lifetime in minutes (default `EXPIRE_MINUTES`, 5)  |
| `metadata`       | any    | no       | Echoed back in status + webhook                    |
| `idempotencyKey` | string | no       | Also accepted via `Idempotency-Key` header         |

Idempotency: reusing a key returns the original transaction (`200`, `idempotent: true`)
instead of creating a duplicate.

```bash
curl -X POST http://localhost:3000/payment/create \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -H 'Idempotency-Key: order-1042' \
  -d '{"amount":50000,"fee":2500,"callbackUrl":"https://shop.example.com/hook","metadata":{"orderId":1042}}'
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "trxId": "TRX-K3F9Q2A7X1",
    "status": "PENDING",
    "amount": 50000,
    "fee": 2500,
    "uniqueCode": 137,
    "amountToPay": 52637,
    "qrString": "00020101021226...",
    "qrImageUrl": "https://pay.example.com/payment/TRX-K3F9Q2A7X1/qr.png",
    "callbackUrl": "https://shop.example.com/hook",
    "metadata": { "orderId": 1042 },
    "createdAt": "2026-07-10T12:24:56.000Z",
    "expiresAt": "2026-07-10T12:34:56.000Z",
    "paidAt": null
  }
}
```

`amountToPay` = `amount` + `fee` + `uniqueCode` (random 1..999). It is the **one
number the payer transfers** and the value the gateway matches on. `amount` and
`fee` are informational.

### `GET /payment/:trxId`

Check a payment. Returns the full transaction; `status` is `PENDING`, `PAID`, or `EXPIRED`.

### `GET /payment/:trxId/qr.png`

PNG image of the QRIS. Render this directly in an `<img>`.

### `POST /payment/:trxId/cancel`

Manually expire a `PENDING` transaction. `409` if not pending.

### `GET /payments?status=&limit=&offset=`

List transactions, newest first. `status` optional (`PENDING`/`PAID`/`EXPIRED`),
`limit` ≤ 200 (default 50).

### `GET /health`

`{ success, data: { pending, total } }`.

## Webhook

On `PAID` or `EXPIRED` the gateway POSTs to `callbackUrl` (or `WEBHOOK_URL`):

```json
{
  "event": "payment.paid",
  "trxId": "TRX-K3F9Q2A7X1",
  "status": "PAID",
  "amount": 50000,
  "fee": 2500,
  "uniqueCode": 137,
  "amountToPay": 52637,
  "paidAt": "2026-07-10T12:30:00.000Z",
  "metadata": { "orderId": 1042 }
}
```

Header `X-Signature` = `HMAC-SHA256(WEBHOOK_SECRET, rawBody)`. Retried up to 3×.

### Verifying (consumer side)

Reuse the gateway's own check:

```js
import { verifyWebhookSignature } from './src/security.js';

app.post('/hook', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifyWebhookSignature(raw, req.get('X-Signature'), process.env.WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const evt = JSON.parse(raw);
  // ... mark order paid
  res.status(200).end(); // non-2xx triggers a retry
});
```

Verify against the **raw** body, not a re-serialized object — key order must match.

## Errors

Envelope: `{ "success": false, "error": "message" }`.

| Code | Meaning                                      |
|------|----------------------------------------------|
| 400  | Bad input (`amount`/`fee`/`callbackUrl`)     |
| 401  | Missing/invalid API key                      |
| 404  | Unknown `trxId`                              |
| 409  | Cancel on non-pending transaction            |
| 429  | Rate limited (`RATE_MAX`/min per IP)         |
| 503  | No free amount slot / slot race — retry      |

## Security notes

- Set `WEBHOOK_SECRET` and `API_KEY` to strong random values in production.
- Put the gateway behind HTTPS (reverse proxy); `trust proxy` is on for real client IPs.
- SQLite file `transaction.db` holds transaction history — back it up, keep it off public paths.
- State survives restarts; pending expiry timers are rebuilt on boot.
- `callbackUrl` is SSRF-guarded: only http/https, no credentials, no internal/private
  hosts (loopback, `10/8`, `172.16/12`, `192.168/16`, link-local, cloud metadata). The
  check is literal-IP only — it does not resolve DNS, so a hostname resolving to a
  private IP still passes. Add DNS pinning if that's a concern in your network.
- Graceful shutdown on `SIGINT`/`SIGTERM`: stops the poller, cancels timers, drains
  connections, closes SQLite; force-exits after 10s. PM2 restarts are clean.
