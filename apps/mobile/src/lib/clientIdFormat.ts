// A client-minted id for a new bottle (the session wine POST's `id`, a
// check-in's `occurrenceId`): 21 characters of the server's `[A-Za-z0-9_-]`
// (lib/occurrences.ts `CLIENT_ID`), the nanoid shape. Pure, so the units can
// pin it (scripts/tests/catalog-choice-units.ts); `newClientId` (clientId.ts)
// feeds it two native v4 UUIDs. A UUID v4 is 122 random bits from the
// system's secure generator; the version nibble and the variant nibble are
// dropped, leaving 30 random hex digits each, 240 bits for the 126 needed.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function clientIdFromUuids(a: string, b: string): string {
  if (!UUID.test(a) || !UUID.test(b)) throw new Error('two v4 UUIDs required');
  const hex = [a, b].map((u) => { const h = u.replace(/-/g, '').toLowerCase(); return h.slice(0, 12) + h.slice(13, 16) + h.slice(17); }).join('');
  let bits = '';
  for (const c of hex) bits += parseInt(c, 16).toString(2).padStart(4, '0');
  let out = '';
  for (let i = 0; i < 21; i++) out += ALPHABET[parseInt(bits.slice(i * 6, i * 6 + 6), 2)];
  return out;
}
