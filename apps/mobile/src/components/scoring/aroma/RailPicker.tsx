import { useEffect, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { AROMA_FAMILIES, AROMA_SELECTION_CAP, getAromaNode } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, alpha, readableSolid } from '@/theme/color';
import { useTheme } from '@/theme';
import { AromaChip, AromaCrumbs, CapHint, ModifierRail, PronouncedRow, canonicalPair, capFirst, type AromaOps } from './parts';
import { aromaFillRatio } from './aromaTint';

// D · badge rail — the most condensed browse picker (09 · Aroma input, kept
// as one of the four device-test variants in the browse sheet). A horizontal
// rail of badges at the current tier with a breadcrumb above it: tap a badge
// to drill family → subfamily → leaves; the round mark on a coarse badge
// selects the WHOLE family/group (the any-tier ruling — coarse picks are
// honest data, stored at the taster's grain). Selecting a node arms the
// modifier block below the rail (modifier chips + the Pronounced toggle).

// One coarse-tier badge: select-dot (group-select) + name + drill chevron.
// The dot is a child Pressable inside the badge's Pressable — the inner
// control claims the touch, so a dot tap selects without also drilling (the
// device-verified 02b nested-pressable pattern; see AromaChip's note).
// hitSlop grows the dot toward the badge's own frame (RN clips slop to the
// PARENT bounds — the rail gotcha), right kept short of the label so a name
// tap still drills.
function GroupBadge({ id, ops, onDrill, onToggle }: { id: string; ops: AromaOps; onDrill: () => void; onToggle: () => void }) {
  const { theme, themeKey } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(id);
  if (!node) return null;
  const color = familyColor(node.family.id);
  const on = ops.isSelected(id);
  const fill = mix(color, theme.surface, aromaFillRatio(themeKey, node.family.id, on ? 0.2 : 0.09));
  // On-state words/marks: readableSolid (Simon's gallery ruling) — solid
  // palette colour where it clears 3:1 on the fill.
  const onWords = readableSolid(color, theme.ink, fill);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${capFirst(node.label)}, browse`}
      onPress={onDrill}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 6,
        paddingLeft: 9,
        paddingRight: 12,
        borderRadius: 999,
        backgroundColor: fill,
      }}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={on ? `${capFirst(node.label)} selected, tap to remove` : `Select all of ${node.label}`}
        onPress={onToggle}
        hitSlop={{ top: 8, bottom: 8, left: 10, right: 4 }}
      >
        {on ? (
          <Icon name="check" size={18} color={onWords} />
        ) : (
          <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: alpha(color, 0.55) }} />
        )}
      </Pressable>
      <VText
        surface="badge"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13.5, color: on ? onWords : theme.ink }}
      >
        {capFirst(node.label)}
      </VText>
      <Icon name="chevron-right" size={14} color={onWords} />
    </Pressable>
  );
}

export function RailPicker({ ops }: { ops: AromaOps }) {
  const { theme } = useTheme();
  // Drill path of node ids: [] = families, [familyId] = its subfamilies,
  // [familyId, subfamilyId] = its leaves.
  const [path, setPath] = useState<string[]>([]);
  // The node whose modifier block is armed (last selected on this rail).
  const [target, setTarget] = useState<string | null>(null);
  // Cap-rejected select — the pickers' shared honest-rejection answer
  // (warning haptic + the "Limit reached" hint; review finding: a rail
  // select over the 30 cap silently did nothing). Cleared once a removal
  // makes room, like usePendingAdd.
  const [capHit, setCapHit] = useState(false);
  useEffect(() => {
    if (ops.value.length < AROMA_SELECTION_CAP) setCapHit(false);
  }, [ops.value.length]);

  const family = path[0] ? AROMA_FAMILIES.find((f) => f.id === path[0]) : undefined;
  const subfamily = path[1] && family ? family.subfamilies.find((s) => s.id === path[1]) : undefined;
  const list: { id: string; drill: boolean }[] = subfamily
    ? subfamily.leaves.map((l) => ({ id: l.id, drill: false }))
    : family
      ? family.subfamilies.map((s) => ({ id: s.id, drill: true }))
      : AROMA_FAMILIES.map((f) => ({ id: f.id, drill: true }));
  // Level changes drop the armed block — a modifier block for a node the
  // rail no longer shows read as stale UI (review finding).
  const drillTo = (next: string[]) => {
    setPath(next);
    setTarget(null);
  };
  const toggleAndArm = (id: string) => {
    const was = ops.isSelected(id);
    if (!ops.toggleNode(id)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setCapHit(true);
      return;
    }
    setTarget(was ? (target === id ? null : target) : id);
  };

  const armed = target && ops.isSelected(target) ? target : null;
  // The armed block edits ONE pair — the node's stored selection. Reading
  // pronounced via the any-pair isPronounced while toggling the first pair
  // showed pair 2's state on a control that edits pair 1 (a node can carry
  // two pairs via search — fig AND dried fig; review finding).
  const armedSel = armed ? ops.selectionFor(armed) : undefined;

  return (
    <View>
      <AromaCrumbs path={path} onPop={(depth) => drillTo(path.slice(0, depth))} />
      {/* the rail — horizontal swipe at every tier */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingBottom: 6 }}>
        {list.map((n) => {
          if (n.drill) {
            // The dot toggles AND arms the modifier block — a coarse-tier
            // pick refines like any other (device finding: family/group
            // selects never showed the modifier/Pronounced block).
            return <GroupBadge key={n.id} id={n.id} ops={ops} onDrill={() => drillTo([...path, n.id])} onToggle={() => toggleAndArm(n.id)} />;
          }
          // The chip shows the node's STORED selection — one resolved pair
          // for both modifier AND pronounced (the any-pair isPronounced could
          // borrow pair 2's border onto pair 1's words when a node carries
          // two pairs via search; Codex finding).
          const sel = ops.selectionFor(n.id);
          return (
            <AromaChip
              key={n.id}
              a={n.id}
              m={sel?.m ?? null}
              muted={!sel}
              pronounced={!!sel?.p}
              focused={armed === n.id}
              onPress={() => toggleAndArm(n.id)}
            />
          );
        })}
      </ScrollView>
      {/* modifier block for the armed selection — edits are PAIR-precise
          (never collapse a node's second pair) and re-arm on the CANONICAL
          node so a promoted rewrite (grape+dried → raisin) keeps the block
          alive instead of stranding it (review findings). */}
      {armed && armedSel ? (
        <View style={{ marginTop: 8, gap: 8 }}>
          <VText variant="small" color="inkSoft">
            Modifier for <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>{capFirst(getAromaNode(armed)?.label ?? armed)}</VText>
          </VText>
          <ModifierRail
            a={armed}
            value={armedSel.m}
            onChange={(m) => {
              ops.setModifierPair(armed, armedSel.m, m);
              setTarget(canonicalPair(armed, m).a);
            }}
          />
          <PronouncedRow
            a={armed}
            on={!!armedSel.p}
            onToggle={() => ops.togglePronounced(armed, armedSel.m)}
          />
        </View>
      ) : null}
      {capHit ? (
        <View style={{ marginTop: 8 }}>
          <CapHint show />
        </View>
      ) : null}
    </View>
  );
}
