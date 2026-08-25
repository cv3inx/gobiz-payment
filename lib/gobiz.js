/**
 * GoBiz (GoPay Merchant) client.
 *
 * Serverless-shaped: no child processes, no local cache file, no polling loop.
 * The access token and merchant id are cached in the database, because a Vercel
 * function has no writable disk and no memory that survives an invocation — a
 * per-invocation login would get the account rate-limited within minutes.
 *
 * Adapted from kavionn/gobiz-payment.
 */
import moment from 'moment-timezone';
import crypto from 'node:crypto';
import { log } from '../src/logger.js';
import * as meta from '../src/db/meta.js';

const logMerchant = log('merchant');
const logAuth = log('auth');

const BASE_URL = 'https://api.gobiz.co.id';
const ANALYTICS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';
const CLIENT_ID = 'go-biz-web-new';
const CACHE_KEY = 'gobiz.cache';
const TZ = process.env.TZ_NAME || 'Asia/Jakarta';

/** Statuses that mean money actually arrived. Refunds must never look like a payin. */
const PAYIN_STATUSES = ['SETTLEMENT', 'CAPTURE'];
const PAYMENT_TYPES = ['QRIS', 'GOPAY', 'OFFLINE_CREDIT_CARD', 'OFFLINE_DEBIT_CARD', 'CREDIT_CARD'];

/** Cooldown after a failed login — GoBiz rate-limits for ~15 min. */
const LOGIN_COOLDOWN_MS = 15 * 60_000;

const readCache = async () => (await meta.get(CACHE_KEY)) || {};
const writeCache = (fields) => meta.patch(CACHE_KEY, fields);

function getAuthHeaders(uniqueId, accessToken) {
   return {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'id',
      'Authentication-Type': 'go-id',
      'Authorization': accessToken ? `Bearer ${accessToken}` : 'Bearer',
      'Content-Type': 'application/json',
      'Gojek-Country-Code': 'ID',
      'Gojek-Timezone': 'Asia/Jakarta',
      'Origin': 'https://portal.gofoodmerchant.co.id',
      'Referer': 'https://portal.gofoodmerchant.co.id/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'X-AppVersion': 'platform-v3.107.0-94ce5d57',
      'X-PhoneMake': 'Windows 10 64-bit',
      'X-PhoneModel': 'Chrome 149.0.0.0 on Windows 10 64-bit',
      'X-Platform': 'Web',
      'X-User-Locale': 'en-US',
      'X-User-Type': 'merchant',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-DeviceOS': 'Web',
      'x-appId': 'go-biz-web-dashboard',
      'x-uniqueid': uniqueId,
   };
}

