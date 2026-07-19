import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Modal, Pressable, useWindowDimensions, View, type LayoutRectangle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AromaChip } from '@/components/scoring/aroma/parts'
import { Avatar } from '@/components/ui/Avatar'
import { Icon } from '@/components/ui/Icon'
import { VText } from '@/components/ui/VText'
import { elevation, motion, radius, useTheme } from '@/theme'

const AROMA_POPOVER_WIDTH = 228
const CORNER_INSET = 10

export type AromaPopoverRect = LayoutRectangle
export type AromaPopoverPerson = { id: string; displayName: string }

// The shared people block inside every aroma badge-extension popover. The
// compare strip says "Perceived by"; a badge inside one person's row says
// "Also perceived by" and excludes that row's owner.
export function AromaPopoverPeople({
  contributors,
  more = 0,
  label = 'Perceived by',
  emptyCopy,
  onPress,
}: {
  contributors: ReadonlyArray<AromaPopoverPerson>
  more?: number
  label?: string
  emptyCopy?: string
  onPress?: () => void
}) {
  const { theme } = useTheme()
  if (contributors.length === 0) {
    return emptyCopy ? (
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_500Medium', color: theme.inkSoft }}>
        {emptyCopy}
      </VText>
    ) : null
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `View contributors. ${label} ${contributors.map((c) => c.displayName).join(', ')}${more > 0 ? `, and ${more} more` : ''}` : undefined}
      hitSlop={onPress ? 6 : undefined}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: 'row', paddingLeft: 2 }}
      >
        {contributors.map((c, i) => (
          <View key={c.id} style={{ marginLeft: i === 0 ? 0 : -7 }}>
            <Avatar name={c.displayName} size={26} ring initialsSize={9.5} />
          </View>
        ))}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', letterSpacing: 0.3, color: theme.inkSoft }}>
          {label}
        </VText>
        <VText numberOfLines={1} variant="small" style={{ fontFamily: 'InstrumentSans_500Medium', color: theme.ink }}>
          {contributors.map((c) => c.displayName).join(', ')}{more > 0 ? ` +${more}` : ''}
        </VText>
      </View>
      {onPress ? <Icon name="chevron-right" size={14} color={theme.inkSoft} /> : null}
    </Pressable>
  )
}

// The device-ruled Badge Extension + Corner treatment shared by Tier 2 and
// every tappable aroma inside Tier 3. The focused canonical badge duplicates
// the trigger's exact rectangle and overlaps halfway into the neutral card.
export function AromaBadgePopover({
  rect,
  onClose,
  a,
  m,
  count,
  pronounced,
  connector,
  children,
}: {
  rect: AromaPopoverRect
  onClose: () => void
  a?: string
  m?: string | null
  count?: number
  pronounced?: boolean
  /** Source-matched trigger clone (Simon 2026-07-19): a non-badge trigger
      (Overview bar segment, fingerprint segment, pyramid facet) passes its
      OWN primitive here and it rides the tap rect instead of the canonical
      badge — the connector matches what was actually tapped. */
  connector?: ReactNode
  children: ReactNode
}) {
  const { theme } = useTheme()
  const { width: screenW, height: screenH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [size, setSize] = useState({ w: 0, h: 0 })
  const anim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: motion.dur1, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start()
  }, [anim])

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
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* The dismiss scrim is a SIBLING of the content, never its parent: RN
          touchables group their descendants into one accessibility element,
          so a scrim-as-parent exposes only "Close aroma details" to
          VoiceOver/TalkBack and hides the nested actions (View contributors,
          Show more). */}
      <View style={{ flex: 1 }}>
        <Pressable
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          accessibilityRole="button"
          accessibilityLabel="Close aroma details"
          onPress={onClose}
        />
        <Animated.View
          onLayout={(e) => setSize({ w: Math.ceil(e.nativeEvent.layout.width), h: Math.ceil(e.nativeEvent.layout.height) })}
          style={{
            position: 'absolute',
            top,
            left,
            width: Math.min(AROMA_POPOVER_WIDTH, maxW),
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [flip ? 4 : -4, 0] }) }],
          }}
        >
          <View style={flip ? { marginBottom: rect.height - badgeOverlap } : { marginTop: rect.height - badgeOverlap }}>
            <View style={detailStyle}>{children}</View>
          </View>
          <View
            collapsable={false}
            style={{
              zIndex: 4,
              position: 'absolute',
              left: badgeLeft,
              ...(flip ? { bottom: 0 } : { top: 0 }),
              flexDirection: 'row',
              borderRadius: radius.pill,
              transform: [{ scale: 1.06 }],
            }}
          >
            {connector ?? (a != null ? <AromaChip a={a} m={m ?? null} count={count} pronounced={pronounced} focused vPad={0} /> : null)}
          </View>
        </Animated.View>
      </View>
    </Modal>
  )
}
