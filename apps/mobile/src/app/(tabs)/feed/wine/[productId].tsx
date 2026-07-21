import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { ClampText } from '@/components/ui/ClampText';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { StarScore } from '@/components/scoring/StarScore';
import { StructureWheel } from '@/components/scoring/StructureWheel';
import { buildWheelAxes, hasRatedAxes } from '@/lib/flavourAxes';
import { getWineProduct } from '@/lib/api/wines';
import { FOOT_CLEARANCE, GUTTER, usePhoneTokens } from '@/lib/layout';
import { wineTypeLabel } from '@/lib/momentFormat';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space, useTheme } from '@/theme';
import { countryName, formatScore, getAromaNode } from '@verre/core';

// Canonical wine product page (proposal: wine product pages). One page per
// real-world bottle, aggregating community ratings across every session/user.
// Reached from the impression detail's About block ("View wine page"). Data =
// GET /api/wines/[productId] (public, viewer-independent). Read-only.
export default function WineProductScreen() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const insets = useSafeAreaInsets();
  const axisColor = useFlavourColors();
  const { width } = useWindowDimensions();

  const { data: product, isPending, isError } = useQuery({
    queryKey: ['wine-product', productId],
    queryFn: () => getWineProduct(productId),
    enabled: !!productId,
  });

  const header = (
    <View style={{ paddingHorizontal: GUTTER }}>
      <VBar title={product?.name ?? 'Wine'} />
    </View>
  );

  if (isPending || isError || !product) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        {header}
        <CenteredMessage
          pending={isPending}
          title={isError ? "This wine isn't available" : 'Not found'}
          body={isError ? 'It may have been removed.' : undefined}
        />
      </View>
    );
  }

  const c = product.community;
  const country = product.country ? countryName(product.country) || product.country : '';
  const origin = [product.region, country].filter(Boolean).join(' · ');
  const producerLine = [product.producer, wineTypeLabel(product.type)].filter(Boolean).join(' · ');
  // Preserve frequency: the API returns nodes ordered by taster count desc.
  // Keep that order + show the count, rather than AromaReadChips' family
  // display-ordering (which drops counts and reorders) — the section is
  // literally "Most-noted", so frequency is the point.
  const topAromas = c.aromas
    .map((a) => ({ ...a, label: getAromaNode(a.node)?.label }))
    .filter((a): a is { node: string; count: number; label: string } => !!a.label)
    .slice(0, 12);
  const showWheel = hasRatedAxes(c.flavors as Record<string, number>, product.type);
  const axes = buildWheelAxes(c.flavors as Record<string, number>, product.type, axisColor);

  const rows: Array<[string, React.ReactNode]> = [];
  if (origin) rows.push(['Origin', <VText key="v" style={{ fontFamily: 'InstrumentSans_500Medium', ...phone.text('small') }}>{origin}</VText>]);
  if (product.grape) rows.push(['Variety', <ClampText key="v" text={product.grape} lines={2} medium />]);
  if (product.vinification) rows.push(['Process', <ClampText key="v" text={product.vinification} lines={2} medium />]);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      {header}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        showsVerticalScrollIndicator={false}
      >
        {/* Identity */}
        {product.imageUrl ? (
          <Image
            source={{ uri: product.imageUrl }}
            style={{ width: '100%', height: 200, borderRadius: radius.lg, marginBottom: space.md }}
            contentFit="contain"
            transition={120}
          />
        ) : null}
        <VText variant="title" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {product.name}
          {product.vintage ? <VText variant="title" color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular' }}>{` - ${product.vintage}`}</VText> : null}
        </VText>
        {producerLine ? (
          <VText color="inkSoft" variant="small" style={{ marginTop: 3 }}>{producerLine}</VText>
        ) : null}

        {/* Community rating summary */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: space.lg }}>
          {c.avgScore != null ? (
            <>
              <VText variant="display" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{formatScore(c.avgScore)}</VText>
              <View>
                <StarScore value={c.avgScore} />
                <VText color="inkSoft" variant="caption" style={{ marginTop: 3 }}>
                  {c.ratingCount} {c.ratingCount === 1 ? 'rating' : 'ratings'}
                  {c.tasterCount > 0 ? ` · ${c.tasterCount} ${c.tasterCount === 1 ? 'person' : 'people'}` : ''}
                </VText>
              </View>
            </>
          ) : (
            <VText color="inkSoft" variant="small">{c.tastingCount > 0 ? 'Tasted, not yet scored' : 'No ratings yet'}</VText>
          )}
        </View>

        {/* Community flavour wheel */}
        {showWheel ? (
          <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: theme.rule }}>
            <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 }}>
              Community flavour profile
            </VText>
            <View style={{ alignItems: 'center', marginTop: space.xs }}>
              <StructureWheel axes={axes} size={232} labels maxWidth={width - GUTTER * 2} />
            </View>
          </View>
        ) : null}

        {/* Most-noted aromas — ordered by taster count (frequency IS the point) */}
        {topAromas.length > 0 ? (
          <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: theme.rule }}>
            <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 }}>
              Most-noted aromas
            </VText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {topAromas.map((a) => (
                <View key={a.node} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: theme.surface, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <VText variant="small">{a.label}</VText>
                  <VText variant="caption" color="inkFaint">{a.count}</VText>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* About */}
        {(product.description || rows.length > 0) ? (
          <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: theme.rule }}>
            <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 }}>
              About this wine
            </VText>
            {product.description ? (
              <View style={{ marginBottom: rows.length ? 8 : 0 }}>
                <ClampText text={product.description} lines={4} />
              </View>
            ) : null}
            {rows.map(([label, value], i) => (
              <View key={label} style={{ flexDirection: 'row', gap: 14, paddingVertical: 9, borderBottomColor: theme.ruleSoft, borderBottomWidth: i === rows.length - 1 ? 0 : 1 }}>
                <VText color="inkSoft" variant="small" style={{ width: 78 }}>{label}</VText>
                <View style={{ flex: 1 }}>{value}</View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
