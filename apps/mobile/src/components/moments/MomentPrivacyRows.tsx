import { useState } from 'react';
import { View } from 'react-native';
import { OptionSheet } from '@/components/moments/momentForm';
import { ChoiceRow, SetTitle, ToggleRow } from '@/components/moments/settingsParts';
import { VText } from '@/components/ui/VText';
import type { VisibilitySettings } from '@/lib/api/settings';
import {
  AUDIENCE_MENU, HIDE_HELPER, MOMENT_HIDE_FROM_FEED_HELPER, MOMENT_HIDE_FROM_FEED_TITLE, ONLY_INSIDE_HELPER, ONLY_INSIDE_TITLE, WHO_CAN_SEE_THIS_MOMENT, WHO_CAN_SEE_YOU,
  audienceLabel, guestCirclesApply, guestCirclesHelper, guestCirclesTitle, ownAudienceBlock, type CreatePrivacyValues,
} from '@/lib/momentVisibilityCopy';

// A moment's privacy as YOU set it before the moment exists, in the rows,
// words and helpers of Moment Privacy (session/[code]/settings/
// visibility.tsx), from the host's side ("Your …"), never the View-Only Link.
// Two parts (Simon's split, 2026-11-25): `HostPrivacyRows` (Visible To, the
// tasters' circle, the two Hide switches: Moment Defaults, Create Moment's
// page) and `YouPrivacyRows` (Incognito, Hide from Feed: Privacy's join
// defaults, Create Moment's page). The caller owns the values and the save. A
// screen rendering HostPrivacyRows wraps itself in a BottomSheetModalProvider
// (the Visible To sheet).
export type PrivacyRowField = keyof CreatePrivacyValues;
type HostValues = Pick<CreatePrivacyValues, 'visibility' | 'includeGuestCircles' | 'showPlace' | 'showDetails'>;
type YouValues = Pick<CreatePrivacyValues, 'onlyInside' | 'hiddenFromFeed'>;
type OnChange<V> = <F extends keyof V>(field: F, value: V[F]) => void;

export function HostPrivacyRows({ title, values, onChange, busy }: { title: string; values: HostValues; onChange: OnChange<HostValues>; busy?: boolean }) {
  const [sheet, setSheet] = useState(false);
  return (
    <View>
      <SetTitle>{title}</SetTitle>
      <ChoiceRow
        flush
        dropdown
        label="Visible To"
        value={audienceLabel(values.visibility, 'host')}
        valueLines={4}
        accessibilityLabel={`${title}: ${audienceLabel(values.visibility, 'host')}`}
        busy={busy}
        onPress={() => setSheet(true)}
      />
      {guestCirclesApply(values.visibility) ? (
        <ToggleRow
          title={guestCirclesTitle(values.visibility)}
          subtitle={guestCirclesHelper(values.visibility)}
          value={values.includeGuestCircles}
          onChange={(on) => onChange('includeGuestCircles', on)}
          busy={busy}
        />
      ) : null}
      {/* Hide, not Show (Moment Privacy's switches): ON while hidden. */}
      <ToggleRow title="Hide Location" subtitle={HIDE_HELPER.place} value={!values.showPlace} onChange={(hide) => onChange('showPlace', !hide)} busy={busy} />
      <ToggleRow title="Hide Description and Link" subtitle={HIDE_HELPER.details} value={!values.showDetails} onChange={(hide) => onChange('showDetails', !hide)} busy={busy} />
      <OptionSheet
        open={sheet}
        title={title}
        options={AUDIENCE_MENU.map((a) => ({ code: a, label: audienceLabel(a, 'host') }))}
        selected={values.visibility}
        onClose={() => setSheet(false)}
        onSelect={(a) => {
          setSheet(false);
          onChange('visibility', a);
        }}
      />
    </View>
  );
}

// `account`: the line naming who outside a moment can see you (Moment
// Privacy's block); only on a moment's own page (Create Moment's), never in
// Settings (Simon, 2026-11-25: your account settings are right there).
// `withHideFromFeed` false: Incognito alone (Privacy, where the moment posts'
// Hide from Feed sits in Post Visibility).
export function YouPrivacyRows({ title, values, onChange, busy, account, withHideFromFeed = true }: { title: string; values: YouValues; onChange: OnChange<YouValues>; busy?: boolean; account?: VisibilitySettings; withHideFromFeed?: boolean }) {
  const own = account ? ownAudienceBlock(account, values.onlyInside) : null;
  return (
    <View>
      <SetTitle>{title}</SetTitle>
      {own ? (
        <View style={{ marginBottom: 12 }}>
          <VText variant="small" color="inkSoft">{own.lead}</VText>
          <VText variant="body" color="ink" style={{ marginTop: 2 }}>{own.value}</VText>
          {own.note ? <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>{own.note}</VText> : null}
        </View>
      ) : null}
      <ToggleRow flush={!own} title={ONLY_INSIDE_TITLE} subtitle={ONLY_INSIDE_HELPER} value={values.onlyInside} onChange={(on) => onChange('onlyInside', on)} busy={busy} />
      {withHideFromFeed ? (
        <ToggleRow title={MOMENT_HIDE_FROM_FEED_TITLE} subtitle={MOMENT_HIDE_FROM_FEED_HELPER} value={values.hiddenFromFeed} onChange={(on) => onChange('hiddenFromFeed', on)} busy={busy} />
      ) : null}
    </View>
  );
}

// Create Moment's Privacy page: THIS moment, both parts, the account line.
export function MomentPrivacyRows({ values, onChange, account }: { values: CreatePrivacyValues; onChange: <F extends PrivacyRowField>(field: F, value: CreatePrivacyValues[F]) => void; account?: VisibilitySettings }) {
  return (
    <>
      <HostPrivacyRows title={WHO_CAN_SEE_THIS_MOMENT} values={values} onChange={(field, value) => onChange(field, value as never)} />
      <YouPrivacyRows title={WHO_CAN_SEE_YOU} values={values} onChange={(field, value) => onChange(field, value as never)} account={account} />
    </>
  );
}
