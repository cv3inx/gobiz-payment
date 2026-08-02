import { db } from './index.js';

const stmt = {
   get: db.prepare(`SELECT value FROM meta WHERE key = ?`),
   set: db.prepare(`INSERT INTO meta (key, value) VALUES (:key, :value)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};

export const get = (key) => stmt.get.get(key)?.value ?? null;
export const set = (key, value) => void stmt.set.run({ key, value: String(value) });

export const getInt = (key, fallback = 0) => {
   const n = parseInt(get(key), 10);
   return Number.isInteger(n) ? n : fallback;
};

/** Run `fn` in an IMMEDIATE transaction so concurrent readers can't interleave. */
export const transact = (fn) => db.transaction(fn).immediate();
