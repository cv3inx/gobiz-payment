# GoBiz Payment Gateway

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxtdotjs&logoColor=white" alt="Nuxt 4" />
  <img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Postgres-any-4169E1?logo=postgresql&logoColor=white" alt="Postgres" />
  <img src="https://img.shields.io/badge/deploy-Vercel-000000?logo=vercel&logoColor=white" alt="Vercel" />
  <img src="https://img.shields.io/badge/admin-Vue%203-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/docs-Swagger-85EA2D?logo=swagger&logoColor=black" alt="Swagger" />
</p>

Payment gateway QRIS di atas GoPay Merchant (GoBiz) — rasa payment gateway
beneran. Bikin QRIS dinamis, pantau pembayaran masuk otomatis, tembak **webhook**
bertanda tangan saat lunas, dan kelola semuanya dari **admin dashboard**.

Satu app **Nuxt 4**: dashboard Vue di `web/`, API Express di `src/`. Jalan di
**Vercel free tier** — tanpa cron, tanpa plan Pro.

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
  Postgres + retry backoff, jadi consumer yang mati tetap kebagian event pas hidup lagi
- 🔗 **Custom webhook per-trx** — `callbackUrl` di body meng-override `WEBHOOK_URL` global
- 💰 **Fee manual** — `fee` ditambah ke `amount`; pembeli bayar `amountToPay`
- 🆔 **Idempotency** — `Idempotency-Key` cegah double-charge saat retry
- 🗄️ **Postgres** — semua state di DB: transaksi, arsip pembayaran, token GoBiz,
  cursor kode unik, health sesi. Ga ada file lokal, ga ada state di memori
- 🖥️ **Admin dashboard** — Nuxt 4 + Vue 3 di `/admin`: stats, grafik harian, tabel
  transaksi, batalkan / kirim ulang webhook, tombol "cek pembayaran" manual
- 🛡️ **Security** — API key (timing-safe), rate limit, SSRF guard, security headers,
  dan endpoint publik yang menahan field milik merchant
- 📚 **Swagger UI** — dokumentasi interaktif di `/docs`
- ⚡ **Tanpa cron sama sekali** — buka status transaksi PENDING = memicu satu cycle
  (poll GoBiz + expire + kirim webhook), di-throttle global lewat DB. Real-time pas
  ada yang nunggu, nol request upstream pas ga ada
- 💓 **Session keepalive** — token expired di-refresh otomatis, status di `/health`
  (503 kalau sesi mati)

---

## 📦 Instalasi

Butuh **Node.js ≥ 22** dan sebuah **Postgres**.

```bash
git clone https://github.com/cv3inx/gobiz-payment.git
cd gobiz-payment
npm install
cp .env.example .env   # isi DATABASE_URL, kredensial GoBiz, QRIS_STRING
npm run migrate        # bikin tabel (idempotent, aman diulang)
npm run dev            # Nuxt dev: dashboard + API sekaligus
```

Buat development cepat, `DATABASE_URL` boleh dikosongkan — kodenya jatuh ke
**PGlite** (Postgres asli, dikompilasi ke WASM, jalan in-process). SQL-nya sama
persis dengan production, tapi datanya cuma di memori. Jangan dipakai produksi.

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

Wajib:

```env
DATABASE_URL="postgres://user:pass@host:6543/db?sslmode=require"
GOPAY_EMAIL="email@merchant.com"
GOPAY_PASSWORD="password-kamu"
QRIS_STRING="00020101021226..."
WEBHOOK_URL="https://app-kamu.com/webhook"
WEBHOOK_SECRET="ganti-ini-random-panjang"
API_KEY="ganti-ini-random-panjang"
```

> [!IMPORTANT]
> `DATABASE_URL` harus connection string **pooler / transaction mode** (Supabase
> port `6543`, Neon host `...-pooler...`). Serverless bikin banyak instance;
> koneksi direct akan kehabisan slot.

Yang sering dipakai (opsional):

