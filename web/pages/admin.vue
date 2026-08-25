<script setup lang="ts">
/**
 * Admin dashboard.
 *
 * Two reads per refresh: `/api/admin/stats` for the aggregates and `/payments` for
 * the table. The table deliberately uses the public endpoint rather than a second
 * aggregate — it already returns the full shape, and it supports filter and paging.
 */
const { apiKey, api, restore, remember, forget } = useApi()

const authed = ref(false)
const keyInput = ref('')
const loginError = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const days = ref(14)

const data = ref<any>({ summary: {}, daily: [], session: {}, poll: {}, config: {}, uniqueCode: {} })
const rows = ref<any[]>([])
const unmatched = ref<any[]>([])

// Table controls
const statusFilter = ref('')
const searchTerm = ref('')
const searchHit = ref<any>(null)
const page = ref(0)
const PAGE_SIZE = 15

// Drawer + reconcile
const selected = ref<any>(null)
const reconciling = ref<any>(null)
const reconcileTrxId = ref('')

let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  busy.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page.value * PAGE_SIZE),
    })
    if (statusFilter.value) query.set('status', statusFilter.value)

    const [stats, payments, history] = await Promise.all([
      api('GET', `/api/admin/stats?days=${days.value}`),
      api<any[]>('GET', `/payments?${query}`),
      api<any[]>('GET', '/history?matched=false&limit=25'),
    ])
    data.value = stats
    rows.value = payments
    unmatched.value = history
  } catch (e: any) {
    error.value = e.message
    if (!apiKey.value) authed.value = false
  } finally {
    busy.value = false
  }
}

/**
 * Exact trxId lookup. Not a fuzzy search on purpose: what an operator actually has
 * from a customer is the exact id, and `GET /payment/:trxId` answers it in one hop
 * without a LIKE scan over the table.
 */
async function search() {
  const term = searchTerm.value.trim()
  searchHit.value = null
  if (!term) return
  busy.value = true
  error.value = ''
  try {
    searchHit.value = await api('GET', `/payment/${encodeURIComponent(term)}`)
  } catch (e: any) {
    error.value = e.message === 'not found' ? `Transaksi "${term}" tidak ada` : e.message
  } finally {
    busy.value = false
  }
}

function clearSearch() {
  searchTerm.value = ''
  searchHit.value = null
  error.value = ''
}

function changeFilter() {
  page.value = 0
  load()
}

function turnPage(delta: number) {
  const next = page.value + delta
  if (next < 0) return
  page.value = next
  load()
}

async function login() {
  busy.value = true
  loginError.value = ''
  apiKey.value = keyInput.value
  try {
    await api('GET', '/api/admin/stats?days=1')
    remember(keyInput.value)
    authed.value = true
    keyInput.value = ''
    await load()
    start()
  } catch (e: any) {
    loginError.value = e.message
    apiKey.value = ''
  } finally {
    busy.value = false
  }
}

function logout() {
  forget()
  authed.value = false
  stop()
}

