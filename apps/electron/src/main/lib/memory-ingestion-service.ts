/**
 * 知识库多源资料摄取服务 (Memory Ingestion Service)
 *
 * 负责将非结构化外部资料（本地文档、网页抓取）通过解析与 LLM 抽取，
 * 转化为符合 Copis 规范的结构化原子知识卡片。
 */

import type {
  MemoryExtractKnowledgeInput,
  MemoryExtractKnowledgeResult,
  MemoryFetchUrlResult,
  MemoryImportItemInput,
  MemoryKind,
} from '@copis/shared'
import { extractTextFromFile } from './document-parser'
import { runMemoryTextTurn } from './adapters/pi-memory-auto-capture'
import { parseMarkdownImport } from '../../renderer/lib/memory-import-parser'

const MAX_INGESTION_TEXT_CHARS = 30_000

/**
 * 净化 HTML 文本并提取正文与标题
 */
export function cleanHtmlContent(rawHtml: string): { title: string; content: string } {
  // 1. 提取标题
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1]?.replace(/\s+/g, ' ').trim() ?? '' : ''

  // 2. 移除无用标签及内容
  let text = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')

  // 3. 转换结构标签为换行
  text = text
    .replace(/<(?:h[1-6]|p|div|section|article|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')

  // 4. 剥离剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ')

  // 5. 解码 HTML 实体
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')

  // 6. 整理空白行
  const content = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

  return { title, content }
}

export class MemoryIngestionService {
  /**
   * 解析本地文档文件（PDF、Word、Excel、PPT、RTF、TXT、MD 等）
   */
  async parseDocumentFile(filePath: string): Promise<string> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('文件路径不能为空')
    }
    const text = await extractTextFromFile(filePath)
    const trimmed = text.trim()
    if (!trimmed) {
      throw new Error('未能从该文件中提取出有效文本内容')
    }
    return trimmed
  }

  /**
   * 抓取网页 URL 内容并提取正文
   */
  async fetchWebpageContent(url: string): Promise<MemoryFetchUrlResult> {
    const trimmedUrl = url.trim()
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error('请输入有效的 HTTP 或 HTTPS 网页链接')
    }

    try {
      const response = await fetch(trimmedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CopisKnowledgeIngestion/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
        signal: AbortSignal.timeout(20_000),
      })

      if (!response.ok) {
        throw new Error(`抓取网页失败（HTTP ${response.status} ${response.statusText}）`)
      }

      const rawHtml = await response.text()
      const { title, content } = cleanHtmlContent(rawHtml)

      const finalTitle = title || new URL(trimmedUrl).hostname
      if (!content) {
        throw new Error('网页内容为空或未能提取到有效正文')
      }

      return {
        url: trimmedUrl,
        title: finalTitle,
        content,
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error
      }
      throw new Error('网页抓取失败，请检查网络或网址是否正确')
    }
  }

  /**
   * 使用当前启用的 AI 模型从长文本中抽取 Copis 结构化原子知识
   */
  async extractKnowledgeFromText(input: MemoryExtractKnowledgeInput): Promise<MemoryExtractKnowledgeResult> {
    const text = input.text.trim()
    if (!text) {
      return { items: [], rawOutput: '' }
    }

    const defaultKind: MemoryKind = input.defaultKind ?? 'fact'
    const truncatedText = text.length > MAX_INGESTION_TEXT_CHARS ? `${text.slice(0, MAX_INGESTION_TEXT_CHARS)}\n...(内容过长已截断)` : text

    // 获取当前可用渠道与模型
    const { listChannels, decryptApiKey } = await import('./channel-manager')
    const channels = listChannels().filter((c) => c.enabled)
    const activeChannel = channels[0]
    if (!activeChannel) {
      throw new Error('未找到已启用的 AI 渠道，请在设置中先配置并启用模型渠道')
    }

    let apiKey = ''
    try {
      apiKey = decryptApiKey(activeChannel.id)
    } catch {
      apiKey = ''
    }

    if (!apiKey) {
      throw new Error(`渠道「${activeChannel.name}」未配置有效的 API Key`)
    }

    const enabledModel = activeChannel.models.find((m) => m.enabled)
    const modelId = enabledModel?.id || activeChannel.models[0]?.id || 'gpt-4o'

    const prompt = `<copis_knowledge_extraction>
你是一个专业的知识库架构师。请仔细阅读以下外部原始资料，并按照 Copis 知识库规范提炼出高价值、长期有效、独立的原子知识卡片。

输出格式要求：
- 只输出 Markdown Bullet 列表，每行一条，格式为：- [fact|preference|decision|project|scratch] 标题: 核心内容 #标签1 #标签2
- 事实分类说明：
  * [fact]: 客观事实、技术原理、业务数据、环境配置等
  * [decision]: 关键架构决策、技术选型方案、设计约定
  * [project]: 项目目录结构、模块职责、构建运行命令
  * [preference]: 团队或用户编码偏好、规范要求
  * [scratch]: 待确认的临时要点或阶段性状态
- 核心规则：
  1. 提取的信息必须独立完整，去除客套修辞、过渡词与一次性琐碎细节；
  2. 每条卡片标题简短凝练（不超过30字），内容清晰精炼（50~300字）；
  3. 在行末附带 1~3 个相关 #tag（如 #vue #sqlite #port）；
  4. 不要输出任何前言、总结、JSON 代码块或多余解释段落。

待提炼资料内容：
${truncatedText}
</copis_knowledge_extraction>`

    try {
      const rawOutput = await runMemoryTextTurn({
        provider: activeChannel.provider,
        baseUrl: activeChannel.baseUrl,
        apiKey,
        modelId,
        prompt,
      })

      const items: MemoryImportItemInput[] = parseMarkdownImport(rawOutput, defaultKind)

      return {
        items,
        rawOutput,
      }
    } catch (error) {
      console.error('[MemoryIngestion] 知识抽取失败:', error)
      const message = error instanceof Error ? error.message : 'AI 知识抽取请求失败'
      throw new Error(`AI 知识抽取失败: ${message}`)
    }
  }
}

export const memoryIngestionService = new MemoryIngestionService()
