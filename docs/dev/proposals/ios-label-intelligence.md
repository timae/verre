# iOS label intelligence

**Status**: ACTIVE proposal. Created on branch `feature/ios-label-intelligence`.

## Goal

Let a host, co-host, or provider take or upload a bottle-label photo while adding an impression, then use on-device Apple capabilities to extract useful wine metadata and prefill the add form after user review.

The first version should improve data entry without changing the server contract. The existing add-wine API already accepts the fields we need: `name`, `producer`, `vintage`, `grape`, `type`, `region`, `country`, `vinification`, `description`, `purchaseUrl`, and `image`.

## Current app shape

The native add-impression screen lives at:

- `apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx`

The screen already has state and inputs for:

- Name
- Vintage
- Producer
- Type
- Variety, mapped to `grape`
- Region
- Country
- Process, mapped to `vinification`
- Description
- Purchase link
- Photo
- Optional position in the line-up

The photo pipeline lives in:

- `apps/mobile/src/components/moments/momentForm.tsx`

That pipeline currently uses `expo-image-picker` and `expo-image-manipulator`, downsizes images, recompresses to JPEG, and strips EXIF/GPS as a side effect of re-encoding. That behavior should stay. Server-side image handling remains the backstop.

There is already a comment in the add screen saying scan-label was deferred. This proposal turns that placeholder into a native iOS flow.

## User experience

### Entry points

The add-impression photo area should become a two-action surface:

- `Add photo`
- `Scan label`

If the user chooses `Add photo`, the app should keep the current behavior.

If the user chooses `Scan label`, the app should open the image picker or camera flow, set the selected image as the wine photo, and run label analysis.

If the user already picked a photo, the preview should expose a small `Scan label` action so they can run extraction on that existing image.

### Review before apply

The app must not silently overwrite form data. After scanning, show a bottom sheet titled `Found on label` with suggested fields.

Each row should show:

- Field name
- Suggested value
- Confidence indicator when available
- Apply control

The sheet should offer:

- Apply all empty fields
- Apply selected fields
- Replace a specific existing field
- Dismiss

Default behavior:

- Empty form fields can be filled by `Apply all`.
- Existing user-entered fields require explicit replacement.
- Low-confidence fields should be shown as suggestions, not automatically applied.

### Failure states

Handle these states in the sheet or near the photo preview:

- No readable text found.
- Label text found, but no useful fields parsed.
- Native scanner unavailable on this device or OS.
- Image could not be loaded.
- Scan interrupted or canceled.

None of these states should block saving the wine manually.

## Native architecture

### Preferred implementation

Create a small iOS native module exposed to React Native through Expo Modules.

Suggested module name:

- `VerreLabelScanner`

Suggested JS wrapper:

- `apps/mobile/src/lib/labelScan.ts`

Suggested native module location:

- `apps/mobile/modules/verre-label-scanner`

The module should expose one main function:

```ts
scanLabel(uri: string): Promise<LabelScanResult>
```

The native implementation should load the local image URI, run Apple Vision text recognition, normalize the observations, and return OCR lines plus parsed fields.

Relevant Apple APIs:

- Vision text recognition: https://developer.apple.com/documentation/vision/recognizing-text-in-images
- VisionKit ImageAnalyzer, useful to evaluate for richer image text interactions: https://developer.apple.com/documentation/visionkit/imageanalyzer
- Foundation Models, useful for a later structured parsing pass on supported OS/device combinations: https://developer.apple.com/documentation/foundationmodels

### Result shape

The JS-facing result should preserve both raw OCR and structured suggestions:

```ts
export type LabelScanResult = {
  rawText: string;
  lines: Array<{
    text: string;
    confidence: number;
    boundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  fields: {
    name?: string;
    producer?: string;
    vintage?: string;
    grape?: string;
    region?: string;
    country?: string;
    type?: WineTypeCode;
    vinification?: string;
    description?: string;
    purchaseUrl?: string;
  };
  confidence: Partial<Record<keyof LabelScanResult["fields"], number>>;
};
```

Bounding boxes should be normalized to image coordinates so the UI can later highlight detected label regions without changing the data contract.

## Parsing strategy

Use a layered parser. The first shipped version should work without network access and without relying on a generative model.

### Layer 1: OCR cleanup

Normalize OCR text before field extraction:

- Trim whitespace.
- Collapse repeated spaces.
- Preserve original line order.
- Keep both per-line text and full concatenated text.
- Strip obviously repeated OCR artifacts.
- Normalize common OCR substitutions only where safe, for example `2O19` to `2019` in a vintage candidate.

### Layer 2: deterministic extraction

Extract high-confidence fields with explicit rules:

- Vintage: four-digit year in a plausible range, for example 1900 through next calendar year.
- Purchase URL: `http`, `https`, or bare domain, later validated through the existing URL sanitizer.
- Type: map explicit terms to the existing server allow-list only:
  - red -> `red`
  - white -> `white`
  - sparkling, champagne, pet nat, cava, prosecco, sekt -> `spark`
  - rose, rosato, rosado -> `rose`
  - non-alcoholic, alcohol free, 0.0 -> `nonalc`
- Grape: dictionary match for common varieties and synonyms.
- Country: dictionary match to ISO 3166-1 alpha-2, matching server expectations.
- Region: dictionary match for common wine regions, with country-aware disambiguation where possible.
- Producer and name: heuristic ranking from prominent lines and remaining text after known fields are removed.

Producer and wine name are the hardest fields. They should be suggestions, not forced facts.

### Layer 3: Apple Intelligence enhancement

Add an optional Foundation Models pass only after the deterministic parser is in place.

