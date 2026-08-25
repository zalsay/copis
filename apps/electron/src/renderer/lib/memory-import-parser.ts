import type { MemoryImportItemInput, MemoryKind } from '@copis/shared'

const VALID_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'project', 'scratch']

function parseKind(raw: string | undefined, fallback: MemoryKind = 'fact'): MemoryKind {
  if (!raw) return fallback
  const normalized = raw.toLowerCase().trim()
  return VALID_KINDS.includes(normalized as MemoryKind) ? (normalized as MemoryKind) : fallback
}

function extractTags(text: string): { cleanText: string; tags: string[] } {
  const tags: string[] = []
  
  // 1. 匹配行内标签，例如 `#tag1 #vue3`
  const tagRegex = /(?:^|\s)#([\w\u4e00-\u9fa5\-_]+)/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(text)) !== null) {
    if (match[1] && !VALID_KINDS.includes(match[1].toLowerCase() as MemoryKind)) {
      tags.push(match[1])
    }
  }

  // 2. 匹配 `Tags: a, b` 或 `标签：a, b`
  const tagsLineRegex = /(?:^|\n)(?:Tags|tags|标签|TAGS)[:：]\s*([^\n]+)/i
  const tagsLineMatch = text.match(tagsLineRegex)
  if (tagsLineMatch?.[1]) {
    const extracted = tagsLineMatch[1].split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
    tags.push(...extracted)
  }

  // 清除 Tags: 声明行与行内 #tag，保持正文干净
  const cleanText = text
    .replace(tagsLineRegex, '')
    .replace(/(?:^|\s)#([\w\u4e00-\u9fa5\-_]+)/g, '')
    .trim()
  return { cleanText, tags: [...new Set(tags)] }
}

function extractKindFromPrefix(rawTitle: string, defaultKind: MemoryKind = 'fact'): { title: string; kind: MemoryKind } {
  const prefixMatch = rawTitle.match(/^\[(fact|preference|decision|project|scratch|事实|偏好|决策|项目|草稿)\]\s*(.*)$/i)
  if (!prefixMatch || !prefixMatch[1]) return { title: rawTitle.trim(), kind: defaultKind }

  const rawKind = prefixMatch[1].toLowerCase()
  let kind: MemoryKind = defaultKind
  if (rawKind === 'fact' || rawKind === '事实') kind = 'fact'
  else if (rawKind === 'preference' || rawKind === '偏好') kind = 'preference'
  else if (rawKind === 'decision' || rawKind === '决策') kind = 'decision'
  else if (rawKind === 'project' || rawKind === '项目') kind = 'project'
  else if (rawKind === 'scratch' || rawKind === '草稿') kind = 'scratch'

  return { title: prefixMatch[2]?.trim() || rawTitle.trim(), kind }
}

export function parseJsonImport(rawJson: string, defaultKind: MemoryKind = 'fact'): MemoryImportItemInput[] {
  const parsed = JSON.parse(rawJson) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('无效的 JSON 格式')
  }

  let rawList: unknown[] = []
  if (Array.isArray(parsed)) {
    rawList = parsed
  } else if ('entries' in parsed && Array.isArray((parsed as { entries: unknown[] }).entries)) {
    rawList = (parsed as { entries: unknown[] }).entries
  } else if ('items' in parsed && Array.isArray((parsed as { items: unknown[] }).items)) {
    rawList = (parsed as { items: unknown[] }).items
  } else {
    rawList = [parsed]
  }

  const items: MemoryImportItemInput[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
    const title = rawTitle || content.slice(0, 50).trim() || '导入知识'
    if (!content && !rawTitle) continue

    const kind = parseKind(typeof record.kind === 'string' ? record.kind : undefined, defaultKind)
    let tags: string[] = []
    if (Array.isArray(record.tags)) {
      tags = record.tags.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).map((t) => t.trim())
    } else if (typeof record.tags === 'string') {
      tags = record.tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
    }

    items.push({
      title,
      content: content || title,
      kind,
      tags: [...new Set(tags)],
    })
  }

  return items
}

