import crc from 'crc';

const CRC_LEN = 4;
const INVALID = 'Invalid QRIS_STRING format';

/** Trailing CRC16-CCITT checksum of a QRIS payload, uppercase hex, 4 chars. */
export function crc16(payload) {
   const sum = crc.crc16ccitt(Buffer.from(payload, 'utf8')).toString(16).toUpperCase();
   return sum.padStart(CRC_LEN, '0').slice(-CRC_LEN);
}

/**
 * Split an EMVCo payload into [tag, value] pairs: 2-digit tag, 2-digit length,
 * value. Throws on anything that does not tile exactly, which is what a truncated
 * or mangled QRIS_STRING looks like.
 */
function parseTlv(s) {
   const fields = [];
   for (let i = 0; i < s.length;) {
      const head = s.slice(i, i + 4);
      const len = Number(head.slice(2));
      if (!/^\d{4}$/.test(head) || i + 4 + len > s.length) throw new Error(INVALID);
      fields.push([head.slice(0, 2), s.slice(i + 4, i + 4 + len)]);
      i += 4 + len;
   }
   return fields;
}

const tlv = ([tag, value]) => tag + String(value.length).padStart(2, '0') + value;

/**
 * Turn a merchant's static QRIS into a dynamic one carrying a fixed amount.
 *
 * Parsed field by field rather than by string search: "010211" or "5802ID" can
 * also occur inside another field's value, and a static string that already has
 * an amount (tag 54) must have it replaced, not duplicated. The amount goes in
 * tag order, before the country tag, and the whole payload is re-checksummed.
 */
export function buildDynamicQris(staticQris, amount) {
   if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('QRIS amount must be a positive integer');
   }
   const fields = parseTlv(String(staticQris).trim())
      .filter(([tag]) => tag !== '54' && tag !== '63') // old amount, old checksum
      .map(([tag, value]) => [tag, tag === '01' ? '12' : value]); // 12 = dynamic

   if (!fields.some(([tag]) => tag === '58')) throw new Error(INVALID);
   const at = fields.findIndex(([tag]) => Number(tag) > 54);
   fields.splice(at, 0, ['54', String(amount)]);

   const payload = fields.map(tlv).join('') + '6304';
   return payload + crc16(payload);
}
