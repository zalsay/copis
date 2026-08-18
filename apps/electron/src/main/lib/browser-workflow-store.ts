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
  AgentWorkspace,
} from '@copis/shared'
import { getWorkspaceBrowserWorkflowsDir } from './config-paths'
import { getAgentWorkspace, getAgentWorkspaceBrowserWorkflowsDir } from './agent-workspace-manager'
import { assertBrowserWorkflowManifest, assertBrowserWorkflowVersion } from './browser-workflow-schema'
import {
  getBrowserWorkflowPlaywrightScriptSha256,
  writeBrowserWorkflowPlaywrightDraft,
  writeBrowserWorkflowPlaywrightVersion,
} from './browser-workflow-playwright-script'

interface StoredWorkflowManifest extends BrowserWorkflowManifest {
  workspaceSlug: string
}

interface StoredWorkflowBundle {
  manifest: StoredWorkflowManifest
  versions: BrowserWorkflowVersion[]
  directory: string
  primaryDirectory: string
}

function writeFileAtomically(filePath: string, content: string | Uint8Array): void {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, content)
    renameSync(temporaryPath, filePath)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
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
  writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function resolveWorkspace(workspaceId: string): AgentWorkspace {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error('Browser Workflow 工作区不存在')
  return workspace
}

function assertSafeWorkflowId(workflowId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workflowId)) throw new Error('Browser Workflow ID 不合法')
  return workflowId
}

function resolveWorkflowDir(workspaceId: string, workflowId: string): string {
  const workspace = resolveWorkspace(workspaceId)
  return join(getAgentWorkspaceBrowserWorkflowsDir(workspace), assertSafeWorkflowId(workflowId))
}

function toMarkdownLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function summarizeWorkflowStep(step: BrowserWorkflowVersion['steps'][number]): string {
  if (step.description?.trim()) return toMarkdownLine(step.description)
  switch (step.type) {
    case 'navigate':
      return `打开 ${step.url}`
    case 'click':
      return '点击页面元素'
    case 'fill':
      return step.value.kind === 'variable' ? `填写变量 ${step.value.variableKey ?? ''}` : '填写固定值'
    case 'press':
      return `按下 ${step.key}`
    case 'select':
      return step.value.kind === 'variable' ? `选择变量 ${step.value.variableKey ?? ''}` : '选择固定值'
    case 'wait':
      return '等待页面条件满足'
    case 'assert':
      return '校验页面状态'
    case 'openTab':
      return `打开页签 ${step.newTabAlias}`
    case 'switchTab':
      return `切换到页签 ${step.targetTabAlias}`
    case 'closeTab':
      return `关闭页签 ${step.targetTabAlias}`
    case 'manual':
      return toMarkdownLine(step.instruction)
  }
}

function renderBrowserWorkflowMarkdown(
  version: BrowserWorkflowVersion,
  manifest?: BrowserWorkflowManifest,
): string {
  const origins = manifest?.allowedOrigins ?? [...new Set([
    version.start.origin,
    ...version.steps.map((step) => step.origin),
  ])]
  const lines = [
    `# ${manifest?.name ?? '待审核 Browser Workflow'}`,
    '',
    `- 状态：${manifest ? '已确认' : '待审核'}`,
    `- Workflow ID：\`${version.workflowId}\``,
    `- 版本：v${version.version}`,
    ...(version.sourceRecordingId ? [`- 来源录制：\`${version.sourceRecordingId}\``] : []),
    '',
    '## 起始页',
    '',
    `- 页签：\`${version.start.tabAlias}\``,
    `- 地址：${version.start.url}`,
    `- Origin：${version.start.origin}`,
  ]
  if (manifest?.description) {
    lines.push('', '## 说明', '', toMarkdownLine(manifest.description))
  }
  lines.push('', '## 允许的 Origin', '')
  lines.push(...origins.map((origin) => `- ${origin}`))
  lines.push('', '## 输入变量', '')
  if (version.variables.length === 0) {
    lines.push('- 无')
  } else {
    lines.push(...version.variables.map((variable) => (
      `- \`${variable.key}\`：${toMarkdownLine(variable.label)}（${variable.type}${variable.required ? '，必填' : ''}）`
    )))
  }
  lines.push('', '## 步骤', '')
  lines.push(...version.steps.flatMap((step, index) => [
    `### ${index + 1}. ${step.type}`,
    '',
    `- 页签：\`${step.tabAlias}\``,
    `- Origin：${step.origin}`,
    `- 操作：${summarizeWorkflowStep(step)}`,
    ...(step.timeoutMs ? [`- 超时：${step.timeoutMs}ms`] : []),
    '',
  ]))
  return `${lines.join('\n').trimEnd()}\n`
}

function readBundleAt(dir: string, primaryDirectory = dir): StoredWorkflowBundle | undefined {
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
  return { manifest, versions, directory: dir, primaryDirectory }
}

function tryGetPrimaryWorkflowsDir(workspace: AgentWorkspace): string | undefined {
  try {
    return getAgentWorkspaceBrowserWorkflowsDir(workspace)
  } catch {
    return undefined
  }
}