| Var | Default | Fungsi |
|-----|---------|--------|
| `PUBLIC_URL` | auto dari Vercel | Domain publik buat `qrImageUrl` absolut |
| `PORT` | `3000` | Port server lokal |
| `EXPIRE_MINUTES` | `5` | Umur transaksi (menit), maks `10080` |
| `POLL_MIN_INTERVAL_MS` | `7000` | Jeda minimum antar poll GoBiz, **global lintas instance** |
| `TRUST_PROXY` | `1` | Hop proxy yg dipercaya. Jangan `true` |
| `GOPAY_ACCESS_TOKEN` | *(kosong)* | Pakai token browser, ganti email/password |

Sisanya (`UNIQUE_CODE_MAX`, `RATE_MAX`, `MAX_AMOUNT`,
`WEBHOOK_*`) aman defaultnya — lihat [.env.example](.env.example).
**Jangan turunin `POLL_MIN_INTERVAL_MS` di bawah 7000**, risiko akun diblokir.

Saat boot ada warning kalau `API_KEY` kosong atau `TRUST_PROXY=true`. Kalau
`NODE_ENV=production` dan `WEBHOOK_SECRET` masih `change-me`, server **nolak jalan**.

> [!WARNING]
> `API_KEY` kosong bukan cuma bikin endpoint tulis terbuka — `POST /api/admin/poll`
> juga terbuka, dan itu bisa dipakai siapa pun buat memicu polling ke GoBiz sampai
> akunmu kena rate-limit. Isi `API_KEY`.

Token GoBiz + merchant ID disimpan di tabel `meta` (bukan file), di-refresh
otomatis. Jangan commit `.env`.

---

## 🚀 Menjalankan lokal

```bash
npm run migrate    # sekali per database
npm run dev        # Nuxt dev server (dashboard + API)
npm run build      # build produksi
npm run preview    # jalanin hasil build
npm test           # 7 suite, offline pakai PGlite
```

- Admin dashboard → **`http://localhost:3000/admin`**
- Swagger UI → **`http://localhost:3000/docs`**

CI di GitHub Actions menjalankan `npm test` + `nuxt build` tiap push — suite-nya
offline (PGlite), jadi ga butuh service container atau secret apa pun.

Satu server buat dua-duanya. Nuxt melayani halaman Vue; `server/middleware/api.ts`
melempar path API ke app Express di `src/` — API-nya ga ditulis ulang jadi Nitro
handler, jadi 78 assertion di test suite tetap menguji kode yang sama.

---

## ▲ Deploy ke Vercel

Vercel mendeteksi Nuxt dan build otomatis (`nuxt build`) — ga ada konfigurasi
build manual. `vercel.json` cuma memaksa preset framework-nya.

```bash
vercel link                            # pilih / bikin project
vercel integration add neon            # provision Postgres, DATABASE_URL auto-inject
vercel env add QRIS_STRING production
vercel env add GOPAY_EMAIL production
vercel env add GOPAY_PASSWORD production
vercel env add WEBHOOK_SECRET production
vercel env add API_KEY production
vercel deploy --prod

vercel env pull .env.local             # tarik DATABASE_URL ke lokal
npm run migrate                        # sekali, buat bikin tabel
```

### 🌐 Custom domain

```bash
vercel domains add pay.violetics.id gobiz-payment
vercel env add PUBLIC_URL production --no-sensitive   # https://pay.violetics.id
```

DNS-nya di Cloudflare, jadi tambahkan record ini di sana:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| `A` | `pay` | `76.76.21.21` | **DNS only** (abu-abu) |

> [!IMPORTANT]
> **Matikan proxy Cloudflare (awan abu-abu, bukan oranye)** untuk record ini.
> Dua alasan:
> 1. Vercel harus bisa menjangkau domainnya buat menerbitkan sertifikat TLS. Kalau
>    diproxy, penerbitan cert bisa nyangkut di "Invalid Configuration".
> 2. Proxy Cloudflare menambah satu hop. `TRUST_PROXY=1` cuma benar untuk 1 hop
>    (Vercel). Kalau tetap mau diproxy, ganti ke **`TRUST_PROXY=2`** — kalau tidak,
>    rate limiter membaca IP Cloudflare, bukan IP pengunjung, jadi satu pengunjung
>    nakal bisa menghabiskan kuota semua orang.

