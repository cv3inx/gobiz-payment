import { all, one, sql } from './index.js';

/**
 * Durable key-value. In serverless there is no writable filesystem and no
 * process memory that survives an invocation, so anything that used to live in
 * `data/*.json` or a module-level variable lives here: the GoBiz token cache,
 * session health, and the watcher's seen-transaction set.
 */

export const get = async (key) => {
   const row = await one(`SELECT value FROM meta WHERE key = $1`, [key]);
   return row ? row.value : null;
};

export const set = async (key, value) => {
   await sql(
      `INSERT INTO meta (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value ?? null)],
   );
};

/** Merge into an existing object value instead of replacing it. */
export const patch = async (key, fields) => {
   await sql(
      `INSERT INTO meta (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = meta.value || excluded.value`,
      [key, JSON.stringify(fields)],
   );
};

/**
 * Take the poll slot if nobody has polled within `minIntervalMs`.
 *
 * A global throttle, not a per-instance one: reads from many payers land on many
 * instances at once, and an in-process guard would let each of them hit GoBiz.
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE` is a single atomic statement, so
 * exactly one caller wins the slot and the rest get `false` and skip the poll.
 *
 * @returns {Promise<boolean>} true if the caller now owns the poll
 */
export async function tryClaimPollSlot(minIntervalMs, now = Date.now()) {
   const rows = await all(
      `INSERT INTO meta (key, value) VALUES ('poller.lastRunAt', to_jsonb($1::bigint))
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::bigint)
       WHERE (meta.value)::bigint <= $2
       RETURNING key`,
      [now, now - minIntervalMs],
   );
   return rows.length > 0;
}

/** When the last poll ran (epoch ms), or null if it never has. */
export async function lastPollAt() {
   const value = await get('poller.lastRunAt');
   return value == null ? null : Number(value);
}

/**
 * Next unique code, from a Postgres sequence.
 *
 * `nextval` is atomic and needs no transaction or lock, so two concurrent
 * /payment/create calls can never receive the same code — which is exactly the
 * guarantee the old SQLite IMMEDIATE transaction existed to provide.
 * Codes come out 1..max and wrap back to 1, continuing across restarts.
 */
export async function nextCodes(max, count = 1) {
   const rows = await all(
      `SELECT ((nextval('unique_code_seq') - 1) % $1) + 1 AS code
       FROM generate_series(1, $2)`,
      [max, count],
   );
   return rows.map((r) => Number(r.code));
}

/** Last code handed out (0 before the first allocation). For /health. */
export async function codeCursor(max) {
   const row = await one(
      `SELECT last_value, is_called FROM unique_code_seq`,
   );
   if (!row || !row.is_called) return 0;
   return Number((BigInt(row.last_value) - BigInt(1)) % BigInt(max)) + 1;
}
