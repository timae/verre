// Tier 2 compare-aroma strip + the ruled contributor popover (compare §9).
// The compact aroma headline on the 02d compare card's expanded body. Two modes,
// both derived in the ONE CompareAromaModel the parent computes (aromaCompareView):
// with agreement it's the consensus primaries+secondaries; without, the flat
// union fallback ("Aromas mentioned" / "Aromas"). Chips are tappable in both
// modes — agreement chips open the Badge-Extension popover (the focused badge
// covers the trigger + overlaps 50% into a neutral surface), union chips the
// simpler contributor popover. "Aroma Details" and the popover's "+N more" open
// the Tier 3 detail sheet; the popover's tappable "Perceived by …" row (with
// its trailing chevron) opens it on the People tab filtered to the aroma
// (slice 3d — the staged viewContributorsRoute, rendered at last).
//
// This file is a thin renderer: every derivation (strip content, popover
// contents, mode fork, pack, pill colours, sheet sizing) is pure +
// harness-pinned in aromaCompareView.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, useWindowDimensions, View, type LayoutRectangle } from 'react-native'
import {
  popoverContent, unionPopoverContent, packStrip, detailPillColors, stripChipMeasureKey, STRIP_GAP, PRON_BAR,
  type AromaRef, type CompareAromaModel, type StripChip, type PopoverContent, type UnionPopoverContent,
} from './aromaCompareView'
import { AromaChip, badgeVMetrics } from '@/components/scoring/aroma/parts'
import { Icon } from '@/components/ui/Icon'
import { VText } from '@/components/ui/VText'
import { usePhoneTokens } from '@/lib/layout'
import { useTheme } from '@/theme'
import { AromaBadgePopover, AromaPopoverPeople } from './AromaBadgePopover'

// Pre-measure bound for the (invisible) strip row: ≈ two packed chip lines at
// the largest badge scale. Keeps the card from briefly expanding to the full
// unpacked height and snapping back once measurement lands.
const PREMEASURE_MAX_H = 68

type ChipRect = { x: number; y: number; width: number; height: number }
type MeasureChip = (onMeasure: (rect: ChipRect) => void) => void
const sameRect = (a: ChipRect, b: ChipRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// ── the "Aroma Details" tail pill ──────────────────────────────────────────────
// The moments-filter activated-chip look at the aroma badges' anatomy
// (badgeVMetrics vPad 0, label 13.5). Colours come from the PURE, per-theme-
// pinned detailPillColors ladder (accent-on-tint → ink-on-tint → solid accent —
// clay needs the solid rung). The "+" is a TEXT sibling at 15 in a centered row
// (a nested baseline-aligned span sat visually HIGH — device round, Simon
// 2026-07-15); the 1pt nudge drops it onto the label's optical center. The 1px
// border is inset from the padding so the pill's outer height matches the
// borderless chips beside it.
function AromaDetailPill({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme()
  const { padV, lineH } = badgeVMetrics(0)
  const colors = useMemo(() => detailPillColors(theme), [theme])
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Aroma Details"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        justifyContent: 'center',
        paddingVertical: padV + 1.5 - 1, // border inset — outer height matches the chips
        paddingHorizontal: 11,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
      }}
    >
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, color: colors.ink, marginTop: 1 }}>+</VText>
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13.5, color: colors.ink, ...(lineH != null ? { lineHeight: lineH } : null) }}>
        Aroma Details
      </VText>
    </Pressable>
  )
}

// ── the compare chip (interaction wrapper; AromaChip stays presentational) ─────
function CompareChip({ chip, onTap }: {
  chip: StripChip
  onTap: (rect: LayoutRectangle, measure: MeasureChip) => void
}) {
  const ref = useRef<View>(null)
  const measure: MeasureChip = (onMeasure) =>
    ref.current?.measureInWindow((x, y, width, height) => onMeasure({ x, y, width, height }))
  return (
    <View ref={ref} collapsable={false}>
      <AromaChip
        a={chip.id}
        m={null}
        count={chip.count}
        pronounced={chip.pronounced}
        vPad={0}
        onPress={() => measure((rect) => onTap(rect, measure))}
      />
    </View>
  )
}

