<script setup lang="ts">
// The root is a signpost, not a landing page: this deployment has exactly two
// human-facing surfaces, and guessing wrong wastes a click.
useHead({ title: 'GoBiz Payment Gateway' })
</script>

<template>
  <div class="wrap" style="max-width: 620px">
    <div class="card" style="margin-top: 12vh">
      <h1>GoBiz Payment Gateway</h1>
      <p class="muted" style="margin: 8px 0 20px; font-size: 13px">
        QRIS payment gateway di atas GoPay Merchant.
      </p>

      <div class="grid" style="gap: 10px">
        <NuxtLink to="/admin" class="btn primary" style="text-align: center; text-decoration: none">
          Admin dashboard
        </NuxtLink>
        <a href="/docs" class="btn" style="text-align: center; text-decoration: none">
          Dokumentasi API (Swagger)
        </a>
        <a href="/health" class="btn" style="text-align: center; text-decoration: none">
          Health check
        </a>
      </div>
    </div>
  </div>
</template>
