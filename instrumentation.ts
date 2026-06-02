// Next.js instrumentation hook — runs once when the server process starts, in
// EVERY runtime (Node + Edge). Keep this file runtime-agnostic: it must NOT
// statically or dynamically pull in Node-only modules, or webpack tries to
// bundle them for the Edge runtime and the build fails (UnhandledSchemeError on
// node:fs etc.). The geo boot work (fs / S3 / child_process) therefore lives in
// instrumentation-node.ts, imported ONLY inside the nodejs branch so the
// bundler keeps it out of the Edge graph.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node').then((m) => m.register())
  }
}
