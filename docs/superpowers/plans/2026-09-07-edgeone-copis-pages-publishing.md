# EdgeOne Copis Pages Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in Copis Working user explicitly publish an HTML page package from Creation mode to one shared EdgeOne Makers project at `https://<edgeone-domain>/u-<working-user-id>/<page-slug>/`.

**Architecture:** The Copis Electron renderer selects and validates a local `index.html` page package through narrow IPC, while the Electron main process forwards the authenticated Working identity to an EdgeOne base project's publish Cloud Function. The function derives the user ID by verifying the bearer token with the Copis backend, writes every deployment under a new Blob revision using the base project's runtime-authorized Blob store, and updates `active.json` only after all files are present. A catch-all EdgeOne Cloud Function redirects missing trailing slashes, resolves the active revision, and streams the requested file with manifest-defined MIME headers.

**Tech Stack:** Bun workspace, TypeScript, React 18, Jotai, Electron IPC, Bun test, EdgeOne Makers Cloud Functions, `@edgeone/pages-blob@0.0.16`, EdgeOne Blob.

**Spec:** Approved product decisions in the 2026-09-07 Copis conversation: publish HTML page packages (not Vite projects); use stable `u-<WorkingUser.id>` paths; do not distribute shared EdgeOne credentials; use revisioned Blob objects and an active manifest; support relative `./assets/...` references; preserve the Working authentication boundary.

## Global Constraints

