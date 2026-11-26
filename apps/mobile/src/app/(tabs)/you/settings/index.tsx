import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { MeCard, SetGroup, SetNav, SetPage, failedReads } from '@/components/moments/settingsParts';
import { VText } from '@/components/ui/VText';
import { MY_ACCOUNT_KEY, getMyAccount } from '@/lib/api/me';
import { profileQueryOptions } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { APP_BUILD, APP_VERSION } from '@/lib/clientVersion';
import { confirmSignOut } from '@/lib/signOutConfirm';
import { legalHref, profileEditHref, settingsHref, useSessionTab } from '@/lib/sessionStack';
import { themes, useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';
import { MOMENTS_AREA_TITLE } from '@/lib/momentVisibilityCopy';

// Settings (handoff 04·4 `settings`): your profile card → Edit Profile, then
// Account, Privacy, Appearance and Help & About; Tasting and Notifications
// are "Soon". Also mounted on an opened post's stack (your own profile opened
// from a post, settingsHref). The Dev Gallery row lives on Help & About.
export default function Settings() {
  const router = useRouter();
  const mount = useSessionTab();
  const { choice } = useTheme();
  const userId = useMeId();
  // Your name from the users row, never Better Auth's session copy (stale
  // after a rename); the photo from your own profile header.
  const account = useQuery({ queryKey: MY_ACCOUNT_KEY, queryFn: getMyAccount });
  const profile = useQuery({ ...profileQueryOptions(userId ?? ''), enabled: userId != null });
  const own = profile.data?.state === 'ok' ? profile.data : null;
  const name = account.data?.name ?? own?.name ?? '';
  const [busy, setBusy] = useState(false);

  const version = [APP_VERSION ? `Verre ${APP_VERSION}` : null, APP_BUILD ? `Build ${APP_BUILD}` : null].filter(Boolean).join(' · ');

  return (
    <SetPage title="Settings" offline={failedReads(account, profile)}>
      <MeCard name={name} username={account.data?.username ?? own?.username ?? null} imageUrl={own?.imageUrl ?? null} onPress={() => router.push(profileEditHref(mount), { dangerouslySingular: true })} />
      <SetGroup flush>
        <SetNav icon="user" label="Account" onPress={() => router.push(settingsHref(mount, 'account'), { dangerouslySingular: true })} />
        <SetNav icon="eye" label="Privacy" onPress={() => router.push(settingsHref(mount, 'privacy'), { dangerouslySingular: true })} />
        <SetNav icon="glass" label={MOMENTS_AREA_TITLE} onPress={() => router.push(settingsHref(mount, 'defaults'), { dangerouslySingular: true })} />
      </SetGroup>
      <SetGroup flush>
        <SetNav icon="bell" label="Notifications" disabled soon />
        <SetNav
          icon="palette"
          label="Appearance"
          value={choice === 'system' ? 'Match System' : themes[choice].name}
          onPress={() => router.push(settingsHref(mount, 'appearance'), { dangerouslySingular: true })}
        />
      </SetGroup>
      <SetGroup flush>
        <SetNav icon="link" label="Help & About" onPress={() => router.push(legalHref(mount, 'about'), { dangerouslySingular: true })} />
      </SetGroup>
      <SetGroup flush>
        <SetNav icon="logout" label="Sign Out" action critical disabled={busy} onPress={() => confirmSignOut(account.data?.email || name, setBusy)} />
      </SetGroup>
      {version ? <VText variant="caption" color="inkFaint" style={{ textAlign: 'center' }}>{version}</VText> : null}
    </SetPage>
  );
}
