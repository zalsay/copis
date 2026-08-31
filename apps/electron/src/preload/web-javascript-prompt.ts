import { contextBridge, ipcRenderer } from 'electron'
import { WEB_IPC_CHANNELS } from '@copis/shared'
import type { WebJavascriptPromptRequest, WebJavascriptPromptResolveInput } from '@copis/shared'

/** prompt 窗口只暴露读取、确认和取消三个固定 IPC 方法。 */
contextBridge.exposeInMainWorld('webJavascriptPrompt', {
  get: (requestId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_GET, requestId) as Promise<WebJavascriptPromptRequest | null>,
  resolve: (input: WebJavascriptPromptResolveInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_RESOLVE, input) as Promise<boolean>,
  cancel: (requestId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_CANCEL, requestId) as Promise<boolean>,
})
