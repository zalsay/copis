import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const sourcePath = resolve(import.meta.dir, '../ipc.ts')
const source = readFileSync(sourcePath, 'utf8')
const webPasswordsSourcePath = resolve(import.meta.dir, '../ipc/web-passwords.ipc.ts')
const webPasswordsSource = readFileSync(webPasswordsSourcePath, 'utf8')
const webTabsSourcePath = resolve(import.meta.dir, '../ipc/web-tabs.ipc.ts')
const webTabsSource = readFileSync(webTabsSourcePath, 'utf8')
const webBookmarksSourcePath = resolve(import.meta.dir, '../ipc/web-bookmarks.ipc.ts')
const webBookmarksSource = readFileSync(webBookmarksSourcePath, 'utf8')
const browserWorkflowSourcePath = resolve(import.meta.dir, '../ipc/browser-workflow.ipc.ts')
const browserWorkflowSource = readFileSync(browserWorkflowSourcePath, 'utf8')

const baselineSha256 = '018ebf8b1c8e2e62ba93c166b939e5efe1ecfd2dcc727487875bfe23472c3160'

function inventoryFunction(text: string, fileName: string, functionName: string) {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const target = file.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  ))
  if (!target?.body) throw new Error(`找不到 IPC 注册函数：${functionName}`)
  return inventoryNode(target.body, file)
}

function inventoryNode(root: ts.Node, file: ts.SourceFile) {
  const entries: Array<{ kind: string; channel: string; line: number }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(file)
      const kind = node.expression.name.text
      if (owner === 'ipcMain' && (kind === 'handle' || kind === 'on')) {
        entries.push({ kind, channel: node.arguments[0]?.getText(file) ?? '', line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 })
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 0) {
      const registrar = registrars.get(node.expression.text)
      if (registrar) entries.push(...inventoryFunction(registrar.source, registrar.path, node.expression.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return entries
}

const registrars = new Map([
  ['registerWebPasswordsIpcHandlers', { source: webPasswordsSource, path: webPasswordsSourcePath }],
  ['registerWebTabsCoreIpcHandlers', { source: webTabsSource, path: webTabsSourcePath }],
  ['registerWebTabsNavigationIpcHandlers', { source: webTabsSource, path: webTabsSourcePath }],
  ['registerWebTabsProjectIpcHandlers', { source: webTabsSource, path: webTabsSourcePath }],
  ['registerWebBookmarksWindowIpcHandlers', { source: webBookmarksSource, path: webBookmarksSourcePath }],
  ['registerWebBookmarksStoreIpcHandlers', { source: webBookmarksSource, path: webBookmarksSourcePath }],
  ['registerBrowserWorkflowIpcHandlers', { source: browserWorkflowSource, path: browserWorkflowSourcePath }],
])
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true)
for (const [domain, name] of [
  ['working-account', 'registerWorkingAccountIpcHandlers'],
  ['working-payment', 'registerWorkingPaymentIpcHandlers'],
  ['working-models', 'registerWorkingModelsIpcHandlers'],
  ['feishu', 'registerFeishuIpcHandlers'],
  ['dingtalk', 'registerDingtalkIpcHandlers'],
  ['wechat', 'registerWechatIpcHandlers'],
  ['agent-mail', 'registerAgentMailIpcHandlers'],
  ['storage', 'registerStorageIpcHandlers'],
  ['migration', 'registerMigrationIpcHandlers'],
  ['planning', 'registerPlanningIpcHandlers'],
  ['automation', 'registerAutomationIpcHandlers'],
  ['memory-ingestion', 'registerMemoryIngestionIpcHandlers'],
  ['trading', 'registerTradingIpcHandlers'],
  ['dsh', 'registerDshIpcHandlers'],
  ['agent-sessions', 'registerAgentSessionsIpcHandlers'],
  ['agent-workspaces', 'registerAgentWorkspacesIpcHandlers'],
  ['workspace-capabilities', 'registerWorkspaceCapabilitiesIpcHandlers'],
  ['agent-execution', 'registerAgentExecutionIpcHandlers'],
  ['agent-interactions', 'registerAgentPermissionResponseIpcHandlers'],
  ['agent-execution', 'registerAgentExecutionSettingsIpcHandlers'],
  ['agent-tools', 'registerAgentToolsIpcHandlers'],
  ['agent-interactions', 'registerAgentInteractionsIpcHandlers'],
  ['git', 'registerGitIpcHandlers'],
  ['file-preview', 'registerDetachedPreviewIpcHandlers'],
  ['system-files', 'registerSystemFilesIpcHandlers'],
  ['attachments', 'registerAttachmentsIpcHandlers'],
  ['attachments', 'registerAgentAttachmentsIpcHandlers'],
  ['attached-paths', 'registerAttachedPathsIpcHandlers'],
  ['agent-files', 'registerAgentFileCoreIpcHandlers'],
  ['file-preview', 'registerClipboardPreviewIpcHandlers'],
  ['agent-files', 'registerAgentFileOpenIpcHandlers'],
  ['file-preview', 'registerFilePreviewIpcHandlers'],
  ['agent-files', 'registerAgentFileMutationIpcHandlers'],
  ['channels', 'registerChannelsIpcHandlers'],
  ['settings', 'registerTutorialIpcHandlers'],
  ['settings', 'registerSettingsIpcHandlers'],
  ['scratch-pad', 'registerScratchPadIpcHandlers'],
  ['settings', 'registerAppAppearanceIpcHandlers'],
  ['runtime', 'registerRuntimeInfoIpcHandlers'],
  ['runtime', 'registerRuntimeServicesIpcHandlers'],
  ['window', 'registerQuickTaskIpcHandlers'],
  ['voice-dictation', 'registerVoiceDictationIpcHandlers'],
  ['window', 'registerWindowIpcHandlers'],
] as const) {
  const path = resolve(import.meta.dir, '../ipc/' + domain + '.ipc.ts')
  registrars.set(name, { source: readFileSync(path, 'utf8'), path })
}
const entries = inventoryNode(file, file)
const canonical = entries.map((entry) => `${entry.kind}|${entry.channel}`).join('\n')
const handleCount = entries.filter((entry) => entry.kind === 'handle').length
const onCount = entries.filter((entry) => entry.kind === 'on').length

test('迁移前注册契约保持 376 个 handle 和 5 个 on', () => {
  expect(handleCount).toBe(376)
  expect(onCount).toBe(5)
  expect(new Set(entries.map((entry) => `${entry.kind}|${entry.channel}`)).size).toBe(entries.length)
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(baselineSha256)
})

test('迁移前保留兼容导出和 updater 独立注册', () => {
  expect(source).toMatch(/export function registerIpcHandlers\s*\(/)
  expect(source).toMatch(/(?:export function resolveAppIconPath\s*\(|export\s*\{[^}]*resolveAppIconPath)/s)
  expect(source).toMatch(/registerUpdaterIpc\s*\(\)/)
})
