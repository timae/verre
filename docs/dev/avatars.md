# Avatars — implementation

Optional user-uploaded profile pictures, free for all users. The data column is `users.image_url` (nullable VARCHAR(512)). The S3 key shape is `avatars/u_<userId>_<timestamp>_<rand>.<ext>` (a random suffix since 2026-11-10: `Date.now()` alone collided under concurrent replaces); the URL stored in DB is the full `${ENDPOINT}/${BUCKET}/<key>`.

> Session **cover photos** (milestone 4) reuse this exact pipeline: same `uploadImage` hardening, same data-URL JSON shape, same replace-then-reclaim ordering. Key shape `sessions/<code>_<timestamp>.<ext>`; see `POST /api/session` + the settings PATCH.

## Edit endpoint

`POST /api/me/avatar` (replace) and `DELETE /api/me/avatar` (remove). Both gated by `isSameOrigin` + cookie auth. POST also rate-limited 10/h per user; DELETE is currently uncapped (see `app/api/rate-limits.md` rationale). POST takes `{imageData: dataURL}` JSON; the validation pipeline in `uploadImage` enforces MIME allow-list (`image/jpeg|png|webp|gif`), magic-byte signatures (SVG is explicitly excluded — XML can carry `<script>`), and a 2MB decoded-byte cap. Both routes run the shared **replace protocol** (`lib/profileImage.ts` `replaceProfileImage`): upload under a fresh unique key → transaction { `SELECT` the current URL `FOR UPDATE`, `UPDATE` } → COMMIT → reclaim the captured prior; zero rows (account deleted) or a failed update → reclaim the fresh upload. The prior URL is read UNDER the row lock, never before the upload, so concurrent replaces serialize and each reclaims exactly what it overwrote (the old route read the prior first and never cleaned up a failed update). On account-delete, `lib/accountDelete.ts` reads the avatar + cover under the same users-row lock and reclaims them after COMMIT; a replace blocked on that lock reclaims its own upload.

## Profile cover (native You profile, step 2)

`users.cover_photo_url` (nullable VARCHAR(512)), the user's own upload (camera / library only, ruling D2). `POST /api/me/cover` `{imageData}` → `{coverPhotoUrl}`, `DELETE /api/me/cover` → `{ok}`; the same `uploadImage` hardening and the same replace protocol. Key `avatars/cover_u_<userId>_<timestamp>_<rand>.<ext>` (the proven public-read prefix). POST is limited by its own `rl:profile-cover` 10/h (cover and photo uploads don't starve each other); DELETE is uncapped (it reclaims). Reclaimed on account delete. Pinned by `scripts/tests/you-profile-integration.mts` § 4–5.

## JPEG metadata strip

`lib/s3.ts:stripJpegMetadata` drops APP/COM segments before S3 to remove EXIF GPS. JPEG-only — iOS HEIC→JPEG conversion covers the camera path; PNG/WebP/GIF aren't stripped.

## Editor UX

`components/profile/AvatarEditor.tsx` is a `<Modal>` with file picker → `react-easy-crop` (round mask, square aspect, 1×–4× zoom slider, drag to reposition) → canvas crop to 512×512 JPEG @ 0.85 quality → POST. The canvas re-encode incidentally strips metadata (defense-in-depth alongside the server-side strip). Remove uses `<ConfirmDeleteButton>` with `btn-del` styling. Picker accepts `image/jpeg|png|webp` only — HEIC was dropped because non-Safari browsers can't decode it for the cropper.
