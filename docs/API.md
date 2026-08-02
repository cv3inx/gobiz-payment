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
is no way to attach our own `trxId` to the payer's transfer. So every pending
transaction gets a unique payable figure: `amountToPay = amount + fee + uniqueCode`.
The payer transfers that slightly-off amount, which the gateway matches back to
exactly one pending transaction.

Codes are handed out **sequentially** — 1, 2, 3 … `UNIQUE_CODE_MAX` (default 99),
then wrapping back to 1:

| Transaction | amount | uniqueCode | amountToPay |
|-------------|--------|-----------|-------------|
| 1           | 10000  | 1         | 10001       |
| 2           | 10000  | 2         | 10002       |
| 3           | 25000  | 3         | 25003       |
| …           |        |           |             |
| 99          | 10000  | 99        | 10099       |
| 100         | 10000  | 1         | 10001 *(wrapped)* |

The cursor is persisted in SQLite, so a restart continues from the last code
instead of replaying from 1. A code still held by a `PENDING` transaction at the
same base amount is skipped, so two open orders never share a payable amount.
Legacy rows created before codes were recorded are still avoided — the allocator
also checks the payable amount itself, not just the code.

**Consequence:** `amountToPay` is up to `UNIQUE_CODE_MAX` rupiah higher than
`amount + fee`. Always render the QR for `amountToPay` and show that figure to the
payer. Up to `UNIQUE_CODE_MAX` transactions may share one base amount while pending;
beyond that `POST /payment/create` returns `503`.

`GET /health` exposes `uniqueCodeCursor` so you can see where the sequence is.

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

`amountToPay` = `amount` + `fee` + `uniqueCode` (sequential 1..99). It is the **one
number the payer transfers** and the value the gateway matches on. `amount` and
`fee` are informational.

### `GET /payment/:trxId`

Check a payment. Returns the full transaction; `status` is `PENDING`, `PAID`, or `EXPIRED`.

### `GET /payment/:trxId/qr.png`

PNG image of the QRIS. Render this directly in an `<img>`.

### `POST /payment/:trxId/cancel`

Manually expire a `PENDING` transaction. `409` if not pending.

### `GET /payments?status=&limit=&offset=`

List transactions, newest first. `status` optional (`PENDING`/`PAID`/`EXPIRED`,
anything else → `400`). `limit` clamped to 1..200 (default 50), `offset` ≥ 0.

### `GET /health`

```json
{
  "success": true,
  "data": {
    "pending": 3,
    "total": 128,
    "webhooksOwed": 0,
    "uniqueCodeCursor": 37,
    "session": {
      "ok": true,
      "lastCheckAt": "2026-07-10T12:30:00.000Z",
      "lastOkAt": "2026-07-10T12:30:00.000Z",
      "consecutiveFailures": 0,
      "reauths": 2,
      "lastError": null
    }
  }
}
```

- `webhooksOwed` > 0 — events queued for redelivery, usually a consumer that is down.
- `uniqueCodeCursor` — last unique code handed out.
- `session` — GoBiz upstream session, probed every `SESSION_CHECK_MS` (default 30s).
  `reauths` counts how often the token was silently refreshed.

Returns **`503`** with `success: false` when `session.ok` is `false`. Payments cannot
be detected without a live GoBiz session, so the instance is genuinely degraded even
though HTTP still works — point your load balancer or uptime monitor at this.

## Session keepalive

The payment watcher polls GoBiz every `POLL_MS`, so the session never goes idle. On
top of that a cheap probe (a 1-record merchant lookup, not a history fetch) runs
every `SESSION_CHECK_MS` to:

- detect an expired token **before** a payment poll trips over it,
- re-authenticate automatically when it has expired,
- expose the result on `/health` instead of burying it in logs.

A failed login puts GoBiz into a ~15 minute cooldown; during that window the probe
logs at `info` and keeps `/health` at `503` rather than hammering the endpoint.

> Do not lower `SESSION_CHECK_MS` or `POLL_MS` below their defaults — aggressive
> polling of GoBiz's internal API risks the merchant account being blocked. The
> server warns at boot if you do.

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

Header `X-Signature` = `HMAC-SHA256(WEBHOOK_SECRET, rawBody)`. Each attempt is
capped at `WEBHOOK_TIMEOUT_MS` (default 10s).

**Delivery is durable.** The owed webhook is written to SQLite before the first
send, so it survives both a consumer outage and a gateway restart. Failures retry
with exponential backoff (30s, 1m, 2m … capped at `WEBHOOK_MAX_BACKOFF_MS`) up to
`WEBHOOK_MAX_ATTEMPTS` (default 12 ≈ 2 hours of downtime). A consumer returning
after an `ECONNREFUSED` window still receives its event.

Delivery state is visible on every transaction response and in `/health`
(`webhooksOwed`):

```json
"webhook": { "state": "PENDING", "attempts": 3, "nextAttemptAt": "...", "lastError": "ECONNREFUSED" }
```

### `POST /payment/:trxId/replay-webhook`

Re-queue a webhook that exhausted its attempts (consumer was down longer than the
retry window). Resets the counter; the sweeper delivers on its next pass. `409` if
the transaction is still `PENDING`.

Exactly one webhook fires per transaction: the `PAID` and `EXPIRED` paths both
settle through a `status = 'PENDING'` guard in SQLite, so a payment landing as the
expiry timer fires produces one event, not two.

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
| 400  | Bad input (`amount`/`fee`/`callbackUrl`/`status`), malformed or oversized JSON |
| 401  | Missing/invalid API key                      |
| 404  | Unknown `trxId` or unknown route             |
| 409  | Cancel on non-pending transaction            |
| 429  | Rate limited (`RATE_MAX`/min per IP)         |
| 500  | Unexpected internal error (details in logs, never in the response) |
| 503  | No free amount slot / slot race — retry      |

`amount` and `fee` must each be ≤ `MAX_AMOUNT` (default Rp 1,000,000,000).

## Security notes

- Set `WEBHOOK_SECRET` and `API_KEY` to strong random values in production. With
  `NODE_ENV=production` the server **refuses to boot** while `WEBHOOK_SECRET` is
  still the default `change-me`; a missing `API_KEY` logs a warning (write
  endpoints are open).
- Put the gateway behind HTTPS (reverse proxy). `trust proxy` trusts `TRUST_PROXY`
  hops of `X-Forwarded-For` (default `1`). Do not set it to `true` — that takes
  the client's own XFF at face value, letting anyone forge an IP and evade the
  per-IP rate limit. Match it to your actual number of proxies.
- SQLite file `transaction.db` holds transaction history — back it up, keep it off public paths.
- State survives restarts; pending expiry timers are rebuilt on boot.
- `callbackUrl` is SSRF-guarded: only http/https, no credentials, no internal/private
  hosts (loopback, `10/8`, `172.16/12`, `192.168/16`, link-local, cloud metadata). The
  check is literal-IP only — it does not resolve DNS, so a hostname resolving to a
  private IP still passes. Add DNS pinning if that's a concern in your network.
- Graceful shutdown on `SIGINT`/`SIGTERM`: stops the poller, cancels timers, drains
  connections, closes SQLite; force-exits after 10s. PM2 restarts are clean.