export function parseMarkdownImport(rawMarkdown: string, defaultKind: MemoryKind = 'fact'): MemoryImportItemInput[] {
  const trimmed = rawMarkdown.trim()
  if (!trimmed) return []

  const lines = trimmed.split('\n')
  const isHeaderBased = lines.some((line) => /^#{1,4}\s+/.test(line))

  if (isHeaderBased) {
    return parseHeaderBasedMarkdown(lines, defaultKind)
  }

  // 检查是否为 Bullet list 列表格式
  const isBulletList = lines.filter((line) => line.trim().length > 0).every((line) => /^[-*•]\s+/.test(line.trim()))
  if (isBulletList) {
    return parseBulletListMarkdown(lines, defaultKind)
  }

  // 纯段落解析
  return parseParagraphMarkdown(trimmed, defaultKind)
}

function parseHeaderBasedMarkdown(lines: string[], defaultKind: MemoryKind): MemoryImportItemInput[] {
  const sections: Array<{ rawHeader: string; bodyLines: string[] }> = []
  let currentHeader: string | null = null
  let currentBody: string[] = []

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,4}\s+(.+)$/)
    if (headerMatch && headerMatch[1]) {
      if (currentHeader !== null) {
        sections.push({ rawHeader: currentHeader, bodyLines: currentBody })
      }
      currentHeader = headerMatch[1].trim()
      currentBody = []
    } else if (currentHeader !== null) {
      currentBody.push(line)
    }
  }

  if (currentHeader !== null) {
    sections.push({ rawHeader: currentHeader, bodyLines: currentBody })
  }

  const items: MemoryImportItemInput[] = []
  for (const section of sections) {
    const rawContent = section.bodyLines.join('\n').trim()
    const { cleanText, tags } = extractTags(rawContent)
    const { title, kind } = extractKindFromPrefix(section.rawHeader, defaultKind)
    const content = cleanText || title

    if (title || content) {
      items.push({
        title,
        content,
        kind,
        tags,
      })
    }
  }

  return items
}

function parseBulletListMarkdown(lines: string[], defaultKind: MemoryKind): MemoryImportItemInput[] {
  const items: MemoryImportItemInput[] = []

  for (const line of lines) {
    const bulletMatch = line.trim().match(/^[-*•]\s+(.+)$/)
    if (!bulletMatch || !bulletMatch[1]) continue

    const rawItem = bulletMatch[1].trim()
    const { cleanText, tags } = extractTags(rawItem)
    const { title: cleanTitle, kind } = extractKindFromPrefix(cleanText, defaultKind)

    // 分离可能存在的标题冒号：例如 "部署端口: 固定为 5173"
    const colonMatch = cleanTitle.match(/^([^:：]{2,30})[:：]\s*(.+)$/)
    let title = cleanTitle
    let content = cleanTitle
    if (colonMatch && colonMatch[1] && colonMatch[2]) {
      title = colonMatch[1].trim()
      content = colonMatch[2].trim()
    }

    items.push({
      title,
      content,
      kind,
      tags,
    })
  }

  return items
}

function parseParagraphMarkdown(rawText: string, defaultKind: MemoryKind): MemoryImportItemInput[] {
  const paragraphs = rawText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const items: MemoryImportItemInput[] = []

  for (const para of paragraphs) {
    const { cleanText, tags } = extractTags(para)
    const firstLine = cleanText.split('\n')[0]?.trim() || ''
    const { title, kind } = extractKindFromPrefix(firstLine.slice(0, 50), defaultKind)

    items.push({
      title: title || '知识条目',
      content: cleanText,
      kind,
      tags,
    })
  }

  return items
}

export function parseMemoryImportFile(
  content: string,
  fileName: string,
  defaultKind: MemoryKind = 'fact',
): MemoryImportItemInput[] {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.json')) {
    return parseJsonImport(content, defaultKind)
  }
  return parseMarkdownImport(content, defaultKind)
}
