// DEV-ONLY reusable Tier 2 "Aroma agreement" strip + the RULED contributor
// popover (compare §9, Slice 2b). Extracted from the dev-gallery so BOTH the
// gallery and a __DEV__ block in the real CmpAccItem can mount the SAME component
// — the gallery alone can't be the final density ruling (Codex), so this is the
// one source of truth for the strip's real pixels.
//
// ⚠️ DEV-ONLY: every consumer lazy-`require`s this file inside `if (__DEV__)`, so
// Metro's DCE keeps it — and everything it statically imports (the selector +
// compare-view + contributor derivations) — OUT of the production bundle. A
// static import of this module from production code would defeat that; don't.
//
// Contains ONLY the ruled production candidate: Tier 2 packing + chips + the
// final **Badge Extension + Corner** popover + contributor content. The rejected
// gallery experiments (Title Bar, Liquid Glass, Center anchor) and the gallery's
// sample panels + knob controls are NOT here.

import { useRef, useState } from 'react'
import { Modal, Pressable, useWindowDimensions, View, type LayoutRectangle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { aggregateAromaRollup } from '@verre/core'
import { aromaConsensus, type AromaConsensusOpts } from './aromaConsensus'
import { buildAromaContributors, type AromaContributorInput } from './aromaContributors'
import { tier2Strip, popoverContent, packStrip, type StripChip, type PopoverContent, type PronouncedBar } from './aromaCompareView'
import { AromaChip } from '@/components/scoring/aroma/parts'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { VText } from '@/components/ui/VText'
import { elevation, radius, useTheme } from '@/theme'

const STRIP_GAP = 8
const COMPARE_CHIP_PAD = 2
const AROMA_POPOVER_WIDTH = 228
const CORNER_INSET = 10

type ChipRect = { x: number; y: number; width: number; height: number }

// ── the compare chip (interaction wrapper; AromaChip stays presentational) ─────
function CompareChip({ chip, onLayoutWidth, onTap }: {
  chip: StripChip
  onLayoutWidth: (id: string, w: number) => void
  onTap: (rect: LayoutRectangle) => void
}) {
  const ref = useRef<View>(null)
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={(e) => onLayoutWidth(chip.id, Math.ceil(e.nativeEvent.layout.width))}
      style={{ borderRadius: 999, padding: COMPARE_CHIP_PAD }}
    >
      <AromaChip
        a={chip.id}
        m={null}
        count={chip.count}
        pronounced={chip.pronounced}
        vPad={0}
        onPress={() => ref.current?.measureInWindow((x, y, width, height) => onTap({
          x: x + COMPARE_CHIP_PAD,
          y: y + COMPARE_CHIP_PAD,
          width: width - COMPARE_CHIP_PAD * 2,
          height: height - COMPARE_CHIP_PAD * 2,
        }))}
      />
    </View>
  )
}

// ── the ruled popover: Badge Extension + Corner (solid neutral surface) ────────
// The focused canonical badge is duplicated at the trigger's EXACT rect and
// overlaps 50% of its height into a neutral Verre surface — no glass, no aroma
// tint, no repeated title, no separate badge shadow (only the detail card is
// elevated).
function PopoverBody({ content, onViewContributors, onMoreBranches }: {
  content: PopoverContent
  onViewContributors: () => void
  onMoreBranches: () => void
}) {
  const { theme } = useTheme()
  return (
    <View style={{ gap: 10 }}>
      {content.ledBy.length > 0 ? (
        <View style={{ gap: 6 }}>
          <VText variant="caption" color="inkFaint">Includes mentions of</VText>
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
            <Pressable onPress={onMoreBranches} accessibilityRole="button">
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.accent }}>{`+${content.moreBranches} More →`}</VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {content.contributorNames.length > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View style={{ flexDirection: 'row', paddingLeft: 2 }}>
            {content.contributorNames.map((name, i) => (
              <View key={name} style={{ marginLeft: i === 0 ? 0 : -7 }}>
                <Avatar name={name} size={26} ring initialsSize={9.5} />
              </View>
            ))}
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <VText variant="caption" color="inkFaint">Supported By</VText>
            <VText numberOfLines={1} surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 12.5, color: theme.inkSoft }}>
              {content.contributorNames.join(', ')}{content.moreContributors > 0 ? ` +${content.moreContributors}` : ''}
            </VText>
          </View>
        </View>
      ) : null}
      {content.pronouncedCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="pronounced" size={14} color={content.isPanelPronounced ? theme.accent : theme.inkFaint} />
          <VText variant="caption" color={content.isPanelPronounced ? 'accent' : 'inkFaint'}>
            {`${content.pronouncedCount} of ${content.count} marked pronounced`}
          </VText>
        </View>
      ) : null}
      <View style={{ borderTopWidth: 1, borderTopColor: theme.rule, paddingTop: 4 }}>
        <Button title="View Contributors" variant="tertiary" size="sm" block onPress={onViewContributors} />
      </View>
    </View>
  )
}

