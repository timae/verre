# 07 — Dynamic Type and scalable containers

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). Covers iOS/Android user font-size settings after the mobile readability pass: text already scales natively; this proposal is about preventing clipping, cramped rows, and mismatched caps when the platform applies Dynamic Type / font scaling.

## 1. Invariant

`phone.text(...)` is the authored size. The platform owns the multiplier.

React Native already applies the OS font-size setting to `<Text>` and `<TextInput>` from the explicit `fontSize` we provide. Do not read `fontScale` and multiply text sizes manually. Do not dampen the large-phone comfort bump when `fontScale` rises. That would fight the user's accessibility setting or double-apply the multiplier.

The gap is containers: a `height: 44` field does not grow just because the text inside it grows. Dynamic Type work is therefore a container/layout pass, not a typography-scale pass.

## 2. Policy

Each text surface gets one policy. The same policy controls both:
- the text cap (`maxFontSizeMultiplier`);
- the container growth factor.

This must be structurally enforced, not a convention. A call site should not be able to write `maxFontSizeMultiplier={1.3}` inline while sizing the container from a helper that assumes `1.5`. The policy object is the only place the cap is written.

Prefer an API shape where a wrapper or hook owns the surface for a subtree and hands down both the text cap and container helpers. Manual wiring at every call site is acceptable only as an intermediate migration step; the final form should make cap/container drift hard to express.

| Surface | Text behavior | Container behavior |
|---|---|---|
| Body copy / descriptions | Uncapped, wraps | Grow naturally through content; avoid fixed heights |
| Forms / text inputs | Uncapped or high cap, native text scaling | Grow field height and vertical padding with effective scale |
| Buttons | Native text scaling, usually one-line | Grow min height and padding; keep labels from clipping |
| Top bars | Title may truncate | Grow bar/action sizes; keep title one-line |
| Compact lists | Names/meta may truncate | Grow row padding/thumb-adjacent spacing |
| Carousel / fixed cards | Capped | Grow only to the cap, or redesign card height |
| Badges / codes / score numerals | Fixed-format or low cap | Fixed or low-growth containers |

## 3. Effective scale

Containers must follow the scale the text actually rendered with, not raw `fontScale`.

`useWindowDimensions().fontScale` is the value React Native reports for the user setting, but a surface with `maxFontSizeMultiplier={1.3}` will not render text beyond `1.3`. If its container grows from raw `fontScale=2.0`, the box over-grows while the text is capped.

Use a per-surface effective scale:

```ts
function effectiveFontScale(fontScale: number, maxFontSizeMultiplier?: number): number {
  return maxFontSizeMultiplier == null
    ? fontScale
    : Math.min(fontScale, maxFontSizeMultiplier);
}
```

All container math rounds to whole points inside the helper. Sub-point row heights and padding (`59.4`) create hairline misalignment and inconsistent border seating.

## 4. Proposed API shape

Define the surfaces centrally in the mobile layout/theme layer:

```ts
const FONT_SURFACES = {
  body: { maxFontSizeMultiplier: undefined },
  formControl: { maxFontSizeMultiplier: undefined },
  button: { maxFontSizeMultiplier: 1.6 },
  topBar: { maxFontSizeMultiplier: 1.4 },
  compactList: { maxFontSizeMultiplier: 1.35 },
  carousel: { maxFontSizeMultiplier: 1.3 },
  badge: { maxFontSizeMultiplier: 1.15 },
  code: { maxFontSizeMultiplier: 1.1 },
} as const;
```

The numbers above are initial policy values, not measured truths. Tune them on device against the validation matrix in §7.

The preferred API is a surface wrapper or scoped hook. The surface key is declared once, and descendants read both text props and container helpers from that same context:

```tsx
<FontSurface name="formControl">
  <FieldShell>
    <FieldInput />
  </FieldShell>
</FontSurface>
```

```ts
function FieldShell({ children }: { children: React.ReactNode }) {
  const surface = useFontSurface();
  return (
    <View
      style={{
        minHeight: surface.height(44),
        paddingVertical: surface.paddingY(10),
      }}
    >
      {children}
    </View>
  );
}

function FieldInput(props: TextInputProps) {
  const surface = useFontSurface();
  return <TextInput {...surface.textProps} {...props} />;
}
```

For leaf components that cannot reasonably use a wrapper, expose a helper that still returns both text props and rounded container helpers from the same surface:

