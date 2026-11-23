// Every incoming system URL passes here BEFORE routing (expo-router hands the
// RAW URL on both paths: warm `link/linking.js`, cold `getLinkingConfig.js`).
// 🔒 A look-in link (`io.verre.app://l/<id>.<token>`, the `/l/` web page's
// "Open in Verre") is taken OUT of routing so its token never becomes a route
// param (Moment Visibility step-2 plan T5): lib/lookInLinks.ts keeps it in
// memory and the opener (lib/usePendingLookIn.ts) opens the look-in itself.
// The logic lives in lib/lookInLinks.ts (unit-tested there).
export { redirectLookInPath as redirectSystemPath } from '@/lib/lookInLinks';
