/**
 * Copis 图片生成工具模块（Agent 模式）
 *
 * 图片生成与计费由 Copis 后端（edu-api /api/working/images/generate）提供：
 * - 客户端带 Working JWT 调用后端，后端解析图片模型、生成、扣钻石并返回图片字节；
 * - 本模块把返回的 data_url 保存到本地附件，绝不编造图片 URL。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@copis/core'
import type { AgentToolMeta, FileAttachment } from '@copis/shared'
import { randomUUID } from 'node:crypto'
import { getWorkingApiClient } from '../working-api-service'
import { getWorkingTokenStore } from '../working-auth-store'
import { saveAttachment } from '../attachment-service'

// ===== 工具执行上下文 =====

/** Copis 图片生成工具执行所需的上下文 */
export interface NanoBananaContext {
  /** 会话 ID（用于保存附件与后端 run_id） */
  conversationId: string
}

// ===== 工具元数据 =====

export const NANO_BANANA_TOOL_META: AgentToolMeta = {
  id: 'nano-banana',
  name: 'Copis 图片生成',
  description: 'AI 图片生成（Copis 后端，edu-api 计费）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<copis_image_generation_instructions>
你拥有 Copis 图片生成能力（generate_image），由 Copis 后端提供图片模型与计费。

**generate_image — 生成图片：**
当用户需要创建图片时调用：
- 用户要求生成图片、插图、配图、海报、封面、头像
- 用户想要基于描述生成视觉内容

**提示词组织规范：**
- 先写主体、场景、动作，再写风格、构图、光线、比例和限制
- 明确 must_include（必须出现的元素）与 avoid（不希望出现的元素）
- 如果不能保证图片文字质量，明确要求“画面中不出现文字”
- 不生成成人化、血腥、恐怖、仇恨、危险操作、自伤或隐私诱导内容
- 不复刻受版权保护角色、商标形象或真实人物肖像；改写为原创角色或泛化描述
- 不要编造图片 URL 或本地文件路径，只展示工具真实返回的图片

**参数说明：**
- prompt: 完整、清晰的图片生成提示词
- size: 可选生成尺寸，如 "1024x1024"、"1536x1024"、"1280x720"，默认由后端决定
</copis_image_generation_instructions>`,
}

// ===== 工具定义（ToolDefinition 格式，传给 Provider） =====

export const NANO_BANANA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_image',
    description: 'Generate an image through the Copis backend. Returns real generated image files; never fabricate URLs.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete image generation prompt with subject, scene, action, style, composition, and constraints.',
        },
        size: {
          type: 'string',
          description: 'Optional output size, e.g. "1024x1024", "1536x1024", "1280x720" (backend decides when omitted)',
        },
      },
      required: ['prompt'],
    },
  },
]

// ===== 可用性检查 =====

/**
 * 检查 Copis 图片生成是否可用（已登录 Copis Working，后端提供模型与计费）
 */
export function isNanoBananaAvailable(): boolean {
  return !!getWorkingTokenStore().getToken()
}

// ===== 工具执行 =====

/** 工具名称集合 */
const NANO_BANANA_TOOL_NAMES = new Set(['generate_image'])

/**
 * 判断是否为 Copis 图片生成工具调用
 */
export function isNanoBananaToolCall(toolName: string): boolean {
  return NANO_BANANA_TOOL_NAMES.has(toolName)
}

/** 根据 base64 头字节猜测图片媒体类型（后端未返回 content_type 时兜底） */
function detectBase64ImageType(base64: string): string {
  const head = base64.replace(/\s+/g, '').slice(0, 16)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  return 'image/png'
}

/** 扩展名辅助 */
function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

/** 从 data URL 中提取纯 base64 数据 */
function base64FromDataUrl(dataUrl: string): string | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return null
  return dataUrl.slice(commaIndex + 1)
}

/**
 * 执行 Copis 图片生成工具调用
 */
export async function executeNanoBananaTool(
  toolCall: ToolCall,
  context: NanoBananaContext,
): Promise<ToolResult> {
  if (!isNanoBananaAvailable()) {
    return {
      toolCallId: toolCall.id,
      content: '请先登录 Copis Working 后再使用图片生成',
      isError: true,
    }
  }

  try {
    const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt.trim() : ''
    const size = typeof toolCall.arguments.size === 'string' ? toolCall.arguments.size.trim() : ''

    if (!prompt) {
      return {
        toolCallId: toolCall.id,
        content: '参数缺失: prompt',
        isError: true,
      }
    }

    console.log(`[Copis 图片生成] 请求 edu-api: prompt="${prompt.slice(0, 50)}..."`)
    const result = await getWorkingApiClient().generateWorkingImage({
      prompt,
      size: size || undefined,
      runId: context.conversationId,
    })

    if (!result.dataUrl) {
      return {
        toolCallId: toolCall.id,
        content: 'Copis 后端未返回生成的图片',
        isError: true,
      }
    }

    const imageBase64 = base64FromDataUrl(result.dataUrl)
    if (!imageBase64) {
      return {
        toolCallId: toolCall.id,
        content: 'Copis 后端返回的图片数据无效',
        isError: true,
      }
    }

    const mediaType = result.contentType?.trim() || detectBase64ImageType(imageBase64)
    const attachmentResult = saveAttachment({
      conversationId: context.conversationId,
      filename: `copis-image-${randomUUID().slice(0, 8)}${extensionForMediaType(mediaType)}`,
      mediaType,
      data: imageBase64,
    })

    const deductionText = result.deductedTokens && result.deductedTokens > 0
      ? `（消耗 ${result.deductedTokens} 钻石${result.balanceAfter != null ? `，余额 ${result.balanceAfter}` : ''}）`
      : ''
    return {
      toolCallId: toolCall.id,
      content: `图片已成功生成（1 张）${deductionText}`,
      generatedAttachments: [attachmentResult.attachment],
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Copis 图片生成] 执行失败:', error)
    return {
      toolCallId: toolCall.id,
      content: `图片生成失败: ${msg}`,
      isError: true,
    }
  }
}
