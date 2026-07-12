import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path, Text as SvgText, TextPath } from 'react-native-svg';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { AROMA_FAMILIES, getAromaNode } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, inkOn, readableSolid } from '@/theme/color';
import { aromaFillRatio } from './aromaTint';
import { motion, useTheme } from '@/theme';
import { CapHint, RefineAddRow, capFirst, usePendingAdd, type AromaOps } from './parts';

// W4 · accordion rings — one of the browse picker variants (ADR-0008; the
// handoff mock is a VISUAL reference only). Three concentric half-rings —
// families / groups / notes: turn a ring to bring a wedge under the top,
// the active tier grows thick (the accordion), the HUB reads the current
// pick's full name, and the shared refine row below commits it.
//
// v5 — the design principles, settled over the device rounds:
// - THE CROP IS THE DESIGN (Simon): the wheel is deliberately OVERSIZED —
//   wider than the screen, sides bleeding past the crop — so the visible
//   top arc is BIG (the mock's 300×214 window on a 428-wide wheel). What
//   must be right is the ON-SCREEN content, and that is guaranteed by the
//   label rules below, not by shrinking the wheel.
// - NO FISHEYE: wedges are always even, so wedges and labels share one
//   static layout in the rotating layer — turning is pure rotation and
//   nothing can drift, overlap, or pop. The FULL name of the pick lives in
//   the hub as plain text (not TextPath), where length never fights arc
//   geometry.
// - LABELS EVERYWHERE ON-SCREEN: every wedge inside the visible window
//   keeps its label; labels never collide because each stays inside its
//   own wedge. Sparse rings run TANGENT text (bent along the ring, sized
//   so the 80th-percentile label fits whole, centred on the VISIBLE slice
//   of the wedge so edge neighbours keep theirs). A ring too dense for
//   readable tangent text flips to RADIAL labels while its band is thick
//   (the classic dense-aroma-wheel idiom — capacity comes from band
//   thickness, so 18-leaf rings still read full names at fs ~9–10). Only
//   a dense ring at its THIN resting width truncates hard (4-char stubs
//   at a 20° × 26u band are its honest capacity); it gains full radial
//   names the moment it is touched. The hub always reads the full pick.
// - SYNCHRONOUS phases: every gesture-terminal path snaps the ring to a
//   detent directly (no release animation, nothing asynchronous to strand).
// - Plain label paths only — rnsvg TextPath draws along MOUNT-time path
//   geometry and end-clips, so paths are React-rendered, never animated.

// The mock's crop window: wheel centre sits below the window's bottom, the
// outer radius overshoots the sides. All in "mock units", scaled by width.
const VB_W = 300;
const VB_H = 214;
const CY = 222; // wheel centre, below the window bottom
const R_MAX = 214;
const RING_GAP = 5;
const THICK = 78;
const THIN = 26;
const HOLE_MIN = 52;
const CHAR_EM = 0.68; // glyph-width estimate (em/char)
const LABEL_PAD = 4; // arc-units kept clear at each end of a label
const MIN_FS = 7; // label font floor — dense rings shrink to here, never blank

type Band = [number, number];
type Bands = { t1: Band; t2: Band; t3: Band; hole: number };

function ringBands(th1: number, th2: number, th3: number): Bands {
  'worklet';
  const ro1 = R_MAX;
  const ri1 = ro1 - th1;
  const ro2 = ri1 - RING_GAP;
  const ri2 = ro2 - th2;
  const ro3 = ri2 - RING_GAP;
  const ri3 = ro3 - th3;
  return { t1: [ri1, ro1], t2: [ri2, ro2], t3: [ri3, ro3], hole: Math.max(HOLE_MIN, ri3 - RING_GAP) };
}

function polar(r: number, deg: number): [number, number] {
  'worklet';
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}

