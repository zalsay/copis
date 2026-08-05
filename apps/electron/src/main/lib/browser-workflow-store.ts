import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BrowserWorkflowListItem,
  BrowserWorkflowManifest,
  BrowserWorkflowRunEvent,
  BrowserWorkflowRunSummary,
  BrowserWorkflowSaveInput,
  BrowserWorkflowVersion,
} from '@copis/shared'
import { getWorkspaceBrowserWorkflowsDir } from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'
import { assertBrowserWorkflowManifest, assertBrowserWorkflowVersion } from './browser-workflow-schema'

interface StoredWorkflowManifest extends BrowserWorkflowManifest {
  workspaceSlug: string
}

interface StoredWorkflowBundle {
  manifest: StoredWorkflowManifest
  versions: BrowserWorkflowVersion[]
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    console.warn(`[Browser Workflow] 读取文件失败: ${filePath}`, error)
    return undefined
  }
}

function writeJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, filePath)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
}

function resolveWorkspace(workspaceId: string): { id: string; slug: string } {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error('Browser Workflow 工作区不存在')
  return { id: workspace.id, slug: workspace.slug }
}

function assertSafeWorkflowId(workflowId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workflowId)) throw new Error('Browser Workflow ID 不合法')
  return workflowId
}

function resolveWorkflowDir(workspaceId: string, workflowId: string): string {
  const { slug } = resolveWorkspace(workspaceId)
  return join(getWorkspaceBrowserWorkflowsDir(slug), assertSafeWorkflowId(workflowId))
}

function readBundle(workspaceId: string, workflowId: string): StoredWorkflowBundle | undefined {
  const dir = resolveWorkflowDir(workspaceId, workflowId)
  const manifest = readJson<StoredWorkflowManifest>(join(dir, 'workflow.json'))
  if (!manifest) return undefined
  const versionsDir = join(dir, 'versions')
  const versions = existsSync(versionsDir)
    ? readdirSync(versionsDir)
      .filter((name) => /^v\d+\.json$/.test(name))
      .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))
      .map((name) => readJson<BrowserWorkflowVersion>(join(versionsDir, name)))
      .filter((version): version is BrowserWorkflowVersion => Boolean(version))
    : []
  return { manifest, versions }
}

function toListItem(bundle: StoredWorkflowBundle): BrowserWorkflowListItem {
  const latestRun = readJson<BrowserWorkflowRunSummary>(join(
    getWorkspaceBrowserWorkflowsDir(bundle.manifest.workspaceSlug),
    bundle.manifest.id,
    'latest-run.json',
  ))
  return { manifest: bundle.manifest, latestRun }
}

export function listBrowserWorkflows(workspaceId: string): BrowserWorkflowListItem[] {
  const { slug } = resolveWorkspace(workspaceId)
  const root = getWorkspaceBrowserWorkflowsDir(slug)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .map((entry) => readBundle(workspaceId, entry.name))
    .filter((bundle): bundle is StoredWorkflowBundle => Boolean(bundle))
    .map(toListItem)
}

export function getBrowserWorkflow(
  workspaceId: string,
  workflowId: string,
  version?: number,
): { manifest: BrowserWorkflowManifest; version: BrowserWorkflowVersion } {
  const bundle = readBundle(workspaceId, workflowId)
  if (!bundle) throw new Error('Browser Workflow 不存在')
  const workspace = resolveWorkspace(workspaceId)
  if (bundle.manifest.workspaceId !== workspace.id || bundle.manifest.workspaceSlug !== workspace.slug || bundle.manifest.id !== workflowId) {
    throw new Error('Browser Workflow 工作区归属无效')
  }
  const selectedVersionNumber = version ?? bundle.manifest.currentVersion
  const selected = bundle.versions.find((item) => item.version === selectedVersionNumber)
  if (!selected) throw new Error('Browser Workflow 版本不存在')
  assertBrowserWorkflowManifest(bundle.manifest)
  assertBrowserWorkflowVersion(selected)
  if (selected.workflowId !== bundle.manifest.id || selected.version < 1) {
    throw new Error('Browser Workflow 版本归属无效')
  }
  return { manifest: bundle.manifest, version: selected }
}

