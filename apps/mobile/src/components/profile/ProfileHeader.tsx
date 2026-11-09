import { useRef } from 'react';
import { View } from 'react-native';
import { BadgePill } from '@/components/moments/RoleChip';
import { PhotoTiles } from '@/components/profile/PhotoTiles';
import { StarScore } from '@/components/scoring/StarScore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import type { FullProfile, ProfileFace } from '@/lib/api/users';
import { usePhoneTokens } from '@/lib/layout';
import { radius, useTheme } from '@/theme';
import { mix } from '@/theme/color';

// The profile header, no-cover variant (04·R5c / R5d / R5n / R5x, Mara = 04·5
// without its cover, blocked = 04·5b). Pixel spec off vero-you.js `youR(5, {
// coverName, noCover, split })` + vero-you.css; the cover hero (04·R5i·b) is
// step 2. Anatomy: photo · name / status ★ average / friends · followers, then
// the three photo tiles, then (someone else) the in-common row + follow button.
//
// Step 1 rulings (Simon, 2026-11-09): the status line, the counts, the tiles
// and the in-common row are visible but INACTIVE (their pages come later); the
// status pill names OUR level (lib/badges.ts), the design's were placeholders.

const AVATAR = 104;

// The design addresses people by first name ("Block Mara?", "You blocked
// Mara."). Display names are free text, so this is presentation only.
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