- The EdgeOne base project's Cloud Function accesses Blob with `getStore(EDGEONE_PAGES_BLOB_STORE)` and platform-injected project authority. No Electron renderer, preload API, local config file, or published page receives an EdgeOne API token; `projectId + token` is reserved for external administrative scripts and is not part of this feature.
- The publisher must not accept a user ID from the desktop client. The EdgeOne publish function verifies the Working bearer token against the Copis backend `/api/users/me` endpoint and derives `u-<id>` itself.
- A publishable package is either one selected `index.html` file or a directory whose root contains `index.html` and optional `assets/` files. Generated default pages remain compatible with the existing single-file `workspace-builder` skill.
- Public HTML must use relative asset paths such as `./assets/style.css`; requests for `/u-42/portfolio` redirect to `/u-42/portfolio/` before serving HTML.
- Allow only ordinary files, reject symbolic links and path traversal, and limit each object to 25 MB and each package to 50 MB before upload.
- Supported publishable extensions are `.html`, `.css`, `.js`, `.mjs`, `.json`, `.txt`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, and `.map`. Files with another extension are rejected rather than guessed.
- Use `X-Content-Type-Options: nosniff`; store `contentType` and `cacheControl` for each file in the manifest and stream Blob reads instead of decoding assets as text.
- Use Jotai for renderer state. The user must click an explicit publish confirmation control; generation must never publish externally as a side effect.
- Comments and logs added by implementation are Chinese. Do not modify `README.md` or `AGENTS.md` unless the user separately approves documentation changes.
- Follow BDD: each behavior below gets a focused failing test before production code. Electron UI visual and interaction acceptance remains a user check in the actual app window, not a screenshot check.

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/types/edgeone-pages.ts` | Versioned desktop IPC contracts and publish-package metadata shared by main, preload, and renderer. |
| `packages/shared/src/types/edgeone-pages.test.ts` | Contract and route/slug invariants that do not require Electron or EdgeOne. |
| `packages/shared/src/types/dsh.ts` | New Creation-to-Copis client event and narrow DSH publish IPC channel names. |
| `apps/edgeone-copis-pages/package.json` | Isolated EdgeOne Makers base-project workspace with the pinned Blob dependency and test scripts. |
| `apps/edgeone-copis-pages/src/page-contract.ts` | Pure path, MIME, manifest, and public-route helpers shared by functions and tests. |
| `apps/edgeone-copis-pages/cloud-functions/api/publish.ts` | Authenticated publish HTTP function: verifies Working identity, validates input, writes a revision, and commits the manifest. |
| `apps/edgeone-copis-pages/cloud-functions/[[default]].ts` | Public catch-all function: slash redirect, tenant route resolution, manifest lookup, streaming Blob response. |
| `apps/edgeone-copis-pages/src/*.test.ts` | BDD unit tests for every publish and read boundary without real credentials. |
| `apps/electron/src/main/lib/edgeone-page-package-service.ts` | Filesystem package scanner and deterministic request builder; owns local path and size safety checks. |
| `apps/electron/src/main/lib/edgeone-page-publish-service.ts` | Main-process authenticated request client; reads Working token only in main and maps remote errors to user-safe messages. |
| `apps/electron/src/main/lib/edgeone-page-*.test.ts` | BDD tests for package scanning, request authentication, and error mapping. |
| `apps/electron/src/main/ipc.ts` | Registers picker, package inspection, and publish IPC handlers. |
| `apps/electron/src/preload/index.ts` | Exposes only page selection/inspection/publish operations, never tokens or EdgeOne configuration. |
| `apps/electron/src/renderer/atoms/edgeone-page-publish.ts` | Jotai state and async actions for the publish panel. |
| `apps/electron/src/renderer/components/creation/CopisCreationPublishView.tsx` | Creation-mode publish panel with selection, slug, preflight results, confirmation, progress, error, and public URL. |
| `apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx` | BDD UI tests for explicit confirmation and all visible states. |
| `apps/electron/src/renderer/components/creation/CopisCreationWebView.tsx` | Registers the `page-publish` subview and renders the new panel beside the DSH native view. |
| `apps/electron/src/preload/dsh-bridge-preload.ts` | Allows the bundled Creation web UI to request opening the publish subview; it does not perform publication. |

### Task 1: Define the shared page-publishing contract

**Files:**
- Create: `packages/shared/src/types/edgeone-pages.ts`
- Create: `packages/shared/src/types/edgeone-pages.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/dsh.ts`

**Interfaces:**
- Consumes: `WorkingUser.id` only as the server-derived route identity; renderer requests do not contain this field.
- Produces: `EdgeOnePagePublishRequest`, `EdgeOnePagePublishResult`, `EdgeOnePagePackageInspection`, `EdgeOnePageFile`, `EdgeOnePageManifest`, and `DSH_CORDIS_IPC_CHANNELS` additions consumed by Tasks 2-6.

- [ ] **Step 1: Write failing shared-contract BDD tests**

```ts
import { expect, test } from 'bun:test'
import {
  buildEdgeOnePublicUrl,
  normalizeEdgeOnePageSlug,
  type EdgeOnePagePublishRequest,
} from './edgeone-pages'

test('Given a safe page slug, when building a public URL, then it ends with a trailing slash', () => {
  expect(buildEdgeOnePublicUrl('https://copis.example.com', 'u-42', 'portfolio'))
    .toBe('https://copis.example.com/u-42/portfolio/')
})

test('Given a traversal or reserved slug, when normalizing it, then publication is rejected', () => {
  expect(() => normalizeEdgeOnePageSlug('../admin')).toThrow('页面地址只允许小写字母、数字和连字符')
  expect(() => normalizeEdgeOnePageSlug('assets')).toThrow('页面地址不能使用保留名称')
})

test('Given a desktop publish request, then it has no user identity or storage credential field', () => {
  const request: EdgeOnePagePublishRequest = {
    slug: 'portfolio',
    files: [{ path: 'index.html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=', contentType: 'text/html; charset=utf-8' }],
  }
  expect(Object.keys(request)).toEqual(['slug', 'files'])
})
```

- [ ] **Step 2: Run the shared tests and verify RED**

Run: `bun test packages/shared/src/types/edgeone-pages.test.ts`

Expected: FAIL because the page-publishing module and contracts do not exist.

- [ ] **Step 3: Add the minimal versioned contracts and route helpers**

```ts
export const EDGEONE_PAGE_PACKAGE_VERSION = 1 as const
export const EDGEONE_PAGE_MAX_FILE_BYTES = 25 * 1024 * 1024
export const EDGEONE_PAGE_MAX_PACKAGE_BYTES = 50 * 1024 * 1024

export interface EdgeOnePageFile {
  path: string
  contentBase64: string
  contentType: string
  cacheControl: string
}

export interface EdgeOnePagePublishRequest {
  slug: string
  files: EdgeOnePageFile[]
}

export interface EdgeOnePagePublishResult {
  publicUrl: string
  revisionId: string
  publishedAt: string
}

export interface EdgeOnePagePackageInspection {
  sourcePath: string
  slugSuggestion: string
  files: Array<Pick<EdgeOnePageFile, 'path' | 'contentType' | 'cacheControl'> & { size: number }>
  totalBytes: number
}

export interface EdgeOnePageManifestFile {
  path: string
  contentType: string
  cacheControl: string
  size: number
}

export interface EdgeOnePageManifest {
  version: typeof EDGEONE_PAGE_PACKAGE_VERSION
  revisionId: string
  publishedAt: string
  files: EdgeOnePageManifestFile[]
}
```

Add `COPIS_OPEN_PAGE_PUBLISH` to `DshClientEvent` and `OPEN_PAGE_PACKAGE_DIALOG`, `INSPECT_PAGE_PACKAGE`, and `PUBLISH_PAGE_PACKAGE` to `DSH_CORDIS_IPC_CHANNELS`. `normalizeEdgeOnePageSlug` must accept `^[a-z0-9]+(?:-[a-z0-9]+)*$`, reject `assets`, `api`, `cloud-functions`, and `index`, and `buildEdgeOnePublicUrl` must remove one-or-more trailing slashes from the configured origin before constructing a single trailing-slash URL.

- [ ] **Step 4: Run the shared tests and typecheck**

Run: `bun test packages/shared/src/types/edgeone-pages.test.ts && bun run --filter='@copis/shared' typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/shared/src/types/edgeone-pages.ts packages/shared/src/types/edgeone-pages.test.ts packages/shared/src/types/index.ts packages/shared/src/types/dsh.ts
git commit -m "feat: define edgeone page publish contracts"
```

### Task 2: Scaffold the credential-owning EdgeOne base project and pure route helpers

**Files:**
- Create: `apps/edgeone-copis-pages/package.json`
- Create: `apps/edgeone-copis-pages/edgeone.json`
- Create: `apps/edgeone-copis-pages/.env.example`
- Create: `apps/edgeone-copis-pages/src/page-contract.ts`
- Create: `apps/edgeone-copis-pages/src/page-contract.test.ts`

**Interfaces:**
- Consumes: Task 1's request, manifest, file, and size contracts.
- Produces: `validatePublishRequest`, `makeRevisionPrefix`, `makeActiveManifestKey`, `parsePublicPageRoute`, and `resolvePublishFileHeaders` for the publish and reader functions.

- [ ] **Step 1: Write failing function-contract BDD tests**

```ts
import { expect, test } from 'bun:test'
import { parsePublicPageRoute, validatePublishRequest } from './page-contract'

test('Given an encoded traversal asset path, when validating publish input, then it is rejected', () => {
  expect(() => validatePublishRequest({
    slug: 'portfolio',
    files: [{ path: 'assets/%2e%2e/index.html', contentBase64: 'AA==', contentType: 'text/plain' }],
  })).toThrow('文件路径无效')
})

test('Given a stable page route without a final slash, when parsing it, then the reader requests a redirect', () => {
  expect(parsePublicPageRoute('/u-42/portfolio')).toEqual({ kind: 'redirect', location: '/u-42/portfolio/' })
})

test('Given an image path in a page route, when parsing it, then it keeps the user and slug boundaries', () => {
  expect(parsePublicPageRoute('/u-42/portfolio/assets/hero.webp')).toEqual({
    kind: 'file', userSegment: 'u-42', slug: 'portfolio', relativePath: 'assets/hero.webp',
  })
})
```

- [ ] **Step 2: Run the function-contract test and verify RED**

Run: `bun test apps/edgeone-copis-pages/src/page-contract.test.ts`

Expected: FAIL because the base project and helpers do not exist.

- [ ] **Step 3: Add the EdgeOne project metadata, locked dependency, and configuration contract**

Create a private workspace package named `@copis/edgeone-pages` with scripts `test`, `test:unit`, and `deploy`. Pin `@edgeone/pages-blob` to `0.0.16`; do not use a caret range. Configure `edgeone.json` for Node Cloud Functions and static fallback. The project must contain no user-generated static content, so the catch-all function remains the reader for every public page.

`.env.example` documents names only, never values:

```dotenv
EDGEONE_PAGES_BLOB_STORE=copis-pages
COPIS_WORKING_API_BASE_URL=https://api.copis.example.com
COPIS_PAGE_PUBLIC_ORIGIN=https://copis.example.com
```

Do not add `EDGEONE_ACCESS_TOKEN` to Electron config. In deployed Makers Functions, initialize Blob exclusively with `getStore(EDGEONE_PAGES_BLOB_STORE)`; the runtime supplies project authorization automatically.

- [ ] **Step 4: Implement pure validation and routing helpers**

`validatePublishRequest` must enforce all global extension, duplicate-path, base64-decoding, per-file, total-size, root-`index.html`, and content-type constraints. It must return decoded files only after all checks pass. `parsePublicPageRoute` must accept only `/u-<positive integer>/<slug>/[asset path]`, redirect the page root without a trailing slash, default the empty asset segment to `index.html`, and return `not-found` for malformed or decoded traversal paths. `resolvePublishFileHeaders` must preserve manifest `contentType` and assign `public, max-age=300, must-revalidate` to `index.html` and `public, max-age=31536000, immutable` to all other assets.

- [ ] **Step 5: Run the EdgeOne pure tests**

Run: `bun test apps/edgeone-copis-pages/src/page-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the base project scaffold**

```bash
git add apps/edgeone-copis-pages bun.lock
git commit -m "feat: add edgeone pages base project"
```

### Task 3: Implement the authenticated, atomic EdgeOne publish function

**Files:**
- Create: `apps/edgeone-copis-pages/cloud-functions/api/publish.ts`
- Create: `apps/edgeone-copis-pages/src/publish-service.ts`
- Create: `apps/edgeone-copis-pages/src/publish-service.test.ts`

**Interfaces:**
- Consumes: `EdgeOnePagePublishRequest`, validated decoded files, `getStore`, `COPIS_WORKING_API_BASE_URL`, and `COPIS_PAGE_PUBLIC_ORIGIN`.
- Produces: `publishPage(request, dependencies): Promise<EdgeOnePagePublishResult>` and a `POST /api/publish` HTTP endpoint.

- [ ] **Step 1: Write failing BDD tests for authentication and manifest-last updates**

```ts
test('Given an unauthenticated request, when publishing, then the function returns 401 before Blob writes', async () => {
  const result = await publishPageRequest(new Request('https://pages.example/api/publish', { method: 'POST' }), deps)
  expect(result.status).toBe(401)
  expect(deps.store.set).not.toHaveBeenCalled()
})

test('Given a bearer token and client-supplied user id, when publishing, then the verified user id owns the revision', async () => {
  deps.fetchWorkingUser.mockResolvedValue({ id: 42 })
  await publishPageRequest(requestWithBody({ userId: 999, slug: 'portfolio', files }), deps)
  expect(deps.store.set.mock.calls.map(([key]) => key)).toContain('pages/u-42/portfolio/active.json')
  expect(deps.store.set.mock.calls.map(([key]) => key).join('\n')).not.toContain('u-999')
})

test('Given a file write failure, when publishing a revision, then active.json is never written', async () => {
  deps.store.set.mockRejectedValueOnce(new Error('Blob unavailable'))
  await expect(publishPage({ slug: 'portfolio', files }, deps)).rejects.toThrow('页面文件上传失败')
  expect(deps.store.set.mock.calls.map(([key]) => key)).not.toContain('pages/u-42/portfolio/active.json')
})
```

- [ ] **Step 2: Run the publish-service test and verify RED**

Run: `bun test apps/edgeone-copis-pages/src/publish-service.test.ts`

Expected: FAIL because the service and HTTP endpoint do not exist.

- [ ] **Step 3: Implement the identity boundary and atomic write sequence**

The endpoint accepts only `POST`, requires `Authorization: Bearer <token>`, and limits request parsing to `EDGEONE_PAGE_MAX_PACKAGE_BYTES` plus JSON overhead. Call `${COPIS_WORKING_API_BASE_URL}/api/users/me` with that bearer token. On any non-2xx or invalid `{ id }` response, return `401` and do not expose backend response bodies.

Build all object keys from the verified identity and normalized slug:

```text
pages/u-42/portfolio/revisions/<revision-id>/index.html
pages/u-42/portfolio/revisions/<revision-id>/assets/style.css
pages/u-42/portfolio/active.json
```

Generate `revisionId` with `crypto.randomUUID()`. Upload every decoded file to its revision key with `store.set(key, bytes, { cacheControl })`; then write one JSON `EdgeOnePageManifest` to `active.json` as the final Blob operation. Return only `{ publicUrl, revisionId, publishedAt }`. If a revision upload fails, report a 502-style publish failure and leave `active.json` unchanged; orphaned revision objects are harmless and must never be visible from a stable URL.

- [ ] **Step 4: Run the service tests and inspect the write order**

Run: `bun test apps/edgeone-copis-pages/src/publish-service.test.ts`

Expected: PASS, including the assertion that `active.json` is the last successful write.

- [ ] **Step 5: Commit the publish function**

```bash
git add apps/edgeone-copis-pages/cloud-functions/api/publish.ts apps/edgeone-copis-pages/src/publish-service.ts apps/edgeone-copis-pages/src/publish-service.test.ts
git commit -m "feat: publish copis pages through edgeone"
```

### Task 4: Implement the public EdgeOne page reader

**Files:**
- Create: `apps/edgeone-copis-pages/cloud-functions/[[default]].ts`
- Create: `apps/edgeone-copis-pages/src/public-reader.ts`
- Create: `apps/edgeone-copis-pages/src/public-reader.test.ts`

**Interfaces:**
- Consumes: `parsePublicPageRoute`, `EdgeOnePageManifest`, `getStore`, revisioned Blob objects, and reader header helpers from Task 2.
- Produces: `servePublicPage(request, dependencies): Promise<Response>` used by the EdgeOne catch-all function.

- [ ] **Step 1: Write failing reader BDD tests**

```ts
test('Given a public page root without a trailing slash, when requested, then it redirects before looking up Blob', async () => {
  const response = await servePublicPage(new Request('https://copis.example.com/u-42/portfolio'), deps)
  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('/u-42/portfolio/')
  expect(deps.store.get).not.toHaveBeenCalled()
})

test('Given an active manifest and CSS asset, when requested, then the reader streams it with its manifest MIME type', async () => {
  deps.store.get.mockResolvedValueOnce(JSON.stringify(manifest)).mockResolvedValueOnce(new ReadableStream())
  const response = await servePublicPage(new Request('https://copis.example.com/u-42/portfolio/assets/style.css'), deps)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
})

test('Given a request that crosses a tenant boundary, when requested, then the reader returns 404', async () => {
  const response = await servePublicPage(new Request('https://copis.example.com/u-42/portfolio/%2e%2e/u-43/index.html'), deps)
  expect(response.status).toBe(404)
})
```

- [ ] **Step 2: Run the reader test and verify RED**

Run: `bun test apps/edgeone-copis-pages/src/public-reader.test.ts`

Expected: FAIL because the public reader does not exist.

- [ ] **Step 3: Stream only manifest-listed files from the active revision**

`[[default]].ts` constructs the Blob store inside the deployed function and delegates to `servePublicPage`. The reader must read `active.json`, parse and validate its manifest, verify that the requested relative path exactly matches a manifest entry, and call `store.get(revisionKey, { type: 'stream' })`. Return `new Response(stream, { headers })` with the exact manifest `contentType`, cache-control policy, and `X-Content-Type-Options: nosniff`.

Return `404` for a missing/corrupt manifest, an unknown file, a Blob miss, a malformed route, or a tenant/slug mismatch. Do not fall back to `getWithHeaders()` because it decodes body content as text and corrupts binary assets.

- [ ] **Step 4: Run reader tests and the complete EdgeOne unit suite**

Run: `bun test apps/edgeone-copis-pages/src/page-contract.test.ts apps/edgeone-copis-pages/src/publish-service.test.ts apps/edgeone-copis-pages/src/public-reader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the public reader**

```bash
git add apps/edgeone-copis-pages/cloud-functions/[[default]].ts apps/edgeone-copis-pages/src/public-reader.ts apps/edgeone-copis-pages/src/public-reader.test.ts
git commit -m "feat: serve revisioned edgeone copis pages"
```

### Task 5: Build the main-process page package and authenticated publish services

**Files:**
- Create: `apps/electron/src/main/lib/edgeone-page-package-service.ts`
- Create: `apps/electron/src/main/lib/edgeone-page-package-service.test.ts`
- Create: `apps/electron/src/main/lib/edgeone-page-publish-service.ts`
- Create: `apps/electron/src/main/lib/edgeone-page-publish-service.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts, Node filesystem APIs, `getWorkingTokenStore().getToken()`, and a configured public EdgeOne publish endpoint.
- Produces: `inspectPagePackage(sourcePath)`, `buildPagePublishRequest(sourcePath, slug)`, and `publishEdgeOnePage(request)` for IPC handlers in Task 6.

- [ ] **Step 1: Write failing filesystem BDD tests**

```ts
test('Given a directory with root index.html and assets, when inspecting it, then the files use package-relative paths', async () => {
  await writeFixture('index.html', '<link rel="stylesheet" href="./assets/style.css">')
  await writeFixture('assets/style.css', 'body { color: black }')
  await expect(inspectPagePackage(fixtureDirectory)).resolves.toMatchObject({
    files: [{ path: 'index.html' }, { path: 'assets/style.css' }],
  })
})

test('Given a selected directory without root index.html, when inspecting it, then it is rejected', async () => {
  await expect(inspectPagePackage(fixtureDirectory)).rejects.toThrow('页面目录必须包含 index.html')
})

test('Given a symbolic link in the selected package, when inspecting it, then it is rejected', async () => {
  await createFixtureSymlink('assets/outside.png', outsideFile)
  await expect(inspectPagePackage(fixtureDirectory)).rejects.toThrow('页面包不允许包含符号链接')
})
```

- [ ] **Step 2: Run the package-service test and verify RED**

Run: `bun test apps/electron/src/main/lib/edgeone-page-package-service.test.ts`

Expected: FAIL because the package service does not exist.

- [ ] **Step 3: Implement package inspection and serialization**

Resolve the selected file or directory using real paths. A file must itself be named `index.html`; a directory must have `index.html` at its root. Recursively enumerate only regular files, reject symlinks before reading, normalize package paths to POSIX separators, enforce Task 1's extension and byte limits, and sort paths lexicographically for deterministic progress and tests.

Use a single extension-to-MIME map shared with the EdgeOne project by duplicating the narrow data table in this desktop service or moving that data table into `@copis/shared`; do not infer MIME from user-supplied values. `buildPagePublishRequest` reads the validated bytes, produces base64 file bodies, uses `text/html; charset=utf-8`, `text/css; charset=utf-8`, and JavaScript `text/javascript; charset=utf-8` where applicable, and uses the cache policy defined in Task 2.

- [ ] **Step 4: Write failing authentication-boundary BDD tests**

```ts
test('Given no Working session, when publishing, then the main process rejects before fetch', async () => {
  tokenStore.getToken.mockReturnValue(null)
  await expect(publishEdgeOnePage(request, deps)).rejects.toThrow('请先登录 Copis Working 后再发布页面')
  expect(fetch).not.toHaveBeenCalled()
})

test('Given a Working token, when publishing, then it is sent only as the Authorization header', async () => {
  tokenStore.getToken.mockReturnValue('working-token')
  await publishEdgeOnePage(request, deps)
  expect(fetch).toHaveBeenCalledWith('https://copis.example.com/api/publish', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer working-token' }),
  }))
  expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('token')
})
```

- [ ] **Step 5: Implement the main-only publisher and configuration boundary**

`EdgeOnePagePublishService` reads the Working token through an internal `WorkingTokenStore` dependency; it must never add a `getToken` method to preload or renderer-visible contracts. Add a main-only configuration getter for `COPIS_EDGEONE_PAGE_PUBLISH_URL` and reject unset or non-HTTPS production values at startup/first use. POST only the Task 1 request JSON and the bearer header, set a 60-second `AbortSignal.timeout`, map `401` to re-login guidance, `413` to package-size guidance, `400` to the function's safe validation message, and other failures to a retryable publication error. Do not log the bearer token or request body.

- [ ] **Step 6: Run the focused desktop service tests**

Run: `bun test apps/electron/src/main/lib/edgeone-page-package-service.test.ts apps/electron/src/main/lib/edgeone-page-publish-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the desktop services**

```bash
git add apps/electron/src/main/lib/edgeone-page-package-service.ts apps/electron/src/main/lib/edgeone-page-package-service.test.ts apps/electron/src/main/lib/edgeone-page-publish-service.ts apps/electron/src/main/lib/edgeone-page-publish-service.test.ts
git commit -m "feat: add authenticated edgeone page publisher"
```

### Task 6: Add narrow IPC and Creation-mode publication UI

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/types/index.ts`
- Modify: `apps/electron/src/preload/dsh-bridge-preload.ts`
- Create: `apps/electron/src/renderer/atoms/edgeone-page-publish.ts`
- Create: `apps/electron/src/renderer/components/creation/CopisCreationPublishView.tsx`
- Create: `apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx`
- Modify: `apps/electron/src/renderer/components/creation/CopisCreationWebView.tsx`
- Modify: `apps/electron/src/renderer/components/creation/CopisCreationWebView.test.tsx`

**Interfaces:**
- Consumes: Task 1 IPC types, Task 5 `inspectPagePackage`/`buildPagePublishRequest`/`publishEdgeOnePage`, existing Electron `dialog.showOpenDialog`, and Creation mode's `CreationSubView` handling.
- Produces: `window.electronAPI.dshCordis.openPagePackageDialog()`, `inspectPagePackage(sourcePath)`, and `publishPagePackage({ sourcePath, slug })`, plus the `page-publish` Creation subview.

- [ ] **Step 1: Write failing BDD renderer tests**

```tsx
test('Given a selected page package, when the user has not confirmed publication, then the publish command is disabled', () => {
  render(<CopisCreationPublishView />)
  mockInspection({ sourcePath: '/tmp/page', slugSuggestion: 'portfolio', files: [{ path: 'index.html', size: 12 }] })
  expect(screen.getByRole('button', { name: '发布页面' })).toBeDisabled()
})

test('Given a valid package and explicit confirmation, when publication succeeds, then the public URL is shown and can be opened', async () => {
  mockPublish({ publicUrl: 'https://copis.example.com/u-42/portfolio/', revisionId: 'revision-1', publishedAt: '2026-09-07T00:00:00.000Z' })
  render(<CopisCreationPublishView />)
  await userEvent.click(screen.getByLabelText('我确认将页面公开发布'))
  await userEvent.click(screen.getByRole('button', { name: '发布页面' }))
  expect(await screen.findByRole('link', { name: '打开已发布页面' })).toHaveAttribute('href', 'https://copis.example.com/u-42/portfolio/')
})
```

- [ ] **Step 2: Run the focused renderer tests and verify RED**

Run: `bun test apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx`

Expected: FAIL because the publish atom, component, and Electron APIs do not exist.

- [ ] **Step 3: Register narrowly scoped main/preload IPC handlers**

The picker handler uses `dialog.showOpenDialog` with `properties: ['openFile', 'openDirectory']` and an HTML file filter. Inspection accepts exactly one filesystem path. Publish accepts `{ sourcePath: string, slug: string }`, calls `buildPagePublishRequest` in main, then calls `publishEdgeOnePage`. Validate IPC payload shapes before filesystem or network work and return typed safe results/errors.

Expose exactly these methods under `window.electronAPI.dshCordis`; do not expose a generic fetch, configuration getter, token getter, or raw filesystem directory read. In `dsh-bridge-preload.ts`, map only `COPIS_OPEN_PAGE_PUBLISH` to the existing `CLIENT_EVENT` path. In `CopisCreationWebView`, add `'page-publish'` to `CreationSubView`, map that client event to `setCreationSubView('page-publish')`, and render the new panel as the right-side content while retaining the DSH sidebar.

- [ ] **Step 4: Implement the Jotai-backed publish interaction**

Create atoms for selected source path, inspection, editable slug, confirmation, status (`idle | inspecting | ready | publishing | succeeded | failed`), result, and error. `CopisCreationPublishView` must have a picker command, package summary (file count and total bytes), a slug input with inline validation, an explicit confirmation checkbox, a disabled state while inspecting/publishing, actionable errors, and success state containing the canonical public URL. Re-selecting a source clears confirmation, prior result, and error; changing the slug clears prior result but retains inspection. Use existing Button, Checkbox, Input, and Alert primitives and Chinese user-facing copy.

- [ ] **Step 5: Run renderer and IPC regressions**

Run: `bun test apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx apps/electron/src/renderer/components/creation/CopisCreationWebView.test.tsx && bun run --filter='@copis/electron' typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the desktop UI**

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/types/index.ts apps/electron/src/preload/dsh-bridge-preload.ts apps/electron/src/renderer/atoms/edgeone-page-publish.ts apps/electron/src/renderer/components/creation/CopisCreationPublishView.tsx apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx apps/electron/src/renderer/components/creation/CopisCreationWebView.tsx apps/electron/src/renderer/components/creation/CopisCreationWebView.test.tsx
git commit -m "feat: publish creation pages to edgeone"
```

### Task 7: Deploy the base project and run end-to-end release verification

**Files:**
- Modify: `apps/edgeone-copis-pages/edgeone.json` only if EdgeOne CLI preview testing proves a required configuration key is missing.
- Test: `apps/edgeone-copis-pages/src/*.test.ts`
- Test: `apps/electron/src/main/lib/edgeone-page-*.test.ts`
- Test: `apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx`

**Interfaces:**
- Consumes: the completed desktop publisher and deployed EdgeOne base project, whose Function runtime has access to its project-scoped Blob namespace.
- Produces: a verified deployment URL and release evidence; no source contract changes.

- [ ] **Step 1: Deploy a preview using only project-scoped EdgeOne configuration**

Run from `apps/edgeone-copis-pages`: `bunx edgeone pages deploy --preview`.

Expected: the deployment receives a preview URL and no EdgeOne secret appears in terminal logs or generated files.

- [ ] **Step 2: Run authenticated HTTP smoke scenarios**

Use a disposable Working test account and an HTML package containing `index.html`, `assets/style.css`, `assets/app.js`, and a small PNG. Verify all of the following against the preview deployment:

```text
Given a valid bearer token and package, when POST /api/publish succeeds, then the public URL contains /u-<verified-id>/<slug>/.
Given the same URL without the final slash, when GET, then it returns 308 to the slash URL.
Given the HTML, CSS, JavaScript, and PNG paths, when GET, then they return 200 and the expected content types.
Given an unauthenticated publish call, when POST, then it returns 401 and no active.json changes.
Given ../, %2e%2e, an unlisted file, or another u- segment in the URL, when GET, then it returns 404.
Given a republish while the reader is serving the prior revision, when the new revision commits, then each stable URL resolves entirely to one manifest revision.
```

- [ ] **Step 3: Run workspace regression checks**

Run:

```bash
bun test packages/shared/src/types/edgeone-pages.test.ts
bun test apps/edgeone-copis-pages/src
bun test apps/electron/src/main/lib/edgeone-page-package-service.test.ts apps/electron/src/main/lib/edgeone-page-publish-service.test.ts
bun test apps/electron/src/renderer/components/creation/CopisCreationPublishView.test.tsx apps/electron/src/renderer/components/creation/CopisCreationWebView.test.tsx
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
bun run typecheck
```

Expected: all new focused tests, Electron builds, and workspace typecheck PASS. Investigate any unrelated pre-existing failures separately; do not mask them in this feature.

- [ ] **Step 4: Obtain required actual-window acceptance**

Start Copis with `bun run dev`. The user verifies in the real Electron window that Creation mode can open the publish subview from the DSH side, choose an HTML file and a page directory, see invalid-package feedback, must explicitly confirm publication, sees progress and the returned URL, and that the native DSH sidebar/right publish panel layout remains usable. Do not substitute screenshots for this acceptance.

- [ ] **Step 5: Inspect the final diff and commit release-ready changes**

Run: `git diff --check && git status --short`.

Expected: no whitespace errors, no credentials, and only intended publish-related paths staged. Commit the final verification/configuration adjustment only when the preceding checks pass:

```bash
git add apps/edgeone-copis-pages apps/electron packages/shared bun.lock
git commit -m "feat: publish copis html pages on edgeone"
```

## Coverage Review

| Requirement | Covered by |
| --- | --- |
| Publish HTML packages rather than Vite projects | Global constraints; Tasks 1, 5, and 6 |
| CSS/JS/images coexist with HTML | Tasks 2, 4, 5, and 7 |
| Shared EdgeOne project without distributed secret | Global constraints; Tasks 2, 3, and 5 |
| Stable per-user/per-page public URLs | Tasks 1, 3, 4, and 7 |
| Working identity controls ownership | Tasks 3 and 5 |
| Safe slash behavior for relative assets | Tasks 1, 2, 4, and 7 |
| Atomic re-publish without mixed revisions | Tasks 3, 4, and 7 |
| Creation-mode explicit user publish flow | Task 6 and Task 7 actual-window acceptance |
| BDD, builds, deployment smoke, and actual UI verification | Every task, especially Task 7 |
