<script setup lang="ts">
interface Day {
  day: string
  created: number
  paid: number
  expired: number
  revenue: number
}

const props = defineProps<{ days: Day[] }>()

const idr = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

/** Scale to the tallest stacked column, never to 0 (which would divide by zero). */
const peak = computed(() =>
  Math.max(1, ...props.days.map((d) => d.paid + d.expired)),
)

const TRACK_PX = 104
const barPx = (n: number) => (n / peak.value) * TRACK_PX

const tooltip = (d: Day) =>
  `${d.day}: ${d.paid} lunas, ${d.expired} kadaluarsa, Rp ${idr.format(d.revenue)}`

// The chart is decorative for assistive tech; the numbers themselves are in the
// tiles and the table, so one summary label is honest and enough.
const summary = computed(() => {
  const paid = props.days.reduce((n, d) => n + d.paid, 0)
  const expired = props.days.reduce((n, d) => n + d.expired, 0)
  return `Aktivitas ${props.days.length} hari: ${paid} lunas, ${expired} kadaluarsa, puncak ${peak.value} per hari`
})
</script>

<template>
  <div class="card">
    <div class="chart" role="img" :aria-label="summary">
      <div v-for="d in days" :key="d.day" class="col" :title="tooltip(d)">
        <div class="bar expired" :style="{ height: `${barPx(d.expired)}px` }" />
        <div class="bar paid" :style="{ height: `${barPx(d.paid)}px` }" />
      </div>
    </div>

    <div class="axis">
      <div v-for="d in days" :key="d.day" class="cap">{{ d.day.slice(8) }}</div>
    </div>

    <div class="legend">
      <span><i class="swatch paid" />Lunas</span>
      <span><i class="swatch expired" />Kadaluarsa</span>
      <span class="spacer" />
      <span>puncak {{ peak }} transaksi/hari</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 116px;
  margin-top: 6px;
}
.col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
.bar { border-radius: 2px 2px 0 0; min-height: 0; }
.bar.paid { background: var(--ok); }
.bar.expired { background: color-mix(in srgb, var(--muted) 45%, transparent); }

.axis { display: flex; gap: 3px; }
.cap {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: 10px;
  text-align: center;
  margin-top: 5px;
  overflow: hidden;
  white-space: nowrap;
}

.legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--muted);
  margin-top: 9px;
}
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.swatch.paid { background: var(--ok); }
.swatch.expired { background: color-mix(in srgb, var(--muted) 45%, transparent); }
</style>