function BadgeExtensionPopover({ rect, onClose, badge, body }: {
  rect: ChipRect
  onClose: () => void
  badge: React.ReactNode
  body: React.ReactNode
}) {
  const { theme } = useTheme()
  const { width: screenW, height: screenH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [size, setSize] = useState({ w: 0, h: 0 })
  const margin = 12
  const maxW = screenW - margin * 2
  const w = Math.min(size.w || AROMA_POPOVER_WIDTH, maxW)
  const left = Math.max(margin, Math.min(rect.x - CORNER_INSET, screenW - margin - w))
  const bottomLimit = screenH - insets.bottom - 8
  const downTop = rect.y
  const flip = size.h > 0 && downTop + size.h > bottomLimit
  const top = flip ? rect.y + rect.height - size.h : downTop
  const badgeLeft = Math.max(0, Math.min(rect.x - left, Math.max(0, (size.w || AROMA_POPOVER_WIDTH) - rect.width)))
  const badgeOverlap = rect.height / 2
  const detailStyle = {
    borderRadius: radius.md,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.ruleSoft,
    paddingHorizontal: 10,
    paddingTop: flip ? 10 : badgeOverlap + 8,
    paddingBottom: flip ? badgeOverlap + 8 : 10,
    shadowColor: '#000',
    shadowOpacity: elevation.sm.ios.shadowOpacity,
    shadowRadius: elevation.sm.ios.shadowRadius,
    shadowOffset: { width: 0, height: elevation.sm.ios.shadowOffsetY },
    elevation: elevation.sm.android.elevation,
  } as const
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1 }} accessibilityLabel="Close Aroma Details" onPress={onClose}>
        <View
          onLayout={(e) => setSize({ w: Math.ceil(e.nativeEvent.layout.width), h: Math.ceil(e.nativeEvent.layout.height) })}
          style={{ position: 'absolute', top, left, width: Math.min(AROMA_POPOVER_WIDTH, maxW) }}
        >
          <View style={flip ? { marginBottom: rect.height - badgeOverlap } : { marginTop: rect.height - badgeOverlap }}>
            <View style={detailStyle}>{body}</View>
          </View>
          {/* Duplicate badge at the trigger's EXACT rect; no own shadow. */}
          <View collapsable={false} style={{ zIndex: 4, position: 'absolute', left: badgeLeft, ...(flip ? { bottom: 0 } : { top: 0 }), flexDirection: 'row', borderRadius: radius.pill }}>
            {badge}
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

// ── the strip card (one impression's Aroma agreement row) ─────────────────────
// Self-contained: owns its measurement + fixed-point pack + popover state.
export type AromaAgreementStripProps = {
  /** id / displayName / their stored aroma picks — the compare Rater shape. */
  raters: AromaContributorInput[]
  /** consensus + pronounced knobs (production bakes the ruled defaults). */
  opts: AromaConsensusOpts
  pronBar: PronouncedBar
  /** "Detailed aromas" / "View contributors" / "+N more" → Tier 3 (not wired in 2b). */
  onDetailed?: () => void
}

