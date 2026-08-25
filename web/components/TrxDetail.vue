<script setup lang="ts">
/**
 * Transaction detail drawer.
 *
 * Exists mainly for one field: `webhook.lastError`. "attempts: 4" only says a
 * webhook is failing — the error says *how*, and `ECONNREFUSED` (consumer down)
 * and `HTTP 500` (consumer up, throwing) need completely different fixes.
 */
const props = defineProps<{ trx: any }>()
defineEmits<{ close: []; cancel: [any]; replay: [any] }>()

const wh = computed(() => props.trx?.webhook)

/** Diagnose the failure class from the driver's error string. */
const errorHint = computed(() => {
  const e = wh.value?.lastError
  if (!e) return ''
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(e)) {
    return 'Consumer-nya tidak bisa dihubungi — URL salah, atau servermu mati.'
  }
  if (/ETIMEDOUT|TimeoutError|aborted/i.test(e)) {
    return 'Consumer menerima request tapi tidak menjawab dalam WEBHOOK_TIMEOUT_MS.'
  }
  if (/HTTP 4\d\d/i.test(e)) {
    return 'Consumer menolak payload-nya — cek verifikasi signature dan bentuk body di sisimu.'
  }
  if (/HTTP 5\d\d/i.test(e)) {
    return 'Consumer hidup tapi error saat memproses — bug ada di handler webhook-mu.'
  }
  return ''
})

const timeline = computed(() => {
  const t = props.trx
  if (!t) return []
  return [
    { label: 'Dibuat', at: t.createdAt },
    { label: 'Kadaluarsa', at: t.expiresAt },
    { label: 'Lunas', at: t.paidAt },
    { label: 'Webhook berikutnya', at: wh.value?.nextAttemptAt },
  ].filter((r) => r.at)
})

const metadataText = computed(() =>
  props.trx?.metadata == null ? null : JSON.stringify(props.trx.metadata, null, 2),
)
</script>

<template>
  <!-- Backdrop closes on click; Escape is wired by the parent's keydown. -->
  <div v-if="trx" class="backdrop" @click.self="$emit('close')">
    <aside class="drawer" role="dialog" aria-modal="true" :aria-label="`Detail ${trx.trxId}`">
      <header class="row" style="margin-bottom: 16px">
        <span class="pill" :class="trx.status">{{ trx.status }}</span>
        <code>{{ trx.trxId }}</code>
        <span class="spacer" />
        <button class="btn" aria-label="Tutup" @click="$emit('close')">✕</button>
      </header>

      <div class="grid two">
        <div><div class="label">Harga</div><div class="mono">{{ rp(trx.amount) }}</div></div>
        <div><div class="label">Fee</div><div class="mono">{{ rp(trx.fee) }}</div></div>
        <div><div class="label">Kode unik</div><div class="mono">{{ trx.uniqueCode ?? '—' }}</div></div>
        <div>
          <div class="label">Dibayar</div>
          <div class="mono" style="font-weight: 620">{{ rp(trx.amountToPay) }}</div>
        </div>
      </div>

      <h2>Waktu</h2>
      <div class="card grid" style="gap: 8px">
        <div v-for="row in timeline" :key="row.label" class="row" style="gap: 10px">
          <span class="label" style="min-width: 130px">{{ row.label }}</span>
          <span class="mono">{{ clock(row.at) }}</span>
        </div>
      </div>

      <h2>Webhook</h2>
      <div class="card grid" style="gap: 9px">
        <template v-if="wh">
          <div class="row" style="gap: 10px">
            <span class="label" style="min-width: 130px">Status</span>
            <span class="mono">{{ wh.state }} — {{ wh.attempts }}× percobaan</span>
          </div>
          <div v-if="trx.callbackUrl" class="row" style="gap: 10px">
            <span class="label" style="min-width: 130px">Tujuan</span>
            <span class="mono" style="overflow-wrap: anywhere">{{ trx.callbackUrl }}</span>
          </div>
          <div v-if="wh.lastError">
            <div class="label">Error terakhir</div>
            <code class="err">{{ wh.lastError }}</code>
            <p v-if="errorHint" class="muted" style="font-size: 12px; margin: 8px 0 0">
              {{ errorHint }}
            </p>
          </div>
        </template>
        <span v-else class="muted">Belum ada webhook untuk transaksi ini.</span>
      </div>

      <template v-if="metadataText">
        <h2>Metadata</h2>
        <pre class="card meta">{{ metadataText }}</pre>
      </template>

      <h2>QR</h2>
      <div class="card">
        <a :href="trx.qrImageUrl" target="_blank" rel="noopener">Buka gambar QRIS</a>
        <pre class="card meta" style="margin-top: 10px">{{ trx.qrString }}</pre>
      </div>

      <div class="row" style="margin-top: 18px">
        <button v-if="trx.status === 'PENDING'" class="btn" @click="$emit('cancel', trx)">
          Batalkan
        </button>
        <button v-if="wh?.state === 'PENDING'" class="btn" @click="$emit('replay', trx)">
          Kirim ulang webhook
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.5);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: min(560px, 100%);
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
  border-left: 1px solid var(--line);
  padding: 20px;
}
.two { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.err {
  display: block;
  color: var(--bad);
  overflow-wrap: anywhere;
  margin-top: 4px;
}
.meta {
  margin: 0;
  padding: 11px 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
