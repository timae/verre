import { getLocales } from 'expo-localization';

// Date/time formatting locale for the app. The app's COPY is English-only, so
// we must NOT use the raw device locale (de-DE etc.) — that would translate the
// month/weekday words ("20 Juni", "Fr."). Instead we keep English WORDS always
// and let only the regional CONVENTIONS vary: month-day + 12h for the US,
// day-month + 24h for everywhere else.
//
// So we resolve to an explicit ENGLISH tag keyed on the device region:
//   US region → "en-US"  → "Jun 20 · 7:00 PM"
//   else      → "en-GB"  → "20 Jun · 19:00"
//
// Explicit tag (never `undefined`): Hermes ships Intl but its undefined-locale
// resolution is the unreliable path on iOS; "en-US"/"en-GB" are the supported
// ones. Resolved once at module load.
const region = getLocales()[0]?.regionCode ?? null;
export const DATE_LOCALE: string = region === 'US' ? 'en-US' : 'en-GB';
