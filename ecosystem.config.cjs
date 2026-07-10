// PM2 process config. Run: pm2 start ecosystem.config.cjs
// The GoPay watcher runs in-process, so keeping this alive = auto payment
// checking + webhook delivery in the background.
// ponytail: single fork instance. Do NOT run cluster mode — the watcher's
// poller and in-memory expiry timers assume one process (SQLite is the shared
// truth, but duplicate pollers would double-fire webhooks).
module.exports = {
  apps: [
    {
      name: 'gobiz-payment',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      // logs go to PM2 default (~/.pm2/logs); view with `pm2 logs gobiz-payment`.
      // No `time:` — the app's own logger already timestamps each line (avoid double stamp).
    },
  ],
};