Cek status: `vercel domains inspect pay.violetics.id`. `PUBLIC_URL` dipakai buat
`qrImageUrl` absolut — kalau kosong, ditebak dari `VERCEL_PROJECT_PRODUCTION_URL`.

### ⚡ Kenapa ga butuh cron (dan ga butuh plan Pro)

Vercel Hobby cuma menjalankan cron **1× sehari**, jadi cron memang ga dipakai —
sudah dihapus. Penggeraknya **traffic aplikasi itu sendiri**.

Tiap `GET /payment/:trxId` untuk transaksi yang masih `PENDING` boleh mengklaim
slot dan menjalankan satu **cycle penuh**:

1. poll history GoBiz → cocokkan pembayaran → tandai `PAID` → kirim webhook
2. expire transaksi yang sudah lewat waktu
3. kirim ulang webhook yang nunggak

Slotnya di-throttle **global lewat DB** (`POLL_MIN_INTERVAL_MS`, default 7s) pakai
satu UPDATE atomik, jadi 100 pembeli polling bareng di 100 instance tetap cuma jadi
**1 request ke GoBiz per 7 detik**. Pas ga ada yang nunggu: nol request upstream.

Halaman bayar pembeli yang polling status = scheduler-nya. Itu justru lebih aman
dari akun diblokir dibanding poller interval tetap yang jalan 24/7.

> [!NOTE]
> **Konsekuensinya, jujur:** kalau benar-benar nol traffic, ga ada yang jalan.
> Webhook `payment.expired` bisa nunggu sampai ada request berikutnya. `payment.paid`
> **tidak** kena — cycle yang menemukan pembayaran itu juga yang menandai lunas dan
> mengantre webhook-nya.
>
> Butuh jaminan waktu? Tembak `POST /api/admin/poll` (pakai `X-API-Key`) dari
> scheduler eksternal gratis (cron-job.org, UptimeRobot). Opsional, bukan syarat.

Dashboard `/admin` nampilin **"Poll terakhir"** biar kelihatan kapan deteksi
terakhir jalan.

---

## 🖥️ Admin dashboard

Buka **`/admin`**, masukkan `API_KEY`. Nuxt 4 + Vue 3, di-build otomatis di Vercel.

- Kartu stats: pending, lunas, uang masuk hari ini / 7 hari / 30 hari, webhook
  nunggak, pembayaran belum kecocokan
- Grafik harian lunas vs kadaluarsa (7 / 14 / 30 hari)
- **Cari `trxId`** (lookup persis) + **filter status** + paginasi
- Tabel transaksi — klik baris buka **panel detail**: metadata, timeline, dan
  `webhookLastError` beserta diagnosanya (`ECONNREFUSED` = consumer mati vs
  `HTTP 500` = consumer hidup tapi handler-nya error)
- **Rekonsiliasi manual** — tautkan pembayaran nyasar ke order, lihat di bawah
- Tombol **Cek pembayaran** (paksa cycle) dan **Kirim ulang webhook nunggak**
- Panel sistem: poll terakhir, cursor kode unik, sesi GoBiz, **cooldown login**,
  jumlah re-auth

### 🔗 Rekonsiliasi manual

Kalau pembeli mengirim nominal yang tidak sama dengan `amountToPay` (salah ketik,
atau bayar setelah order kadaluarsa), duitnya masuk tapi tidak ada order yang cocok.
Dashboard menampilkannya di tabel **"belum kecocokan"** dengan tombol **Tautkan…**.

Isi `trxId` order tujuan, lalu gateway akan:

1. mengklaim pembayaran itu (satu pembayaran tidak bisa dipakai untuk dua order)
2. menandai order **PAID** — **termasuk kalau statusnya sudah `EXPIRED`**
3. mengirim webhook `payment.paid`
4. mencatat baris log `MANUAL RECONCILE ... received=X expected=Y difference=Z`

