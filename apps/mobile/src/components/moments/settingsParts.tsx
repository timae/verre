import { Children, Fragment, isValidElement, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, View, type StyleProp, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ConnectionState';
import { Avatar } from '@/components/ui/Avatar';
import { Icon, type IconName } from '@/components/ui/Icon';
import { BadgePill } from '@/components/moments/RoleChip';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { GLASS_FILL, GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { alpha } from '@/theme/color';
import { elevation, radius, useTheme } from '@/theme';

// Shared presentational pieces for the 02f settings screens (hub + Moment
// details + Moment Setup). Pixel-spec from the design's inline CSS
// (.set-readcard / .setgroup / .setnav / .trow / .set-photo-btn).

// The cardless settings rows' rhythm (ToggleRow / ChoiceRow / PersonRow): the
// design's ~12 between rows. A helper is pulled up under its label to ~18
// baseline to baseline (a 2–3 pt gap; the line heights alone left ~25).
const ROW_GAP = 12;
const HELPER_PULL = -4;
// The chevron-right glyph ends ~6 pt inside its 18 pt box (path to 16.3 of 24,
// stroke included); a switch fills its frame, so it is inset by the same 6 to
// end where the chevrons end.
const CHEVRON_TIP_INSET = 6;

export type SettingsRole = 'host' | 'cohost' | 'provider' | 'taster';

// .set-readcard — moment name + "Hosted by … · date" + role pill.
export function ReadCard({ name, metaLine, role }: { name: string; metaLine: string; role: SettingsRole }) {
  const { theme } = useTheme();
  // host + cohost carry the accent pill (.set-role-host) — both hold host
  // powers; provider + taster get the neutral pill (.set-role).
  const accentRole = role === 'host' || role === 'cohost';
  const label =
    role === 'host' ? 'You are the host'
    : role === 'cohost' ? 'You are a co-host'
    : role === 'provider' ? 'You are a provider'
    : 'You are a taster';
  return (
    <View style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, padding: 16, marginBottom: 18 }}>
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{name}</VText>
      <VText variant="small" color="inkSoft" style={{ marginTop: 3 }}>{metaLine}</VText>
      <BadgePill
        label={label}
        bg={accentRole ? theme.accentTint : theme.surfaceSunk}
        color={accentRole ? theme.accent : theme.inkSoft}
        uppercase={false}
        paddingHorizontal={11}
        paddingVertical={4}
        style={{ marginTop: 10 }}
      />
    </View>
  );
}

