# Avatars — implementation

Optional user-uploaded profile pictures, free for all users. The data column is `users.image_url` (nullable VARCHAR(512)). The S3 key shape is `avatars/u_<userId>_<timestamp>.<ext>`; the URL stored in DB is the full `${ENDPOINT}/${BUCKET}/<key>`.

## Edit endpoint

`POST /api/me/avatar` (replace) and `DELETE /api/me/avatar` (remove). Both gated by `isSameOrigin` + cookie auth. POST also rate-limited 10/h per user; DELETE is currently uncapped (see `app/api/rate-limits.md` rationale). POST takes `{imageData: dataURL}` JSON; the validation pipeline in `uploadImage` enforces MIME allow-list (`image/jpeg|png|webp|gif`), magic-byte signatures (SVG is explicitly excluded — XML can carry `<script>`), and a 2MB decoded-byte cap. On replace, the prior URL is reclaimed from S3 fire-and-forget after the new upload + DB update succeed. On account-delete, `lib/accountDelete.ts` reclaims the avatar alongside check-in and wine images.

## JPEG metadata strip

`lib/s3.ts:stripJpegMetadata` drops APP/COM segments before S3 to remove EXIF GPS. JPEG-only — iOS HEIC→JPEG conversion covers the camera path; PNG/WebP/GIF aren't stripped.

## Editor UX

`components/profile/AvatarEditor.tsx` is a `<Modal>` with file picker → `react-easy-crop` (round mask, square aspect, 1×–4× zoom slider, drag to reposition) → canvas crop to 512×512 JPEG @ 0.85 quality → POST. The canvas re-encode incidentally strips metadata (defense-in-depth alongside the server-side strip). Remove uses `<ConfirmDeleteButton>` with `btn-del` styling. Picker accepts `image/jpeg|png|webp` only — HEIC was dropped because non-Safari browsers can't decode it for the cropper.
