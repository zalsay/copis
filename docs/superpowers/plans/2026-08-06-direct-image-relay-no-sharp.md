# Direct Image Relay Without Sharp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send authorized PNG/JPEG images to Vision Relay models without Sharp preprocessing, and remove Sharp's native runtime payload from the Electron package.

**Architecture:** Keep the existing Vision Relay authorization, TOCTOU, regular-file, and byte-size checks. Replace Sharp decoding/re-encoding with a raw file buffer and preserve the original PNG/JPEG filename and MIME type. Remove Sharp from the Electron dependency, esbuild external list, runtime dependency synchronizer, and asar unpack rules; leave unrelated PDF.js native dependencies unchanged.

**Tech Stack:** Bun, TypeScript, Electron, esbuild, electron-builder, Bun test.

---

### Task 1: Lock the raw PNG/JPEG contract with a regression test

**Files:**
- Create: `apps/electron/src/main/lib/vision-relay-service.test.ts`
- Test: `apps/electron/src/main/lib/vision-relay-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create a focused test around `inspectImageWithVisionRelay()` that mocks settings, channel lookup, runtime API key resolution, model capability, adapter request construction, and SSE transport. Write real PNG and JPEG byte buffers to temporary files inside an allowed root. Assert the adapter receives the original filename, original MIME type, original byte size, and exact raw Base64 bytes. Add cases asserting `.gif`, `.webp`, `.bmp`, and `.svg` return `VISION_UNSUPPORTED_IMAGE` without calling the provider.

- [ ] **Step 2: Run the focused test and verify it fails for the old behavior**

Run:

```bash
bun test apps/electron/src/main/lib/vision-relay-service.test.ts
```

Expected: the PNG/JPEG assertions fail because the current implementation changes the filename and MIME type to `.jpg`/`image/jpeg`; unsupported-extension assertions fail for GIF/WebP because they are currently accepted.

### Task 2: Remove Sharp preprocessing and restrict Vision Relay formats

**Files:**
- Modify: `apps/electron/src/main/lib/vision-relay-service.ts:8-135`

- [ ] **Step 1: Restrict the extension map to PNG and JPEG**

Keep only `.png: image/png`, `.jpg: image/jpeg`, and `.jpeg: image/jpeg` in `SUPPORTED_IMAGE_TYPES`.

- [ ] **Step 2: Remove the Sharp import and normalization helper**

Delete the `sharp` import and `normalizeImageContent()` helper. Preserve the async resolver signature to avoid changing callers.

- [ ] **Step 3: Return the original file buffer and metadata**

After the existing descriptor/inode/size checks, use the fully read `sourceData` only when its length equals the opened file size. Reject empty or oversized buffers. Return `basename(resolvedPath)`, the extension-derived `mediaType`, `data.length`, and the original `Buffer`. Update the failure message so it no longer claims to decode or re-encode image content.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
bun test apps/electron/src/main/lib/vision-relay-service.test.ts
```

Expected: all raw PNG/JPEG and unsupported-format cases pass.

### Task 3: Remove Sharp from Electron runtime packaging

**Files:**
- Modify: `apps/electron/package.json:18,21,60`
- Modify: `apps/electron/scripts/sync-runtime-deps.ts:46-52`
- Modify: `apps/electron/electron-builder.yml:28-29`
- Modify: `apps/electron/scripts/browser-workflow-e2e.ts:40-51`
- Modify: `bun.lock` through Bun's lockfile regeneration

- [ ] **Step 1: Remove Sharp from package/build configuration**

Delete the `sharp` dependency, `--external:sharp` flags, the `sharp` runtime package entry, and Sharp/@img asar unpack patterns. Remove the stale Sharp external flag from the browser workflow build script. Do not remove `pdfjs-dist`, `@napi-rs`, or `detect-libc`, which have independent runtime consumers.

- [ ] **Step 2: Regenerate the lockfile with Bun**

Run:

```bash
bun install
```

Expected: the Electron importer and Sharp-only `sharp`, `@img/sharp-*`, `@img/colour`, and `sharp/semver` records disappear while shared packages such as `detect-libc` remain when still referenced.

### Task 4: Validate source, type, build, and dependency closure

**Files:**
- No additional source files.

- [ ] **Step 1: Run targeted regression tests**

```bash
bun test apps/electron/src/main/lib/vision-relay-service.test.ts
```

- [ ] **Step 2: Check remaining Sharp references**

```bash
rg -n -i "sharp|@img" apps/electron packages bun.lock --glob '!node_modules/**'
```

Expected: no runtime source, package, lockfile, or builder references; only explicitly stale documentation would be reported.

- [ ] **Step 3: Run typecheck and the main-process build**

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
```

Expected: both commands exit successfully and the generated main bundle no longer requires `sharp`.

- [ ] **Step 4: Review the final diff**

```bash
git diff --check
git diff -- apps/electron/src/main/lib/vision-relay-service.ts apps/electron/package.json apps/electron/scripts/sync-runtime-deps.ts apps/electron/electron-builder.yml apps/electron/scripts/browser-workflow-e2e.ts bun.lock docs/superpowers/plans/2026-08-06-direct-image-relay-no-sharp.md
```

Confirm unrelated dirty files remain untouched. Report that actual Electron-window visual confirmation and Windows packaging must still be performed by the user on the target platform.