function readBundle(workspaceId: string, workflowId: string): StoredWorkflowBundle | undefined {
  const workspace = resolveWorkspace(workspaceId)
  const safeWorkflowId = assertSafeWorkflowId(workflowId)
  const primaryRoot = tryGetPrimaryWorkflowsDir(workspace)
  const roots = [
    ...(primaryRoot ? [primaryRoot] : []),
    getWorkspaceBrowserWorkflowsDir(workspace.slug),
  ]
  const primaryDirectory = primaryRoot ? join(primaryRoot, safeWorkflowId) : undefined
  let primaryBundle: StoredWorkflowBundle | undefined
  let legacyBundle: StoredWorkflowBundle | undefined
  for (const root of roots) {
    const bundle = readBundleAt(join(root, safeWorkflowId), primaryDirectory ?? join(root, safeWorkflowId))
    if (!bundle) continue
    if (root === primaryRoot) primaryBundle = bundle
    else legacyBundle = bundle
  }
  if (!primaryBundle) return legacyBundle
  if (!legacyBundle) return primaryBundle
  const versions = new Map(legacyBundle.versions.map((version) => [version.version, version]))
  for (const version of primaryBundle.versions) versions.set(version.version, version)
  return {
    ...primaryBundle,
    versions: [...versions.values()].sort((left, right) => left.version - right.version),
  }
}

function toListItem(bundle: StoredWorkflowBundle): BrowserWorkflowListItem {
  const latestRun = readJson<BrowserWorkflowRunSummary>(join(bundle.primaryDirectory, 'latest-run.json'))
    ?? readJson<BrowserWorkflowRunSummary>(join(bundle.directory, 'latest-run.json'))
  return { manifest: bundle.manifest, latestRun }
}

export function listBrowserWorkflows(workspaceId: string): BrowserWorkflowListItem[] {
  const workspace = resolveWorkspace(workspaceId)
  const primaryRoot = tryGetPrimaryWorkflowsDir(workspace)
  const roots = [
    ...(primaryRoot ? [primaryRoot] : []),
    getWorkspaceBrowserWorkflowsDir(workspace.slug),
  ]
  const seenWorkflowIds = new Set<string>()
  const bundles: StoredWorkflowBundle[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name) || seenWorkflowIds.has(entry.name)) continue
      const bundle = readBundleAt(join(root, entry.name), primaryRoot ? join(primaryRoot, entry.name) : join(root, entry.name))
      if (!bundle) continue
      seenWorkflowIds.add(entry.name)
      bundles.push(bundle)
    }
  }
  return bundles.map(toListItem)
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
  const existingBundle = readBundle(input.workspaceId, workflowId)
  const dir = join(getAgentWorkspaceBrowserWorkflowsDir(workspace), workflowId)
  const versionsDir = join(dir, 'versions')
  mkdirSync(versionsDir, { recursive: true })
  const versionNumber = Math.max(
    existingBundle?.manifest.currentVersion ?? 0,
    ...(existingBundle?.versions.map((item) => item.version) ?? []),
  ) + 1
  const baseVersion: BrowserWorkflowVersion = {
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
  const version: BrowserWorkflowVersion = {
    ...baseVersion,
    approval: {
      ...baseVersion.approval,
      playwrightScriptSha256: getBrowserWorkflowPlaywrightScriptSha256(baseVersion),
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
    createdAt: existingBundle?.manifest.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  if (manifest.allowedOrigins.length === 0) throw new Error('Browser Workflow 至少需要一个允许的 Origin')
  assertBrowserWorkflowManifest(manifest)
  writeBrowserWorkflowPlaywrightVersion(input.workspaceId, version)
  writeJson(join(versionsDir, `v${versionNumber}.json`), version)
  writeJson(join(dir, 'workflow.json'), manifest)
  return manifest
}

export function writeBrowserWorkflowDraftMarkdown(
  workspaceId: string,
  version: BrowserWorkflowVersion,
): void {
  assertBrowserWorkflowVersion(version)
  const workflowDir = resolveWorkflowDir(workspaceId, version.workflowId)
  mkdirSync(workflowDir, { recursive: true })
  writeFileAtomically(join(workflowDir, 'draft.md'), renderBrowserWorkflowMarkdown(version))
  writeBrowserWorkflowPlaywrightDraft(workspaceId, version)
}

export function promoteBrowserWorkflowDraftMarkdown(workspaceId: string, workflowId: string): void {
  const workflow = getBrowserWorkflow(workspaceId, workflowId)
  const workflowDir = resolveWorkflowDir(workspaceId, workflowId)
  writeFileAtomically(
    join(workflowDir, 'workflow.md'),
    renderBrowserWorkflowMarkdown(workflow.version, workflow.manifest),
  )
  rmSync(join(workflowDir, 'draft.md'), { force: true })
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

/** 返回当前 Workflow 运行的临时 artifact 目录，仅供主进程启动的脚本使用。 */
export function getBrowserWorkflowArtifactDirectory(
  workspaceId: string,
  workflowId: string,
  runId: string,
): string {
  const workflowDir = resolveWorkflowDir(workspaceId, workflowId)
  const safeRunId = assertSafeArtifactPart(runId, 'runId')
  const root = join(workflowDir, 'artifacts')
  const runDir = join(root, safeRunId)
  mkdirSync(runDir, { recursive: true })
  const markerPath = join(runDir, '.created')
  if (!existsSync(markerPath)) writeFileSync(markerPath, String(Date.now()), 'utf8')
  pruneWorkflowArtifacts(root)
  return runDir
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
  const runDir = getBrowserWorkflowArtifactDirectory(workspaceId, workflowId, safeRunId)
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
  const dir = resolveWorkflowDir(workspaceId, workflowId)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'latest-run.json'), summary)
}
