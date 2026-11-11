import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ConnectionState';
import { Avatar } from '@/components/ui/Avatar';
import { Icon, type IconName } from '@/components/ui/Icon';
import { BadgePill } from '@/components/moments/RoleChip';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { GLASS_FILL, GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { elevation, radius, useTheme } from '@/theme';

// Shared presentational pieces for the 02f settings screens (hub + Moment
// details + Moment Setup). Pixel-spec from the design's inline CSS
// (.set-readcard / .setgroup / .setnav / .trow / .set-photo-btn).

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
export function SetPage({ title, children, bottomPad, footer }: { title: string; children: ReactNode; bottomPad?: number; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={title} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: bottomPad ?? TAB_BAR_CLEARANCE, gap: 26 }}
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
export function SetNav({
  icon, leading, label, subtitle, value, trailing, onPress, action, critical, accent, disabled, soon, busy,
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
      style={({ pressed }) => ({
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
        <VText variant="body" style={{ fontFamily: action ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium' }} color={tint}>
          {label}
        </VText>
        {subtitle ? <VText variant="caption" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: 2 }}>{subtitle}</VText> : null}
      </View>
      {value ? <VText variant="small" color={disabled ? 'inkFaint' : 'inkSoft'} numberOfLines={1} style={{ maxWidth: '60%' }}>{value}</VText> : null}
      {soon ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
      {end}
    </Pressable>
  );
}

// .yo-stog — a switch row in a settings group (no icon): title, optional
// caption, the switch in the chevron's place. `soon` locks it at its value
// with the "Soon" caption.
export function SetSwitch({ label, subtitle, value, onChange, disabled, soon }: {
  label: string;
  subtitle?: string;
  value: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  soon?: boolean;
}) {
  const { theme } = useTheme();
  const locked = disabled || soon;
  return (
    <SetNav
      label={label}
      subtitle={subtitle}
      soon={soon}
      disabled={soon}
      trailing={<Switch value={value} onValueChange={onChange} disabled={locked} trackColor={{ true: theme.accent }} accessibilityLabel={label} />}
    />
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
export function ToggleRow({
  title, subtitle, value, onChange, disabled, proBadge, reason, note,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  proBadge?: boolean;
  reason?: string;
  // A second, quieter line under the subtitle (e.g. the blind feed-reveal rule).
  note?: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingTop: 18, paddingBottom: 2 }}>
      <View style={{ flexShrink: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color={disabled ? 'inkFaint' : 'ink'}>{title}</VText>
          {proBadge ? (
            // letterSpacing adds trailing space after the last glyph, shoving
            // the text optically left — pull the right padding in by that amount
            // (6 left / 4 right) so PRO reads centered.
            <View style={{ backgroundColor: theme.accent, borderRadius: radius.xs, paddingVertical: 2, paddingLeft: 6, paddingRight: 4 }}>
              <VText style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 9, lineHeight: 11, letterSpacing: 1.08, color: theme.accentInk }}>PRO</VText>
            </View>
          ) : null}
        </View>
        <VText variant="caption" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: 2, maxWidth: 210 }}>{subtitle}</VText>
        {note ? <VText variant="caption" color="inkFaint" style={{ marginTop: 4, maxWidth: 230 }}>{note}</VText> : null}
        {reason ? <VText variant="caption" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 3 }}>{reason}</VText> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: theme.accent }} accessibilityLabel={title} />
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
