// PM2 config for an always-on host. Build first, then start:
//   npm ci && npm run migrate && npm run build
//   pm2 start ecosystem.config.cjs && pm2 save
//
// .env is read by Node itself (--env-file) rather than by the app, because the
// Nitro server reads PORT before any app code runs.
//
// ponytail: one fork instance. The poll throttle lives in Postgres, so more
// instances would be safe, but a gateway this size gains nothing from them.
module.exports = {
  apps: [
    {
      name: 'gobiz-payment',
      script: '.output/server/index.mjs',
      cwd: __dirname,
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '384M',
      env: {
        NODE_ENV: 'production',
        // No cron here: without this, payments are only detected while someone
        // is reading a payment status. See server/plugins/ticker.ts.
        BACKGROUND_POLL: '1',
      },
    },
  ],
};
