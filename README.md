# GoBiz Payment Gateway

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/API-GoBiz%20Merchant-00AED9?logoColor=white" alt="GoBiz API" />
  <img src="https://img.shields.io/badge/docs-Swagger-85EA2D?logo=swagger&logoColor=black" alt="Swagger" />
  <a href="https://pay.violetics.pw/docs"><img src="https://img.shields.io/badge/demo-pay.violetics.pw-6f42c1" alt="Demo" /></a>
</p>

Payment gateway **self-hosted** di atas GoPay Merchant (GoBiz) — rasa payment
gateway beneran, tapi jalan di server sendiri. Bikin QRIS dinamis, pantau
pembayaran masuk otomatis, dan tembak **webhook** bertanda tangan saat lunas.

🔗 **Demo:** [pay.violetics.pw/docs](https://pay.violetics.pw/docs) (Swagger UI)

Dibangun di atas library GoBiz dari [**kavionn/gobiz-payment**](https://github.com/kavionn/gobiz-payment) (lihat [Credit](#-credit)).

> [!WARNING]
> **Risiko banned:** otomatisasi login & polling API GoBiz yang terlalu agresif
> berisiko membuat akun kamu **terblokir**. Pakai dengan risiko sendiri. Ini
> **bukan** library resmi Gojek/GoPay — mengakses API internal GoBiz.

---

## ✨ Fitur

- 🧾 **Create payment** — 1 endpoint, QRIS dinamis + gambar PNG langsung (tanpa upload eksternal)
- 🔎 **Check by trxId** — cek status pakai ID transaksi kamu sendiri (atau auto `TRX-xxxx`)
- 🪝 **Webhook durable** — callback ditembak saat lunas (HMAC-SHA256), di-persist di
  SQLite + retry backoff, jadi consumer yang mati tetap kebagian event pas hidup lagi
- 🔗 **Custom webhook per-trx** — `callbackUrl` di body meng-override `WEBHOOK_URL` global
- 💰 **Fee manual** — `fee` ditambah ke `amount`; pembeli bayar `amountToPay`
- 🆔 **Idempotency** — `Idempotency-Key` cegah double-charge saat retry
- 🗄️ **SQLite (WAL)** — transaksi persist di `data/transaction.db`, tahan restart
- 🛡️ **Security** — API key (timing-safe), rate limit per-IP, security headers
- 📚 **Swagger UI** — dokumentasi interaktif di `/docs`
- 📈 **Morgan** — log tiap request, satu baris berwarna
- ♻️ **Watcher in-process** — polling jalan otomatis di dalam server, PM2 jaga tetap hidup
- 💓 **Session keepalive** — sesi GoBiz dicek tiap 30s, token expired di-refresh
  otomatis, status kelihatan di `/health` (503 kalau sesi mati)

---

## 📦 Instalasi

Butuh **Node.js ≥ 20**. SQLite lewat `better-sqlite3` (native binding, di-build
saat `npm install` — butuh build tools di beberapa OS).

```bash
git clone https://github.com/cv3inx/gobiz-payment.git
cd gobiz-payment
npm install
cp .env.example .env   # lalu isi kredensial + QRIS_STRING
```

---

## 🔑 Autentikasi (2 opsi)

Pilih salah satu:

### Opsi A — Email & Password (auto-login)

Kalau belum punya password:

1. Buka [portal.gofoodmerchant.co.id](https://portal.gofoodmerchant.co.id)
2. Login pakai OTP (nomor HP terdaftar)
3. Ke [halaman Profile](https://portal.gofoodmerchant.co.id/account/profile)
4. Atur / ubah **password login**, simpan
5. Isi `GOPAY_EMAIL` + `GOPAY_PASSWORD` di `.env`

### Opsi B — Access Token langsung (tanpa login)

Kalau ga mau taruh password, ambil token dari browser:

1. Login ke portal GoBiz di browser
2. **F12 → Application → Cookies** → cari `access_token`, copy value-nya
3. Isi `GOPAY_ACCESS_TOKEN` di `.env`
4. (Opsional) isi `GOPAY_MERCHANT_ID` manual — kalau kosong, dideteksi otomatis dari token

> Token menang kalau diisi. Token bisa expired — refresh manual (ambil ulang dari
> cookies) saat gateway error 401. Untuk jalan jangka panjang tanpa perawatan,
> Opsi A lebih enak (token di-refresh otomatis).

Ambil `QRIS_STRING` dengan men-scan gambar QRIS statis dari portal GoBiz Merchant,
paste hasilnya ke `.env`.

---

## ⚙️ Konfigurasi (`.env`)

Cuma **4 baris wajib** — sisanya ada default:

```env
GOPAY_EMAIL="email@merchant.com"
GOPAY_PASSWORD="password-kamu"
QRIS_STRING="00020101021226..."
WEBHOOK_URL="https://app-kamu.com/webhook"
WEBHOOK_SECRET="ganti-ini-random-panjang"
```

Yang sering dipakai (opsional):

| Var | Default | Fungsi |
|-----|---------|--------|
| `API_KEY` | *(kosong)* | Proteksi endpoint tulis. **Kosong = siapa aja bisa bikin transaksi** |
| `PUBLIC_URL` | dari request | Domain publik buat `qrImageUrl` absolut |
| `PORT` | `3000` | Port server |
| `EXPIRE_MINUTES` | `5` | Umur transaksi (menit) |
| `TRUST_PROXY` | `1` | Hop reverse proxy yg dipercaya. Jangan `true` |
| `GOPAY_ACCESS_TOKEN` | *(kosong)* | Pakai token browser, ganti email/password |

Sisanya (`POLL_MS`, `SESSION_CHECK_MS`, `UNIQUE_CODE_MAX`, `RATE_MAX`, `MAX_AMOUNT`,
`WEBHOOK_*`, `DB_FILE`) sudah aman defaultnya — lihat [.env.example](.env.example)
kalau mau tuning. **Jangan turunin `POLL_MS`/`SESSION_CHECK_MS`**, risiko akun diblokir.

Server ngasih warning saat boot kalau `API_KEY` kosong, `TRUST_PROXY=true`, atau
polling terlalu agresif. Kalau `NODE_ENV=production` dan `WEBHOOK_SECRET` masih
`change-me`, server **nolak jalan**.

`data/gopay_cache.json` dibuat otomatis (nyimpen token + merchant ID), token
di-refresh otomatis. Jangan commit `.env`, `data/`, `*.db`.

---

## 🚀 Menjalankan

```bash
npm start          # jalan biasa
npm test           # semua suite (qris, uniqueCode, db, security, api)
```

Buka **`http://localhost:3000/docs`** untuk Swagger UI interaktif.

Watcher pemantau pembayaran jalan **di dalam** proses server — begitu server
hidup, cek pembayaran + webhook jalan otomatis di background. Tanpa cron, tanpa
panggil check manual.

### Background (PM2)

```bash
npm i -g pm2
npm run pm2:start   # pm2 start ecosystem.config.cjs
pm2 save
pm2 startup         # jalankan command yang dicetak → auto-nyala saat reboot

npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

> [!IMPORTANT]
> Jalankan **1 instance** (fork mode — sudah diset). Jangan cluster mode:
> poller dobel = webhook ketembak 2×.

---

## 📡 API Singkat

Detail lengkap: [docs/API.md](docs/API.md) atau Swagger di `/docs`.

| Method | Path | Auth | Fungsi |
|--------|------|:----:|--------|
| POST | `/payment/create` | 🔑 | Buat pembayaran |
| GET | `/payment/:trxId` | — | Cek status by trxId |
| GET | `/payment/:trxId/qr.png` | — | Gambar QRIS (PNG) |
| POST | `/payment/:trxId/cancel` | 🔑 | Batalkan (expire manual) |
| POST | `/payment/:trxId/replay-webhook` | 🔑 | Kirim ulang webhook yg gagal total |
| GET | `/payments` | 🔑 | List transaksi (paginated) |
| GET | `/history` | 🔑 | History transaksi GoBiz (arsip + `?matched=`) |
| GET | `/health` | — | Counts + status sesi GoBiz (`503` kalau sesi mati) |

🔑 = butuh `X-API-Key: <API_KEY>` kalau `API_KEY` diset.

### Contoh: create payment

```bash
curl -X POST http://localhost:3000/payment/create \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: API_KEY_KAMU' \
  -d '{
    "amount": 50000,
    "fee": 2500,
    "trxId": "ORDER-1042",
    "callbackUrl": "https://tokoku.com/webhook"
  }'
```

Body — cuma `amount` yang wajib:

| Field | Wajib | Isi |
|-------|:-----:|-----|
| `amount` | ✅ | Harga barang (rupiah) |
| `fee` | ❌ | Biaya admin, ditambah ke amount. Default 0 |
| `trxId` | ❌ | ID order kamu. Kosong = auto `TRX-xxxx` |
| `callbackUrl` | ❌ | Webhook khusus trx ini, override `.env` |
| `callbackSecret` | ❌ | Secret khusus trx ini (8-256 char) buat tanda tangan webhook. Ga pernah dikembalikan di response |
| `expireMinutes` | ❌ | Kadaluarsa (menit). Default 5 |
| `metadata` | ❌ | Data bebas, dikembalikan di webhook |

Respons berisi **`amountToPay`** = `amount + fee + uniqueCode`, dengan `uniqueCode`
berurutan 1..99 (lihat [Cara matching](#-cara-matching-penting)). **Itu satu-satunya
angka yang dibayar pembeli** dan yang dicocokkan gateway. Tampilkan `amountToPay`,
bukan `amount`. Contoh: `amount 100` + `uniqueCode 52` → pembeli bayar `152`.

### Webhook

Saat `PAID` / `EXPIRED`, gateway POST ke `callbackUrl` (atau `WEBHOOK_URL`):

```json
{
  "event": "payment.paid",
  "trxId": "ORDER-1042",
  "status": "PAID",
  "amount": 50000,
  "fee": 2500,
  "uniqueCode": 137,
  "amountToPay": 52637,
  "paidAt": "2026-07-10T12:30:00.000Z",
  "metadata": { "orderId": 1042 }
}
```

Header `X-Signature` = `HMAC-SHA256(WEBHOOK_SECRET, rawBody)`. Verifikasi pakai
`verifyWebhookSignature` dari [src/security.js](src/security.js) — lihat [docs/API.md](docs/API.md).

---

## 🧠 Cara matching (penting)

API GoBiz cuma melaporkan **nominal** pembayaran masuk — tidak ada cara menautkan
`trxId` kita ke transfer pembeli. Jadi gateway kasih tiap transaksi pending nominal
bayar yang **unik**: `amountToPay = amount + fee + uniqueCode`.

`uniqueCode` dibagikan **berurutan**: 1, 2, 3 … sampai `UNIQUE_CODE_MAX` (default
**99**), lalu balik lagi ke 1. Cursor-nya disimpan di SQLite, jadi restart lanjut
dari kode terakhir — bukan mulai dari 1 lagi. Kode yang masih dipakai transaksi
`PENDING` di nominal dasar yang sama otomatis dilewati.

```
trx 1 (amount 10000) → code 1  → bayar 10001
trx 2 (amount 10000) → code 2  → bayar 10002
trx 3 (amount 25000) → code 3  → bayar 25003   ← cursor lanjut, beda amount
...
trx 99               → code 99 → bayar  ...99
trx 100              → code 1  → wrap balik ke 1
```

**Konsekuensi:** `amountToPay` bisa lebih tinggi sampai `UNIQUE_CODE_MAX` rupiah
dari `amount + fee`. Selalu render QR + tampilkan `amountToPay`, jangan `amount`.
Maksimal `UNIQUE_CODE_MAX` transaksi pending boleh berbagi nominal dasar yang sama;
lewat itu `/payment/create` balas `503`.

---

## 🧩 Struktur

```
server.js                  entry point: boot, watcher wiring, graceful shutdown
lib/gobiz.js               library GoBiz (auth, history, watcher) — dari kavionn

src/
  config.js                parsing env + validasi startup
  app.js                   wiring Express (middleware + routes)
  qris.js                  CRC16 + QRIS dinamis
  uniqueCode.js            allocator kode berurutan (1..max, wrap)
  logger.js                leveled logger (badge + warna, auto-plain di PM2)
  security.js              API key, rate limit, headers, HMAC, SSRF guard
  openapi.js               spec OpenAPI untuk Swagger UI
  db/
    index.js               koneksi SQLite + schema + migrasi
    transactions.js        query transaksi
    history.js             arsip transaksi GoBiz
    webhooks.js            state pengiriman webhook
    meta.js                key-value (cursor uniqueCode)
  services/
    payments.js            create, expire, markPaid, reconcile
    webhooks.js            pengiriman + retry sweeper
    session.js             keepalive + health check sesi GoBiz
  routes/
    payments.js            /payment/*, /payments
    history.js             /history
    system.js              /docs, /openapi.json, /health

tests/                     suite per modul (node tests/run.js)
data/transaction.db        database SQLite (dibuat otomatis)
docs/API.md                dokumentasi API lengkap
ecosystem.config.cjs       konfigurasi PM2
demo.js                    demo QRIS end-to-end (CLI, tanpa server)
```

Alur satu pembayaran:

```
POST /payment/create
  → routes/payments.js    validasi input
  → services/payments.js  allocate code → build QRIS → simpan
  → db/transactions.js

pembeli bayar
  → lib/gobiz.js          watcher polling history GoBiz
  → services/payments.js  reconcile: cocokin nominal → markPaid
  → services/webhooks.js  queue + kirim webhook (retry kalau gagal)
```

---

## 📚 Library GoBiz (dipakai internal)

Gateway pakai `lib/gobiz.js`. Kalau mau pakai library-nya langsung:

```js
import GoPayMerchant, { getGoPayWatcher } from './lib/gobiz.js';

const watcher = getGoPayWatcher(7_000);
watcher.on('payment', ({ amount, txId }) => {
  console.log('💸 masuk:', amount, txId);
});
```

| Export | Fungsi |
|--------|--------|
| `GoPayMerchant` *(default)* | `init()`, `getHistory({ days, size })`, dst |
| `GoPayWatcher` | EventEmitter, `waitForPayment(amount, opts)`, event `'payment'` |
| `getGoPayWatcher(intervalMs?)` | Singleton watcher (1 poller per proses) |

Event `'payment'` memancarkan `{ amount, txId, entry }`. Detail method ada di
komentar `lib/gobiz.js`.

---

## 🙏 Credit

- Library GoBiz inti (`lib/gobiz.js`, `demo.js`) berasal dari repo original
  **[kavionn/gobiz-payment](https://github.com/kavionn/gobiz-payment)** oleh
  [@kavionn](https://github.com/kavionn). Terima kasih 🙌
- Lapisan payment gateway (Express, SQLite, webhook, security, Swagger, PM2)
  ditambahkan di fork ini.

---

## 📄 Lisensi

MIT — lihat [LICENSE](LICENSE).

---

## Star History

<a href="https://www.star-history.com/?repos=kavionn%2Fgobiz-payment&type=date&logscale=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kavionn/gobiz-payment&type=date&theme=dark&logscale&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kavionn/gobiz-payment&type=date&logscale&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kavionn/gobiz-payment&type=date&logscale&legend=bottom-right" />
 </picture>
</a>
