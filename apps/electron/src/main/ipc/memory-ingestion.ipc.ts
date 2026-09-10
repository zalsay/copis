import { ipcMain } from 'electron'
import { MEMORY_IPC_CHANNELS } from '@copis/shared'
import type { MemoryExtractKnowledgeInput, MemoryExtractKnowledgeResult, MemoryFetchUrlResult } from '@copis/shared'
import { memoryIngestionService } from '../lib/memory-ingestion-service'

export function registerMemoryIngestionIpcHandlers(): void {
  // ===== Memory 知识库摄取通道 =====
  ipcMain.handle(
    MEMORY_IPC_CHANNELS.PARSE_DOCUMENT_FILE,
    async (_, filePath: string): Promise<string> => {
      return memoryIngestionService.parseDocumentFile(filePath)
    }
  )

  ipcMain.handle(
    MEMORY_IPC_CHANNELS.FETCH_URL_CONTENT,
    async (_, url: string): Promise<MemoryFetchUrlResult> => {
      return memoryIngestionService.fetchWebpageContent(url)
    }
  )

  ipcMain.handle(
    MEMORY_IPC_CHANNELS.EXTRACT_KNOWLEDGE,
    async (_, input: MemoryExtractKnowledgeInput): Promise<MemoryExtractKnowledgeResult> => {
      return memoryIngestionService.extractKnowledgeFromText(input)
    }
  )
}
