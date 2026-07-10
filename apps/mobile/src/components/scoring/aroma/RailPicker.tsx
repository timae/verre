import { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { AROMA_FAMILIES, getAromaNode } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, alpha } from '@/theme/color';
import { useTheme } from '@/theme';
import { AromaChip, ModifierRail, PronouncedRow, canonicalPair, capFirst, type AromaOps } from './parts';

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
function GroupBadge({ id, ops, onDrill }: { id: string; ops: AromaOps; onDrill: () => void }) {
  const { theme } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(id);
  if (!node) return null;
  const color = familyColor(node.family.id);
  const on = ops.isSelected(id);
  const tintedInk = mix(color, theme.ink, 0.7);
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
        backgroundColor: mix(color, theme.surface, on ? 0.2 : 0.09),
      }}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={on ? `${capFirst(node.label)} selected, tap to remove` : `Select all of ${node.label}`}
        onPress={() => ops.toggleNode(id)}
        hitSlop={6}
      >
        {on ? (
          <Icon name="check" size={18} color={tintedInk} />
        ) : (
          <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: alpha(color, 0.55) }} />
        )}
      </Pressable>
      <VText
        surface="badge"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13.5, color: on ? tintedInk : theme.ink }}
      >
        {capFirst(node.label)}
      </VText>
      <Icon name="chevron-right" size={14} color={tintedInk} />
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

  const family = path[0] ? AROMA_FAMILIES.find((f) => f.id === path[0]) : undefined;
  const subfamily = path[1] && family ? family.subfamilies.find((s) => s.id === path[1]) : undefined;
  const list: { id: string; drill: boolean }[] = subfamily
    ? subfamily.leaves.map((l) => ({ id: l.id, drill: false }))
    : family
      ? family.subfamilies.map((s) => ({ id: s.id, drill: true }))
      : AROMA_FAMILIES.map((f) => ({ id: f.id, drill: true }));
  const crumbs = [
    { label: 'All families', depth: 0 },
    ...path.map((id, i) => ({ label: capFirst(getAromaNode(id)?.label ?? id), depth: i + 1 })),
  ];

  const toggleAndArm = (id: string) => {
    const was = ops.isSelected(id);
    ops.toggleNode(id);
    setTarget(was ? (target === id ? null : target) : id);
  };

  const armed = target && ops.isSelected(target) ? target : null;

  return (
    <View>
      {/* breadcrumb — back chevron + trail; taps jump up the path */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 11, minHeight: 20 }}>
        {path.length ? (
          <Pressable accessibilityLabel="Back" onPress={() => setPath(path.slice(0, -1))} hitSlop={8}>
            <Icon name="back" size={19} color={theme.accent} />
          </Pressable>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, flex: 1 }}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={c.depth} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Pressable disabled={last} onPress={() => setPath(path.slice(0, c.depth))}>
                  <VText
                    surface="badge"
                    style={{
                      fontFamily: last ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium',
                      fontSize: 12.5,
                      color: last ? theme.ink : theme.accent,
                    }}
                  >
                    {c.label}
                  </VText>
                </Pressable>
                {!last ? <VText surface="badge" style={{ fontSize: 12.5, color: theme.inkFaint }}>›</VText> : null}
              </View>
            );
          })}
        </View>
      </View>
      {/* the rail — horizontal swipe at every tier */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingBottom: 6 }}>
        {list.map((n) =>
          n.drill ? (
            <GroupBadge key={n.id} id={n.id} ops={ops} onDrill={() => { setPath([...path, n.id]); }} />
          ) : (
            <AromaChip
              key={n.id}
              a={n.id}
              m={ops.modifierOf(n.id)}
              muted={!ops.isSelected(n.id)}
              pronounced={ops.isPronounced(n.id)}
              focused={armed === n.id}
              onPress={() => toggleAndArm(n.id)}
            />
          ),
        )}
      </ScrollView>
      {/* modifier block for the armed selection — edits are PAIR-precise
          (never collapse a node's second pair) and re-arm on the CANONICAL
          node so a promoted rewrite (grape+dried → raisin) keeps the block
          alive instead of stranding it (review findings). */}
      {armed ? (
        <View style={{ marginTop: 8, gap: 8 }}>
          <VText variant="small" color="inkSoft">
            Modifier for <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>{capFirst(getAromaNode(armed)?.label ?? armed)}</VText>
          </VText>
          <ModifierRail
            a={armed}
            value={ops.modifierOf(armed)}
            onChange={(m) => {
              ops.setModifierPair(armed, ops.modifierOf(armed), m);
              setTarget(canonicalPair(armed, m).a);
            }}
          />
          <PronouncedRow
            a={armed}
            on={ops.isPronounced(armed)}
            onToggle={() => ops.togglePronounced(armed, ops.modifierOf(armed))}
          />
        </View>
      ) : null}
    </View>
  );
}
