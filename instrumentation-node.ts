// Node-runtime-only instrumentation. Split out from instrumentation.ts (which
// is analyzed for BOTH the Node and Edge runtimes) so the Node-only imports it
// pulls in — lib/geoData.ts → node:fs / node:path / node:child_process — are
// never traced into the Edge bundle. Without this split the build fails with
// `UnhandledSchemeError: Reading from "node:fs"`, because webpack bundles a
// dynamically-imported module for every runtime instrumentation runs in,
// regardless of the runtime guard. instrumentation.ts only imports THIS file
// inside its `NEXT_RUNTIME === 'nodejs'` branch, so webpack keeps it Node-only.
//
// See https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
// (conditional-import-by-runtime pattern).
import { ensureGeoData } from '@/lib/geoData'

export async function register() {
  await ensureGeoData()
}
