# 07 — Dynamic Type and scalable containers

**Status**: IMPLEMENTED — phase 1 (surface policy + hotspot pass + partial static gate). Part of the [mobile-app meta-proposal](README.md). Covers iOS/Android user font-size settings after the mobile readability pass: text already scales natively; this proposal is about preventing clipping, cramped rows, and mismatched caps when the platform applies Dynamic Type / font scaling.

As built: `apps/mobile/src/lib/layout.ts` owns `FONT_SURFACES`, `effectiveFontScale`, and `phone.surface(...)`. Shared primitives and the known mobile hotspots now consume those surfaces; `scripts/check-mobile-dynamic-type.mjs` plus `.github/workflows/check-mobile-dynamic-type.yml` enforce the grep-able invariants. The gate is deliberately a **partial static check**, not a proof of visual correctness; nested capped text and layout intent remain review/device-backed.

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
  score: { maxFontSizeMultiplier: 1.15 },
  code: { maxFontSizeMultiplier: 1.1 },
} as const;
```

The numbers above are initial policy values, not measured truths. Tune them on device against the validation matrix in §7.

The preferred final API is a surface wrapper or scoped hook. The phase-1 implementation uses the leaf-helper shape (`phone.surface(name)` plus `VText surface="..."`) rather than a context wrapper, because most affected sites are small leaf controls. The surface object is still the single source for both text caps and container math.

A future context wrapper can reduce manual wiring if more complex subtrees start drifting. Until then, the partial static gate blocks inline text caps and common fixed-height/text-input bypasses.

The wrapper shape remains the direction for larger subtrees:

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

For leaf components that cannot reasonably use a wrapper, the implemented helper returns both text props and rounded container helpers from the same surface:

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

For `VText`, the implemented API is:

```tsx
<VText surface="compactList" numberOfLines={1}>
  {name}
</VText>
```

The important property is not the exact API name. It is that text caps and container scaling come from the same surface object, so they cannot drift.

## 5. Implementation pass

Implemented primitives-first:

1. Add `fontScale` to `usePhoneMetrics()`, but use it only in surface/container helpers.
2. Add surface policies and effective-scale helpers.
3. Updated shared primitives and shared domain pieces:
   - `VText` / surface text props;
   - `Button`;
   - `TextField`;
   - `NotesField`;
   - `VBar`;
   - date/select fields;
   - score input/readout;
   - badges/role chips;
   - sheet/header controls.
4. Replaced fixed scalable-text containers with surface-backed `height`/`minHeight` and/or scaled padding. Single-line `TextInput` is the important exception: it keeps an explicit surface-scaled `height` and omits `lineHeight`, because iOS centers the entered glyph better without the paragraph line box.
5. Audited nested `VText`: `maxFontSizeMultiplier` does not reliably inherit to nested text, so nested nodes receive the same surface cap where capped.

The existing large-phone comfort work stays separate. It sets the authored size and roomier control sizes for large devices. This pass makes the boxes adapt when the OS scales text.

## 6. CI gate

Added a dependency-free partial CI check, matching the shape of `scripts/check-mobile-design-tokens.mjs` + `.github/workflows/check-mobile-design-tokens.yml`. It keeps the grep-able parts of the surface-policy invariant from becoming another convention that future changes bypass.

The implemented gate fails on:
- direct `maxFontSizeMultiplier={...}` and object-literal `maxFontSizeMultiplier: ...` outside the surface-policy layer;
- reintroduced local carousel cap constants;
- common fixed-height scalable-text containers using `36`/`44`/`52`/`control.h*` when a nearby subtree contains text;
- new `TextInput` / `BottomSheetTextInput` instances that set scalable body text without spreading surface text props.

It does **not** claim to prove:
- every raw ordinary-text `fontSize` / `lineHeight` literal is invalid;
- every possible fixed-height text container is caught (`height: phone.lerp(...)` still needs review);
- every nested capped `VText` inherits the same surface;
- vendored-token edits (that remains covered by `check-mobile-design-tokens` for its own constants, not this gate).

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

This check landed with the Dynamic Type implementation branch. The branch changes shared primitives and many call sites; without a gate, the next screen could reintroduce a local cap or hardcoded size and all other checks would still stay green.

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

Phase-1 device notes from the implementation pass:
- Moment home, Recent/Upcoming, Moment Details text fields, impression score input, People/Invite sheets, and line-up rows were checked interactively and adjusted for clipping/centering regressions.
- Still re-check default scale for Recent/Upcoming against the Vero handoff, because the accessibility fix allows title/meta to wrap to two lines and changes the resting row rhythm.
- Continue to test any screen touched by future UI work at default and largest accessibility sizes; the static gate is only a backstop.
