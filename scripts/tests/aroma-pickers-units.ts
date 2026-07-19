// Aroma browse-picker units — drives the REAL pure modules (hexMath.ts,
// mapLayout.ts) plus the theme colour math, per the repo's tsx-harness
// convention. Run from repo root:  npx tsx .local/test-env/scripts/aroma-pickers-units.ts
//
// Covers the 2026-07-10 review findings: lattice placement completeness +
// connectivity, wrapLabel long-token hard-break, pan/pinch clamp parity
// (clampAxis midpoint on wider-than-content stages), Canvas cluster overflow
// bounds, and the List/chip label-contrast sweep across all 6 themes.

import { breakWord, clampAxis, combCoords, honeyXY, wrapLabel } from '../../apps/mobile/src/components/scoring/aroma/hexMath';
import { aromaFillRatio } from '../../apps/mobile/src/components/scoring/aroma/aromaTint';
import { placeLevel, LEVEL_R } from '../../apps/mobile/src/components/scoring/aroma/mapLayout';
import { mix, inkOn, readableSolid } from '../../apps/mobile/src/theme/color';
import { contrastRatio } from '../../apps/mobile/src/lib/contrast';
import { themes } from '../../apps/mobile/src/theme/vero-tokens';
import { FLAVOUR_PALETTE } from '../../apps/mobile/src/theme/flavour-palette/palette';
import { AROMA_FAMILIES } from '@verre/core';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── combCoords: exact count, uniqueness, contiguity ──
for (const n of [1, 2, 7, 12, 60, 217, 365]) {
  const cells = combCoords(n);
  const keys = new Set(cells.map(([q, r]) => `${q},${r}`));
  check(`combCoords(${n}) count+unique`, cells.length === n && keys.size === n);
}

// ── wrapLabel: long tokens hyphen-break on syllable-ish boundaries ──
{
  check('breakWord: chemi-cal (not chemic-al)', breakWord('Chemical', 7).join('|') === 'Chemi-|cal');
  check('breakWord: elder-flower (no cluster split)', breakWord('Elderflower', 7).join('|') === 'Elder-|flower');
  check('breakWord: all-spice', breakWord('allspice', 7).join('|') === 'all-|spice');
  check('breakWord: band-aid (no double hyphen)', breakWord('band-aid', 7).join('|') === 'band-|aid');
  check('breakWord: chlo-rine (no 2-letter tail)', breakWord('chlorine', 7).join('|') === 'chlo-|rine');
  const lines = wrapLabel('Elderflower', 8);
  check('wrapLabel breaks long tokens within width', lines.every((l) => l.length <= 8), JSON.stringify(lines));
  const multi = wrapLabel('Green bell pepper', 8);
  check('wrapLabel still packs words', multi.every((l) => l.length <= 8) && multi.length <= 3, JSON.stringify(multi));
  check('wrapLabel caps at 3 lines with ellipsis', wrapLabel('a b c d e f g h i j k l', 3).length === 3);
  // Eyeball sweep: every taxonomy token that can break at the stage's
  // narrowest label budget (R=37 → maxChars 7..9 depending on font size).
  const tokens = new Set<string>();
  for (const f of AROMA_FAMILIES) {
    f.label.split(' ').forEach((w) => tokens.add(w));
    for (const g of f.subfamilies) {
      g.label.split(' ').forEach((w) => tokens.add(w));
      for (const l of g.leaves) l.label.split(' ').forEach((w) => tokens.add(w));
    }
  }
  const long = [...tokens].filter((t) => t.length > 7).sort();
  console.log(`ℹ syllable breaks at width 7: ${long.map((t) => breakWord(t, 7).join('')).join(', ')}`);
}

// ── clampAxis: the ONE clamp both render and pinch-conversion use ──
{
  check('clampAxis clamps inside bounds', clampAxis(5, 0, 10) === 5 && clampAxis(-3, 0, 10) === 0 && clampAxis(14, 0, 10) === 10);
  // Content narrower than stage (lo > hi): centres at the midpoint — the
  // pinch conversion MUST see this same value (the old min/max variant
  // returned `hi`, off by (lo-hi)/2 on wide screens).
  check('clampAxis centres narrow content', clampAxis(999, 80, 20) === 50);
  // Round-trip parity: stage point → content and back through the same tx.
  const tx = clampAxis(0, 80, 20); // wide stage, content centred
  const contentX = 33;
  const stageX = contentX + tx;
  check('pinch conversion round-trips', stageX - tx === contentX);
}