// Annular-sector path between radii ri→ro across a0→a1 degrees. A full-turn
// span (a 1-leaf group fills its ring) is clamped a hair short — coincident
// arc endpoints render as NOTHING in SVG; the seam hides below the stage.
function wedgePath(ri: number, ro: number, a0: number, a1: number): string {
  'worklet';
  if (a1 - a0 >= 360) a1 = a0 + 359.9;
  const [x0o, y0o] = polar(ro, a0);
  const [x1o, y1o] = polar(ro, a1);
  const [x1i, y1i] = polar(ri, a1);
  const [x0i, y0i] = polar(ri, a0);
  const large = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M ${x0o.toFixed(1)} ${y0o.toFixed(1)} A ${ro} ${ro} 0 ${large} 1 ${x1o.toFixed(1)} ${y1o.toFixed(1)} L ${x1i.toFixed(1)} ${y1i.toFixed(1)} A ${ri} ${ri} 0 ${large} 0 ${x0i.toFixed(1)} ${y0i.toFixed(1)} Z`;
}

// Label arc, always authored to read left-to-right at the top (the bottom
// half, where this would invert, is below the stage).
function labelArcPath(r: number, mid: number, half: number): string {
  const [ax, ay] = polar(r, mid - half);
  const [bx, by] = polar(r, mid + half);
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

const AnimatedPath = Reanimated.createAnimatedComponent(Path);
const EASE = Easing.bezier(...motion.ease);
const mod = (n: number, m: number) => ((n % m) + m) % m;
const DEG = 180 / Math.PI;

type Ring = 1 | 2 | 3;

// One wedge: angles are plain per-commit props (even slots — the same
// numbers the labels use); only the radial band animates (the accordion).
function RingWedge({
  ring,
  a0,
  a1,
  fill,
  stroke,
  th1,
  th2,
  th3,
}: {
  ring: Ring;
  a0: number;
  a1: number;
  fill: string;
  stroke: string;
  th1: SharedValue<number>;
  th2: SharedValue<number>;
  th3: SharedValue<number>;
}) {
  const animatedProps = useAnimatedProps(() => {
    const b = ringBands(th1.value, th2.value, th3.value);
    const band = ring === 1 ? b.t1 : ring === 2 ? b.t2 : b.t3;
    return { d: wedgePath(band[0], band[1], a0, a1) };
  });
  return <AnimatedPath animatedProps={animatedProps} fill={fill} stroke={stroke} strokeWidth={2} />;
}

// Label layer: dips + fades back in while the accordion bands animate to
// meet the (instantly relocated) labels. Plain View opacity — never rnsvg
// animatedProps. Own component so each ring gets its own animated style.
function LabelFadeLayer({ fade, side, children }: { fade: SharedValue<number>; side: number; children: React.ReactNode }) {
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, top: 0, width: side, height: side }, style]}
    >
      {children}
    </Reanimated.View>
  );
}

export function RingsPicker({ ops }: { ops: AromaOps }) {
  const { theme, themeKey } = useTheme();
  const familyColor = useAromaColors();

  // Rotations (degrees, unbounded; ALWAYS on a detent at rest) + the
  // accordion thicknesses.
  const rot1 = useSharedValue(0);
  const rot2 = useSharedValue(0);
  const rot3 = useSharedValue(0);
  const th1 = useSharedValue(THICK);
  const th2 = useSharedValue(THIN);
  const th3 = useSharedValue(THIN);

  const [snap, setSnap] = useState({ s1: 0, s2: 0, s3: 0 });
  const [act, setAct] = useState<Ring>(1);
  const [turned, setTurned] = useState<Record<Ring, boolean>>({ 1: true, 2: false, 3: false });
  const [layoutW, setLayoutW] = useState(0);

  const N1 = AROMA_FAMILIES.length;
  const f1 = mod(-snap.s1, N1);
  const family = AROMA_FAMILIES[f1];
  const N2 = family.subfamilies.length;
  const f2 = mod(-snap.s2, N2);
  const sub = family.subfamilies[f2];
  const N3 = sub.leaves.length;
  const f3 = mod(-snap.s3, N3);

  const ringItems = useMemo(
    () => ({
      1: AROMA_FAMILIES.map((f) => ({ id: f.id, label: f.label, familyId: f.id })),
      2: family.subfamilies.map((s) => ({ id: s.id, label: s.label, familyId: family.id })),
      3: sub.leaves.map((l) => ({ id: l.id, label: l.label, familyId: family.id })),
    }),
    [family, sub],
  );

  const rotFor = (ring: Ring) => (ring === 1 ? rot1 : ring === 2 ? rot2 : rot3);
  const stepFor = (ring: Ring) => 360 / ringItems[ring].length;
  const tick = () => Haptics.selectionAsync();

  // ── synchronous transitions: rest is always reached in ONE commit ──
  const engage = (ring: Ring, targetIdx: number) => {
    const step = stepFor(ring);
    const rot = rotFor(ring);
    let target = -targetIdx * step;
    const cur = rot.value;
    while (target - cur > 180) target -= 360;
    while (target - cur < -180) target += 360;
    rot.value = target;
    const sv = Math.round(target / step);
    if (ring === 1) {
      rot2.value = 0;
      rot3.value = 0;
      setSnap({ s1: sv, s2: 0, s3: 0 });
      setTurned({ 1: true, 2: false, 3: false });
    } else if (ring === 2) {
      rot3.value = 0;
      setSnap((s) => ({ ...s, s2: sv, s3: 0 }));
      setTurned((t) => ({ ...t, 2: true, 3: false }));
    } else {
      setSnap((s) => ({ ...s, s3: sv }));
      setTurned((t) => ({ ...t, 3: true }));
    }
    setAct(ring);
    tick();
  };

  // Un-picking a ring hands the accordion to the deepest ring still
  // engaged — act must NEVER rest on a disengaged ring, or its band sits
  // expanded (and its labels at the expanded radius) with nothing picked
  // (the "tier 2 never shrank back / label clips into tier 1" device bug).
  const disengage = (ring: Ring) => {
    if (ring === 1) {
      rot2.value = 0;
      rot3.value = 0;
      setSnap((s) => ({ ...s, s2: 0, s3: 0 }));
      setTurned({ 1: false, 2: false, 3: false });
      setAct(1);
    } else if (ring === 2) {
      rot3.value = 0;
      setSnap((s) => ({ ...s, s3: 0 }));
      setTurned((t) => ({ ...t, 2: false, 3: false }));
      setAct(1);
    } else {
      setTurned((t) => ({ ...t, 3: false }));
      setAct(turned[2] ? 2 : 1);
    }
  };

  // First movement of a ring: it becomes the active tier and detaches the
  // rings below it (their picks are no longer meaningful under a new parent).
  const dragStart = (ring: Ring) => {
    setAct(ring);
    if (ring < 3) {
      rot3.value = 0;
      if (ring === 1) rot2.value = 0;
      setSnap((s) => (ring === 1 ? { ...s, s2: 0, s3: 0 } : { ...s, s3: 0 }));
      setTurned((t) => (ring === 1 ? { ...t, 2: false, 3: false } : { ...t, 3: false }));
    }
  };

  const endDrag = (ring: Ring) => {
    const step = stepFor(ring);
    const N = ringItems[ring].length;
    const fi = mod(-Math.round(rotFor(ring).value / step), N);
    engage(ring, fi);
  };

  // Cancelled mid-turn (scroll steal) OR a sub-threshold nudge that activated
  // the pan without turning: land on the NEAREST detent AND engage it, so the
  // ring never rests off-detent (finding 1) and act/turned never strand on a
  // never-engaged expanded band (finding 2 — the "tier 2 sits thick with
  // nothing picked" device bug re-entering through the cancel path). Engaging
  // the landed slot routes through the same engage() that sets turned + act.
  const dragAbort = (ring: Ring) => {
    const step = stepFor(ring);
    const N = ringItems[ring].length;
    const fi = mod(-Math.round(rotFor(ring).value / step), N);
    engage(ring, fi);
  };

  const endTap = (ring: Ring, ang: number) => {
    const N = ringItems[ring].length;
    const step = stepFor(ring);
    const rotVal = rotFor(ring).value;
    const fi = mod(-Math.round(rotVal / step), N);
    const idx = mod(Math.round((ang + 90 - rotVal) / step), N);
    if (idx === fi && turned[ring]) disengage(ring);
    else engage(ring, idx);
  };

  // Gesture callbacks read through a ref — an in-flight gesture never acts
  // on a stale render's closure.
  const cbRef = useRef({ dragStart, endDrag, dragAbort, endTap });
  cbRef.current = { dragStart, endDrag, dragAbort, endTap };
  const jsDragStart = useCallback((ring: number) => cbRef.current.dragStart(ring as Ring), []);
  const jsEndDrag = useCallback((ring: number) => cbRef.current.endDrag(ring as Ring), []);
  const jsDragAbort = useCallback((ring: number) => cbRef.current.dragAbort(ring as Ring), []);
  const jsEndTap = useCallback((ring: number, ang: number) => cbRef.current.endTap(ring as Ring, ang), []);

  // Live drag mirroring + the mechanical tick per detent crossing (bails on
  // values engage already wrote synchronously).
  const onSnap1 = (v: number, live: boolean) => {
    setSnap((s) => (s.s1 === v ? s : { s1: v, s2: 0, s3: 0 }));
    if (live) tick();
  };
  const onSnap2 = (v: number, live: boolean) => {
    setSnap((s) => (s.s2 === v ? s : { ...s, s2: v, s3: 0 }));
    if (live) tick();
  };
  const onSnap3 = (v: number, live: boolean) => {
    setSnap((s) => (s.s3 === v ? s : { ...s, s3: v }));
    if (live) tick();
  };
  const dragRing = useSharedValue(0);
  useAnimatedReaction(
    () => Math.round(rot1.value / (360 / N1)),
    (v, prev) => {
      if (prev !== null && v !== prev) runOnJS(onSnap1)(v, dragRing.value === 1);
    },
    [N1],
  );
  useAnimatedReaction(
    () => Math.round(rot2.value / (360 / N2)),
    (v, prev) => {
      if (prev !== null && v !== prev) runOnJS(onSnap2)(v, dragRing.value === 2);
    },
    [N2],
  );
  useAnimatedReaction(
    () => Math.round(rot3.value / (360 / N3)),
    (v, prev) => {
      if (prev !== null && v !== prev) runOnJS(onSnap3)(v, dragRing.value === 3);
    },
    [N3],
  );

  const rotStyle1 = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot1.value}deg` }] }));
  const rotStyle2 = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot2.value}deg` }] }));
  const rotStyle3 = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot3.value}deg` }] }));

  // The accordion: grow the active band, slim the others. Labels are
  // React-rendered at the TARGET radii in the same commit that changes
  // `act` (animated TextPath is broken on device — see header), so they
  // relocate instantly while the bands animate; the fade below re-settles
  // them in step with the bands instead of letting them float mid-band.
  const labelFade = useSharedValue(1);
  useEffect(() => {
    const cfg = { duration: motion.dur2, easing: EASE };
    th1.value = withTiming(act === 1 ? THICK : THIN, cfg);
    th2.value = withTiming(act === 2 ? THICK : THIN, cfg);
    th3.value = withTiming(act === 3 ? THICK : THIN, cfg);
    labelFade.value = 0.25;
    labelFade.value = withTiming(1, cfg);
  }, [act, th1, th2, th3, labelFade]);

  // ── stage geometry: the mock's oversized crop, scaled by WIDTH — the
  // wheel bleeds past the sides, the stage shows its big top arc. ──
  const scale = layoutW > 0 ? layoutW / VB_W : 0;
  const stageH = VB_H * scale;
  const centerX = layoutW / 2;
  const centerY = CY * scale;

  const targetBands = ringBands(act === 1 ? THICK : THIN, act === 2 ? THICK : THIN, act === 3 ? THICK : THIN);
  const bandFor = (ring: Ring) => (ring === 1 ? targetBands.t1 : ring === 2 ? targetBands.t2 : targetBands.t3);

  // ── gestures ──
  const lastAng = useSharedValue(0);
  const movedDeg = useSharedValue(0);
  const started = useSharedValue(0);
  // Whether the pan actually ACTIVATED (onUpdate ran ≥ once, i.e. rot moved).
  // A pure tap grabs the pan at onBegin but the Tap wins the race and onUpdate
  // never fires, so this stays 0 and finalize leaves the tap alone.
  const activated = useSharedValue(0);

  const pan = Gesture.Pan()
    .minDistance(4)
    .onBegin((e) => {
      const dx = (e.x - centerX) / scale;
      const dy = (e.y - centerY) / scale;
      const dist = Math.hypot(dx, dy);
      const b = ringBands(th1.value, th2.value, th3.value);
      let ring = 0;
      if (dist >= b.t3[0] - 3 && dist <= b.t3[1] + 3) ring = 3;
      else if (dist >= b.t2[0] - 3 && dist <= b.t2[1] + 3) ring = 2;
      else if (dist >= b.t1[0] - 3 && dist <= b.t1[1] + 3) ring = 1;
      dragRing.value = ring;
      movedDeg.value = 0;
      started.value = 0;
      activated.value = 0;
      lastAng.value = (Math.atan2(dy, dx) * 180) / Math.PI;
    })
    .onUpdate((e) => {
      const ring = dragRing.value;
      if (!ring) return;
      activated.value = 1;
      const dx = (e.x - centerX) / scale;
      const dy = (e.y - centerY) / scale;
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      let delta = ang - lastAng.value;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      lastAng.value = ang;
      movedDeg.value += Math.abs(delta);
      if (started.value === 0 && movedDeg.value > 4) {
        started.value = 1;
        runOnJS(jsDragStart)(ring);
      }
      if (ring === 1) rot1.value += delta;
      else if (ring === 2) rot2.value += delta;
      else rot3.value += delta;
    })
    .onFinalize((e) => {
      const ring = dragRing.value;
      if (!ring) return;
      dragRing.value = 0;
      // If the pan never activated (a pure tap won the race — onUpdate never
      // ran, rot untouched), leave it entirely to the Tap gesture.
      if (activated.value === 0) return;
      activated.value = 0;
      // started===1: a real turn (> 4°) — CANCELLED aborts to a detent, else
      // engage the landed slot. Activated but sub-threshold (4px..4°): rot
      // has drifted a few px off its detent and the racing Tap was cancelled,
      // so nothing else will snap it — abort to the nearest detent so the
      // ring never rests misaligned (finding 1).
      if (started.value === 1 && e.state !== State.CANCELLED) runOnJS(jsEndDrag)(ring);
      else runOnJS(jsDragAbort)(ring);
    });

  // Taps are a REAL tap gesture racing the pan — a pan cancelled by the
  // sheet's scroll must never fire as a phantom tap.
  const tapGesture = Gesture.Tap()
    .maxDuration(300)
    .maxDeltaX(8)
    .maxDeltaY(8)
    .onEnd((e, success) => {
      if (!success) return;
      const dx = (e.x - centerX) / scale;
      const dy = (e.y - centerY) / scale;
      const dist = Math.hypot(dx, dy);
      const b = ringBands(th1.value, th2.value, th3.value);
      let ring = 0;
      if (dist >= b.t3[0] - 3 && dist <= b.t3[1] + 3) ring = 3;
      else if (dist >= b.t2[0] - 3 && dist <= b.t2[1] + 3) ring = 2;
      else if (dist >= b.t1[0] - 3 && dist <= b.t1[1] + 3) ring = 1;
      if (ring > 0) runOnJS(jsEndTap)(ring, (Math.atan2(dy, dx) * 180) / Math.PI);
    });
  const gesture = Gesture.Race(pan, tapGesture);

  // The pick: the DEEPEST engaged ring's focus (any-tier). Shallower flags
  // are irrelevant once a deeper ring is engaged — turning the note ring
  // first is a valid direct pick (the old shallow-first cascade read
  // "Turn a ring" while a note wedge sat engaged under the top).
  const selId = turned[3] ? sub.leaves[f3].id : turned[2] ? sub.id : turned[1] ? family.id : null;
  const selNode = selId ? getAromaNode(selId) : undefined;
  const selTier = selNode ? (selNode.leaf ? 'note' : selNode.subfamily ? 'group' : 'family') : null;
  const pend = usePendingAdd(selId, ops);


  // ── ring layers: ONE even layout per commit for wedges AND labels ──
  const layerSide = 2 * R_MAX * scale;
  const layerLeft = centerX - layerSide / 2;
  const layerTop = centerY - layerSide / 2;

  const ringLayers = ([1, 2, 3] as const).map((ring) => {
    const itemsR = ringItems[ring];
    const N = itemsR.length;
    const step = 360 / N;
    const focusIdx = ring === 1 ? f1 : ring === 2 ? f2 : f3;
    const engaged = turned[ring];
    const band = bandFor(ring);
    const rL = (band[0] + band[1]) / 2;
    const arcPerDeg = (Math.PI / 180) * rL;
    const active = act === ring;
    const s = ring === 1 ? snap.s1 : ring === 2 ? snap.s2 : snap.s3;
    // Ring font + mode: tangent text sized so MOST labels (80th pct) fit
    // their wedge whole, floored at MIN_FS. When even the floor can't carry
    // readable tangent text (dense note rings) AND the band is thick enough
    // to beat it, the ring flips to RADIAL labels — text runs along the
    // radius, the classic dense-aroma-wheel idiom: capacity comes from band
    // THICKNESS (78u active ⇒ full names at fs ~9–10), and the angular
    // budget per label is just the text height, so EVERY wedge in the
    // window carries a full-size label no matter how many leaves share it.
    const fsBase = active ? 10 : 8.5;
    const arcU = step * arcPerDeg - LABEL_PAD * 2;
    const lens = itemsR.map((x) => x.label.length).sort((a, b) => a - b);
    const pLen = Math.max(1, lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.8))]);
    const fsTan = Math.max(MIN_FS, Math.min(fsBase, arcU / (pLen * CHAR_EM)));
    const radU = band[1] - band[0] - LABEL_PAD * 2;
    const fsRad = Math.max(MIN_FS, Math.min(fsBase, radU / (pLen * CHAR_EM)));
    const radial = fsTan < 8 && radU / (fsRad * CHAR_EM) > arcU / (fsTan * CHAR_EM) + 2;
    const fs = radial ? fsRad : fsTan;
    const rIn = band[0] + LABEL_PAD;
    const rOut = band[1] - LABEL_PAD;
    const rLabel = rL - fs * 0.35;
    const wedgeCap = Math.floor(arcU / (fs * CHAR_EM));
    const radCap = Math.floor(radU / (fs * CHAR_EM));
    // Visible angular window of this ring's labels inside the stage crop
    // (top-half angles, [-180, 0]): bounded by the stage's bottom edge and,
    // for radii wider than the stage, its sides. Radial labels span the
    // whole band, so their window keys on the band's edges.
    const edge = radial
      ? DEG *
          Math.max(
            Math.asin(Math.min(1, (CY - VB_H + 2) / rIn)),
            rOut > VB_W / 2 - 3 ? Math.acos((VB_W / 2 - 3) / rOut) : 0,
          ) +
        (fs * 0.7) / ((Math.PI / 180) * rIn)
      : DEG *
        Math.max(
          Math.asin(Math.min(1, (CY - VB_H + 2) / rLabel)),
          rLabel > VB_W / 2 - 3 ? Math.acos((VB_W / 2 - 3) / rLabel) : 0,
        );
    const winA0 = -180 + edge;
    const winA1 = -edge;
    const wedges: React.ReactNode[] = [];
    const labels: React.ReactNode[] = [];
    itemsR.forEach((it, i) => {
      // Content angles: authored so slot i sits at its at-rest world
      // position once the layer's rotation (s·step at rest) applies —
      // the focused slot lands under the top.
      const contentMid = -90 + (i - focusIdx) * step - s * step;
      const a0 = contentMid - step / 2;
      const a1 = contentMid + step / 2;
      const color = familyColor(it.familyId);
      const bold = i === focusIdx && engaged;
      // Route the resting wedge fill through the SHARED pipeline
      // (aromaFillRatio per-theme/family boosts) — a bare 0.13 mix dissolved
      // into the sheet at 1.0:1 on cobalt/Chemical & clay/Fruity (the exact
      // weakness the boost table was ruled to fix; review finding). Bold
      // (focused+engaged) stays the solid family colour.
      const restFill = mix(color, theme.surface, aromaFillRatio(themeKey, it.familyId, 0.13));
      wedges.push(
        <RingWedge
          key={`w-${it.id}`}
          ring={ring}
          a0={a0}
          a1={a1}
          fill={bold ? color : restFill}
          stroke={theme.surface}
          th1={th1}
          th2={th2}
          th3={th3}
        />,
      );
      // World angle at rest, normalized near the top half (the label rides
      // the layer; between detents it drifts a bounded half-step — accepted).
      const delta = mod((i - focusIdx) * step + 180, 360) - 180;
      const worldMid = -90 + delta;
      const name = capFirst(it.label);
      // Bold label = inkOn the solid wedge; resting = readableSolid against
      // its own resting wedge fill (the badges' font treatment — a fixed 0.68
      // ink pull measured 1.08:1 on clay/Fire; review finding).
      const labelFill = bold ? inkOn(color, theme.ink, theme.bg) : readableSolid(color, theme.ink, restFill);
      const labelOpacity = bold ? 1 : active ? 0.85 : 0.62;
      const labelFont = bold ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium';
      if (radial) {
        // Radial label: plain SvgText along the radius across the band,
        // flipped past vertical so the left half never reads upside-down.
        if (worldMid <= winA0 || worldMid >= winA1) return;
        const txt = name.length <= radCap ? name : `${name.slice(0, Math.max(1, radCap - 1))}…`;
        const [x, y] = polar((rIn + rOut) / 2, contentMid);
        const rot = contentMid + (worldMid < -90 ? 180 : 0);
        labels.push(
          <SvgText
            key={`l-${it.id}`}
            x={x}
            y={y}
            dy={fs * 0.35}
            transform={`rotate(${rot.toFixed(1)}, ${x.toFixed(1)}, ${y.toFixed(1)})`}
            fill={labelFill}
            opacity={labelOpacity}
            fontSize={fs}
            fontFamily={labelFont}
            textAnchor="middle"
          >
            {txt}
          </SvgText>,
        );
        return;
      }
      // Tangent label: centred on the VISIBLE slice of its wedge, not the
      // wedge mid — an edge wedge keeps a label hugging the crop instead of
      // losing it whole; capacity = the slice's arc, so nothing half-cuts.
      const o0 = Math.max(worldMid - step / 2, winA0);
      const o1 = Math.min(worldMid + step / 2, winA1);
      if (o1 <= o0) return;
      const availU = (o1 - o0) * arcPerDeg - LABEL_PAD * 2;
      const cap = Math.min(wedgeCap, Math.floor(availU / (fs * CHAR_EM)));
      if (cap < Math.min(4, name.length)) return;
      const txt = name.length <= cap ? name : `${name.slice(0, cap - 1)}…`;
      const tHalf = ((txt.length * fs * CHAR_EM) / 2 + 4) / arcPerDeg;
      const labelMid = contentMid + ((o0 + o1) / 2 - worldMid);
      // The label's own path must be at least as long as its text (rnsvg
      // end-clips glyphs past a path's ends — see header).
      const half = Math.min(88, Math.max(tHalf, Math.min((step / 2) * 0.96, (o1 - o0) / 2)));
      const pid = `rp${ring}s${i}`;
      labels.push(<Path key={`lp-${it.id}`} id={pid} d={labelArcPath(rLabel, labelMid, half)} fill="none" />);
      labels.push(
        <SvgText
          key={`l-${it.id}`}
          fill={labelFill}
          opacity={labelOpacity}
          fontSize={fs}
          fontFamily={labelFont}
          textAnchor="middle"
        >
          <TextPath href={`#${pid}`} startOffset="50%">
            {txt}
          </TextPath>
        </SvgText>,
      );
    });
    const rotStyle = ring === 1 ? rotStyle1 : ring === 2 ? rotStyle2 : rotStyle3;
    return (
      <Reanimated.View
        key={`ring-${ring}`}
        pointerEvents="none"
        style={[{ position: 'absolute', left: layerLeft, top: layerTop, width: layerSide, height: layerSide }, rotStyle]}
      >
        <Svg width={layerSide} height={layerSide} viewBox={`${-R_MAX} ${-R_MAX} ${2 * R_MAX} ${2 * R_MAX}`}>
          {wedges}
        </Svg>
        <LabelFadeLayer fade={labelFade} side={layerSide}>
          <Svg width={layerSide} height={layerSide} viewBox={`${-R_MAX} ${-R_MAX} ${2 * R_MAX} ${2 * R_MAX}`}>
            {labels}
          </Svg>
        </LabelFadeLayer>
      </Reanimated.View>
    );
  });

  // The hub — a PASSIVE read of the pick, plain wrapped text (never
  // TextPath): the full name always reads here regardless of arc geometry.
  const hubR = targetBands.hole * scale;

  return (
    <View style={{ gap: 10 }}>
      {/* full-bleed stage; the wheel + labels FIT inside it */}
      <View style={{ marginHorizontal: -20 }} onLayout={(e) => setLayoutW(e.nativeEvent.layout.width)}>
        {layoutW > 0 ? (
          <GestureDetector gesture={gesture}>
            <View style={{ width: layoutW, height: stageH, overflow: 'hidden' }} collapsable={false}>
              {ringLayers}
              {/* hub semicircle on the stage's bottom edge */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: centerX - hubR,
                  top: centerY - hubR,
                  width: hubR * 2,
                  height: hubR * 2,
                  borderRadius: hubR,
                  backgroundColor: theme.surfaceSunk,
                }}
              />
              {/* hub text sits INSIDE the hub's visible slice (from the hub's
                  top edge to the stage bottom) — it can never spill onto the
                  rings or below the stage. */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: centerX - hubR * 0.8,
                  top: centerY - hubR + 8,
                  width: hubR * 1.6,
                  height: Math.max(0, stageH - (centerY - hubR) - 10),
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1,
                  overflow: 'hidden',
                }}
              >
                <VText
                  surface="badge"
                  numberOfLines={2}
                  style={{
                    textAlign: 'center',
                    fontFamily: 'InstrumentSans_600SemiBold',
                    fontSize: 13.5,
                    color: selId ? theme.ink : theme.inkFaint,
                  }}
                >
                  {selId ? capFirst(getAromaNode(selId)?.label ?? '') : 'Turn a ring'}
                </VText>
                {selId && selTier ? (
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 10.5, color: theme.inkSoft }}>
                    {selTier}
                  </VText>
                ) : null}
              </View>
            </View>
          </GestureDetector>
        ) : null}
      </View>
      {/* the same refine row every picker commits through */}
      <RefineAddRow
        a={selId}
        m={pend.pendM}
        p={pend.pendP}
        added={pend.added}
        onM={pend.setPendM}
        onP={pend.togglePendP}
        onAdd={() => {
          pend.commit();
        }}
      />
      {!selId ? (
        <VText variant="small" color="inkFaint" style={{ textAlign: 'center' }}>
          Turn a ring to pick — stop at a family or group to add the whole thing.
        </VText>
      ) : null}
      <CapHint show={pend.capHit} />
    </View>
  );
}
