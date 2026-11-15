// How a person in a moment is drawn for the viewer, given the session's
// block-pair lists (`viewerBlocksOut` = people YOU blocked, `viewerBlocksIn` =
// people who blocked you): the web's locked matrix (components/session/
// SessionPanel.tsx, WineModal `resolveProvenanceMode`), verbatim, so a person
// can't be a guest in one place and a registered person in another
// (docs/dev/block.md; leak-fixes F5):
//   - yourself                         → 'self'
//   - a guest (`a:`), a deleted account (`d:`) → 'guest'
//   - they blocked you (one way, or mutual) → 'guest' (the app's anonymous-user
//     look: user glyph, regular weight, ink-soft name, the "Unregistered" tag,
//     no Friend word, not tappable)
//   - you blocked them (one way)       → 'blocked-by-me' (the "· Blocked" marker)
//   - else                             → 'normal'
// Pure; units in scripts/tests/block-look-units.ts.
export type BlockLook = 'self' | 'normal' | 'blocked-by-me' | 'guest';

export function blockLook(
  id: string,
  myId: string,
  blocksOut: readonly string[] | null | undefined,
  blocksIn: readonly string[] | null | undefined,
): BlockLook {
  if (myId && id === myId) return 'self';
  if (!id.startsWith('u:')) return 'guest';
  if (blocksIn?.includes(id)) return 'guest';
  if (blocksOut?.includes(id)) return 'blocked-by-me';
  return 'normal';
}

// Whether a tap on this person opens their preview (the scan card, ruled
// 2026-11-15): registered people, and people YOU blocked (the card offers
// Unblock). 🔒 Never a 'guest' look: it covers real guests AND people who
// blocked you, and a tap that behaved differently for the two would tell a
// blocker from a guest (their header read is a 404). Never yourself.
export function opensPreview(look: BlockLook): boolean {
  return look === 'normal' || look === 'blocked-by-me';
}