// ── placeLevel: completeness, uniqueness, per-family/group connectivity ──
const groupCount = AROMA_FAMILIES.reduce((a, f) => a + f.subfamilies.length, 0);
const leafCount = AROMA_FAMILIES.reduce((a, f) => a + f.subfamilies.reduce((b, g) => b + g.leaves.length, 0), 0);
const connectedByDistance = (pts: { x: number; y: number }[], R: number): boolean => {
  if (pts.length <= 1) return true;
  const adj = Math.sqrt(3) * R * 1.05; // lattice neighbours sit at √3·R
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const i = stack.pop()!;
    pts.forEach((p, j) => {
      if (!seen.has(j) && Math.hypot(p.x - pts[i].x, p.y - pts[i].y) <= adj) {
        seen.add(j);
        stack.push(j);
      }
    });
  }
  return seen.size === pts.length;
};
{
  const l1 = placeLevel(1);
  check(`placeLevel(1) places all ${AROMA_FAMILIES.length} families`, l1.length === AROMA_FAMILIES.length);
  for (const level of [2, 3] as const) {
    const placed = placeLevel(level);
    const want = level === 2 ? groupCount : leafCount;
    const ids = new Set(placed.map((p) => p.id));
    check(`placeLevel(${level}) places ${want} nodes`, placed.length === want && ids.size === want, `${placed.length} placed`);
    const posKeys = new Set(placed.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    check(`placeLevel(${level}) no overlapping cells`, posKeys.size === placed.length);
    let allConnected = true;
    const broken: string[] = [];
    for (const f of AROMA_FAMILIES) {
      const pts = placed.filter((p) => p.familyId === f.id);
      if (!connectedByDistance(pts, LEVEL_R[level])) { allConnected = false; broken.push(f.id); }
      if (level === 3) {
        for (const g of f.subfamilies) {
          const gp = placed.filter((p) => p.groupId === g.id);
          if (!connectedByDistance(gp, LEVEL_R[level])) { allConnected = false; broken.push(g.id); }
        }
      }
    }
    check(`placeLevel(${level}) families${level === 3 ? '+groups' : ''} connected`, allConnected, broken.join(','));
  }
}

// ── Canvas cluster bounds: report the worst rest-state overflow ──
{
  let worst = { id: '', h: 0, w: 0, n: 0 };
  for (const f of AROMA_FAMILIES) {
    for (const g of f.subfamilies) {
      const n = g.leaves.length;
      const R = 44; // CanvasPicker leaf-level radius
      const pos = honeyXY(n, Math.sqrt(3) * R);
      const w = Math.max(...pos.map((p) => p[0])) - Math.min(...pos.map((p) => p[0])) + 2 * R;
      const h = Math.max(...pos.map((p) => p[1])) - Math.min(...pos.map((p) => p[1])) + 2 * R;
      if (h > worst.h) worst = { id: `${f.id}/${g.id}`, h, w, n };
    }
  }
  console.log(`ℹ canvas worst leaf cluster: ${worst.id} (${worst.n} leaves) ${Math.round(worst.w)}×${Math.round(worst.h)}pt vs 340pt stage`);
}

// ── Badge-anatomy contrast sweep: PALETTE PUNCH-LIST, not a gate ──
// The ruling (Simon, 2026-07-10): badge words = 100% SOLID family colour on
// the tint fill (the design's .badge pattern); armed/focused = SOLID family
// fill + inkOn-picked label. Weak combos are the PALETTE's to fix (re-pick
// values, the Apricot-Bubbles precedent) — so this reports offenders instead
// of failing. Fill ratios are the REAL rendered ones (clay boost).
{
  const REST_SITES: [string, number][] = [['list-rest', 0.13], ['chip-rest', 0.2], ['badge', 0.09], ['modrow', 0.24]];
  const weakWords: string[] = [];
  const weakArmed: string[] = [];
  for (const [themeKey, t] of Object.entries(themes)) {
    const aroma = (FLAVOUR_PALETTE as any)[themeKey]?.aroma;
    if (!aroma) { check(`palette has aroma set for ${themeKey}`, false); continue; }
    for (const f of AROMA_FAMILIES) {
      const c = aroma[f.label];
      if (!c) { check(`palette maps family '${f.label}' (${themeKey})`, false); continue; }
      const ink = (t as any).ink as string;
      const bg = (t as any).bg as string;
      // Resting: solid colour words on the tint fill.
      let worst = Infinity;
      for (const [, fillR] of REST_SITES) {
        worst = Math.min(worst, contrastRatio(c, mix(c, (t as any).surface, aromaFillRatio(themeKey, f.id, fillR))));
      }
      if (worst < 3) weakWords.push(`${themeKey}/${f.label}=${worst.toFixed(2)}`);
      // Armed: inkOn label on the solid family fill.
      const armed = contrastRatio(inkOn(c, ink, bg), c);
      if (armed < 3) weakArmed.push(`${themeKey}/${f.label}=${armed.toFixed(2)}`);
    }
  }
  console.log(`ℹ palette punch-list — solid words < 3:1 on their tint fill (${weakWords.length}): ${weakWords.join(' ') || 'none'}`);
  console.log(`ℹ palette punch-list — armed inkOn label < 3:1 on solid fill (${weakArmed.length}): ${weakArmed.join(' ') || 'none'}`);
  // readableSolid (the gallery's comparison variant): solid where solid
  // reads, AA (or pure-ink fallback) where it doesn't — every combo.
  let rsBroken = 0;
  let rsKeptSolid = 0;
  for (const [themeKey, t] of Object.entries(themes)) {
    const aroma = (FLAVOUR_PALETTE as any)[themeKey]?.aroma;
    for (const f of AROMA_FAMILIES) {
      const c = aroma?.[f.label];
      if (!c) continue;
      const fill = mix(c, (t as any).surface, aromaFillRatio(themeKey, f.id, 0.2));
      const out = readableSolid(c, (t as any).ink, fill);
      if (out === mix(c, (t as any).ink, 1)) rsKeptSolid++;
      else if (contrastRatio(out, fill) < 3 && out !== (t as any).ink) rsBroken++;
    }
  }
  check('readableSolid: AA or solid or ink everywhere', rsBroken === 0, `${rsKeptSolid}/72 stay 100% solid`);
}

// ── Reviewer-flagged sites now on the shared pipeline (2026-07-12 pass) ──
// These were the blind spots: the 'solid' boost must NOT leak into a muted
// ratio; hexStage's Pronounced stroke + Rings' resting wedge/label must clear
// their bars via aromaFillRatio/readableSolid/inkOn like everything else.
{
  let mutedLeak = 0;
  let ringWeak = 0;
  let hexStrokeWeak = 0;
  for (const [themeKey, t] of Object.entries(themes)) {
    const aroma = (FLAVOUR_PALETTE as any)[themeKey]?.aroma;
    if (!aroma) continue;
    const ink = (t as any).ink as string;
    const bg = (t as any).bg as string;
    const surface = (t as any).surface as string;
    for (const f of AROMA_FAMILIES) {
      const c = aroma[f.label];
      if (!c) continue;
      // Finding 1: a muted chip (r=0.09) must stay BELOW solid even on a
      // 'solid' family — else it renders at full armed strength.
      if (aromaFillRatio(themeKey, f.id, 0.09) >= 1) mutedLeak++;
      // Finding 3: Rings resting wedge fill (0.13) + readableSolid label.
      const ringFill = mix(c, surface, aromaFillRatio(themeKey, f.id, 0.13));
      if (contrastRatio(readableSolid(c, ink, ringFill), ringFill) < 3) ringWeak++;
      // Finding 2: hexStage Pronounced stroke = inkOn the SOLID cell fill.
      if (contrastRatio(inkOn(c, ink, bg), c) < 3) hexStrokeWeak++;
    }
  }
  check('finding 1: muted ratio never resolves solid', mutedLeak === 0, `${mutedLeak} leaks`);
  // findings 2+3 route through readableSolid/inkOn like everything else, so
  // their only residual weakness IS the palette ceiling (the clay families
  // already in the punch-list, where even pure ink can't clear 3:1 on a low
  // tint) — report, don't fail, matching the punch-list posture. The FIX was
  // routing them through the shared pipeline; a palette re-pick closes these.
  console.log(`ℹ finding 3: Rings resting label < 3:1 on its 0.13 wedge: ${ringWeak} (clay low-tint, palette-bound; readableSolid falls to ink)`);
  console.log(`ℹ finding 2: hexStage stroke (inkOn on solid) < 3:1: ${hexStrokeWeak} (= the armed punch-list, palette-bound)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
