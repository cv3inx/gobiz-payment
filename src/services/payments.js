import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { buildDynamicQris } from '../qris.js';
import { allocate } from '../uniqueCode.js';
import * as transactions from '../db/transactions.js';
import * as history from '../db/history.js';
import * as webhooks from './webhooks.js';

const logTrx = log('trx');
const logBoot = log('server');

// Expiry timers, keyed by trxId. Not persisted — rebuilt on boot.
const timers = new Map();

// Unambiguous alphabet: no 0/1/O/I. 12 chars ≈ 10^18 space.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateTrxId() {
   const bytes = crypto.randomBytes(12);
   let id = '';
   for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
   return `TRX-${id}`;
}

/** Public shape of a transaction. `amountToPay` is the only figure the payer sends. */
export function toPublic(trx, baseUrl = '') {
   const qrPath = `/payment/${trx.trxId}/qr.png`;
   return {
      trxId: trx.trxId,
      status: trx.status,
      amount: trx.amount,
      fee: trx.fee,
      uniqueCode: trx.uniqueCode ?? trx.payAmount - trx.total,
      amountToPay: trx.payAmount,
      qrString: trx.qrString,
      qrImageUrl: baseUrl ? baseUrl + qrPath : qrPath,
      callbackUrl: trx.callbackUrl || null,
      metadata: trx.metadata || null,
      createdAt: trx.createdAt,
      expiresAt: trx.expiresAt,
      paidAt: trx.paidAt || null,
      webhook: trx.webhookState
         ? {
              state: trx.webhookState,
              attempts: trx.webhookAttempts || 0,
              nextAttemptAt: trx.webhookNextAt || null,
              lastError: trx.webhookLastError || null,
           }
         : null,
   };
}

function clearTimer(trxId) {
   const timer = timers.get(trxId);
   if (timer) {
      clearTimeout(timer);
      timers.delete(trxId);
   }
}

function scheduleExpiry(trx) {
   const ms = Math.max(0, new Date(trx.expiresAt).getTime() - Date.now());
   timers.set(trx.trxId, setTimeout(() => {
      const fresh = transactions.get(trx.trxId);
      if (fresh) expire(fresh);
   }, ms));
}

/**
 * Create a payment: allocate a unique payable amount, build its QRIS, persist,
 * and schedule expiry.
 * @throws {Error & { code: 'NO_FREE_CODE' | 'DUPLICATE' }}
 */
export function create({ amount, fee = 0, trxId, callbackUrl = null, callbackSecret = null, expireMinutes, metadata = null, idempotencyKey = null }) {
   const total = amount + fee;
   const { code, payAmount } = allocate(total, {
      max: config.uniqueCodeMax,
      isTaken: (candidate) => !!transactions.getPendingByAmount(candidate),
   });

   const minutes = expireMinutes ?? config.expireMinutes;
   const trx = {
      trxId: trxId || generateTrxId(),
      status: 'PENDING',
      amount,
      fee,
      total,
      payAmount,
      uniqueCode: code,
      qrString: buildDynamicQris(config.qrisString, payAmount),
      callbackUrl,
      callbackSecret,
      idempotencyKey,
      metadata,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      paidAt: null,
      entry: null,
   };

   try {
      transactions.insert(trx);
   } catch (e) {
      // unique index race on pending payAmount, idempotencyKey, or trxId
      throw Object.assign(new Error('slot taken, retry'), { code: 'DUPLICATE', cause: e });
   }

   scheduleExpiry(trx);
   logTrx.info(`CREATE ${trx.trxId} amount=${amount} fee=${fee} code=${code} amountToPay=${payAmount}`);
   return trx;
}

// Both settle paths go through the DB's PENDING guard, so exactly one wins and
// fires a webhook — a payment landing as the expiry timer fires can't double-notify.

export function expire(trx) {
   if (trx.status !== 'PENDING') return false;
   clearTimer(trx.trxId);
   if (!transactions.settle({ ...trx, status: 'EXPIRED' })) return false;
   webhooks.enqueue({ ...trx, status: 'EXPIRED' });
   return true;
}

export function markPaid(trx, entry = null) {
   if (trx.status !== 'PENDING') return false;
   clearTimer(trx.trxId);
   const paid = { ...trx, status: 'PAID', paidAt: new Date().toISOString(), entry };
   if (!transactions.settle(paid)) {
      logTrx.warn(`${trx.trxId} already settled, skipping PAID webhook`);
      return false;
   }
   logTrx.ok(`PAID ${trx.trxId} amountToPay=${trx.payAmount}`);
   webhooks.enqueue(paid);
   return true;
}

/**
 * Reconcile an incoming GoBiz payment against a pending order, then archive it.
 * Upstream sends gross_amount/100 (a float); payAmount is an INTEGER column, so a
 * non-integral value could never match and the payment would go unreconciled.
 */
export function reconcile({ amount, txId, entry = null }) {
   const rupiah = Math.round(amount);
   const trx = Number.isFinite(rupiah) ? transactions.getPendingByAmount(rupiah) : null;

   if (trx) markPaid(trx, entry);
   else logTrx.warn(`unmatched payment Rp ${amount} (gobizId=${txId}) — archived only`);

   try {
      history.upsert({
         gobizId: txId,
         amount: rupiah,
         time: entry?.time ?? null,
         matchedTrxId: trx?.trxId ?? null,
         raw: entry,
         seenAt: new Date().toISOString(),
      });
   } catch (e) {
      log('history').warn(`archive failed: ${e.message}`);
   }
   return trx;
}

/** Rebuild expiry timers after a restart, expiring whatever came due while down. */
export function restorePending() {
   const pending = transactions.listPending();
   for (const trx of pending) {
      if (new Date(trx.expiresAt).getTime() <= Date.now()) expire(trx);
      else scheduleExpiry(trx);
   }
   if (pending.length) logBoot.info(`restored ${pending.length} pending trx`);
   return pending.length;
}

export function clearAllTimers() {
   for (const timer of timers.values()) clearTimeout(timer);
   timers.clear();
}
