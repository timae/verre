import { ActivityIndicator, Pressable, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ConnectionState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

const GUTTER = 22;

// Shared presentational pieces for the 02f settings screens (hub + Moment
// details + Reveal & blind). Pixel-spec from the design's inline CSS
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
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>{name}</VText>
      <VText variant="small" color="inkSoft" style={{ marginTop: 3 }}>{metaLine}</VText>
      <View
        style={{
          alignSelf: 'flex-start',
          marginTop: 10,
          paddingVertical: 4,
          paddingHorizontal: 11,
          borderRadius: radius.pill,
          backgroundColor: accentRole ? theme.accentTint : theme.surfaceSunk,
        }}
      >
        <VText variant="caption" color={accentRole ? 'accent' : 'inkSoft'} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {label}
        </VText>
      </View>
    </View>
  );
}

// .setgroup — a carded group of nav-rows divided by hairlines.
export function SetGroup({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, overflow: 'hidden', marginBottom: 18 }}>
      {children}
    </View>
  );
}

// .setnav — a row. `action` = bold label with no chevron (Share/Delete/Leave);
// otherwise a nav-row with a chevron. `critical` = red.
export function SetNav({
  icon, label, onPress, action, critical, disabled, soon,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  action?: boolean;
  critical?: boolean;
  disabled?: boolean;
  soon?: boolean;
}) {
  const { theme } = useTheme();
  const tint = disabled ? theme.inkFaint : critical ? theme.critical : theme.ink;
  const iconTint = disabled ? theme.inkFaint : critical ? theme.critical : theme.inkSoft;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 13,
        paddingHorizontal: 14,
        // Every row draws a top hairline; the first row's overlaps the group's
        // own top border so it reads as one line (.setnav + .setnav rule).
        borderTopWidth: 1,
        borderTopColor: theme.ruleSoft,
        backgroundColor: pressed && !disabled ? theme.surfaceSunk : 'transparent',
      })}
    >
      <Icon name={icon} size={19} color={iconTint} />
      <VText style={{ flex: 1, fontFamily: action ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium', fontSize: 15 }} color={tint}>
        {label}
      </VText>
      {soon ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
      {!action ? <Icon name="chevron-right" size={18} color={theme.inkFaint} /> : null}
    </Pressable>
  );
}

// .set-photo-btn — glass round button over the cover (edit / remove).
export function GlassButton({ label, icon, right, onPress }: { label: string; icon: IconName; right: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ position: 'absolute', top: 10, right, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(20,18,15,0.42)', alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={icon} size={17} color="#fff" />
    </Pressable>
  );
}

// Sticky Discard | Save bar pinned to the bottom of a settings sub-SCREEN
// (Moment details / Reveal & blind). SOLID theme.bg fill + a 1px top rule —
// deliberately NOT the create.tsx transparent→bg GRADIENT: the Discard button
// is an outline (.btn-secondary, transparent fill), so over a gradient the
// scrolling form content reads straight THROUGH it. An opaque bar blocks the
// content behind the whole footer, so the outline button only ever shows the
// solid bar. (Create gets away with the gradient because its single button is
// a solid fill.)
export function SettingsFooter({ saving, onDiscard, onSave, bottomInset }: { saving: boolean; onDiscard: () => void; onSave: () => void; bottomInset: number }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        flexDirection: 'row', gap: 10,
        paddingTop: 14, paddingHorizontal: 16, paddingBottom: bottomInset + 16,
        backgroundColor: theme.bg,
      }}
    >
      <Button title="Discard" variant="secondary" onPress={onDiscard} disabled={saving} bar style={{ flex: 1 }} />
      <Button title="Save" loadingTitle="Saving…" loading={saving} variant="positive" onPress={onSave} bar style={{ flex: 1 }} />
    </View>
  );
}

// .trow — switch row with an optional PRO badge + locked-reason caption.
export function ToggleRow({
  title, subtitle, value, onChange, disabled, proBadge, reason,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  proBadge?: boolean;
  reason?: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingTop: 18, paddingBottom: 2 }}>
      <View style={{ flexShrink: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }} color={disabled ? 'inkFaint' : 'ink'}>{title}</VText>
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
        {reason ? <VText variant="caption" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 3 }}>{reason}</VText> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: theme.accent }} accessibilityLabel={title} />
    </View>
  );
}

// Shared loading/error body for the 02f settings screens (hub + Moment details
// + Reveal & blind) when `useSettingsSession` has no `meta` yet. All three had
// the identical VBar + spinner-or-"Couldn't load" block; this collapses them to
// one line and upgrades the error case to a retryable <ErrorState>. The fatal
// auth/existence kinds bounce to the line-up inside the hook, so the only error
// that reaches here is a network/5xx — Retry is the right action.
export function SettingsScreenFallback({
  title, isError, retrying, onRetry,
}: {
  title: string;
  isError: boolean;
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
          title="Couldn’t load this moment"
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