> [!WARNING]
> Ini satu-satunya jalan yang boleh menembus penjaga `status = 'PENDING'`. Kalau
> consumer-mu sudah menerima `payment.expired` untuk order itu, dia akan menerima
> `payment.paid` sesudahnya — **handler webhook-mu harus tahan urutan itu.**
> Mengulang rekonsiliasi yang sama dijawab `409` dan tidak mengirim webhook kedua.

### 💤 Cooldown login GoBiz

Login GoBiz yang gagal memasang cooldown 15 menit **di database**, jadi instance
berikutnya tidak langsung mencoba lagi dan memperdalam rate-limit. Dashboard
menampilkan hitungan mundurnya dan **mematikan tombol "Cek pembayaran"** selama
cooldown — satu-satunya keadaan di mana tindakan yang benar adalah menunggu.

Auto-refresh 20 detik dan berhenti kalau tab-nya ga aktif — tiap refresh juga ikut
menggerakkan satu cycle, jadi membiarkan dashboard terbuka = deteksi tetap jalan.
Key disimpan di `sessionStorage` tab itu saja.

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
| GET | `/` | — | Halaman Nuxt: link ke dashboard / docs / health |
| GET | `/admin` | — | Dashboard Nuxt (halamannya publik, datanya 🔑) |
| GET | `/api/admin/stats` | 🔑 | Semua angka dashboard dalam 1 request |
| POST | `/api/admin/poll` | 🔑 | Paksa 1 cycle sekarang (abaikan throttle) |
| POST | `/api/admin/reconcile` | 🔑 | Tautkan pembayaran nyasar ke order (bisa hidupkan EXPIRED) |
| POST | `/api/admin/webhooks/drain` | 🔑 | Kirim ulang semua webhook nunggak |

🔑 = butuh `X-API-Key: <API_KEY>` kalau `API_KEY` diset.

> [!NOTE]
> **Dua endpoint mengembalikan bentuk berbeda tergantung ada API key atau tidak** —
> keduanya harus tetap terbuka, jadi yang dibatasi adalah isinya:
>
> | Endpoint | Tanpa key | Dengan key |
> |---|---|---|
> | `GET /payment/:trxId` | `status`, `amountToPay`, `qrString`, `expiresAt`, `paidAt` | + `metadata`, `callbackUrl`, `webhook` |
> | `GET /health` | status sesi GoBiz saja | + `pending`, `total`, `webhooksOwed`, `uniqueCodeCursor` |
>
> Alasannya: `trxId` yang kamu isi sendiri bisa ditebak (`ORDER-1042`), jadi
> `metadata` merchant ga boleh ikut kebaca. Dan `/health` yang menyiarkan
> "pending: 3, total: 128" ke publik = siapa pun bisa mengukur volume dagangmu.

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
**99**), lalu balik lagi ke 1. Cursor-nya sequence Postgres, jadi cold start lanjut
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
nuxt.config.ts             srcDir: web/, SPA, satu-satunya entry deployment
vercel.json                paksa preset framework nuxtjs
public/robots.txt          Disallow: / — ga ada yang perlu diindeks
.github/workflows/ci.yml   npm test + nuxt build tiap push
server/middleware/api.ts   lempar path API ke app Express (fromNodeMiddleware)
lib/gobiz.js               client GoBiz (auth via fetch, history) — dari kavionn
scripts/migrate.js         apply schema (npm run migrate)

web/                       app Nuxt
  app.vue                  root
  assets/css/main.css      design token (dark/light) + style bareng
  composables/useApi.ts    fetch ber-API-key + formatter rupiah/tanggal
  components/
    StatTile.vue           kartu angka
    ActivityChart.vue      bar harian lunas vs kadaluarsa (tanpa lib chart)
  pages/
    index.vue              landing: link dashboard / docs / health
    admin.vue              dashboard