/** POST JSON with a hard timeout, returning the parsed body whatever the status. */
async function postJson(url, headers, payload, timeoutMs = 15_000) {
   const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
   });
   const text = await res.text();
   let body;
   try {
      body = JSON.parse(text);
   } catch {
      throw new Error(`Respons GoBiz bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
   }
   return { status: res.status, ok: res.ok, body };
}

async function loginWithPassword(email, password) {
   const headers = getAuthHeaders(crypto.randomUUID());

   logAuth.info(`Memvalidasi email: ${email}`);
   const validation = await postJson(`${BASE_URL}/goid/login/request`, headers, {
      email, login_type: 'password', client_id: CLIENT_ID,
   });

   if (validation.body.errors?.length > 0) {
      const msg = validation.body.errors[0].message || '';
      logAuth.warn(`Peringatan validasi email: ${msg}`);
      // Rate-limited at the validation step → the token request will also fail
      // AND deepen the ban. Bail out now instead of pushing another request.
      if (/terlalu banyak|too many|rate.?limit|coba lagi|try again/i.test(msg)) {
         throw new Error(`Login dibatalkan — rate-limit di validasi email: ${msg}`);
      }
   }

   logAuth.info('Mengirim kredensial login...');
   const token = await postJson(`${BASE_URL}/goid/token`, headers, {
      client_id: CLIENT_ID,
      grant_type: 'password',
      data: { email, password },
   });

   if (token.body.errors?.length > 0) {
      throw new Error(`Login gagal: ${token.body.errors[0].message || 'Password salah atau akun bermasalah'}`);
   }
   if (!token.body.access_token) {
      throw new Error(`Login gagal: GoBiz tidak mengembalikan access_token (HTTP ${token.status})`);
   }
   return token.body.access_token;
}

export default class GoPayMerchant {
   constructor(options = {}) {
      this.token = options.token || null;
      this.merchantId = options.merchantId || null;
      this._initialized = false;
   }

   /**
    * Probe the token. Three-valued on purpose: a 429 or a 5xx says nothing about
    * whether the token is good, and treating it as "invalid" would trigger a
    * login that deepens an existing rate-limit.
    * @returns {Promise<'valid'|'invalid'|'unknown'>}
    */
   async tokenState(token) {
      if (!token) return 'invalid';
      try {
         const res = await postJson(
            `${BASE_URL}/v1/merchants/search`,
            getAuthHeaders(crypto.randomUUID(), token),
            { from: 0, to: 1, _source: ['id'] },
         );
         if (res.status === 401 || res.status === 403) return 'invalid';
         return res.ok ? 'valid' : 'unknown';
      } catch {
         return 'unknown';
      }
   }

   /** Back-compat shape for the health probe: only an explicit 'invalid' is false. */
   async _isTokenValid(token) {
      return (await this.tokenState(token)) !== 'invalid';
   }

   async _doLogin() {
      const email = process.env.GOPAY_EMAIL;
      const password = process.env.GOPAY_PASSWORD;
      if (!email || !password) {
         throw new Error('[GoPayMerchant] GOPAY_EMAIL/GOPAY_PASSWORD belum diisi');
      }

      const cache = await readCache();
      if (cache.loginCooldownUntil && Date.now() < cache.loginCooldownUntil) {
         const waitS = Math.ceil((cache.loginCooldownUntil - Date.now()) / 1000);
         throw new Error(
            `[GoPayMerchant] Login di-cooldown ${waitS}s (rate-limit / kredensial salah). Perbaiki env lalu deploy ulang.`,
         );
      }

      logMerchant.info(`Login otomatis sebagai: ${email}`);
      try {
         this.token = await loginWithPassword(email, password);
      } catch (e) {
         // Persisted, not in-memory: the next invocation is a different instance
         // and would otherwise retry immediately and deepen the ban.
         await writeCache({ loginCooldownUntil: Date.now() + LOGIN_COOLDOWN_MS });
         throw e;
      }
      await writeCache({ token: this.token, loginCooldownUntil: null });
      logMerchant.ok('Login berhasil, token disimpan.');
   }

   async _detectMerchantId() {
      logMerchant.info('Mendeteksi Merchant ID...');
      const res = await postJson(
         `${BASE_URL}/v1/merchants/search`,
         getAuthHeaders(crypto.randomUUID(), this.token),
         { from: 0, to: 50, _source: ['id', 'merchant_name'] },
      );
      if (!res.ok) {
         throw new Error(`Gagal mengambil list merchant (${res.status}): ${res.body?.errors?.[0]?.message || 'Gagal autentikasi'}`);
      }

      const data = res.body;
      const list = Array.isArray(data) ? data
         : Array.isArray(data?.merchants) ? data.merchants
         : Array.isArray(data?.hits?.hits) ? data.hits.hits.map((h) => h._source || h)
         : Array.isArray(data?.hits) ? data.hits
         : Array.isArray(data?.data) ? data.data
         : [];

      if (!list.length) throw new Error('[GoPayMerchant] Tidak ada merchant terasosiasi dengan akun ini.');

      this.merchantId = list[0].id || list[0].merchant_id;
      logMerchant.ok(`Menggunakan merchant: ${list[0].merchant_name || 'Tidak diketahui'} (ID: ${this.merchantId})`);
      await writeCache({ merchantId: this.merchantId });
   }

   async init() {
      if (this._initialized) return;
      const cache = await readCache();

      if (!this.token && cache.token) {
         this.token = cache.token;
         logMerchant.info('Token dimuat dari cache.');
      }

      // A cached token may be newer than the one passed in via env.
      if (this.token && cache.token && this.token !== cache.token
          && (await this.tokenState(this.token)) === 'invalid') {
         logMerchant.info('Token utama invalid, mencoba token dari cache...');
         this.token = cache.token;
      }

      if ((await this.tokenState(this.token)) === 'invalid') {
         logMerchant.info('Token tidak valid atau belum ada, login ulang...');
         await this._doLogin();
      }

      if (!this.merchantId) this.merchantId = cache.merchantId || null;
      if (!this.merchantId) await this._detectMerchantId();

      this._initialized = true;
   }

   /**
    * When the login cooldown lifts (epoch ms), or null if there is none.
    *
    * Surfaced so the dashboard can show a countdown and disable "check now":
    * retrying login during a GoBiz rate-limit is what deepens the ban, and an
    * operator staring at "session down" has no other way to learn that waiting is
    * the fix.
    */
   async loginCooldownUntil() {
      const { loginCooldownUntil: until } = await readCache();
      return until && until > Date.now() ? until : null;
   }

   /** Drop the cached token so the next init() logs in again. */
   async invalidateToken() {
      this.token = null;
      this._initialized = false;
      await writeCache({ token: null });
   }

   /**
    * Incoming transactions, newest first.
    *
    * Only settled payins — REFUND and PARTIAL_REFUND are deliberately excluded.
    * They carry a positive gross_amount, so including them would let a refund
    * whose value happens to equal a pending order's payable amount mark that
    * order PAID.
    */
   async getHistory({ days = 1, size = 50 } = {}) {
      await this.init();

      const analytics = await this._fetchAnalytics({ days, size });
      if (Array.isArray(analytics?.transactions)) return this._normalize(analytics.transactions);

      // The analytics endpoint is undocumented and has changed shape before. The
      // journal search returns the same transactions the long way round.
      logMerchant.warn('Analytics tidak mengembalikan transactions[], fallback ke journal.');
      const journal = await this._fetchJournal({ days, size });
      const nested = Array.isArray(journal?.data)
         ? journal.data.map((item) => item.metadata?.transaction).filter(Boolean)
         : [];
      return this._normalize(nested);
   }

   /** Upstream rows → the flat shape the reconciler consumes. */
   _normalize(transactions) {
      return transactions
         .filter((tx) => PAYIN_STATUSES.includes(String(tx.status || '').toUpperCase()))
         .map((tx) => ({
            gobizId: String(tx.transaction_id ?? tx.id ?? tx.order_id ?? `${tx.transaction_time}_${tx.gross_amount}`),
            // Upstream reports cents.
            amount: typeof tx.gross_amount === 'number' ? tx.gross_amount / 100 : Number.NaN,
            time: tx.transaction_time
               ? moment(tx.transaction_time).tz(TZ).locale('id').format('DD MMM YYYY - HH:mm:ss')
               : null,
            raw: tx,
         }));
   }

   async _fetchAnalytics({ days, size }) {
      const url = new URL(ANALYTICS_URL);
      url.searchParams.set('from', '0');
      url.searchParams.set('size', String(size));
      url.searchParams.set('statuses', PAYIN_STATUSES.join(','));
      url.searchParams.set('payment_types', PAYMENT_TYPES.join(','));
      url.searchParams.set('start_time', moment().tz(TZ).subtract(days, 'days').toISOString());
      url.searchParams.set('end_time', moment().tz(TZ).toISOString());
      url.searchParams.set('merchant_ids', this.merchantId);

      const send = () => fetch(url, {
         method: 'GET',
         headers: {
            accept: 'application/json, text/plain, */*',
            'authentication-type': 'go-id',
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
         },
         signal: AbortSignal.timeout(15_000),
      });

      let res = await send();
      if (res.status === 401) {
         logMerchant.info('Token expired, login ulang...');
         await this.invalidateToken();
         await this.init();
         res = await send();
      }
      if (!res.ok) throw new Error(`HTTP Error Analytics: ${res.status} ${res.statusText}`);
      return res.json();
   }

   /** Fallback source. Same transactions, wrapped in journal entries. */
   async _fetchJournal({ days, size }) {
      const body = {
         from: 0,
         size,
         sort: { time: { order: 'desc' } },
         included_categories: { incoming: ['transaction_share', 'action'] },
         query: [{
            op: 'and',
            clauses: [
               {
                  op: 'not',
                  clauses: [{
                     op: 'or',
                     clauses: [
                        { field: 'metadata.source', op: 'in', value: ['GOSAVE_ONLINE', 'GoSave', 'GODEALS_ONLINE'] },
                        { field: 'metadata.gopay.source', op: 'in', value: ['GOSAVE_ONLINE', 'GoSave', 'GODEALS_ONLINE'] },
                     ],
                  }],
               },
               {
                  field: 'metadata.transaction.status',
                  op: 'in',
                  value: PAYIN_STATUSES.map((s) => s.toLowerCase()),
               },
               {
                  field: 'metadata.transaction.payment_type',
                  op: 'in',
                  value: PAYMENT_TYPES.map((t) => t.toLowerCase()),
               },
               { field: 'metadata.transaction.transaction_time', op: 'gte', value: moment().tz(TZ).subtract(days, 'days').toISOString() },
               { field: 'metadata.transaction.transaction_time', op: 'lte', value: moment().tz(TZ).toISOString() },
               { field: 'metadata.transaction.merchant_id', op: 'equal', value: this.merchantId },
            ],
         }],
      };

      const res = await postJson(
         `${BASE_URL}/journals/search`,
         {
            ...getAuthHeaders(crypto.randomUUID(), this.token),
            accept: 'application/json, text/plain, */*, application/vnd.journal.v1+json',
         },
         body,
      );
      if (!res.ok) throw new Error(`HTTP Error Journal: ${res.status}`);
      return res.body;
   }
}
