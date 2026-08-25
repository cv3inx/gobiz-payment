<script setup lang="ts">
/**
 * Admin dashboard.
 *
 * Everything renders from `GET /api/admin/stats` — one request per refresh rather
 * than six, because each one is a serverless invocation.
 */
const { apiKey, api, restore, remember, forget } = useApi()

const authed = ref(false)
const keyInput = ref('')
const loginError = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const days = ref(14)

const data = ref<any>({ summary: {}, daily: [], recent: [], session: {}, poll: {}, config: {}, uniqueCode: {} })
const unmatched = ref<any[]>([])

let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  busy.value = true
  error.value = ''
  try {
    const [stats, history] = await Promise.all([
      api('GET', `/api/admin/stats?days=${days.value}`),
      api('GET', '/history?matched=false&limit=15'),
    ])
    data.value = stats
    unmatched.value = history
  } catch (e: any) {
    error.value = e.message
    if (!apiKey.value) authed.value = false
  } finally {
    busy.value = false
  }
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

const replay = (t: any) =>
  act(
    () => api('POST', `/payment/${encodeURIComponent(t.trxId)}/replay-webhook`),
    () => `Webhook ${t.trxId} dikirim ulang`,
  )

// Auto-refresh only while the tab is visible. A hidden tab polling forever burns
// invocations for nobody — and each refresh also drives a maintenance cycle.
function start() {
  stop()
  timer = setInterval(() => {
    if (!document.hidden) load()
  }, 20_000)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(() => {
  if (restore()) {
    authed.value = true
    load()
    start()
  }
})
onBeforeUnmount(stop)

const s = computed(() => data.value.summary || {})
const p = computed(() => data.value.poll || {})
const c = computed(() => data.value.config || {})

const conversion = computed(() =>
  s.value.conversionRate == null ? '—' : `${Math.round(s.value.conversionRate * 100)}%`,
)

const sessionDot = computed(() =>
  data.value.session?.ok === true ? 'ok' : data.value.session?.ok === false ? 'bad' : 'unknown',
)
const sessionLabel = computed(() =>
  data.value.session?.ok === true
    ? 'sesi GoBiz aktif'
    : data.value.session?.ok === false
      ? 'sesi GoBiz MATI'
      : 'sesi belum dicek',
)

/**
 * With no cron, detection rides on traffic. A long gap is not necessarily broken —
 * it can just mean nobody used the gateway — so say that rather than cry wolf.
 */
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
        <input
          id="key"
          v-model="keyInput"
          type="password"
          placeholder="API_KEY"
          autocomplete="current-password"
        >
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
        <button class="btn primary" :disabled="busy" @click="pollNow">Cek pembayaran</button>
        <button class="btn" @click="logout">Keluar</button>
      </header>

      <div v-if="error" class="banner bad">{{ error }}</div>
      <div v-if="notice" class="banner ok">{{ notice }}</div>
      <div v-if="pollNote" class="banner warn">{{ pollNote }}</div>

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

      <h2>Transaksi terbaru</h2>
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
            <tr v-for="t in data.recent" :key="t.trxId">
              <td class="mono">{{ t.trxId }}</td>
              <td><span class="pill" :class="t.status">{{ t.status }}</span></td>
              <td class="num mono">{{ rp(t.payAmount) }}</td>
              <td class="num mono hide-sm">{{ t.uniqueCode ?? '—' }}</td>
              <td class="hide-sm muted" style="font-size: 12px">
                {{ t.webhookState || '—' }}<template v-if="t.webhookAttempts"> ({{ t.webhookAttempts }}×)</template>
              </td>
              <td class="hide-sm muted mono" style="font-size: 12px">{{ clock(t.createdAt) }}</td>
              <td class="num">
                <button v-if="t.status === 'PENDING'" class="btn" :disabled="busy" @click="cancel(t)">
                  Batalkan
                </button>
                <button
                  v-else-if="t.webhookState === 'PENDING'"
                  class="btn"
                  :disabled="busy"
                  @click="replay(t)"
                >
                  Ulang
                </button>
              </td>
            </tr>
            <tr v-if="!data.recent?.length">
              <td colspan="7" class="muted">Belum ada transaksi.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Pembayaran masuk belum kecocokan</h2>
      <div class="card" style="padding: 15px 6px">
        <table>
          <thead>
            <tr>
              <th>gobizId</th>
              <th class="num">Nominal</th>
              <th class="hide-sm">Waktu GoBiz</th>
              <th class="hide-sm">Diarsip</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in unmatched" :key="h.gobizId">
              <td class="mono">{{ h.gobizId }}</td>
              <td class="num mono">{{ rp(h.amount) }}</td>
              <td class="hide-sm muted" style="font-size: 12px">{{ h.time || '—' }}</td>
              <td class="hide-sm muted mono" style="font-size: 12px">{{ clock(h.seenAt) }}</td>
            </tr>
            <tr v-if="!unmatched.length">
              <td colspan="4" class="muted">Semua pembayaran cocok ke order. 🎉</td>
            </tr>
          </tbody>
        </table>
      </div>

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
          <div class="label">Re-auth</div>
          <div class="mono">{{ data.session?.reauths ?? 0 }}×</div>
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

      <p v-if="data.session?.lastError" class="muted" style="font-size: 12px; margin-top: 10px">
        Error sesi terakhir: <code>{{ data.session.lastError }}</code>
      </p>
    </template>
  </div>
</template>

<style scoped>
.login { max-width: 380px; margin: 15vh auto; }
</style>