// ── the ruled popover body: Badge Extension + Corner (solid neutral surface) ───
// The focused canonical badge is duplicated at the trigger's EXACT rect and
// overlaps 50% of its height into a neutral Verre surface — no glass, no aroma
// tint, no repeated title, no separate badge shadow (only the detail card is
// elevated). "+N more" (peak branches beyond the cap) opens the Tier 3 sheet.
function PopoverBody({ content, onMoreBranches, onViewContributors }: {
  content: PopoverContent
  onMoreBranches: () => void
  onViewContributors: () => void
}) {
  const { theme } = useTheme()
  const sectionLabel = { fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, letterSpacing: 0.3, color: theme.inkSoft } as const
  return (
    <View style={{ gap: 10 }}>
      {content.ledBy.length > 0 ? (
        <View style={{ gap: 6 }}>
          <VText surface="badge" style={sectionLabel}>Includes mentions of</VText>
          {content.ledBy.map((branch, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
              {branch.map((step, j) => (
                <View key={step.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {j > 0 ? <Icon name="chevron-right" size={12} color={theme.inkFaint} /> : null}
                  <AromaChip a={step.id} m={null} count={step.count} vPad={0} />
                </View>
              ))}
            </View>
          ))}
          {content.moreBranches > 0 ? (
            <Pressable
              onPress={onMoreBranches}
              accessibilityRole="button"
              accessibilityLabel={`Show ${content.moreBranches} more branches`}
              hitSlop={8}
              style={{ alignSelf: 'flex-start', paddingVertical: 5 }}
            >
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.accent }}>{`+${content.moreBranches} more →`}</VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <AromaPopoverPeople contributors={content.contributors} more={content.moreContributors} onPress={onViewContributors} />
      {content.pronouncedCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="pronounced" size={14} color={content.isPanelPronounced ? theme.accent : theme.inkSoft} />
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 12, color: content.isPanelPronounced ? theme.accent : theme.inkSoft }}>
            {`${content.pronouncedCount} of ${content.count} marked pronounced`}
          </VText>
        </View>
      ) : null}
    </View>
  )
}

// The fallback (union) popover body — no consensus tree. Shows the exact
// modifier breakdown as chips (Strawberry · cooked 2, Strawberry · fresh 1) when
// there's a real distinction, then who perceived it.
function UnionPopoverBody({ content, onViewContributors }: { content: UnionPopoverContent; onViewContributors: () => void }) {
  const { theme } = useTheme()
  return (
    <View style={{ gap: 10 }}>
      {content.byModifier.length > 0 ? (
        <View style={{ gap: 6 }}>
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, letterSpacing: 0.3, color: theme.inkSoft }}>How it was described</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {content.byModifier.map((g) => (
              <AromaChip key={g.m ?? '_'} a={content.id} m={g.m} count={g.count} vPad={0} />
            ))}
          </View>
        </View>
      ) : null}
      <AromaPopoverPeople contributors={content.contributors} more={content.moreContributors} onPress={onViewContributors} />
    </View>
  )
}

// ── the strip (one impression's aroma row) ─────────────────────────────────────
// Purely presentational over the parent-computed model: measurement + pack +
// popover state only. Returns null when there's nothing to show.
export type AromaCompareStripProps = {
  model: CompareAromaModel
  /**
   * Open the Tier 3 detail sheet. `focusId` is the node the popover's "+N more"
   * was viewing (the sheet scrolls/focuses there); "Aroma Details" passes none.
   */
  onOpenDetails: (focusId?: string) => void
  /**
   * Popover → People (slice 3d): open the Tier 3 sheet on the People tab
   * filtered to the aroma. The ref's kind carries the popover's granularity —
   * agreement popovers pass a node ref (subsumed), union popovers a base ref
   * (literal picks only). The caller builds the route via viewContributorsRoute.
   */
  onViewContributors: (ref: AromaRef) => void
}

