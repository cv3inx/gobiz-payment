# GoBiz Payment Gateway — API

QRIS payment gateway on top of GoPay Merchant (GoBiz). Creates dynamic QRIS,
watches incoming payments, resolves them to a transaction by amount, and fires a
signed webhook.

State lives in Postgres. One Nuxt app owns the deployment: Vue pages in `web/`,
this Express API in `src/`, wired together by `server/middleware/api.ts`.
`npm run dev` serves both on `PORT` (default `3000`).

## How payments get detected

There is no background process. Nothing holds a `setInterval`, because a
serverless instance is frozen between requests. Detection has three triggers:

There is no cron. Application traffic is the scheduler.

| Trigger | Fires when | Covers |
|---------|-----------|--------|
| **Status read** | `GET /payment/{trxId}` on a PENDING transaction | Everything: poll, reconcile, expiry sweep, webhook retries |
| **`POST /api/admin/poll`** | Dashboard button, or any caller with the API key | Forcing a cycle immediately, ignoring the throttle |

A status read may claim the slot and run a full cycle. The slot is throttled
**globally through the database** (`POLL_MIN_INTERVAL_MS`, default 7s) with one
atomic UPDATE, so a hundred payers polling across a hundred instances still produce
one GoBiz request per 7 seconds — and an idle gateway makes zero upstream calls.
That is gentler on the account than a fixed-interval poller running 24/7.

`GET /api/admin/stats` reports `poll.staleSeconds`, which the dashboard surfaces as
"Poll terakhir".

**Consequence, stated plainly:** with literally zero traffic nothing runs, so a
`payment.expired` webhook can sit until the next request. `payment.paid` is
unaffected — the cycle that finds the payment is the one that settles it and queues
the webhook. If you want a time guarantee, have any free external scheduler hit
`POST /api/admin/poll` with `X-API-Key`. Optional, not required.

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

The cursor is a Postgres **sequence**, so a cold start continues from the last
code instead of replaying from 1, and `nextval` is atomic without a transaction or
lock — two instances allocating at the same moment can never receive the same code.

Allocation is advisory. The real guarantee is the partial unique index
`("payAmount") WHERE status = 'PENDING'`: two open orders physically cannot share
a payable amount. If an insert loses that race, `create` draws another code and
retries (up to 3 times) before returning `503`.

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
| `callbackSecret` | string | no       | 8-256 chars. Signs **this** transaction's webhooks instead of `WEBHOOK_SECRET`. Never returned in any response |
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
    "qrImageUrl": "https://pay.violetics.id/payment/TRX-K3F9Q2A7X1/qr.png",
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
- `session` — GoBiz upstream session, probed on each full cycle.
  `reauths` counts how often the token was silently refreshed.

Returns **`503`** with `success: false` when `session.ok` is `false`. Payments cannot
be detected without a live GoBiz session, so the instance is genuinely degraded even
though HTTP still works — point your load balancer or uptime monitor at this.

## Session keepalive

The session is probed on each cycle, not per request — probing per request would
multiply upstream calls by traffic. Session health is stored in the `meta` table,
because the instance serving `/health` is almost never the one that ran the probe. On
top of that a cheap probe (a 1-record merchant lookup, not a history fetch) runs
on each full cycle to:

- detect an expired token **before** a payment poll trips over it,
- re-authenticate automatically when it has expired,
- expose the result on `/health` instead of burying it in logs.

A failed login puts GoBiz into a ~15 minute cooldown; during that window the probe
logs at `info` and keeps `/health` at `503` rather than hammering the endpoint.

> Do not lower `POLL_MIN_INTERVAL_MS` below its default — aggressive
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

Header `X-Signature` = `HMAC-SHA256(secret, rawBody)`, where `secret` is the
transaction's own `callbackSecret` if one was set at create time, else the global
`WEBHOOK_SECRET`. Each attempt is capped at `WEBHOOK_TIMEOUT_MS` (default 10s).

**Delivery is durable.** The owed webhook is written to Postgres before the first
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
settle through a `status = 'PENDING'` guard in Postgres, so a payment landing as the
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

## Manual reconciliation

`POST /api/admin/reconcile { gobizId, trxId }`

Automatic matching keys on the payable amount, so it cannot help when the amount is
wrong — a payer who typed the figure themselves, or who paid after the order expired.
The money is in `gobiz_history` with `matchedTrxId: null` (`GET /history?matched=false`)
and no order will ever claim it.

