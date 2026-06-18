import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, useWindowDimensions, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetView } from '@gorhom/bottom-sheet';
import { AnchoredMenu, MenuItem } from '@/components/ui/AnchoredMenu';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { BadgePill } from '@/components/moments/RoleChip';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { getMyFriends } from '@/lib/api/me';
import { usePhoneTokens } from '@/lib/layout';
import {
  ApiError,
  removeParticipant,
  setParticipantRole,
  type SessionMetaView,
} from '@/lib/api/sessions';
import { alpha } from '@/theme/color';
import { radius, useTheme } from '@/theme';

// 02c — the People roster (host-manage view). Uses the shared @gorhom/bottom-
// sheet <Sheet> (same shell as the invite sheet). Rows show role + relationship
// (Friend / Blocked) + Unregistered tags; the host/cohost ⋯ menu offers role +
// remove/ban actions via an anchored dropdown (the 02e .ir-menu pattern). All tier gates
// are SERVER-authoritative — the menu only mirrors them to avoid dead actions.

type Participant = SessionMetaView['participants'][number];

export function PeopleSheet({
  open,
  onClose,
  code,
  meta,
  myIdentityId,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  code: string;
  meta: SessionMetaView | null;
  myIdentityId: string;
  onInvite: () => void;
}) {
  const { theme } = useTheme();
  const { height: windowH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  // Friends fetched once per open; an id Set gives O(1) "is this row a friend".
  const friends = useQuery({ queryKey: ['my-friends'], queryFn: getMyFriends, enabled: open, staleTime: 30_000 });
  const friendIds = useMemo(() => new Set((friends.data ?? []).map((f) => f.id)), [friends.data]);

  // Anchored row menu — holds the target id + the ⋯ button's top/bottom window-Y
  // (RowMenu picks open-down vs open-up from these so it never clips off-screen).
  const [menu, setMenu] = useState<{ id: string; anchorTop: number; anchorBottom: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => { if (!open) setMenu(null); }, [open]);

  const strictHost = !!meta && (
    (meta.hostIdentityId != null && myIdentityId === meta.hostIdentityId) ||
    (meta.hostUserId != null && myIdentityId === `u:${meta.hostUserId}`)
  );
  const hostId = meta?.hostIdentityId ?? (meta?.hostUserId != null ? `u:${meta.hostUserId}` : null);
  const isHostViewer = !!meta && (
    strictHost || (meta.coHostIds ?? []).includes(myIdentityId)
  );

  const roleOf = (p: Participant): 'host' | 'cohost' | 'provider' | 'taster' => {
    if (p.id === hostId) return 'host';
    if ((meta?.coHostIds ?? []).includes(p.id)) return 'cohost';
    if ((meta?.providerIds ?? []).includes(p.id)) return 'provider';
    return 'taster';
  };

  // Order: host first, then cohosts, then everyone else (stable otherwise).
  const ordered = useMemo(() => {
    if (!meta) return [];
    const rank = (p: Participant) => {
      const r = roleOf(p);
      return r === 'host' ? 0 : r === 'cohost' ? 1 : 2;
    };
    return [...meta.participants].sort((a, b) => rank(a) - rank(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['session-state', code] });

  const runAction = async (fn: () => Promise<void>, targetId: string) => {
    setMenu(null);
    setBusyId(targetId);
    try {
      await fn();
      refresh();
    } catch (e) {
      const msg = e instanceof ApiError && e.message ? e.message : 'That didn’t work. Please try again.';
      Alert.alert('Could not complete', msg);
    } finally {
      setBusyId(null);
    }
  };

  const setRole = (p: Participant, role: 'taster' | 'co_host' | 'provider') =>
    runAction(() => setParticipantRole(code, p.id, role), p.id);

  const remove = (p: Participant, mode: 'kick' | 'ban') => {
    const verb = mode === 'ban' ? 'Ban' : 'Remove';
    const detail = mode === 'ban'
      ? `Ban ${p.displayName} from this moment? Their ratings here will be removed and they can’t rejoin.`
      : `Remove ${p.displayName} from this moment? They can rejoin with the code.`;
    Alert.alert(`${verb} ${p.displayName}?`, detail, [
      { text: 'Cancel', style: 'cancel' },
      { text: verb, style: 'destructive', onPress: () => runAction(() => removeParticipant(code, p.id, mode), p.id) },
    ]);
  };

  const menuTarget = menu ? ordered.find((p) => p.id === menu.id) ?? null : null;

  return (
    <>
    <Sheet open={open} onClose={onClose} maxDynamicContentSize={windowH * 0.85}>
      <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 14 }}>
        {/* .at-head — "People · N" + Add pill (opens invite). */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            People · {meta?.participants.length ?? 0}
          </VText>
          {/* .hv-add — filled accent pill. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add people"
            onPress={() => { onClose(); onInvite(); }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.accent, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, opacity: pressed ? 0.85 : 1 })}
          >
            <Icon name="plus" size={15} color={theme.accentInk} />
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accentInk }}>Add</VText>
          </Pressable>
        </View>

        {ordered.length === 0 ? (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}>
            <ActivityIndicator />
          </View>
        ) : (
          // Rows in a plain View so dynamic sizing measures them (a
          // BottomSheetScrollView here reports 0 height under dynamic sizing →
          // the sheet won't open). A long roster is capped by the sheet's
          // maxDynamicContentSize (set in <Sheet>).
          <View>
            {ordered.map((p, i) => (
              <PersonRow
                key={p.id}
                p={p}
                first={i === 0}
                role={roleOf(p)}
                isAnon={p.id.startsWith('a:')}
                isFriend={p.id.startsWith('u:') && friendIds.has(Number(p.id.slice(2)))}
                isBlocked={(meta?.viewerBlocksOut ?? []).includes(p.id) || (meta?.viewerBlocksIn ?? []).includes(p.id)}
                isSelf={p.id === myIdentityId}
                busy={busyId === p.id}
                // ⋯ shows only when the viewer has ≥1 available action. Host/
                // cohost, not self, not the strict host — and a non-strict-host
                // cohost has zero actions on ANOTHER cohost (role + kick/ban both
                // need strict-host), so hide it there too.
                canManage={
                  isHostViewer && p.id !== myIdentityId && p.id !== hostId &&
                  (roleOf(p) !== 'cohost' || strictHost)
                }
                onMenu={(anchorTop, anchorBottom) => setMenu({ id: p.id, anchorTop, anchorBottom })}
              />
            ))}
            {isHostViewer ? (
              <VText variant="caption" color="inkSoft" style={{ marginTop: 14 }}>
                Tap ⋯ on anyone to make them a co-host, make a Provider (lets a taster add impressions), remove, or ban them.
              </VText>
            ) : null}
          </View>
        )}
      </BottomSheetView>
    </Sheet>

    {/* Anchored row menu (shared AnchoredMenu — the .ir-menu pattern; flips up
        near the screen bottom). right:20 keeps the prior inset. */}
    <AnchoredMenu
      anchor={menu && menuTarget ? { top: menu.anchorTop, bottom: menu.anchorBottom } : null}
      onClose={() => setMenu(null)}
      right={20}
    >
      {(menuTarget ? buildMenuItems({ p: menuTarget, role: roleOf(menuTarget), strictHost, setRole, remove }) : []).map((it, i) => (
        <MenuItem key={i} label={it.label} tone={it.danger ? 'danger' : 'default'} onPress={it.onPress} />
      ))}
    </AnchoredMenu>
    </>
  );
}

type MenuItem = { label: string; danger?: boolean; onPress: () => void };

// Mirror the server's gates so the menu never offers a dead (403) action:
//  - co-host assign/remove → strict-host only
//  - Provider toggle hidden on cohosts (provider ⊥ cohost)
//  - anon target → remove/ban only
//  - banning a cohost → strict-host only (the row only manages cohosts if strictHost)
function buildMenuItems({
  p, role, strictHost, setRole, remove,
}: {
  p: Participant;
  role: 'host' | 'cohost' | 'provider' | 'taster' | undefined;
  strictHost: boolean;
  setRole: (p: Participant, role: 'taster' | 'co_host' | 'provider') => void;
  remove: (p: Participant, mode: 'kick' | 'ban') => void;
}): MenuItem[] {
  const items: MenuItem[] = [];
  const isAnon = p.id.startsWith('a:');
  const isCohostTarget = role === 'cohost';
  if (!isAnon) {
    if (isCohostTarget) {
      if (strictHost) items.push({ label: 'Remove as co-host', onPress: () => setRole(p, 'taster') });
    } else {
      if (strictHost) items.push({ label: 'Make co-host', onPress: () => setRole(p, 'co_host') });
      // Provider toggle only on non-cohost registered tasters.
      items.push(
        role === 'provider'
          ? { label: 'Remove as Provider', onPress: () => setRole(p, 'taster') }
          : { label: 'Make Provider', onPress: () => setRole(p, 'provider') },
      );
    }
  }
  // Kicking/banning a cohost requires strict-host (server gate) — don't offer
  // it to a non-strict-host cohost or it 403s.
  if (!isCohostTarget || strictHost) {
    items.push({ label: 'Remove from moment', onPress: () => remove(p, 'kick') });
    items.push({ label: 'Ban from moment', danger: true, onPress: () => remove(p, 'ban') });
  }
  return items;
}

// .pl-row — avatar · name + role/relationship tags · ⋯.
function PersonRow({
  p, first, role, isAnon, isFriend, isBlocked, isSelf, busy, canManage, onMenu,
}: {
  p: Participant;
  first: boolean;
  role: 'host' | 'cohost' | 'provider' | 'taster';
  isAnon: boolean;
  isFriend: boolean;
  isBlocked: boolean;
  isSelf: boolean;
  busy: boolean;
  canManage: boolean;
  onMenu: (anchorTopY: number, anchorBottomY: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  const rowRef = useRef<View>(null);
  // Relationship suffix after the name: "· You / · Friend / · Blocked".
  const rel: { label: string; color: 'inkSoft' | 'critical' | 'positive' } | null =
    isSelf ? { label: 'You', color: 'inkSoft' }
    : isBlocked ? { label: 'Blocked', color: 'critical' }
    : isFriend ? { label: 'Friend', color: 'positive' }
    : null;

  return (
    <View
      ref={rowRef}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: surface.paddingY(11), borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft }}
    >
      {/* .pl-av — host = accent; anon = user glyph. */}
      <Avatar imageUrl={p.imageUrl} name={p.displayName} size={40} anon={isAnon} host={role === 'host'} initialsSize={14} />

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {/* Name, "·" (name color), relationship WORD (colored) as separate
              flex siblings — the row's gap gives the spacing (nested-Text padding
              didn't render). ROLES stay pill badges. */}
          <VText surface="compactList" variant="body" style={{ fontFamily: isAnon ? 'InstrumentSans_400Regular' : 'InstrumentSans_600SemiBold', flexShrink: 1 }} color={isAnon ? 'inkSoft' : 'ink'} numberOfLines={1}>
            {p.displayName}
          </VText>
          {rel ? (
            <>
              <VText surface="compactList" variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color={isAnon ? 'inkSoft' : 'ink'}>·</VText>
              <VText surface="compactList" variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color={rel.color}>{rel.label}</VText>
            </>
          ) : null}
          {role === 'host' ? <Tag label="Host" kind="host" /> : role === 'cohost' ? <Tag label="Co-host" kind="plain" /> : null}
          {role === 'provider' ? <Tag label="Provider" kind="provider" /> : null}
          {isAnon ? <Tag label="Unregistered" kind="anon" /> : null}
        </View>
      </View>

      {busy ? (
        <ActivityIndicator />
      ) : canManage ? (
        // Anchored to the ROW (not just the button) so the menu opens from the
        // row's bottom edge — keep the rowRef measure rather than AnchorButton.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Manage ${p.displayName}`}
          hitSlop={8}
          onPress={() => rowRef.current?.measureInWindow((_x, y, _w, h) => onMenu(y, y + h))}
          style={({ pressed }) => ({ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
        >
          <Icon name="more" size={20} color={theme.inkSoft} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Tag({ label, kind }: { label: string; kind: 'host' | 'plain' | 'provider' | 'anon' }) {
  const { theme } = useTheme();
  const styles: Record<typeof kind, { bg: string; fg: string; border?: string }> = {
    host: { bg: theme.accentTint, fg: theme.accent },
    plain: { bg: theme.surfaceSunk, fg: theme.inkSoft },
    provider: { bg: alpha(theme.positive, 0.16), fg: theme.positive },
    anon: { bg: 'transparent', fg: theme.inkFaint, border: theme.rule },
  };
  const s = styles[kind];
  return <BadgePill label={label} bg={s.bg} color={s.fg} border={s.border} />;
}
