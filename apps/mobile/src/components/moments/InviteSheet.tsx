import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetScrollView, BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';
import * as Clipboard from 'expo-clipboard';
import { formatCode } from '@verre/core';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { QrCode } from '@/components/ui/QrCode';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { getMyFriends, type Friend } from '@/lib/api/me';
import { WEB_BASE } from '@/lib/config';
import { usePhoneTokens } from '@/lib/layout';
import { alpha } from '@/theme/color';
import { radius, useTheme } from '@/theme';

// 02c·I1 — the invite sheet (design 6a hybrid), in the shared @gorhom/bottom-
// sheet <Sheet>. Mockup-faithful: codecard (QR flat + code + copy), then a
// friends group ("Quick add · not in yet" chips led by a Browse chip + a
// "Search and browse friends" field) and a Share footer. The Browse/search
// affordance swaps the sheet to a full friends-list pane (one sheet). No invite
// backend (Simon, milestone 5): all "Invite"/share affordances open the OS
// share sheet; only "Joined" is truthful (block-scrubbed participant ids).

export function InviteSheet({
  open,
  onClose,
  code,
  momentName,
  participantIds,
}: {
  open: boolean;
  onClose: () => void;
  code: string;
  momentName: string | null;
  participantIds: Set<string>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const formSurface = phone.surface('formControl');
  const [pane, setPane] = useState<'invite' | 'browse'>('invite');
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset transient sub-state when the sheet closes, so reopening is clean.
  useEffect(() => {
    if (!open) {
      setPane('invite');
      setQ('');
      setCopied(false);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    }
  }, [open]);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const label = momentName?.trim() ? momentName.trim() : 'this moment';
  const joinUrl = `${WEB_BASE}/join/${code}`;
  const shareMessage = `Join “${label}” on Verre`;

  const friends = useQuery({ queryKey: ['my-friends'], queryFn: getMyFriends, enabled: open, staleTime: 30_000 });
  const allFriends = useMemo(() => friends.data ?? [], [friends.data]);
  // Friends not already in the session, for the quick-add chip row.
  const notIn = allFriends.filter((f) => !participantIds.has(`u:${f.id}`));
  const browseMatches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? allFriends.filter((f) => f.name.toLowerCase().includes(needle)) : allFriends;
  }, [allFriends, q]);

  const copyLink = async () => {
    try {
      await Clipboard.setStringAsync(joinUrl);
    } catch {
      return; // clipboard write failed — don't show the "copied" confirm
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const shareInvite = async (extra?: string) => {
    try {
      await Share.share({ message: extra ? `${shareMessage}\n${extra}` : shareMessage, url: joinUrl });
    } catch {
      // user dismissed the OS sheet — no-op
    }
  };

  // Header (shared) — title + (browse) back chevron.
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
      {pane === 'browse' ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} onPress={() => setPane('invite')} style={({ pressed }) => ({ marginLeft: -6, width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}>
          <Icon name="back" size={22} color={theme.ink} />
        </Pressable>
      ) : null}
      <VText variant="subhead" style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>
        {pane === 'browse' ? 'Invite friends' : `Invite to ${label}`}
      </VText>
    </View>
  );

  return (
    // @gorhom/bottom-sheet (pure-JS, no native overlay — the @expo/ui sheet's
    // Host blocked header taps).
    //  - INVITE pane: dynamic-sized (BottomSheetView of plain content) — fits
    //    snugly to the QR + chips.
    //  - BROWSE pane: a FIXED snap point, NOT dynamic. Its friends list is a
    //    BottomSheetScrollView, and dynamic sizing can't measure a scroll view's
    //    content (it collapses the sheet to a sliver — the same trap PeopleSheet
    //    avoids with a plain View). A fixed height lets the list scroll inside.
    <Sheet
      open={open}
      onClose={onClose}
      enableDynamicSizing={pane === 'invite'}
      snapPoints={pane === 'browse' ? ['85%'] : undefined}
    >
      {pane === 'invite' ? (
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 16 }}>
          {header}
          {/* QR + code + copy — FLAT on the sheet (Simon: no codecard panel). */}
          <View style={{ alignItems: 'center', gap: 12 }}>
            {/* DEVIATION (Simon): design specs a fixed WHITE 180×180 frame with
                dark modules; we keep the theme-matched QrCode (contrast-clamped). */}
            <QrCode value={joinUrl} size={168} />
            <VText variant="small" color="inkSoft">Scan to join — or use the code</VText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy invite link"
              onPress={copyLink}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: theme.surfaceSunk, borderRadius: radius.pill, paddingVertical: 8, paddingLeft: 20, paddingRight: 10, opacity: pressed ? 0.7 : 1 })}
            >
              <VText surface="code" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 22, letterSpacing: 2.6, fontVariant: ['tabular-nums'] }}>{formatCode(code)}</VText>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: theme.surface, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={copied ? 'check' : 'copy'} size={16} color={copied ? theme.positive : theme.inkSoft} />
              </View>
            </Pressable>
            <VText variant="caption" color="inkSoft" style={{ marginTop: -6, textAlign: 'center' }}>
              {copied ? 'Link copied' : 'Copies the moment link'}
            </VText>
          </View>

          {/* .ish-friends — quick-add chips led by Browse, + search field. */}
          <View style={{ gap: 10 }}>
            <VText variant="label" color="inkSoft" style={{ letterSpacing: 1.54 }}>QUICK ADD · NOT IN YET</VText>
            {friends.isPending ? (
              <View style={{ height: 84, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingBottom: 4 }}>
                <BrowseChip onPress={() => setPane('browse')} />
                {notIn.slice(0, 4).map((f) => (
                  <FriendChip key={f.id} friend={f} onPress={() => shareInvite()} />
                ))}
              </ScrollView>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => setPane('browse')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 11 }}
            >
              <Icon name="search" size={17} color={theme.inkSoft} />
              <VText variant="body" color="inkSoft">Search and browse friends</VText>
            </Pressable>
          </View>

          {/* .ish-sharebtn */}
          <Pressable
            accessibilityRole="button"
            onPress={() => shareInvite()}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.accent, borderRadius: radius.pill, paddingVertical: 13, opacity: pressed ? 0.85 : 1 })}
          >
            <Icon name="share" size={18} color={theme.accentInk} />
            <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accentInk }}>Share</VText>
          </Pressable>
        </BottomSheetView>
      ) : (
        // Browse pane — FIXED-height sheet (snapPoints above), so the container
        // fills the sheet (flex:1) and the friends list scrolls within it. Header
        // + search stay fixed at the top; the BottomSheetScrollView flexes to the
        // remaining space.
        <BottomSheetView style={{ flex: 1, width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 14 }}>
          {header}
          {/* .fr-search — fixed pill height + a centered, zero-vertical-padding
              input so the value/placeholder sit on the pill's centre line. A
              paddingVertical-only input lets iOS bias the (single-line) text down
              in its line box — the value and grey placeholder read low. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, height: formSurface.height(44), backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.pill, paddingHorizontal: 14 }}>
            <Icon name="search" size={17} color={theme.inkSoft} />
            <BottomSheetTextInput
              {...formSurface.textProps}
              value={q}
              onChangeText={setQ}
              placeholder="Search friends"
              placeholderTextColor={theme.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, paddingVertical: 0, fontFamily: 'InstrumentSans_400Regular', color: theme.ink, fontSize: phone.text('body').fontSize }}
            />
          </View>
          {friends.isPending ? (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <ActivityIndicator />
            </View>
          ) : browseMatches.length === 0 ? (
            <VText variant="small" color="inkSoft" style={{ paddingVertical: 12 }}>
              {allFriends.length === 0 ? 'No friends yet.' : 'No matches.'}
            </VText>
          ) : (
            <View style={{ flex: 1 }}>
              <VText variant="label" color="inkSoft" style={{ marginBottom: 4, letterSpacing: 1.54 }}>ALL FRIENDS · {allFriends.length}</VText>
              <BottomSheetScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
                {browseMatches.map((f, i) => (
                  <FriendRow key={f.id} friend={f} first={i === 0} joined={participantIds.has(`u:${f.id}`)} onInvite={() => shareInvite()} />
                ))}
              </BottomSheetScrollView>
            </View>
          )}
        </BottomSheetView>
      )}
    </Sheet>
  );
}

// .ish-chip-all — leading "Browse" chip: accent-tint avatar w/ search glyph.
function BrowseChip({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Browse friends" onPress={onPress} style={{ alignItems: 'center', gap: 6, width: 60 }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: theme.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="search" size={20} color={theme.accent} />
      </View>
      <VText variant="caption" numberOfLines={1}>Browse</VText>
    </Pressable>
  );
}

// .ish-chip — avatar (initials) + "+" badge + first name. Tap → OS share.
function FriendChip({ friend, onPress }: { friend: Friend; onPress: () => void }) {
  const { theme } = useTheme();
  const firstName = friend.name.split(/\s+/)[0];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Invite ${friend.name}`} onPress={onPress} style={{ alignItems: 'center', gap: 6, width: 60 }}>
      <Avatar
        imageUrl={friend.imageUrl}
        name={friend.name}
        size={52}
        initialsSize={16}
        badge={
          <View style={{ position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: theme.surface }}>
            <Icon name="plus" size={11} color={theme.accentInk} />
          </View>
        }
      />
      <VText variant="caption" numberOfLines={1}>{firstName}</VText>
    </Pressable>
  );
}

// .fr-row — browse-pane row: avatar · name + "Friend" · Joined chip | Invite.
function FriendRow({ friend, first, joined, onInvite }: { friend: Friend; first: boolean; joined: boolean; onInvite: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: surface.paddingY(9), borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft }}>
      <Avatar imageUrl={friend.imageUrl} name={friend.name} size={42} initialsSize={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText surface="compactList" variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>{friend.name}</VText>
        <VText surface="compactList" variant="small" color="inkSoft">Friend</VText>
      </View>
      {joined ? (
        // .fr-in — translucent positive tint (design: color-mix positive 14%).
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: alpha(theme.positive, 0.14), borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Icon name="check" size={14} color={theme.positive} />
          <VText surface="compactList" variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.positive }}>Joined</VText>
        </View>
      ) : (
        // .fr-btn
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Invite ${friend.name}`}
          onPress={onInvite}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: theme.accent, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 8, opacity: pressed ? 0.85 : 1 })}
        >
          <Icon name="plus" size={14} color={theme.accentInk} />
          <VText surface="compactList" variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accentInk }}>Invite</VText>
        </Pressable>
      )}
    </View>
  );
}