src/
  config.js                parsing env + validasi startup
  app.js                   wiring Express (middleware + routes)
  qris.js                  CRC16 + QRIS dinamis
  uniqueCode.js            allocator kode berurutan (pakai sequence Postgres)
  logger.js                leveled logger (badge + warna, auto-plain di log file)
  security.js              API key, rate limit, headers, HMAC, SSRF guard
  openapi.js               spec OpenAPI untuk Swagger UI
  db/
    index.js               koneksi Postgres (pg / PGlite) + schema
    transactions.js        query transaksi
    history.js             arsip transaksi GoBiz (= memori poller)
    webhooks.js            state pengiriman webhook + claim/lease
    stats.js               agregat buat dashboard
    meta.js                key-value: token GoBiz, health sesi, throttle poll
  server.js                instance Express tunggal + guard config fatal
  services/
    payments.js            create, expire, markPaid, reconcile
    webhooks.js            pengiriman + retry
    session.js             probe + health sesi GoBiz (state di DB)
    poller.js              pollOnce, cycleIfStale, runCycle
  routes/
    payments.js            /payment/*, /payments
    history.js             /history
    admin.js               /api/admin/*
    system.js              /docs, /openapi.json, /health

tests/                     7 suite (node tests/run.js), offline pakai PGlite
docs/API.md                dokumentasi API lengkap
```

Alur satu pembayaran:

```
POST /payment/create
  → routes/payments.js    validasi input
  → services/payments.js  allocate code (nextval) → build QRIS → simpan
  → db/transactions.js    unique index jamin payAmount PENDING tidak kembar

pembeli bayar, lalu halaman bayar polling GET /payment/:trxId
  → services/poller.js    cycleIfStale: klaim slot di DB, jalankan cycle
  → lib/gobiz.js          getHistory (SETTLEMENT/CAPTURE saja, refund dibuang)
  → services/payments.js  reconcile: cocokin nominal → markPaid
  → services/webhooks.js  simpan sebagai owed → kirim → retry via cycle
```

**Kenapa nominalnya unik, bukan trxId?** API GoBiz cuma melaporkan *nominal*
pembayaran masuk. Ga ada tempat nempelin ID kita. Jadi nominal itu sendiri yang
jadi kunci — lihat [Cara matching](#-cara-matching-penting).

---

## 📚 Library GoBiz (dipakai internal)

Gateway pakai `lib/gobiz.js`. Kalau mau pakai langsung:

```js
import GoPayMerchant from './lib/gobiz.js';

const merchant = new GoPayMerchant();
for (const tx of await merchant.getHistory({ days: 1, size: 30 })) {
  console.log(tx.gobizId, tx.amount, tx.time);
}
```

| Method | Fungsi |
|--------|--------|
| `init()` | Login / muat token dari DB, deteksi merchant ID |
| `getHistory({ days, size })` | Pembayaran masuk, terbaru dulu |
| `tokenState(token)` | `'valid'` / `'invalid'` / `'unknown'` |
| `invalidateToken()` | Buang token cache, paksa login ulang |

`getHistory` hanya mengembalikan `SETTLEMENT` + `CAPTURE` — **refund sengaja
dibuang**, karena `gross_amount`-nya positif dan bisa kebetulan sama dengan
`amountToPay` sebuah order pending lalu menandainya lunas padahal duitnya keluar.

Token + merchant ID di-cache di tabel `meta`, jadi `init()` ga login ulang tiap
cold start. Gagal login memasang cooldown 15 menit **di DB** — supaya instance
berikutnya ga langsung nyoba lagi dan memperdalam rate-limit.

---

## 🙏 Credit

- Library GoBiz inti (`lib/gobiz.js`) berasal dari repo original
  **[kavionn/gobiz-payment](https://github.com/kavionn/gobiz-payment)** oleh
  [@kavionn](https://github.com/kavionn). Terima kasih 🙌
- Lapisan payment gateway (Express, Postgres, webhook, security, Swagger, admin dashboard, Vercel)
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
