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
        { selector: "ImportDeclaration[importKind!='type'][source.value!=/^(next-auth|@.auth[.]config)$/]", message: "proxy.ts may import only next-auth and @/auth.config: JWT presence only, never auth.ts, Prisma or bcrypt (lib/CLAUDE.md)." },
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
  // apps/mobile is its own workspace (expo lint); the rest are gitignored build/scratch output.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "apps/**", "ios/**", ".local/**", ".expo/**", ".claude/**"]),
]);
