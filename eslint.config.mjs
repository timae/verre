import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Indirect ways to pull runtime code into a boundary file.
const noIndirectLoads = [
  { selector: "ImportExpression", message: "No dynamic import() in this file (boundary: see lib/CLAUDE.md § Per-device sessions)." },
  { selector: "CallExpression[callee.name='require']", message: "No require() in this file (boundary)." },
  { selector: "MemberExpression[property.name='require'], MemberExpression[property.value='require']", message: "No module.require / x.require in this file (boundary)." },
  { selector: "TSImportEqualsDeclaration", message: "No import = require() in this file (boundary)." },
  { selector: "ExportAllDeclaration, ExportNamedDeclaration[source]", message: "No re-exports in this file (boundary)." },
];

// Any reference to a CommonJS loader global, so an alias (`const load = require`) is caught too.
const noLoaderGlobals = ["error", ...["require", "module", "__non_webpack_require__"].map((name) => ({ name, message: "No CommonJS loader in this file (boundary)." }))];
// Only the exact compile-time expression lets the bundler drop the branch from the Edge build.
const NODEJS_BRANCH = "IfStatement[test.operator='==='][test.left.type='MemberExpression'][test.left.computed=false][test.left.property.name='NEXT_RUNTIME'][test.left.object.type='MemberExpression'][test.left.object.computed=false][test.left.object.property.name='env'][test.left.object.object.type='Identifier'][test.left.object.object.name='process'][test.right.type='Literal'][test.right.value='nodejs']";

// redis-rehydration mechanism 1 (lib/CLAUDE.md § NX/XX): `meta` and `wines` are
// written with NX to create and XX to update, so a wiped or evicted key can never
// be recreated by a stale writer, whatever lock it holds or doesn't. Any
// `.set(k.meta(…) | k.wines(…), …)` without an NX/XX option is an error. Stated
// limit: a key held in a variable evades it — write these keys inline.
const SET_META_WINES_WITHOUT_NX_XX = "CallExpression[callee.property.name='set'][arguments.0.type='CallExpression'][arguments.0.callee.object.name='k'][arguments.0.callee.property.name=/^(meta|wines)$/]:not(:has(Property[key.name=/^(NX|XX)$/]))";
const NX_XX = { selector: SET_META_WINES_WITHOUT_NX_XX, message: "s:{CODE}:meta / s:{CODE}:wines are written NX (create) or XX (update) — never a bare SET (redis-rehydration § 5.4 mechanism 1, lib/CLAUDE.md)." }

// No em dash in user-facing copy (root CLAUDE.md § Coding style): U+2014 in a
// string literal, template text or JSX text. A LONE '—' (an empty-value
// placeholder) passes only when it is the whole value: the whole literal, a
// template without substitutions, or the only child of a JSX element. A
// fragment between two expressions (`${a} — ${b}`, <p>{a} — {b}</p>) is prose.
// Comments, console.* arguments and tagged templates (SQL) are exempt. Covers
// app/, components/ and @verre/core; apps/mobile is outside this config:
// scripts/check-no-em-dash-copy.mjs is its twin (check-lint.yml).
const EM_DASH = "/\u2014/"
const LONE_EM_DASH = "/^\\s*\u2014\\s*$/"
const NO_EM_DASH_COPY = [
  `Literal[value=${EM_DASH}]:not([value=${LONE_EM_DASH}])`,
  `TemplateElement[value.cooked=${EM_DASH}]:not(TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${LONE_EM_DASH}])`,
  `JSXText[value=${EM_DASH}]:not(JSXElement[children.length=1] > JSXText[value=${LONE_EM_DASH}])`,
].map((sel) => ({
  selector: `${sel}:not(CallExpression[callee.object.name='console'] *):not(TaggedTemplateExpression *)`,
  message: "No em dash in user-facing copy: use a full stop, comma, colon or parentheses (root CLAUDE.md § Coding style).",
}))

// Web calls to /api/session* carry the web wire generation (public-user-ids
// § 6): through sessionFetch or webApiFetch (lib/sessionFetch.ts), never a bare
// fetch, or the proxy reads the call as an old tab and bounces it. A bare
// `fetch` / `window.fetch` whose URL literal or template starts with
// /api/session is an error in components/** and app/** (not app/api/**).
const SESSION_URL = "/^.api.session/"
const NO_BARE_SESSION_FETCH = [
  `CallExpression[callee.name='fetch'][arguments.0.value=${SESSION_URL}]`,
  `CallExpression[callee.name='fetch'][arguments.0.quasis.0.value.cooked=${SESSION_URL}]`,
  `CallExpression[callee.property.name='fetch'][arguments.0.value=${SESSION_URL}]`,
  `CallExpression[callee.property.name='fetch'][arguments.0.quasis.0.value.cooked=${SESSION_URL}]`,
].map((selector) => ({
  selector,
  message: "Call /api/session* through sessionFetch or webApiFetch (lib/sessionFetch.ts): they send X-Verre-Web, without which the proxy bounces the call (public-user-ids § 6).",
}))

