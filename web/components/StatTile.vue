<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'warn' | 'bad'
}>()
</script>

<template>
  <div class="card">
    <div class="label">{{ label }}</div>
    <div class="value" :class="tone">{{ value }}</div>
    <div v-if="sub" class="sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.value {
  font-size: 23px;
  font-weight: 620;
  margin-top: 5px;
  letter-spacing: -0.02em;
  /* Tabular figures so the number does not shift width as it updates. */
  font-variant-numeric: tabular-nums;
}
.value.warn { color: var(--warn); }
.value.bad { color: var(--bad); }
.sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
</style>
