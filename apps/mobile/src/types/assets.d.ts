// Bundled static assets (Metro resolves these to an opaque asset-module id).
// expo/types declares CSS modules only, so image imports need this shim.
declare module '*.jpg' {
  const source: number;
  export default source;
}
declare module '*.png' {
  const source: number;
  export default source;
}
