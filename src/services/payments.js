import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { buildDynamicQris } from '../qris.js';
import { allocate } from '../uniqueCode.js';
import * as transactions from '../db/transactions.js';
import * as history from '../db/history.js';
import * as webhooks from './webhooks.js';

const logTrx = log('trx');

// Unambiguous alphabet: no 0/1/O/I. 12 chars ≈ 10^18 space.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Postgres unique-violation. */
const isUniqueViolation = (e) => e?.code === '23505';

function generateTrxId() {
   const bytes = crypto.randomBytes(12);
   let id = '';
   for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
   return `TRX-${id}`;
}

/** Has this pending transaction outlived its expiry? */
export const isOverdue = (trx) =>
   trx.status === 'PENDING' && new Date(trx.expiresAt).getTime() <= Date.now();

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

/**
 * Create a payment: allocate a unique payable amount, build its QRIS, persist.
 *
 * No expiry timer is scheduled. A serverless instance is frozen between requests,
 * so a setTimeout would simply never fire — expiry is settled lazily on read and
 * on read and by the cycle sweep instead (see `expireIfOverdue` and `expireDue`).
 *
 * @throws {Error & { code: 'NO_FREE_CODE' | 'DUPLICATE' }}
 */
export async function create({
   amount, fee = 0, trxId, callbackUrl = null, callbackSecret = null,
   expireMinutes, metadata = null, idempotencyKey = null,
}) {
   const total = amount + fee;
   const minutes = expireMinutes ?? config.expireMinutes;

   // Losing the race on ("payAmount") WHERE status = 'PENDING' is expected under
   // concurrency, not an error — draw another code and try again.
   for (let attempt = 1; attempt <= 3; attempt++) {
      const { code, payAmount } = await allocate(total, { max: config.uniqueCodeMax });
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
         await transactions.insert(trx);
         logTrx.info(`CREATE ${trx.trxId} amount=${amount} fee=${fee} code=${code} amountToPay=${payAmount}`);
         return trx;
      } catch (e) {
         if (!isUniqueViolation(e)) throw e;
         // A duplicate trxId or idempotencyKey will never resolve by retrying —
         // only a payAmount collision will.
         if (e.constraint && e.constraint !== 'idx_pending_amount') {
            throw Object.assign(new Error('trxId or idempotencyKey already exists'), {
               code: 'DUPLICATE', cause: e,
            });
         }
         if (attempt === 3) {
            throw Object.assign(new Error('amount slot contended, retry'), {
               code: 'DUPLICATE', cause: e,
            });
         }
      }
   }
}

// Both settle paths go through the DB's PENDING guard, so exactly one wins and
// fires a webhook — a payment landing as the expiry sweep runs can't double-notify.

export async function expire(trx) {
   if (trx.status !== 'PENDING') return false;
   if (!(await transactions.settle({ ...trx, status: 'EXPIRED' }))) return false;
   await webhooks.enqueue({ ...trx, status: 'EXPIRED' });
   return true;
}

async function markPaid(trx, entry = null) {
   if (trx.status !== 'PENDING') return false;
   const paid = { ...trx, status: 'PAID', paidAt: new Date().toISOString(), entry };
   if (!(await transactions.settle(paid))) {
      logTrx.warn(`${trx.trxId} already settled, skipping PAID webhook`);
      return false;
   }
   logTrx.ok(`PAID ${trx.trxId} amountToPay=${trx.payAmount}`);
   await webhooks.enqueue(paid);
   return true;
}

/**
 * Settle an overdue transaction at read time, so a status check never reports
 * PENDING for something that expired while nothing was running. Returns the
 * transaction as the caller should present it.
 */
export async function expireIfOverdue(trx) {
   if (!trx || !isOverdue(trx)) return trx;
   await expire(trx);
   return (await transactions.get(trx.trxId)) || trx;
}

/** Expire every overdue pending transaction. Part of runCycle(). */
export async function expireDue() {
   const overdue = await transactions.listExpired();
   let expired = 0;
   for (const trx of overdue) if (await expire(trx)) expired++;
   if (expired) logTrx.info(`expired ${expired} overdue trx`);
   return expired;
}

/**
 * Reconcile an incoming GoBiz payment against a pending order, then archive it.
 * Upstream sends gross_amount/100 (a float); payAmount is an integer column, so a
 * non-integral value could never match and the payment would go unreconciled.
 */
/**
 * Attach an incoming payment to an order by hand.
 *
 * The escape hatch for the one case automatic matching cannot cover: the money
 * arrived but its amount never matched any pending order — a payer who typed the
 * figure themselves, or one who paid after the order had already expired. Without
 * this the operator can see the money on the dashboard and do nothing about it.
 *
 * Deliberately allowed to revive an EXPIRED order, because the money is real.
 * Everything about it is explicit: an operator action, its own log line, and a
 * recorded amount discrepancy. Note the consumer may already have had a
 * `payment.expired` webhook for this order and will now get `payment.paid`.
 *
 * @throws {Error & { code: 'NOT_FOUND' | 'ALREADY_MATCHED' | 'ALREADY_PAID' }}
 */
export async function reconcileManually({ gobizId, trxId }) {
   const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

   const entry = await history.getById(gobizId);
   if (!entry) fail('NOT_FOUND', `payment ${gobizId} is not in the archive`);
   if (entry.matchedTrxId) {
      fail('ALREADY_MATCHED', `payment ${gobizId} is already linked to ${entry.matchedTrxId}`);
   }

   const trx = await transactions.get(trxId);
   if (!trx) fail('NOT_FOUND', `transaction ${trxId} does not exist`);
   if (trx.status === 'PAID') fail('ALREADY_PAID', `${trxId} is already PAID`);

   // Claim the payment first. If a second operator (or a double-click) got there a
   // moment ago this returns false and we stop before touching the order.
   if (!(await history.linkIfUnmatched(gobizId, trxId))) {
      fail('ALREADY_MATCHED', `payment ${gobizId} was just linked by someone else`);
   }

   const paidAt = new Date().toISOString();
   const previousStatus = trx.status;
   if (!(await transactions.forcePaid({ trxId, paidAt, entry: entry.raw ?? entry }))) {
      fail('ALREADY_PAID', `${trxId} became PAID while reconciling`);
   }

   // What the payer actually sent minus what we asked for. Non-zero is the normal
   // case here — it is why the automatic match missed — so surface it, don't hide it.
   const difference = entry.amount - trx.payAmount;
   logTrx.warn(
      `MANUAL RECONCILE ${trxId} (${previousStatus} → PAID) gobizId=${gobizId} ` +
      `received=${entry.amount} expected=${trx.payAmount} difference=${difference}`,
   );

   const paid = { ...trx, status: 'PAID', paidAt, entry: entry.raw ?? entry };
   await webhooks.enqueue(paid);

   return { trx: paid, previousStatus, received: entry.amount, difference };
}

export async function reconcile({ amount, txId, entry = null }) {
   const rupiah = Math.round(amount);
   const trx = Number.isFinite(rupiah) ? await transactions.getPendingByAmount(rupiah) : null;

   if (trx) await markPaid(trx, entry);
   else logTrx.warn(`unmatched payment Rp ${amount} (gobizId=${txId}) — archived only`);

   try {
      await history.upsert({
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