// .setgroup — a carded group of nav-rows divided by hairlines. `flush`: the
// You settings pages space their groups with the page gap (`.yo-sgrp
// .setgroup { margin: 0 }`) instead of the group's own bottom margin. The
// hairline goes BETWEEN rows only (`.setnav + .setnav`): a line on the first
// row sat under the card's own border and doubled it (a visible shade, seen
// on device 2026-11-11). Children are rows; a `null` child draws nothing.
export function SetGroup({ children, flush }: { children: ReactNode; flush?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, overflow: 'hidden', marginBottom: flush ? 0 : 18 }}>
      {Children.toArray(children).map((row, i) => (
        <Fragment key={isValidElement(row) && row.key != null ? row.key : i}>
          {i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

// .yo-setbody — a You settings page (04·4): the bar, then its sections 26
// apart, clear of the pill. `footer` renders below the scroll (a sticky
// footer page, which hides the pill, clears it through `bottomPad`); the
// scroll keeps a focused field above the keyboard.
// `gap`: between sections (26; a page of SetTitle sections uses 32, the
// design's space above a section title).
export function SetPage({ title, children, bottomPad, footer, gap = 26 }: { title: string; children: ReactNode; bottomPad?: number; footer?: ReactNode; gap?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={title} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: bottomPad ?? TAB_BAR_CLEARANCE, gap }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

// .yo-sgrp — a section on a settings page: the optional uppercase label
// (.yo-label) over its content, 10 apart.
export function SetSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      {label ? <VText variant="label" color="inkSoft" accessibilityRole="header">{label}</VText> : null}
      {children}
    </View>
  );
}

// .setnav — a row. `action` = bold label with no chevron (Share/Delete/Leave);
// otherwise a nav-row with a chevron. `critical` = red. The You settings
// additions (04·4): `subtitle` (the second line, `.setnav-t > span`), `value`
// (the trailing ink-soft text, `.setnav-v`), `leading` (a node in the icon's
// place, e.g. the initials disc; `icon` is optional for the switch rows,
// `.yo-stog`), and `trailing` (a node, e.g. a button or a switch, in the
// chevron's place; `'none'` = nothing there). A row that carries a trailing
// NODE is not one accessible element, so the button or switch in it stays
// reachable. `busy` = a spinner in the chevron's place, the row still one
// (busy) button. `accent` = label + icon in the accent (an action row that
// matches the accent text buttons, e.g. Disconnect All Other Devices).
// `bare` = the cardless settings standard (ruled 2026-11-11: Privacy,
// Account): no card padding or press fill (a dim instead), label `body`
// regular (an `action` row MEDIUM, the weight of the rows' trailing
// actions: Remove All Other Devices, Delete Account), value `body`, rows ~12
// apart (`flush` = none above).
export function SetNav({
  icon, leading, label, subtitle, value, trailing, onPress, action, critical, accent, disabled, soon, busy, bare, flush,
}: {
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  subtitle?: string;
  value?: string;
  trailing?: ReactNode | 'none';
  onPress?: () => void;
  action?: boolean;
  critical?: boolean;
  accent?: boolean;
  disabled?: boolean;
  soon?: boolean;
  busy?: boolean;
  bare?: boolean;
  flush?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const tint = disabled ? theme.inkFaint : critical ? theme.critical : accent ? theme.accent : theme.ink;
  const iconTint = disabled ? theme.inkFaint : critical ? theme.critical : accent ? theme.accent : theme.inkSoft;
  const end = busy ? <ActivityIndicator /> : trailing === 'none' ? null : trailing ?? (!action ? <Icon name="chevron-right" size={18} color={theme.inkFaint} /> : null);
  return (
    <Pressable
      accessible={trailing == null || trailing === 'none'}
      accessibilityRole={onPress || disabled ? 'button' : undefined}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => (bare
        ? {
            flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16),
            paddingTop: flush ? 0 : ROW_GAP, paddingBottom: 2,
            opacity: pressed && !disabled && onPress ? 0.6 : 1,
          }
        : {
            flexDirection: 'row',
            alignItems: 'center',
            gap: phone.lerp(12, 16),
            paddingVertical: phone.lerp(13, 17),
            paddingHorizontal: 14,
            // No line of its own: SetGroup draws the hairline between rows.
            backgroundColor: pressed && !disabled ? theme.surfaceSunk : 'transparent',
          })}
    >
      {leading ?? (icon ? <Icon name={icon} size={19} color={iconTint} /> : null)}
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText
          variant="body"
          style={bare ? (action ? { fontFamily: 'InstrumentSans_500Medium' } : null) : { fontFamily: action ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium' }}
          color={tint}
        >
          {label}
        </VText>
        {subtitle ? <VText variant="small" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: HELPER_PULL }}>{subtitle}</VText> : null}
      </View>
      {/* Middle truncation keeps both ends of a long value (an email address)
          and a narrower max width keeps air after the label (design). */}
      {value ? (
        <VText variant={bare ? 'body' : 'small'} color={disabled ? 'inkFaint' : 'inkSoft'} numberOfLines={1} ellipsizeMode="middle" style={{ maxWidth: bare ? '55%' : '60%' }}>
          {value}
        </VText>
      ) : null}
      {soon ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
      {end}
    </Pressable>
  );
}

// .yo-mecard — the Settings hub's own-profile card: 60pt photo, name, "Edit
// Profile", chevron. Elevated by the sm shadow token (the mock's
// `--shadow-sm`), no border.
export function MeCard({ name, imageUrl, onPress }: { name: string; imageUrl: string | null; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, Edit Profile`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14,
        backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
        borderRadius: radius.lg,
        shadowColor: '#000',
        shadowOpacity: elevation.sm.ios.shadowOpacity,
        shadowRadius: elevation.sm.ios.shadowRadius,
        shadowOffset: { width: 0, height: elevation.sm.ios.shadowOffsetY },
        elevation: elevation.sm.android.elevation,
      })}
    >
      <Avatar imageUrl={imageUrl} name={name} size={60} tint />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <VText variant="subhead" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{name}</VText>
        <VText variant="small" color="inkSoft">Edit Profile</VText>
      </View>
      <Icon name="chevron-right" size={18} color={theme.inkFaint} />
    </Pressable>
  );
}

// .set-photo-btn — glass round button over the cover (edit / remove).
// `bottom` anchors it to the bottom edge instead of 10 from the top (the Edit
// Profile page's `.yo-ep-btn`, bottom-right).
export function GlassButton({ label, icon, right, bottom, onPress }: { label: string; icon: IconName; right: number; bottom?: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={{ position: 'absolute', ...(bottom != null ? { bottom } : { top: 10 }), right, width: 34, height: 34, borderRadius: 17, backgroundColor: GLASS_FILL, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={icon} size={17} color="#fff" />
    </Pressable>
  );
}

// Sticky Discard | Save bar pinned to the bottom of a settings sub-SCREEN
// (Moment details / Moment Setup). SOLID theme.bg fill + a 1px top rule —
// deliberately NOT the create.tsx transparent→bg GRADIENT: the Discard button
// is an outline (.btn-secondary, transparent fill), so over a gradient the
// scrolling form content reads straight THROUGH it. An opaque bar blocks the
// content behind the whole footer, so the outline button only ever shows the
// solid bar. (Create gets away with the gradient because its single button is
// a solid fill.)
export function SettingsFooter({ saving, error, onDiscard, onSave, bottomInset }: { saving: boolean; error?: string | null; onDiscard: () => void; onSave: () => void; bottomInset: number }) {
  const { theme } = useTheme();
  return (
    // The error banner lives HERE (above the buttons), not in the scroll body:
    // a save error must always be visible, but the form body scrolls and an
    // error at its end would land below the fold on a small screen.
    <View
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        paddingTop: 14, paddingHorizontal: 16, paddingBottom: bottomInset + 16,
        backgroundColor: theme.bg,
      }}
    >
      {error ? (
        <VText variant="small" style={{ marginBottom: 10, color: theme.critical }}>{error}</VText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title="Discard" variant="secondary" onPress={onDiscard} disabled={saving} bar style={{ flex: 1 }} />
        <Button title="Save" loadingTitle="Saving…" loading={saving} variant="positive" onPress={onSave} bar style={{ flex: 1 }} />
      </View>
    </View>
  );
}

// .trow — switch row with an optional PRO badge + locked-reason caption.
// The settings row type (ruled 2026-11-11, every switch row in the app): the
// label `body` regular, the helper `small` ink-soft right under it, a note
// `small` 500 accent; rows ~12 apart (the design). The switch's OFF track is
// a NEUTRAL ink at 18%: iOS's default grey vanished on Apricot, and an
// accent-tinted one read as "half on". `flush`: no
// top padding (the first row under a SetTitle or a label). `busy`: only the switch is inert (a save in flight); `disabled`
// also fades the text (the option is unavailable).
export function ToggleRow({
  title, subtitle, value, onChange, disabled, busy, flush, proBadge, reason, note,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  flush?: boolean;
  proBadge?: boolean;
  reason?: string;
  // A second, quieter line under the subtitle (e.g. the blind feed-reveal rule).
  note?: string;
}) {
  const { theme } = useTheme();
  const offTrack = alpha(theme.ink, 0.18);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingTop: flush ? 0 : ROW_GAP, paddingBottom: 2 }}>
      <View style={{ flexShrink: 1 }}>
        <ToggleTitle title={title} disabled={disabled} proBadge={proBadge} />
        {subtitle ? <VText variant="small" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: HELPER_PULL }}>{subtitle}</VText> : null}
        {note ? <VText variant="small" color="inkFaint" style={{ marginTop: 4 }}>{note}</VText> : null}
        {reason ? <SetNote style={{ marginTop: 3 }}>{reason}</SetNote> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled || busy}
        trackColor={{ false: offTrack, true: theme.accent }}
        ios_backgroundColor={offTrack}
        accessibilityLabel={title}
        style={{ marginRight: CHEVRON_TIP_INSET }}
      />
    </View>
  );
}

// A switch row's title, with the PRO badge INLINE after its last word (a long
// title wraps and the badge follows it; as a flex sibling it hung at the end
// of the first line). An inline view's vertical spot depends on the font's
// baseline, so it is MEASURED: the title's last line (onTextLayout) and the
// badge's frame (onLayout, which a transform doesn't change, so no loop) give
// the shift that centres the badge on its line, at any Dynamic Type size.
function ToggleTitle({ title, disabled, proBadge }: { title: string; disabled?: boolean; proBadge?: boolean }) {
  const { theme } = useTheme();
  const [shift, setShift] = useState(0);
  const line = useRef<{ y: number; height: number } | null>(null);
  const badge = useRef<{ y: number; height: number } | null>(null);
  const align = () => {
    if (!line.current || !badge.current) return;
    setShift(Math.round(line.current.y + line.current.height / 2 - (badge.current.y + badge.current.height / 2)));
  };
  return (
    <VText
      variant="body"
      color={disabled ? 'inkFaint' : 'ink'}
      onTextLayout={proBadge ? (e) => { line.current = e.nativeEvent.lines.at(-1) ?? null; align(); } : undefined}
    >
      {title}
      {proBadge ? (
        <>
          {' '}
          <View
            onLayout={(e) => { badge.current = e.nativeEvent.layout; align(); }}
            style={{ backgroundColor: theme.accent, borderRadius: radius.xs, paddingVertical: 2, paddingLeft: 6, paddingRight: 4, transform: [{ translateY: shift }] }}
          >
            {/* letterSpacing adds trailing space after the last glyph, shoving
                the text optically left — pull the right padding in by that
                amount (6 left / 4 right) so PRO reads centered. */}
            <VText style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 9, lineHeight: 11, letterSpacing: 1.08, color: theme.accentInk }}>PRO</VText>
          </View>
        </>
      ) : null}
    </VText>
  );
}

// A settings note: `small` 500 accent (a locked reason, "Limited by …").
export function SetNote({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <VText variant="small" color="accent" style={[{ fontFamily: 'InstrumentSans_500Medium' }, style]}>{children}</VText>;
}

// A settings section title (the You Privacy page, ruled 2026-11-11): `bodyLg`
// 600, -0.01em, ink, Title Case, 6 above its first row. Not the uppercase
// micro-label.
export function SetTitle({ children }: { children: string }) {
  return (
    <VText variant="bodyLg" accessibilityRole="header" style={{ fontFamily: 'InstrumentSans_600SemiBold', letterSpacing: -0.17, marginBottom: 6 }}>
      {children}
    </VText>
  );
}

// A choice row without a card: the label `body` regular, the value `body`
// ink-soft, a chevron (18, ink-faint); a tap opens the choice (a sheet or a
// page). Without `onPress` it is an inert value row (no chevron). `helper`: a
// line under the label, as on a ToggleRow. `dropdown`: it opens a choices
// sheet, so the chevron points DOWN (a page = right; ruled 2026-11-11).
// `icon`: a leading glyph (19, ink-soft, as on SetNav). Same rhythm as
// ToggleRow (`flush` = no top padding).
export function ChoiceRow({ icon, label, value, helper, onPress, dropdown, disabled, busy, flush, accessibilityLabel }: {
  icon?: IconName;
  label: string;
  value: string;
  helper?: string;
  onPress?: () => void;
  dropdown?: boolean;
  disabled?: boolean;
  // Inert without fading (a save in flight; `disabled` fades the row).
  busy?: boolean;
  flush?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={accessibilityLabel ?? (value ? `${label}: ${value}` : label)}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: flush ? 0 : ROW_GAP, paddingBottom: 2,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={19} color={disabled ? theme.inkFaint : theme.inkSoft} /> : null}
      <View style={{ flex: 1 }}>
        <VText variant="body" color={disabled ? 'inkFaint' : 'ink'}>{label}</VText>
        {helper ? <VText variant="small" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: HELPER_PULL }}>{helper}</VText> : null}
      </View>
      {value ? <VText variant="body" color={disabled ? 'inkFaint' : 'inkSoft'} numberOfLines={1} style={{ maxWidth: '60%' }}>{value}</VText> : null}
      {/* The down chevron's tip sits ~2 pt nearer the edge than the right one's
          (path to 18.8 vs 16.3 of 24): inset it so every row ends on the same
          line as the switches (CHEVRON_TIP_INSET). */}
      {onPress ? (
        <View style={dropdown ? { marginRight: 2 } : null}>
          <Icon name={dropdown ? 'chevron-down' : 'chevron-right'} size={18} color={theme.inkFaint} />
        </View>
      ) : null}
    </Pressable>
  );
}

// A person on a cardless settings list (Blocked / Muted): the initials disc,
// the name `body` regular, a trailing node (the Unblock / Unmute button).
export function PersonRow({ name, trailing, flush }: { name: string; trailing: ReactNode; flush?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: flush ? 0 : ROW_GAP, paddingBottom: 2 }}>
      <Avatar name={name} size={36} initialsSize={12} />
      <VText variant="body" numberOfLines={1} style={{ flex: 1 }}>{name}</VText>
      {trailing}
    </View>
  );
}

// Shared loading/error body for a settings page whose first load hasn't
// landed: the 02f moment screens (hub + Moment details + Moment Setup, while
// `useSettingsSession` has no `meta` yet) and the You Blocked / Muted lists
// (`errorTitle`). The three moment screens had
// the identical VBar + spinner-or-"Couldn't load" block; this collapses them to
// one line and upgrades the error case to a retryable <ErrorState>. The fatal
// auth/existence kinds bounce to the line-up inside the hook, so the only error
// that reaches here is a network/5xx — Retry is the right action.
export function SettingsScreenFallback({
  title, isError, errorTitle = 'Couldn’t load this moment', retrying, onRetry,
}: {
  title: string;
  isError: boolean;
  errorTitle?: string;
  retrying?: boolean;
  onRetry: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={title} />
      </View>
      {isError ? (
        <ErrorState
          title={errorTitle}
          message="Check your connection and try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}
