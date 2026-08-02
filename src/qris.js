import crc from 'crc';

const CRC_LEN = 4;
const COUNTRY_TAG = '5802ID';
const STATIC_INDICATOR = '010211';
const DYNAMIC_INDICATOR = '010212';

/** Trailing CRC16-CCITT checksum of a QRIS payload, uppercase hex, 4 chars. */
export function crc16(payload) {
   const sum = crc.crc16ccitt(Buffer.from(payload, 'utf8')).toString(16).toUpperCase();
   return sum.padStart(CRC_LEN, '0').slice(-CRC_LEN);
}

/**
 * Turn a merchant's static QRIS into a dynamic one carrying a fixed amount.
 * The amount goes in tag 54 (transaction amount) before the country tag, and the
 * whole payload is re-checksummed.
 */
export function buildDynamicQris(staticQris, amount) {
   if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('QRIS amount must be a positive integer');
   }
   const body = staticQris.endsWith('6304') ? staticQris : staticQris.slice(0, -CRC_LEN);
   const dynamic = body.replace(STATIC_INDICATOR, DYNAMIC_INDICATOR);
   if (!dynamic.includes(COUNTRY_TAG)) throw new Error('Invalid QRIS_STRING format');

   const [before, after] = dynamic.split(COUNTRY_TAG);
   const digits = String(amount);
   const amountTag = `54${String(digits.length).padStart(2, '0')}${digits}`;
   const payload = before + amountTag + COUNTRY_TAG + after;
   return payload + crc16(payload);
}