// The entrance gate (leak-fixes F2, lib/sessionRoute.ts): a moment route opens
// a moment ONLY through openSessionFor / openAsParticipant (the join page
// through openSessionCharged), which charge a wrong code and refuse a spent
// stranger before anything else runs. Every export of lib/sessionRehydrate
// that opens or rebuilds a moment is refused in app/**, by name (an alias
// can't dodge it) for the `@/` path AND any relative path; the helpers routes
// still need (contractFailure, unavailable, …) stay importable.
const OPENERS = ["openSession", "ensureSessionLive", "loadLiveWines", "rehydrateSession"]
const OPEN_MESSAGE = "Open a moment through the entrance gate: openSessionFor / openAsParticipant (lib/sessionRoute.ts), never lib/sessionRehydrate's openers (leak-fixes F2, app/api/CLAUDE.md)."
const NO_UNGATED_OPEN = ["error", {
  paths: [{ name: "@/lib/sessionRehydrate", importNames: OPENERS, message: OPEN_MESSAGE }],
  patterns: [{ group: ["**/lib/sessionRehydrate", "**/lib/sessionRehydrate.ts"], importNames: OPENERS, message: OPEN_MESSAGE }],
}]

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  // eslint-plugin-react-hooks 7 (arrived with eslint-config-next 16) reports React
  // Compiler diagnostics as errors. The flagged code predates them, and fixing it
  // means changing render/effect timing, including the frozen web touch code
  // (WineModal, usePullToSwap). Warnings until the React Compiler / web redesign
  // decision (docs/dev/proposals/dependency-upgrades.md §8). Only the rules that
  // fire are relaxed; every other compiler rule stays an error for new code.
  {
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // Since Next 16 the proxy runs on Node and Turbopack only warns about Node
  // modules in instrumentation's Edge entry, so Prisma / bcrypt / the full
  // auth.ts reaching these files no longer fails the build. These allowlists
  // are the replacement tripwire (lib/CLAUDE.md, app/CLAUDE.md).
  {
    files: ["proxy.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportDeclaration[importKind!='type'][source.value!=/^(next-auth|next-auth.jwt|@.auth[.]config|@.lib.clientVersion)$/]", message: "proxy.ts may import only next-auth, next-auth/jwt, @/auth.config and @/lib/clientVersion: JWT decode only, never auth.ts, Prisma or bcrypt (lib/CLAUDE.md)." },
        ...noIndirectLoads],
      "no-restricted-globals": noLoaderGlobals,
    },
  },
  {
    files: ["auth.config.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportDeclaration[importKind!='type']", message: "auth.config.ts is the proxy's whole dependency graph: `import type` only (lib/CLAUDE.md)." },
        ...noIndirectLoads],
      "no-restricted-globals": noLoaderGlobals,
    },
  },
  {
    files: ["instrumentation.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportDeclaration[importKind!='type']", message: "No static imports in instrumentation.ts: they are bundled for Edge (app/CLAUDE.md). Use a dynamic import inside the NEXT_RUNTIME === 'nodejs' branch." },
        { selector: `ImportExpression:not(${NODEJS_BRANCH} > .consequent ImportExpression)`, message: "Dynamic imports in instrumentation.ts belong inside `if (process.env.NEXT_RUNTIME === 'nodejs')` (app/CLAUDE.md)." },
        { selector: "Identifier[name='process']:not(MemberExpression > .object)", message: "Use `process` only as `process.env…` here, so the NEXT_RUNTIME guard is the real compile-time one (no shadowing or aliasing)." },
        ...noIndirectLoads.slice(1)],
      "no-restricted-globals": noLoaderGlobals,
    },
  },
  // One block per file set: a later block's no-restricted-syntax REPLACES an
  // earlier one's options, so app/** carries both rules in one list.
  {
    files: ["lib/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", NX_XX] },
  },
  {
    // AFTER lib/** (a later block's no-restricted-syntax replaces it). In the
    // proxy's graph since public user ids (the version floor runs on
    // every /api call): no runtime imports at all.
    files: ["lib/clientVersion.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportDeclaration[importKind!='type']", message: "lib/clientVersion.ts is in the proxy's dependency graph: `import type` only (lib/CLAUDE.md)." },
        NX_XX,
        ...noIndirectLoads],
      "no-restricted-globals": noLoaderGlobals,
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", NX_XX, ...NO_EM_DASH_COPY], "no-restricted-imports": NO_UNGATED_OPEN },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/api/**"],
    rules: { "no-restricted-syntax": ["error", NX_XX, ...NO_EM_DASH_COPY, ...NO_BARE_SESSION_FETCH], "no-restricted-imports": NO_UNGATED_OPEN },
  },
  {
    files: ["components/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_EM_DASH_COPY, ...NO_BARE_SESSION_FETCH] },
  },
  {
    files: ["packages/core/src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_EM_DASH_COPY] },
  },
  // apps/mobile is its own workspace (expo lint); the rest are gitignored build/scratch output.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "apps/**", "ios/**", ".local/**", ".expo/**", ".claude/**"]),
]);
