/**
 * IPC 处理器模块
 *
 * 负责注册主进程和渲染进程之间的通信处理器
 */

import { startIpcArchiveMaintenance, startIpcStorageCleanup } from './app/ipc-startup-maintenance'
import { registerUpdaterIpc } from './lib/updater/updater-ipc'
import { registerWebBookmarksStoreIpcHandlers, registerWebBookmarksWindowIpcHandlers } from './ipc/web-bookmarks.ipc'
import { registerWebPasswordsIpcHandlers } from './ipc/web-passwords.ipc'
import {
  registerWebTabsCoreIpcHandlers,
  registerWebTabsNavigationIpcHandlers,
  registerWebTabsProjectIpcHandlers,
} from './ipc/web-tabs.ipc'
import { registerBrowserWorkflowIpcHandlers } from './ipc/browser-workflow.ipc'
import { registerWorkingAccountIpcHandlers } from './ipc/working-account.ipc'
import { registerWorkingPaymentIpcHandlers } from './ipc/working-payment.ipc'
import { registerWorkingModelsIpcHandlers } from './ipc/working-models.ipc'
import { registerChannelsIpcHandlers } from './ipc/channels.ipc'
import {
  registerTutorialIpcHandlers,
  registerSettingsIpcHandlers,
  registerAppAppearanceIpcHandlers,
} from './ipc/settings.ipc'
import { registerScratchPadIpcHandlers } from './ipc/scratch-pad.ipc'
import { registerRuntimeInfoIpcHandlers, registerRuntimeServicesIpcHandlers } from './ipc/runtime.ipc'
import { registerQuickTaskIpcHandlers, registerWindowIpcHandlers } from './ipc/window.ipc'
import { registerVoiceDictationIpcHandlers } from './ipc/voice-dictation.ipc'
import { registerGitIpcHandlers } from './ipc/git.ipc'
import {
  registerDetachedPreviewIpcHandlers,
  registerClipboardPreviewIpcHandlers,
  registerFilePreviewIpcHandlers,
} from './ipc/file-preview.ipc'
import { registerSystemFilesIpcHandlers } from './ipc/system-files.ipc'
import { registerAttachmentsIpcHandlers, registerAgentAttachmentsIpcHandlers } from './ipc/attachments.ipc'
import { registerAttachedPathsIpcHandlers } from './ipc/attached-paths.ipc'
import {
  registerAgentFileCoreIpcHandlers,
  registerAgentFileOpenIpcHandlers,
  registerAgentFileMutationIpcHandlers,
} from './ipc/agent-files.ipc'
import { registerAgentSessionsIpcHandlers } from './ipc/agent-sessions.ipc'
import { registerAgentWorkspacesIpcHandlers } from './ipc/agent-workspaces.ipc'
import { registerWorkspaceCapabilitiesIpcHandlers } from './ipc/workspace-capabilities.ipc'
import { registerAgentExecutionIpcHandlers, registerAgentExecutionSettingsIpcHandlers } from './ipc/agent-execution.ipc'
import {
  registerAgentPermissionResponseIpcHandlers,
  registerAgentInteractionsIpcHandlers,
} from './ipc/agent-interactions.ipc'
import { registerAgentToolsIpcHandlers } from './ipc/agent-tools.ipc'
import { registerFeishuIpcHandlers } from './ipc/feishu.ipc'
import { registerDingtalkIpcHandlers } from './ipc/dingtalk.ipc'
import { registerWechatIpcHandlers } from './ipc/wechat.ipc'
import { registerAgentMailIpcHandlers } from './ipc/agent-mail.ipc'
import { registerStorageIpcHandlers } from './ipc/storage.ipc'
import { registerMigrationIpcHandlers } from './ipc/migration.ipc'
import { registerPlanningIpcHandlers } from './ipc/planning.ipc'
import { registerAutomationIpcHandlers } from './ipc/automation.ipc'
import { registerMemoryIngestionIpcHandlers } from './ipc/memory-ingestion.ipc'
import { registerTradingIpcHandlers } from './ipc/trading.ipc'
import { registerDshIpcHandlers } from './ipc/dsh.ipc'

/**
 * 解析应用图标变体的文件路径
 */
export { resolveAppIconPath } from './lib/app-icon-path'

export function registerIpcHandlers(): void {
  console.log('[IPC] 正在注册 IPC 处理器...')

  // ===== 内嵌 Chromium 网页页签 =====
  registerWebTabsCoreIpcHandlers()
  registerWebBookmarksWindowIpcHandlers()
  registerWebTabsNavigationIpcHandlers()
  registerWebBookmarksStoreIpcHandlers()
  registerWebTabsProjectIpcHandlers()

  // ===== 内嵌网页密码安全存储与自动填充 =====
  registerWebPasswordsIpcHandlers()

  // ===== Browser Workflow（仅高层能力；CDP 不通过 IPC 暴露） =====
  registerBrowserWorkflowIpcHandlers()

  // ===== Copis Working 后端（仅账号与业务元数据） =====
  registerWorkingAccountIpcHandlers()
  registerWorkingPaymentIpcHandlers()
  registerWorkingModelsIpcHandlers()

  registerRuntimeInfoIpcHandlers()

  registerGitIpcHandlers()

  registerDetachedPreviewIpcHandlers()

  registerSystemFilesIpcHandlers()

  registerChannelsIpcHandlers()

  registerTutorialIpcHandlers()

  registerAttachmentsIpcHandlers()

  registerSettingsIpcHandlers()

  registerScratchPadIpcHandlers()

  registerAppAppearanceIpcHandlers()

  registerRuntimeServicesIpcHandlers()

  registerAgentSessionsIpcHandlers()

  registerAgentWorkspacesIpcHandlers()

  registerWorkspaceCapabilitiesIpcHandlers()

  registerAgentExecutionIpcHandlers()

  registerAgentPermissionResponseIpcHandlers()

  registerAgentExecutionSettingsIpcHandlers()

  registerAgentToolsIpcHandlers()

  registerAgentInteractionsIpcHandlers()

  registerAgentAttachmentsIpcHandlers()

  registerAttachedPathsIpcHandlers()

  registerAgentFileCoreIpcHandlers()

  registerClipboardPreviewIpcHandlers()

  registerAgentFileOpenIpcHandlers()

  registerFilePreviewIpcHandlers()

  registerAgentFileMutationIpcHandlers()

  registerFeishuIpcHandlers()

  registerDingtalkIpcHandlers()

  registerWechatIpcHandlers()

  registerAgentMailIpcHandlers()

  console.log('[IPC] IPC 处理器注册完成')

  // 注册更新 IPC 处理器
  registerUpdaterIpc()

  startIpcArchiveMaintenance()

  registerStorageIpcHandlers()

  startIpcStorageCleanup()

  registerQuickTaskIpcHandlers()

  registerVoiceDictationIpcHandlers()

  registerMigrationIpcHandlers()

  registerWindowIpcHandlers()

  registerPlanningIpcHandlers()

  registerAutomationIpcHandlers()

  registerMemoryIngestionIpcHandlers()

  registerTradingIpcHandlers()

  registerDshIpcHandlers()

}