export function AromaCompareStrip({ model, onOpenDetails, onViewContributors }: AromaCompareStripProps) {
  const { result, contrib, strip, hasAgreement } = model
  const phone = usePhoneTokens()
  const [rowW, setRowW] = useState(0)
  const [chipW, setChipW] = useState<Record<string, number>>({})
  const [pillW, setPillW] = useState(0)
  // The open popover carries the strip SIGNATURE it was opened against: if the
  // live 5s poll meaningfully changes the strip (node dropped/re-counted, mode
  // flipped), the popover simply stops rendering — no stale frame, no effect
  // race — and the next tap opens fresh (the toggle check requires a sig match,
  // so a stale entry can't eat the first tap as a "close").
  const [open, setOpen] = useState<{ id: string; rect: ChipRect; sig: string; measure: MeasureChip } | null>(null)
  const sig = `${hasAgreement}|${strip.map((c) => `${c.id}:${c.count}:${c.pronounced ? 1 : 0}`).join(',')}`

  // Measured widths go stale when the OS font scale OR the window geometry
  // changes (badge typography comfort-scales off width AND height) — reset and
  // re-measure on the full key.
  const { fontScale, width: winW, height: winH } = useWindowDimensions()
  const measureKey = `${fontScale}|${winW}|${winH}`
  const prevKey = useRef(measureKey)
  useEffect(() => {
    if (prevKey.current === measureKey) return
    prevKey.current = measureKey
    setChipW({})
    setPillW(0)
    setOpen(null)
  }, [measureKey])

  // The duplicated badge lives in a Modal at window coordinates. Re-measure
  // after every React render while open so a poll-driven reflow above the strip
  // cannot leave it floating at stale tap-time coordinates.
  useEffect(() => {
    if (!open || open.sig !== sig) return
    open.measure((rect) => {
      setOpen((current) => {
        if (!current || current.id !== open.id || current.sig !== open.sig) return current
        return sameRect(current.rect, rect) ? current : { ...current, rect }
      })
    })
  })

  // A content change invalidates both the open popover and any width whose
  // visible label changed. Widths are keyed by the full rendered chip label
  // below, so unaffected chips remain reusable.
  useEffect(() => {
    setOpen((current) => (current && current.sig !== sig ? null : current))
    const liveKeys = new Set(strip.map(stripChipMeasureKey))
    setChipW((current) => {
      const entries = Object.entries(current).filter(([key]) => liveKeys.has(key))
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
    })
  }, [sig, strip])

  // Pack to 2 lines with the measured always-present tail reserved. Until every
  // width is in, the row renders invisible AND height-bounded (no first-frame
  // unpacked flash, no expand-then-snap while the hidden pass measures).
  const widths = strip.map((c) => chipW[stripChipMeasureKey(c)] ?? 0)
  const measured = widths.every((x) => x > 0) && pillW > 0
  const { fit } = measured && rowW > 0 ? packStrip(widths, rowW, STRIP_GAP, pillW, true) : { fit: strip.length }
  const shown = strip.slice(0, fit)
  const unmeasured = strip.filter((c) => !chipW[stripChipMeasureKey(c)])

  // Agreement chips open the consensus popover; union (fallback) chips the
  // simpler contributor popover — both derive from the model. A sig-mismatched
  // `open` renders nothing (see above).
  const openLive = open && open.sig === sig ? open : null
  const openContent: PopoverContent | null = openLive && hasAgreement ? popoverContent(result, contrib, openLive.id, PRON_BAR) : null
  const openUnion: UnionPopoverContent | null = openLive && !hasAgreement ? unionPopoverContent(contrib, openLive.id) : null
  const close = () => setOpen(null)
  const openDetails = (focusId?: string) => { close(); onOpenDetails(focusId) }
  const viewContributors = (ref: AromaRef) => { close(); onViewContributors(ref) }

  // Render whenever there's ANYTHING to show. Only truly aroma-less cases (no
  // taster gave a resolvable aroma → empty union too) omit the block.
  if (strip.length === 0) return null
  // Header states (Simon 2026-07-14): agreement → "Group aroma"; several tasters
  // but no overlap → "Aromas mentioned"; a single aroma respondent → "Aromas".
  const header = hasAgreement ? 'Group aroma' : result.n >= 2 ? 'Aromas mentioned' : 'Aromas'

  return (
    <View style={{ gap: 8 }}>
      <VText
        variant="label"
        color="inkSoft"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', textAlign: 'center', ...phone.text('label') }}
      >
        {header}
      </VText>
      {/* Off-screen measure pass: ONLY the not-yet-measured chips (+ pill), gone
          entirely once complete. Hidden from a11y too — pointerEvents:none blocks
          touch but NOT the accessibility tree (Codex). */}
      {unmeasured.length > 0 || pillW === 0 ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: 'absolute', opacity: 0, left: 0, top: 0, flexDirection: 'row', flexWrap: 'wrap' }}
        >
          {unmeasured.map((c) => {
            const key = stripChipMeasureKey(c)
            return (
              <View key={key} onLayout={(e) => { const x = Math.ceil(e.nativeEvent.layout.width); setChipW((p) => (p[key] === x ? p : { ...p, [key]: x })) }}>
                <AromaChip a={c.id} m={null} count={c.count} pronounced={c.pronounced} vPad={0} />
              </View>
            )
          })}
          {pillW === 0 ? (
            <View onLayout={(e) => { const x = Math.ceil(e.nativeEvent.layout.width); setPillW((p) => (p === x ? p : x)) }}>
              <AromaDetailPill onPress={() => {}} />
            </View>
          ) : null}
        </View>
      ) : null}
      {/* The strip: chips packed to 2 lines + the "Aroma Details" tail pill INLINE
          as the last item. Chips tappable in BOTH modes (Simon 2026-07-14). */}
      <View
        onLayout={(e) => {
          const width = e.nativeEvent.layout.width
          if (rowW > 0 && rowW !== width) setOpen(null)
          setRowW(width)
        }}
        style={{
          flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: STRIP_GAP,
          opacity: measured ? 1 : 0,
          ...(measured ? null : { maxHeight: PREMEASURE_MAX_H, overflow: 'hidden' as const }),
        }}
      >
        {shown.map((chip) => (
          <CompareChip
            key={chip.id}
            chip={chip}
            onTap={(rect, measure) => setOpen((cur) =>
              cur && cur.sig === sig && cur.id === chip.id
                ? null
                : { id: chip.id, rect, sig, measure })}
          />
        ))}
        <AromaDetailPill onPress={() => openDetails()} />
      </View>
      {openContent && openLive ? (
        <AromaBadgePopover
          rect={openLive.rect}
          onClose={close}
          a={openContent.id}
          m={null}
          count={openContent.count}
          pronounced={openContent.isPanelPronounced}
        >
          <PopoverBody content={openContent} onMoreBranches={() => openDetails(openContent.id)} onViewContributors={() => viewContributors({ kind: 'node', a: openContent.id })} />
        </AromaBadgePopover>
      ) : openUnion && openLive ? (
        <AromaBadgePopover
          rect={openLive.rect}
          onClose={close}
          a={openUnion.id}
          m={null}
          count={openUnion.count}
        >
          <UnionPopoverBody content={openUnion} onViewContributors={() => viewContributors({ kind: 'base', a: openUnion.id })} />
        </AromaBadgePopover>
      ) : null}
    </View>
  )
}