export function AromaAgreementStrip({ raters, opts, pronBar, onDetailed }: AromaAgreementStripProps) {
  const { theme } = useTheme()
  const [rowW, setRowW] = useState(0)
  const [chipW, setChipW] = useState<Record<string, number>>({})
  const [pillW, setPillW] = useState<Record<string, number>>({})
  const [open, setOpen] = useState<{ id: string; rect: ChipRect } | null>(null)

  const res = aromaConsensus(aggregateAromaRollup(raters.map((r) => (r.aromas ?? []).map((a) => ({ a: a.a, m: a.m })))), opts)
  const contrib = buildAromaContributors(raters)
  const strip = tier2Strip(res, contrib, pronBar)
  const widths = strip.map((c) => chipW[c.id] ?? 0)
  const measured = strip.length === 0 || widths.every((x) => x > 0)
  const pillLabelFor = (n: number) => `+${n} more`
  const pillWidthFor = (n: number) => pillW[pillLabelFor(n)] ?? 64

  let fit = strip.length, overflow = 0
  if (measured && rowW > 0) {
    let prev = -1
    for (let i = 0; i < strip.length + 2; i++) {
      const r = packStrip(widths, rowW, STRIP_GAP, overflow > 0 ? pillWidthFor(overflow) : 0)
      fit = r.fit; overflow = r.overflow
      if (overflow === prev) break
      prev = overflow
    }
  }
  const shown = strip.slice(0, fit)
  const pillLabel = pillLabelFor(overflow)
  const candidateOverflows = strip.map((_, i) => i + 1)

  const openContent: PopoverContent | null = open ? popoverContent(res, contrib, open.id, pronBar) : null
  const close = () => setOpen(null)
  const detailed = () => { close(); onDetailed?.() }

  // n === 0 = NO aroma responses (missing evidence), NOT disagreement — so this
  // renders an explicit "No aroma responses" line instead of the "mixed; no
  // shared aromas" copy (Codex). NOTE: this component returns that line; the
  // real-card DEV block still keeps its Live/Pinned + knob controls around it (so
  // you can flip to Pinned from an aroma-less card). PRODUCTION Tier 2 (slice 3b)
  // is where the empty block is omitted entirely.
  if (res.n === 0) {
    return <VText variant="caption" color="inkFaint">No aroma responses</VText>
  }

  return (
    <View style={{ gap: 8 }}>
      <VText variant="caption" color="inkFaint">Aroma agreement</VText>
      {/* Off-screen measure pass: every chip + every candidate pill label. */}
      <View pointerEvents="none" style={{ position: 'absolute', opacity: 0, left: 0, top: 0, flexDirection: 'row', flexWrap: 'wrap' }}>
        {strip.map((c) => (
          <View key={c.id} onLayout={(e) => { const x = Math.ceil(e.nativeEvent.layout.width); setChipW((p) => (p[c.id] === x ? p : { ...p, [c.id]: x })) }}>
            <View style={{ padding: COMPARE_CHIP_PAD }}><AromaChip a={c.id} m={null} count={c.count} pronounced={c.pronounced} vPad={0} /></View>
          </View>
        ))}
        {candidateOverflows.map((n) => {
          const label = pillLabelFor(n)
          return (
            <View key={label} onLayout={(e) => { const x = Math.ceil(e.nativeEvent.layout.width); setPillW((p) => (p[label] === x ? p : { ...p, [label]: x })) }}>
              <View style={{ paddingVertical: 4, paddingHorizontal: 10 }}><VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }}>{label}</VText></View>
            </View>
          )
        })}
      </View>
      {strip.length > 0 ? (
        <View onLayout={(e) => setRowW(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: STRIP_GAP }}>
          {shown.map((chip) => (
            <CompareChip
              key={chip.id}
              chip={chip}
              onLayoutWidth={(id, x) => setChipW((p) => (p[id] === x ? p : { ...p, [id]: x }))}
              onTap={(rect) => setOpen((cur) => (cur?.id === chip.id ? null : { id: chip.id, rect }))}
            />
          ))}
          {overflow > 0 ? (
            <Pressable accessibilityRole="button" onPress={detailed} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: theme.bg }}>
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.inkSoft }}>{pillLabel}</VText>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <VText variant="caption" color="inkFaint">— mixed; no shared aromas —</VText>
      )}
      <Pressable accessibilityRole="button" onPress={detailed}>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.inkSoft }}>Detailed aromas →</VText>
      </Pressable>
      {openContent && open ? (
        <BadgeExtensionPopover
          rect={open.rect}
          onClose={close}
          badge={<View style={{ flexDirection: 'row' }}><AromaChip a={openContent.id} m={null} count={openContent.count} pronounced={openContent.isPanelPronounced} focused vPad={0} /></View>}
          body={<PopoverBody content={openContent} onViewContributors={detailed} onMoreBranches={detailed} />}
        />
      ) : null}
    </View>
  )
}
