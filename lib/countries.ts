// Country data moved to @verre/core (pure, shared with native — the impression
// view needs countryName too). Re-exported here so existing `@/lib/countries`
// imports across the web app stay unchanged.
export { COUNTRIES, COUNTRY_CODES, countryName, type Country } from '@verre/core'