```ts
const field = phone.surface('formControl');

<TextInput
  {...field.textProps}
  style={{
    minHeight: field.height(44),
    paddingVertical: field.paddingY(10),
  }}
/>
```

For `VText`:

```tsx
const row = phone.surface('compactList');

<VText {...row.textProps} numberOfLines={1}>
  {name}
</VText>
```

The important property is not the exact API name. It is that text caps and container scaling come from the same surface object, so they cannot drift.

## 5. Implementation pass

Do this primitives-first:

1. Add `fontScale` to `usePhoneMetrics()`, but use it only in surface/container helpers.
2. Add surface policies and effective-scale helpers.
3. Update shared primitives:
   - `VText` / surface text props;
   - `Button`;
   - `TextField`;
   - `NotesField`;
   - `VBar`;
   - date/select fields;
   - sheet/header controls.
4. Replace fixed `height` with `minHeight` + scaled `paddingVertical` where the control contains scalable text.
5. Audit nested `VText`: `maxFontSizeMultiplier` does not reliably inherit to nested text, so nested nodes must receive the same surface cap.

The existing large-phone comfort work stays separate. It sets the authored size and roomier control sizes for large devices. This pass makes the boxes adapt when the OS scales text.

## 6. CI gate

Add a dependency-free CI check, matching the shape of `scripts/check-mobile-design-tokens.mjs` + `.github/workflows/check-mobile-design-tokens.yml`. This is not optional process polish; it is what keeps the surface-policy invariant from becoming another convention that future changes bypass.

The gate should fail on:
- hand-edits to `apps/mobile/src/theme/vero-tokens.js` that are not a deliberate re-vendor;
- raw ordinary-text `fontSize` / `lineHeight` literals in `apps/mobile/src` outside allowlisted fixed-format components;
- direct `maxFontSizeMultiplier={...}` literals outside the surface-policy layer;
- scalable-text containers using fixed `height` where the surface helper should provide `minHeight` / rounded padding;
- `VText` nested inside capped text without the same surface cap or wrapper context;
- new `TextInput` instances that set text size without going through the shared phone/surface text path.

The gate should explicitly allow documented fixed-format text:
- invite/join codes;
- score numerals and numeric picker fields;
- PRO/map/badge labels;
- countdown cell labels;
- constrained carousel/card text while that surface remains fixed-height.

Suggested implementation:
- keep it static and dependency-free (`git ls-files`, read tracked TS/TSX/JS/JSX files);
- strip comments before scanning, like the existing design-token check;
- keep allowlists narrow and close to the script, with comments naming the fixed-format surface;
- run on `push` to `main` and on every `pull_request`;
- print actionable errors that name the replacement path (`VText` variant, `phone.surface(...)`, or the fixed-format allowlist).

Feasibility note: not every invariant above is equally grep-able. Vendored-file edits, raw ordinary `fontSize` / `lineHeight` literals, inline `maxFontSizeMultiplier` literals, and `TextInput` text-size bypasses are clean static checks. Container `height` misuse and nested capped `VText` inheritance are JSX-structure checks; implement them with an AST pass if they need to be hard gates, or document them as review-backed checks rather than pretending a line grep proves them.

This check should land with the Dynamic Type implementation branch, not later. The branch changes shared primitives and many call sites; without a gate, the next screen can reintroduce a local cap or hardcoded size and all other checks still stay green.

## 7. Known hotspots

- `Button`: fixed `36/44/52` heights can clip at larger font sizes.
- `TextField`: fixed `44` height while body text scales.
- Date/select fields: fixed `44` rows with one-line text.
- Top bars and hero bars: one-line titles are acceptable, but bar/control height must grow.
- Recent moments carousel: deliberately capped today because the card height is fixed. Keep it capped or redesign the card height; do not let raw `fontScale` over-grow its box.
- Line-up, people, and invite rows: truncation is acceptable for compact lists, but row padding should grow.
- Codes, score numerals, PRO badges, map pills, countdown cell labels: fixed-format or low-cap surfaces.

## 8. Validation matrix

Test on device/simulator with:
- default font size;
- one or two steps larger;
- largest accessibility size;
- smaller-than-default font size.

Check at least:
- create/add forms;
- moment main and Recent Moments;
- session line-up;
- impression detail;
- people and invite sheets;
- sticky footers with buttons;
- top bars over both plain and hero surfaces.

At maximum accessibility sizes, the goal is not pixel-perfect parity. The goal is no clipping, no unreadable overlap, and intentional truncation only where the surface policy says truncation is allowed.
