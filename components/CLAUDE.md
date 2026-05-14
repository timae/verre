# components/ — Shared UI primitives

Local rules for `components/*`. Root CLAUDE.md still applies; this is overlay context for the shared visual layer.

## Standing rule

**If a visual pattern appears in 3+ places, extract it into a shared component or constant.** Inline magic numbers and copy-pasted layout drift across commits — especially when multiple authors (or AI tools) are working on the project.

## Primitives in place

- **Color tokens** (`app/globals.css` CSS variables exposed via Tailwind). Use `var(--bg2)`, `var(--accent)`, `text-fg-dim`, etc. — never raw hex codes. Chrome-specific tokens for app shell (header / bottom nav / borders): `var(--chrome-bg)`, `var(--chrome-nav-bg)`, `var(--chrome-border)` — theme-aware (cream tones in light mode, dark warm-tinted in dark mode). Use these on any sticky header / fixed bottom nav rather than hardcoding `rgba(14,14,12,...)`-style literals. Role chip color for providers is `var(--accent-provider)`.
- **Element classes** (`.btn-p`, `.btn-g`, `.btn-s`, `.btn-del`, `.fi`, `.field`, `.fl`, `.panel`, `.chip`). Use these for buttons and form fields rather than re-styling inline.
- **`<ConfirmDeleteButton>`** (`components/ui/ConfirmDeleteButton.tsx`) — two-press destructive button with armed/pending/failed states. Use for any destructive action that previously would have called `window.confirm()`. Full-width `.btn-del` style.
- **`<DiscardButton>`** (`components/ui/DiscardButton.tsx`) — sibling of `<ConfirmDeleteButton>` for the "row destructive" case where the button sits in a flex row alongside Keep editing / Save (e.g. the unsaved-changes confirm modals in WineModal and AddWineModal). Same two-press semantics, fixed-width ghost button with red border, sized so the row layout doesn't reflow when armed.
- **`<UnsavedChangesConfirm>`** (`components/ui/UnsavedChangesConfirm.tsx`) — shared modal-on-modal confirm used by WineModal (uncommitted-rating) and AddWineModal (uncommitted-wine-metadata). Three resolutions wired by the caller: Discard → onDiscard, Keep editing → onKeep, Save → onSave (returns `Promise<boolean>`; on success the caller fires the queued nav, on failure the confirm stays open and surfaces `error`). Backdrop/Escape → onDismiss (Keep-editing semantics). Use this for any other modal that grows a dirty-guard prompt rather than re-rolling the button row.
- **Lightbox** (`components/ui/ImageLightbox.tsx`). Use `openLightbox(url, alt)` to display any image full-screen.
- **`<WineIdentity>`** (`components/wine/WineIdentity.tsx`) — canonical wine identity rendering: Name + Vintage on line 1, Producer on line 2, Grape on line 3. Three sizes (`compact` / `card` / `hero`) cover list rows, modal cards, and hero banners. Use this on every surface that displays a wine — never re-implement the field order inline. Surrounding chrome (image, accent bar, score, like button, "revealed" badge, etc.) stays in the call site.
- **`CHART_SIZE`** (`components/charts/sizes.ts`) — named PolarChart / RadarChart sizes (`THUMB` / `EMBED` / `DETAIL` / `COMPARE` / `HERO`) instead of inline pixel values. Pick the tier that matches the chart's *role* in the layout (glance, embedded with form, modal detail, side-by-side compare, hero interactive surface).
- **`<FlavorChips>`** (`components/rate/FlavorChips.tsx`) — canonical input surface for setting flavour intensity (none → intense, 0–5). Used in WineModal's Rate pane and CheckinModal. Tap-or-drag pill chips with a separate × clear button per row; the `INTENSITY` label array is shared with `<IntensityHelp>` (`components/rate/IntensityHelp.tsx`), the (i)-popover that explains the scale, so chip captions and help text can't drift.
- **`<StarRating>`** (`components/ui/StarRating.tsx`) + **`formatScore`** (`lib/formatScore.ts`) — canonical *read-side* score rendering. The component renders `★ <num>` in two size tiers (`compact` / `detail`); `formatScore(v)` is the same logic exported for non-component call sites (compare-page chips, history sublist rows where the full primitive would dominate the surrounding row). Use one of these on every surface that displays a score — never re-implement `★ ${v}` inline. Display rule (locked): single star + number, no `/5` denominator; whole numbers show `.0` (`4.0`), half-steps trim trailing zero (`4.5`), quarters keep both decimals (`4.25`); empty state (null/undefined/0/NaN) renders nothing.
- **`<ScoreSlider>`** (`components/ui/ScoreSlider.tsx`) — canonical *write-side* score input. Touch-and-drag slider (0..5, snaps to 0.25), tabular-nums + `.toFixed(2)` for stable digits during drag, full keyboard support via `role="slider"` + arrow/Page/Home/End handlers. Used in WineModal's Rate pane and CheckinModal. Replaces the old 5-button score row; if a third score-entry surface appears, route it through this primitive too.
- **`<Avatar>`** (`components/profile/Avatar.tsx`) — canonical user-avatar circle. Renders `<img>` when `imageUrl` is set, falls back to the user's initial letter on an accent-tinted background. Single `size` prop (pixels). Use this everywhere a user circle appears (ProfileHeader, ProfilePreviewInline, CheckinCard author byline, ProfilePanelPeople rows, AvatarEditor empty state). Two thin client wrappers add behavior: `<EditableAvatar>` (own avatar — tap opens AvatarEditor with optimistic UI + TanStack invalidation on save), `<ZoomableAvatar>` (other users — tap opens the full-screen lightbox).

## Pending extractions

Track for next time you touch the relevant area:

- `<WineIdentityFields>` — sibling for create/edit forms (CheckinModal, AddWineModal). Same canonical field order as `<WineIdentity>`.

## Modal primitive

**Modals use the shared `<Modal>` primitive.** `components/ui/Modal.tsx` handles `createPortal(children, document.body)` (so the overlay is never trapped in a parent stacking context — important because `.panel` uses `backdrop-filter` which creates a containing block for fixed descendants), backdrop click-to-close, Escape-key-to-close, and the standard sheet styling. New modal/overlay components should use it rather than re-rolling `position: fixed; inset: 0; …` boilerplate. `ImageLightbox` is the deliberate exception — it has unique styling needs (z-index 9999 to float over everything, full-black backdrop, center-aligned close button) and stays standalone.

The shared `<Modal>` also handles **iOS body scroll lock** while open (overflow:hidden + position:fixed + overscroll-behavior:contain on body). Nested modals don't double-lock; only the first one in the stack mutates body styles, and the last one out restores. Modal stack depth is exposed via `getModalStackDepth()` for callers that need to gate window-level handlers on "am I the topmost modal."

## iOS touch gestures (subdirectory-specific)

See `components/wine/CLAUDE.md` for pull-to-swap rules on the wine modal, and `docs/dev/ios-touch-gestures.md` for the full design history.
