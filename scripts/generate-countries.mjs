// Regenerate `lib/countries.ts` from the ISO 3166-1 alpha-2 list,
// pulling English display names from `Intl.DisplayNames`.
//
// Usage:  node scripts/generate-countries.mjs > lib/countries.ts
//
// When to run:
//   - ISO assigns a new alpha-2 code (rare — most recently RS/ME in 2006,
//     SS in 2011, SX/BQ/CW in 2010, AX in 2004).
//   - A country's display name changes (e.g. Turkey → Türkiye in 2022).
//   - The pinned Intl.DisplayNames data shifts and you want to refresh.
//
// The `TW` entry is overridden to "Taiwan" because Intl's value varies
// across browsers and locales ("Taïwan", "Taiwan (Province of China)")
// and we want a stable, neutral display label.
//
// The codes list below is the current ISO 3166-1 alpha-2 set. Update it
// by hand when new codes are assigned — Intl.DisplayNames will return
// the code itself (e.g. `'XK'` for Kosovo, not officially ISO yet) if
// you list one it doesn't know, and the filter at the bottom drops
// those rows so the embedded list only contains entries with a real
// English name.

const codes = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS',
  'YE','YT',
  'ZA','ZM','ZW',
]

const dn = new Intl.DisplayNames(['en'], { type: 'region' })

const entries = codes
  .map(code => ({
    code,
    name: code === 'TW' ? 'Taiwan' : (dn.of(code) || code),
  }))
  // Drop any code without a real English name (Intl returns the code
  // itself as fallback — those rows would be useless in the UI).
  .filter(e => e.name !== e.code)
  .sort((a, b) => a.name.localeCompare(b.name))

const header = `// ISO 3166-1 alpha-2 country list with English display names.
//
// Generated once via \`Intl.DisplayNames(['en'], { type: 'region' })\` and
// embedded here as a static array so we don't re-derive on every render.
// \`TW\` is overridden to "Taiwan" — Intl's value can vary across browsers
// and locales ("Taïwan", "Taiwan (Province of China)") and we want a
// stable display label.
//
// To regenerate this list when the ISO assignments change:
//   node scripts/generate-countries.mjs > lib/countries.ts
//
// \`COUNTRY_CODES\` is a Set of the alpha-2 codes for O(1) server-side
// validation. \`countryName(code)\` returns the English display name for
// a given code, or undefined if not in the list.

export type Country = { code: string; name: string }

export const COUNTRIES: Country[] = [
`

const body = entries
  .map(e => `  { code: ${JSON.stringify(e.code)}, name: ${JSON.stringify(e.name)} },`)
  .join('\n')

const footer = `
]

export const COUNTRY_CODES = new Set<string>(COUNTRIES.map(c => c.code))

export function countryName(code: string | null | undefined): string | undefined {
  if (!code) return undefined
  return COUNTRIES.find(c => c.code === code)?.name
}
`

process.stdout.write(header + body + footer)