This endpoint claims the payment, marks the order **PAID even if it is EXPIRED**, sends
`payment.paid`, and logs `MANUAL RECONCILE <trxId> (EXPIRED → PAID) ... difference=-7`.

It is the only path allowed through the `status = 'PENDING'` guard. Everything else —
the automatic reconciler, the expiry sweep — goes through `settle()` and cannot revive a
settled order. Two safeguards keep it honest:

- the payment is linked with `WHERE "matchedTrxId" IS NULL`, so one incoming payment can
  never be pointed at two orders
- the order is settled with `WHERE status <> 'PAID'`, so reconciling twice is a `409` and
  sends no second webhook

**Consumers must tolerate `payment.expired` followed by `payment.paid` for the same
`trxId`.** That sequence is the normal shape of a recovered payment.

## Two-shape responses

`GET /payment/{trxId}` and `GET /health` must stay open — the payer polls one, an
uptime monitor polls the other — so what they *return* is what gets restricted:

| Endpoint | Anonymous | With `X-API-Key` |
|---|---|---|
| `GET /payment/{trxId}` | `trxId`, `status`, `amount`, `fee`, `uniqueCode`, `amountToPay`, `qrString`, `qrImageUrl`, `createdAt`, `expiresAt`, `paidAt` | adds `metadata`, `callbackUrl`, `webhook` |
| `GET /health` | `session` | adds `pending`, `total`, `webhooksOwed`, `uniqueCodeCursor` |

A caller-supplied `trxId` is often guessable (`ORDER-1042`), so the merchant's
`metadata` and webhook diagnostics cannot ride along on the public shape. And an open
`/health` publishing `total: 128` lets anyone measure the merchant's trade volume.

Merchant tooling that sends the key sees exactly what it always did.

## Caching

`GET /payment/{trxId}/qr.png` sets `Cache-Control: public, max-age=31536000,
immutable`. The QR encodes one fixed payable amount, so for a given `trxId` the bytes
can never change, and rendering a PNG is the most expensive thing this API does — the
CDN absorbing a payer's repeated page loads is the single biggest saving available.
A 404 is `no-store`, since the id may exist a moment later.

Everything else is uncached: a payment status that a CDN held for even a second would
be worse than useless.

## Storage growth

Nothing is ever deleted, deliberately — these are financial records. At roughly 1 KB
per transaction, Neon's free 0.5 GB holds on the order of 500k transactions, and the
`gobiz_history` archive grows at the rate money actually arrives. If you outgrow it,
archive out to cold storage rather than adding an automatic purge: a job that deletes
paid orders is one bug away from destroying the audit trail.

## Security notes

- Set `WEBHOOK_SECRET` and `API_KEY` to strong random values in production. With
  `NODE_ENV=production` the server **refuses to boot** while `WEBHOOK_SECRET` is
  still the default `change-me`; a missing `API_KEY` logs a warning (write
  endpoints are open).
- `trust proxy` trusts `TRUST_PROXY` hops of `X-Forwarded-For` (default `1`, which
  is correct for Vercel alone). Do not set it to `true` — that takes the client's own
  XFF at face value, letting anyone forge an IP and evade the per-IP rate limit.
  **Match it to the actual number of proxies:** a Cloudflare-proxied (orange cloud)
  record in front of Vercel is two hops, so it needs `TRUST_PROXY=2`. Leave the
  record on "DNS only" and `1` stays correct.
- Postgres holds transaction history, the GoBiz token, and merchant ID — back it up, restrict network access.
- `POST /api/admin/poll` is the only way to force a cycle and it sits behind
  `API_KEY`. Leaving `API_KEY` unset makes it open, which lets anyone drive the
  upstream polling loop until the GoBiz account is rate-limited.
- All state is in Postgres, so a cold start loses nothing. Expiry is settled on read
  and on each cycle rather than by timers.
- The `/admin` dashboard shell is served unauthenticated (it is an empty shell); every
  figure on it comes from `/admin/*` behind `API_KEY`.
- `callbackUrl` is SSRF-guarded: only http/https, no credentials, no internal/private
  hosts (loopback, `10/8`, `172.16/12`, `192.168/16`, link-local, cloud metadata). The
  check is literal-IP only — it does not resolve DNS, so a hostname resolving to a
  private IP still passes. Add DNS pinning if that's a concern in your network.
- Graceful shutdown on `SIGINT`/`SIGTERM` (local server): stops the cycle, drains
  connections, closes the pool; force-exits after 10s. On Vercel there is nothing to
  shut down — every unit of work is committed to Postgres before its response.