/** Run an action, surface its outcome, then refresh. */
async function act(fn: () => Promise<any>, describe: (out: any) => string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    notice.value = describe(await fn())
    await load()
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

const pollNow = () =>
  act(
    () => api('POST', '/api/admin/poll'),
    (r) =>
      `Cek selesai — ${r?.poll?.fresh ?? 0} transaksi baru, ${r?.poll?.matched ?? 0} cocok, ` +
      `${r?.expired ?? 0} kadaluarsa, ${r?.webhooks ?? 0} webhook dikirim` +
      (r?.errors?.length ? ` — error: ${r.errors.join('; ')}` : ''),
  )

const drain = () =>
  act(() => api('POST', '/api/admin/webhooks/drain'), (r) => `${r.attempted} webhook dicoba ulang`)

const cancel = (t: any) =>
  act(() => api('POST', `/payment/${encodeURIComponent(t.trxId)}/cancel`), () => `${t.trxId} dibatalkan`)
    .then(() => { selected.value = null })

const replay = (t: any) =>
  act(
    () => api('POST', `/payment/${encodeURIComponent(t.trxId)}/replay-webhook`),
    () => `Webhook ${t.trxId} dikirim ulang`,
  )

/** Link an orphan payment to an order. The one action that can revive an EXPIRED order. */
function startReconcile(payment: any) {
  reconciling.value = payment
  reconcileTrxId.value = ''
  notice.value = ''
  error.value = ''
}

const confirmReconcile = () => {
  const payment = reconciling.value
  const trxId = reconcileTrxId.value.trim()
  if (!payment || !trxId) return
  return act(
    () => api('POST', '/api/admin/reconcile', { gobizId: payment.gobizId, trxId }),
    (r) => {
      const gap = r.difference === 0
        ? 'nominalnya pas'
        : `selisih ${r.difference > 0 ? 'lebih' : 'kurang'} ${rp(Math.abs(r.difference))}`
      return `${r.trxId}: ${r.previousStatus} → ${r.status}, ${gap}. Webhook payment.paid dikirim.`
    },
  ).then(() => { reconciling.value = null })
}

// Auto-refresh only while the tab is visible. A hidden tab polling forever burns
// invocations for nobody — and each refresh also drives a maintenance cycle.
function start() {
  stop()
  timer = setInterval(() => {
    if (!document.hidden && !selected.value && !reconciling.value) load()
  }, 20_000)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (reconciling.value) reconciling.value = null
  else if (selected.value) selected.value = null
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (restore()) {
    authed.value = true
    load()
    start()
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stop()
})

const s = computed(() => data.value.summary || {})
const p = computed(() => data.value.poll || {})
const c = computed(() => data.value.config || {})
const session = computed(() => data.value.session || {})

const conversion = computed(() =>
  s.value.conversionRate == null ? '—' : `${Math.round(s.value.conversionRate * 100)}%`,
)

const sessionDot = computed(() =>
  session.value.ok === true ? 'ok' : session.value.ok === false ? 'bad' : 'unknown',
)
const sessionLabel = computed(() =>
  session.value.ok === true
    ? 'sesi GoBiz aktif'
    : session.value.ok === false
      ? 'sesi GoBiz MATI'
      : 'sesi belum dicek',
)

/**
 * A GoBiz login cooldown is the one state where the fix is to do nothing. Retrying
 * during it only deepens the rate-limit, so "check now" gets disabled outright.
 */
const cooldown = computed(() => {
  const secs = session.value.cooldownSeconds || 0
  if (secs <= 0) return null
  const m = Math.floor(secs / 60)
  const sec = secs % 60
  return { secs, text: m > 0 ? `${m}m ${sec}s` : `${sec}s`, until: session.value.cooldownUntil }
})

const pollNote = computed(() => {
  const stale = p.value.staleSeconds
  if (stale == null) {
    return 'Belum pernah polling. Pembayaran terdeteksi begitu ada yang membuka halaman status transaksi, atau klik "Cek pembayaran".'
  }
  if (stale > 900) {
    return `Polling terakhir ${Math.round(stale / 60)} menit lalu — normal kalau memang belum ada transaksi. Klik "Cek pembayaran" untuk memaksa sekarang.`
  }
  return ''
})

useHead({ title: 'Admin — GoBiz Payment' })
</script>

<template>
  <div class="wrap">
    <!-- ── Key prompt ──────────────────────────────────────────────────────── -->
    <div v-if="!authed" class="card login">
      <h1>GoBiz Payment — Admin</h1>
      <p class="muted" style="margin: 4px 0 14px; font-size: 13px">
        Masukkan <code>API_KEY</code>. Disimpan di sessionStorage tab ini saja.
      </p>

      <form @submit.prevent="login">
        <label for="key" class="sr">API key</label>
        <input id="key" v-model="keyInput" type="password" placeholder="API_KEY" autocomplete="current-password">
        <div v-if="loginError" class="banner bad" style="margin: 12px 0 0">{{ loginError }}</div>
        <button class="btn primary" style="width: 100%; margin-top: 12px" :disabled="busy">
          {{ busy ? 'Memeriksa…' : 'Masuk' }}
        </button>
      </form>

      <p class="muted" style="font-size: 12px; margin: 14px 0 0">
        Kalau <code>API_KEY</code> kosong di env, endpoint tulis terbuka — isi apa saja.
      </p>
    </div>

    <!-- ── Dashboard ───────────────────────────────────────────────────────── -->
    <template v-else>
      <header class="row" style="margin-bottom: 22px">
        <h1>GoBiz Payment</h1>
        <span class="muted mono" style="font-size: 12px">
          <span class="dot" :class="sessionDot" />{{ sessionLabel }}
        </span>
        <span class="spacer" />
        <label for="range" class="sr">Rentang hari</label>
        <select id="range" v-model.number="days" @change="load()">
          <option :value="7">7 hari</option>
          <option :value="14">14 hari</option>
          <option :value="30">30 hari</option>
        </select>
        <button class="btn" :disabled="busy" @click="load()">{{ busy ? '…' : 'Refresh' }}</button>
        <button
          class="btn primary"
          :disabled="busy || !!cooldown"
          :title="cooldown ? `GoBiz cooldown, tunggu ${cooldown.text}` : ''"
          @click="pollNow"
        >
          Cek pembayaran
        </button>
        <button class="btn" @click="logout">Keluar</button>
      </header>

      <div v-if="error" class="banner bad">{{ error }}</div>
      <div v-if="notice" class="banner ok">{{ notice }}</div>

      <div v-if="cooldown" class="banner bad">
        <strong>GoBiz login di-cooldown {{ cooldown.text }}</strong> (sampai {{ clock(cooldown.until) }}).
        Login berulang saat rate-limit justru memperpanjang blokir — tombol "Cek pembayaran"
        dimatikan sampai selesai. Kalau ini karena kredensial salah, perbaiki
        <code>GOPAY_EMAIL</code>/<code>GOPAY_PASSWORD</code> dulu.
      </div>
      <div v-else-if="pollNote" class="banner warn">{{ pollNote }}</div>

      <div class="grid tiles">
        <StatTile label="Pending" :value="s.pending ?? '—'" :sub="`${s.total ?? 0} transaksi total`" />
        <StatTile label="Lunas" :value="s.paid ?? '—'" :sub="`${conversion} dari yang selesai`" />
        <StatTile label="Masuk hari ini" :value="rp(s.revenueToday)" :sub="`7 hari: ${rp(s.revenue7d)}`" />
        <StatTile label="Masuk 30 hari" :value="rp(s.revenue30d)" :sub="`total: ${rp(s.revenueAll)}`" />
        <StatTile
          label="Webhook nunggak"
          :value="s.webhooksOwed ?? '—'"
          :tone="s.webhooksStuck ? 'bad' : s.webhooksOwed ? 'warn' : 'default'"
          :sub="s.webhooksStuck ? `${s.webhooksStuck} habis percobaan` : 'semua masih dicoba'"
        />
        <StatTile
          label="Belum kecocokan"
          :value="s.unmatchedPayments ?? '—'"
          :tone="s.unmatchedPayments ? 'warn' : 'default'"
          :sub="`${rp(s.unmatchedValue)} perlu dicek manual`"
        />
      </div>

      <div v-if="s.webhooksOwed" class="row" style="margin-top: 12px">
        <button class="btn" :disabled="busy" @click="drain">Kirim ulang webhook nunggak</button>
        <span class="muted" style="font-size: 12px">maks 50 per klik</span>
      </div>

      <h2>Aktivitas {{ days }} hari</h2>
      <ActivityChart :days="data.daily || []" />

      <!-- ── Search ────────────────────────────────────────────────────────── -->
      <h2>Cari transaksi</h2>
      <div class="card">
        <form class="row" @submit.prevent="search">
          <label for="q" class="sr">trxId</label>
          <input
            id="q"
            v-model="searchTerm"
            placeholder="trxId persis, mis. ORDER-1042 atau TRX-K3F9Q2A7X1B4"
            style="flex: 1; min-width: 220px"
          >
          <button class="btn primary" :disabled="busy || !searchTerm.trim()">Cari</button>
          <button v-if="searchHit || searchTerm" type="button" class="btn" @click="clearSearch">
            Bersihkan
          </button>
        </form>

        <div v-if="searchHit" class="row hit" @click="selected = searchHit">
          <span class="pill" :class="searchHit.status">{{ searchHit.status }}</span>
          <code>{{ searchHit.trxId }}</code>
          <span class="mono">{{ rp(searchHit.amountToPay) }}</span>
          <span class="muted mono" style="font-size: 12px">{{ clock(searchHit.createdAt) }}</span>
          <span class="spacer" />
          <span class="muted" style="font-size: 12px">klik untuk detail →</span>
        </div>
      </div>

      <!-- ── Transactions ──────────────────────────────────────────────────── -->
      <h2 class="row">
        <span>Transaksi</span>
        <span class="spacer" />
        <label for="st" class="sr">Filter status</label>
        <select id="st" v-model="statusFilter" @change="changeFilter">
          <option value="">Semua status</option>
          <option value="PENDING">PENDING</option>
          <option value="PAID">PAID</option>
          <option value="EXPIRED">EXPIRED</option>
        </select>
      </h2>

      <div class="card" style="padding: 15px 6px">
        <table>
          <thead>
            <tr>
              <th>trxId</th>
              <th>Status</th>
              <th class="num">Bayar</th>
              <th class="num hide-sm">Kode</th>
              <th class="hide-sm">Webhook</th>
              <th class="hide-sm">Dibuat</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in rows" :key="t.trxId" class="clickable" @click="selected = t">
              <td class="mono">{{ t.trxId }}</td>
              <td><span class="pill" :class="t.status">{{ t.status }}</span></td>
              <td class="num mono">{{ rp(t.amountToPay) }}</td>
              <td class="num mono hide-sm">{{ t.uniqueCode ?? '—' }}</td>
              <td class="hide-sm muted" style="font-size: 12px">
                <template v-if="t.webhook">
                  <span :class="{ bad: t.webhook.lastError }">{{ t.webhook.state }}</span>
                  <template v-if="t.webhook.attempts"> ({{ t.webhook.attempts }}×)</template>
                </template>
                <template v-else>—</template>
              </td>
              <td class="hide-sm muted mono" style="font-size: 12px">{{ clock(t.createdAt) }}</td>
              <td class="num" @click.stop>
                <button v-if="t.status === 'PENDING'" class="btn" :disabled="busy" @click="cancel(t)">
                  Batalkan
                </button>
                <button
                  v-else-if="t.webhook?.state === 'PENDING'"
                  class="btn"
                  :disabled="busy"
                  @click="replay(t)"
                >
                  Ulang
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="7" class="muted">
                {{ statusFilter ? `Tidak ada transaksi ${statusFilter}.` : 'Belum ada transaksi.' }}
              </td>
            </tr>
          </tbody>
        </table>

        <div class="row" style="margin: 12px 10px 2px">
          <button class="btn" :disabled="busy || page === 0" @click="turnPage(-1)">← Sebelumnya</button>
          <span class="muted" style="font-size: 12px">
            Halaman {{ page + 1 }} · {{ rows.length }} baris
          </span>
          <span class="spacer" />
          <button class="btn" :disabled="busy || rows.length < PAGE_SIZE" @click="turnPage(1)">
            Berikutnya →
          </button>
        </div>
      </div>

      <!-- ── Unmatched payments ────────────────────────────────────────────── -->
      <h2>Pembayaran masuk belum kecocokan</h2>
      <p v-if="unmatched.length" class="muted" style="font-size: 12px; margin: -4px 0 11px">
        Duitnya sudah masuk tapi nominalnya tidak cocok ke order mana pun. Tautkan manual
        supaya order-nya jadi <code>PAID</code> dan webhook-nya terkirim.
      </p>
      <div class="card" style="padding: 15px 6px">
        <table>
          <thead>
            <tr>
              <th>gobizId</th>
              <th class="num">Nominal</th>
              <th class="hide-sm">Waktu GoBiz</th>
              <th class="hide-sm">Diarsip</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in unmatched" :key="h.gobizId">
              <td class="mono">{{ h.gobizId }}</td>
              <td class="num mono">{{ rp(h.amount) }}</td>
              <td class="hide-sm muted" style="font-size: 12px">{{ h.time || '—' }}</td>
              <td class="hide-sm muted mono" style="font-size: 12px">{{ clock(h.seenAt) }}</td>
              <td class="num">
                <button class="btn" :disabled="busy" @click="startReconcile(h)">Tautkan…</button>
              </td>
            </tr>
            <tr v-if="!unmatched.length">
              <td colspan="5" class="muted">Semua pembayaran cocok ke order. 🎉</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ── System ────────────────────────────────────────────────────────── -->
      <h2>Sistem</h2>
      <div class="card grid" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px">
        <div>
          <div class="label">Poll terakhir</div>
          <div class="mono">
            {{ p.lastPollAt ? clock(p.lastPollAt) : 'belum pernah' }}
            <span v-if="p.staleSeconds != null" class="muted">({{ p.staleSeconds }}s lalu)</span>
          </div>
        </div>
        <div>
          <div class="label">Jeda minimum poll</div>
          <div class="mono">{{ Math.round((p.minIntervalMs ?? 0) / 1000) }}s</div>
        </div>
        <div>
          <div class="label">Kode unik</div>
          <div class="mono">{{ data.uniqueCode?.cursor ?? '—' }} / {{ data.uniqueCode?.max ?? '—' }}</div>
        </div>
        <div>
          <div class="label">Sesi GoBiz</div>
          <div class="mono"><span class="dot" :class="sessionDot" />{{ sessionLabel }}</div>
        </div>
        <div>
          <div class="label">Cooldown login</div>
          <div class="mono" :class="{ bad: cooldown }">
            {{ cooldown ? `${cooldown.text} lagi` : 'tidak aktif' }}
          </div>
        </div>
        <div>
          <div class="label">Re-auth</div>
          <div class="mono">{{ session.reauths ?? 0 }}×</div>
        </div>
        <div>
          <div class="label">Webhook global</div>
          <div class="mono" style="overflow-wrap: anywhere">{{ c.webhookUrl || 'tidak diset' }}</div>
        </div>
        <div>
          <div class="label">Umur transaksi</div>
          <div class="mono">{{ c.expireMinutes }} menit</div>
        </div>
        <div>
          <div class="label">Runtime</div>
          <div class="mono">{{ c.serverless ? 'Vercel serverless' : 'proses lokal' }}</div>
        </div>
      </div>

      <p v-if="session.lastError" class="muted" style="font-size: 12px; margin-top: 10px">
        Error sesi terakhir: <code>{{ session.lastError }}</code>
      </p>

      <!-- ── Overlays ──────────────────────────────────────────────────────── -->
      <TrxDetail
        :trx="selected"
        @close="selected = null"
        @cancel="cancel"
        @replay="replay"
      />

      <div v-if="reconciling" class="backdrop" @click.self="reconciling = null">
        <div class="card modal" role="dialog" aria-modal="true" aria-label="Tautkan pembayaran">
          <h1 style="font-size: 15px">Tautkan pembayaran ke order</h1>
          <p class="muted" style="font-size: 13px; margin: 8px 0 14px">
            <code>{{ reconciling.gobizId }}</code> · <strong>{{ rp(reconciling.amount) }}</strong>
            masuk {{ reconciling.time || clock(reconciling.seenAt) }}.
          </p>

          <form @submit.prevent="confirmReconcile">
            <label for="rid" class="label">trxId order tujuan</label>
            <input id="rid" v-model="reconcileTrxId" placeholder="ORDER-1042" style="margin-top: 5px">

            <div class="banner warn" style="margin: 14px 0 0">
              Order akan ditandai <strong>PAID</strong> walaupun statusnya sudah
              <code>EXPIRED</code>, dan webhook <code>payment.paid</code> dikirim. Kalau
              consumer-mu sudah menerima <code>payment.expired</code> untuk order ini,
              dia akan menerima <code>payment.paid</code> sesudahnya — pastikan
              handler-mu tahan urutan itu. Tidak bisa dibatalkan.
            </div>

            <div class="row" style="margin-top: 14px">
              <button class="btn primary" :disabled="busy || !reconcileTrxId.trim()">
                Tautkan &amp; tandai PAID
              </button>
              <button type="button" class="btn" @click="reconciling = null">Batal</button>
            </div>
          </form>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.login { max-width: 380px; margin: 15vh auto; }

.clickable { cursor: pointer; }

.hit {
  margin-top: 13px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}
.hit:hover { border-color: var(--accent); }

.bad { color: var(--bad); }

.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 60;
}
.modal { width: min(500px, 100%); }
</style>