export function saveBrowserWorkflow(input: BrowserWorkflowSaveInput): BrowserWorkflowManifest {
  const workspace = resolveWorkspace(input.workspaceId)
  assertBrowserWorkflowVersion(input.version)
  if (input.version.approval.status !== 'approved') {
    throw new Error('只有用户批准的 Browser Workflow 才能保存')
  }
  const workflowId = assertSafeWorkflowId(input.version.workflowId || randomUUID())
  const dir = join(getWorkspaceBrowserWorkflowsDir(workspace.slug), workflowId)
  const versionsDir = join(dir, 'versions')
  mkdirSync(versionsDir, { recursive: true })
  const existing = readJson<StoredWorkflowManifest>(join(dir, 'workflow.json'))
  const existingBundle = existing ? readBundle(input.workspaceId, workflowId) : undefined
  const versionNumber = Math.max(
    existing?.currentVersion ?? 0,
    ...(existingBundle?.versions.map((item) => item.version) ?? []),
  ) + 1
  const version: BrowserWorkflowVersion = {
    ...input.version,
    workflowId,
    version: versionNumber,
    approval: {
      ...input.version.approval,
      status: 'approved',
      approvedAt: input.version.approval.approvedAt ?? Date.now(),
      approvedBySessionId: input.version.approval.approvedBySessionId ?? input.sessionId,
    },
  }
  const manifest: StoredWorkflowManifest = {
    schemaVersion: 1,
    id: workflowId,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    name: input.name.trim() || '未命名 Workflow',
    description: input.description?.trim() || undefined,
    status: 'ready',
    currentVersion: versionNumber,
    profileId: input.profileId?.trim() || 'copis-web',
    allowedOrigins: [...new Set(input.allowedOrigins.map((origin) => origin.trim()).filter(Boolean))],
    unattendedAllowed: input.unattendedAllowed === true,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  if (manifest.allowedOrigins.length === 0) throw new Error('Browser Workflow 至少需要一个允许的 Origin')
  assertBrowserWorkflowManifest(manifest)
  writeJson(join(versionsDir, `v${versionNumber}.json`), version)
  writeJson(join(dir, 'workflow.json'), manifest)
  return manifest
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_RUNS = 20

function assertSafeArtifactPart(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`${label} 不合法`)
  return value
}

function pruneWorkflowArtifacts(root: string): void {
  if (!existsSync(root)) return
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name)
      return { path, mtime: statSync(path).mtimeMs }
    })
    .sort((left, right) => right.mtime - left.mtime)
  for (const run of runs.slice(MAX_ARTIFACT_RUNS)) rmSync(run.path, { recursive: true, force: true })
}

export function writeBrowserWorkflowArtifact(
  workspaceId: string,
  workflowId: string,
  runId: string,
  fileName: string,
  data: Uint8Array | string,
): string | undefined {
  const workflowDir = resolveWorkflowDir(workspaceId, workflowId)
  const safeRunId = assertSafeArtifactPart(runId, 'runId')
  const safeFileName = assertSafeArtifactPart(fileName, 'artifact')
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) return undefined
  const root = join(workflowDir, 'artifacts')
  const runDir = join(root, safeRunId)
  mkdirSync(runDir, { recursive: true })
  const markerPath = join(runDir, '.created')
  if (!existsSync(markerPath)) writeFileSync(markerPath, String(Date.now()), 'utf8')
  const filePath = join(runDir, safeFileName)
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, bytes)
    renameSync(temporaryPath, filePath)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
  pruneWorkflowArtifacts(root)
  return `artifacts/${safeRunId}/${safeFileName}`
}
export function appendBrowserWorkflowRunEvent(
  workspaceId: string,
  workflowId: string,
  event: BrowserWorkflowRunEvent,
): void {
  const dir = resolveWorkflowDir(workspaceId, workflowId)
  mkdirSync(join(dir, 'runs'), { recursive: true })
  const filePath = join(dir, 'runs', `${event.runId}.jsonl`)
  writeFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
}

export function saveLatestBrowserWorkflowRun(
  workspaceId: string,
  workflowId: string,
  summary: BrowserWorkflowRunSummary,
): void {
  writeJson(join(resolveWorkflowDir(workspaceId, workflowId), 'latest-run.json'), summary)
}