// 1234 → "1.2k", 12400 → "12.4k", 212000 → "212k" (the design's big-profile
// frame 04·R5x). Floors, so a count never reads higher than it is.
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(Math.floor(n / 100) / 10).toString()}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toString()}M`;
}

// .yo-cnrow — photo left, name + lines right. `children` = the lines under
// the name (absent on the blocked / private views: name and initials only).
export function ProfileIdentity({
  name,
  imageUrl,
  children,
  onNameBottom,
}: {
  name: string;
  imageUrl: string | null;
  children?: React.ReactNode;
  // The name's bottom edge within this row (the bar title shows once it has
  // scrolled under the bar).
  onNameBottom?: (y: number) => void;
}) {
  const sideY = useRef<number | null>(null);
  const nameBottom = useRef<number | null>(null);
  const report = () => {
    if (sideY.current != null && nameBottom.current != null) onNameBottom?.(sideY.current + nameBottom.current);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginLeft: -8 }}>
      <Avatar imageUrl={imageUrl} name={name} size={AVATAR} tint />
      <View
        onLayout={(e) => {
          sideY.current = e.nativeEvent.layout.y;
          report();
        }}
        style={{ flex: 1, minWidth: 0, gap: 4, paddingLeft: 2, alignItems: 'flex-start' }}
      >
        {/* .yo-ncname — 700 26px in the mock; the nearest type token is
            heading (23), bold. Flagged deviation: no inline font sizes. */}
        <VText
          variant="heading"
          numberOfLines={1}
          onLayout={(e) => {
            nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
            report();
          }}
          style={{ fontFamily: 'InstrumentSans_700Bold', marginBottom: 2, maxWidth: '100%' }}
        >
          {name}
        </VText>
        {children}
      </View>
    </View>
  );
}

// .yo-statline — status pill + ★ average (no average until they rated).
function StatLine({ level, avgScore }: { level: string; avgScore: number | null }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <BadgePill
        label={level}
        bg={theme.accentTint}
        color={mix(theme.accent, theme.ink, 0.6)}
        uppercase={false}
        paddingHorizontal={10}
        style={{ alignSelf: 'center' }}
      />
      {avgScore != null && avgScore > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {/* The house score read (accent ★ + value). ⚠️ The mock draws the
              numeral in ink; StarScore's accent numeral is the canonical read. */}
          <StarScore value={avgScore} size={13} />
          <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>
            average
          </VText>
        </View>
      ) : null}
    </View>
  );
}

// .yo-cnfollows — "48 friends  212 followers", count in ink 600.
function Counts({ friends, followers }: { friends: number; followers: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      <Count n={friends} word="friends" />
      <Count n={followers} word="followers" />
    </View>
  );
}

function Count({ n, word }: { n: number; word: string }) {
  return (
    <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontVariant: ['tabular-nums'] }}>
        {compactCount(n)}
      </VText>{' '}
      {word}
    </VText>
  );
}

// The full header block above the posts (state 'ok', own or someone else).
export function ProfileHeader({
  profile,
  own,
  onFollowPress,
  followBusy,
  onNameBottom,
}: {
  profile: FullProfile;
  own: boolean;
  onFollowPress: () => void;
  followBusy: boolean;
  // The identity row is the header's first child, so its y is the header's.
  onNameBottom?: (y: number) => void;
}) {
  const t = profile.tiles;
  return (
    <View style={{ gap: 16 }}>
      <ProfileIdentity name={profile.name} imageUrl={profile.imageUrl} onNameBottom={onNameBottom}>
        <StatLine level={profile.level.name} avgScore={profile.flavor.avgScore} />
        <Counts friends={profile.friendsCount} followers={profile.stats.followers} />
      </ProfileIdentity>
      <PhotoTiles
        tiles={[
          { label: 'Impressions', count: compactCount(t.impressions.count), imageUrl: t.impressions.imageUrl },
          { label: 'Moments', count: compactCount(t.moments.count), imageUrl: t.moments.imageUrl },
          { label: 'Cravings', count: compactCount(t.cravings.count), imageUrl: t.cravings.imageUrl },
        ]}
      />
      {own ? null : (
        // .yo-frow — "N in common" faces + names, the follow button right.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <InCommon inCommon={profile.inCommon} />
          <FollowButton
            isFollowing={profile.isFollowing}
            followsYou={profile.followsYou}
            busy={followBusy}
            onPress={onFollowPress}
          />
        </View>
      )}
    </View>
  );
}

function InCommon({ inCommon }: { inCommon?: { count: number; faces: ProfileFace[] } }) {
  const phone = usePhoneTokens();
  if (!inCommon || inCommon.count === 0) return <View style={{ flex: 1 }} />;
  const { count, faces } = inCommon;
  const face = phone.grow(26);
  const names = faces.slice(0, 2).map((f) => firstName(f.name));
  const rest = count - names.length;
  const line = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ');
  return (
    <View
      accessible
      accessibilityLabel={`${count} in common: ${line}`}
      style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      {/* .yo-stack — overlapping 26px faces, 2px bg ring */}
      <View style={{ flexDirection: 'row' }}>
        {faces.map((f, i) => (
          <View key={f.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar imageUrl={f.imageUrl} name={f.name} size={face} ring initialsSize={Math.round(face * 0.38)} />
          </View>
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {count} in common
        </VText>
        <VText variant="small" color="inkSoft" numberOfLines={2}>
          {line}
        </VText>
      </View>
    </View>
  );
}

// Follow / Follow Back (primary) · Following / Friends (secondary, ✓). The
// caller confirms an unfollow; following acts immediately.
export function FollowButton({
  isFollowing,
  followsYou,
  busy,
  onPress,
}: {
  isFollowing: boolean;
  followsYou: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  if (isFollowing) {
    return <Button size="sm" variant="secondary" icon="check" title={followsYou ? 'Friends' : 'Following'} loading={busy} onPress={onPress} />;
  }
  return <Button size="sm" variant="primary" title={followsYou ? 'Follow Back' : 'Follow'} loading={busy} onPress={onPress} />;
}

// .yo-blockedbox — the sentence + one action on the fill tone. Used by the
// blocked view (04·5b: "You blocked Mara." + Unblock) and, per Simon's
// ruling, the private (tier-gated) view with a Follow button.
export function NoticeBox({ text, action }: { text: string; action: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        marginTop: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: radius.md,
        backgroundColor: theme.surfaceSunk,
      }}
    >
      <VText variant="small" color="inkSoft" style={{ flex: 1 }}>
        {text}
      </VText>
      {action}
    </View>
  );
}

// .yo-emptyfeed — quiet block under the tiles when there are no posts.
export function EmptyPosts({ title, body }: { title: string; body?: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 4, paddingTop: 40, paddingHorizontal: 24, paddingBottom: 40 }}>
      <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold', textAlign: 'center' }}>
        {title}
      </VText>
      {body ? (
        <VText variant="small" color="inkSoft" style={{ textAlign: 'center' }}>
          {body}
        </VText>
      ) : null}
    </View>
  );
}