Use it to convert OCR text into the same structured field schema. It should be:

- Gated by OS and device availability.
- Optional at runtime.
- On-device where Apple supports it.
- Disabled without breaking scanning.
- Constrained to the known field schema.

If the model returns a value outside app constraints, reject or normalize it through the same validation path as deterministic parsing.

The app should expose this as better suggestions, not as an autonomous decision maker.

## Security and privacy

This feature should be privacy-first by default.

### Data handling

- Do OCR on device.
- Do not send OCR text to Verre servers in v1.
- Do not persist raw OCR text.
- Do not log OCR text, parsed fields, or image paths.
- Do not upload extra scan artifacts.
- Reuse the current image pipeline for the photo that the user intentionally attaches to the wine.
- Keep EXIF/GPS stripping behavior.

### Input trust

OCR output is untrusted input. Treat it like pasted user text.

Required safeguards:

- Trim all field values.
- Enforce client-side length limits that mirror server behavior.
- Validate `purchaseUrl` as `http` or `https` only.
- Normalize `country` to ISO 3166-1 alpha-2.
- Only map `type` into `WineTypeCode`.
- Never construct code, selectors, or dynamic paths from OCR text.
- Never auto-submit a scanned wine.

### User control

The user must review suggestions before they are applied. This prevents bad OCR from accidentally creating misleading blind-tasting data.

### Apple capability boundaries

Avoid making Apple Intelligence the only implementation path. Apple Intelligence availability varies by OS version, hardware, language, region, and account settings. Vision OCR is the reliable base layer.

## Best-practice code shape

Keep parsing logic outside React components.

Suggested files:

- `apps/mobile/src/lib/labelScan.ts`
- `apps/mobile/src/lib/labelParser.ts`
- `apps/mobile/src/components/moments/LabelScanSheet.tsx`

Responsibilities:

- Native module: image loading and OCR.
- `labelParser.ts`: deterministic parsing and normalization.
- `labelScan.ts`: public JS facade, availability checks, native call wrapper.
- `LabelScanSheet.tsx`: review UI only.
- `add.tsx`: owns form state and applies selected suggestions.

This keeps the add screen from becoming a parser, native bridge, and UI state machine all at once.

## Proposed implementation phases

### Phase 1: iOS OCR bridge

- Add Expo native module for iOS.
- Implement `scanLabel(uri)`.
- Return raw text, line confidence, and bounding boxes.
- Add an availability check for iOS.
- Add a JS wrapper with a typed result.

Deliverable: a hidden or developer-triggered scan path that can return OCR results for a picked image.

### Phase 2: deterministic parser

- Add pure TypeScript parser.
- Add vintage, type, URL, country, region, and grape extraction.
- Add conservative producer/name heuristics.
- Add parser fixtures from anonymized label text samples.

Deliverable: `LabelScanResult.fields` has useful suggestions without generative AI.

### Phase 3: add-screen integration

- Update the photo picker surface with `Add photo` and `Scan label`.
- Run scan on a selected image.
- Add loading and failure states.
- Add `LabelScanSheet`.
- Apply selected fields into the existing form state.

Deliverable: users can scan a label and fill the add-impression form after review.

### Phase 4: Apple Intelligence enhancement

- Add Foundation Models structured extraction behind runtime availability.
- Compare model output against deterministic parser output.
- Keep deterministic parser as fallback.
- Surface low-confidence or conflicting fields as suggestions only.

Deliverable: better extraction on supported devices without breaking unsupported devices.

### Phase 5: polish and validation

- Add visual field confidence treatment.
- Add optional OCR bounding-box preview if useful.
- Test with real bottle labels, angled photos, glare, and multilingual labels.
- Validate no OCR data is logged or persisted.
- Confirm TestFlight build behavior.

## Testing plan

### Unit tests

Parser tests should cover:

- Vintage extraction and OCR mistakes.
- Type mapping.
- URL normalization and rejection.
- Country normalization.
- Region and grape extraction.
- Producer/name heuristics.
- Empty or noisy OCR text.

### Native validation

Manual device testing should cover:

- Photos library image.
- Camera image, if camera capture is added.
- Dark labels.
- Glare.
- Curved bottle labels.
- Multiple labels in one photo.
- Non-wine labels.
- Offline mode.
- Unsupported iOS or unsupported scanner state.

### App validation

Run:

```sh
npm run typecheck --workspace apps/mobile
npx expo run:ios
```

For native module changes, also validate through Xcode using:

- `apps/mobile/ios/Verre.xcworkspace`

## Open decisions

1. Should v1 support camera capture, photo library, or both?
2. Should scan run automatically after selecting a label photo, or only after tapping `Scan label`?
3. Do we want dictionaries shipped locally, or should some metadata lists come from the backend later?
4. Should raw OCR text ever be shown to users for manual copy/edit, or only structured suggestions?
5. Is iOS-only acceptable for v1, with Android getting manual entry until a separate ML Kit or server-side plan exists?
6. Should scanned suggestions be eligible for analytics, or should we deliberately avoid instrumentation around OCR content?

## Non-goals for v1

- No server-side OCR.
- No automatic wine creation.
- No background photo scanning.
- No persistent OCR history.
- No App Store dependency on Apple Intelligence availability.
- No backend schema changes unless later phases decide to store scan provenance.

## Recommended first PR scope

Ship the minimal useful path:

- iOS Vision OCR native module.
- Deterministic parser.
- Add-screen scan action.
- Review sheet.
- Apply-to-form behavior.
- Typecheck and manual device validation.

Leave Foundation Models integration for a follow-up PR after the base OCR path is working and testable.
