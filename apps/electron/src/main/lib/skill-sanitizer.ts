/**
 * 技能 (Skill) 元数据规范化与自愈工具
 *
 * 保证所有工作区和额外路径中的 SKILL.md 都包含 Pi SDK 所必需的 YAML frontmatter，
 * 尤其是 non-empty 的 name 和 description，避免触发：
 * [Pi SDK] Skill 加载诊断: ... SKILL.md description is required
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Pi SDK 规范上限：name 最长 64 字符，description 最长 1024 字符 */
const MAX_SKILL_NAME_LENGTH = 64
const MAX_SKILL_DESCRIPTION_LENGTH = 1024

export interface SkillFrontmatterInfo {
  hasFrontmatter: boolean
  rawFrontmatter?: string
  headerBlock?: string
  body: string
  name?: string
  displayName?: string
  description?: string
  version?: string
  group?: string
  icon?: string
  category?: string
}

/**
 * 解析 SKILL.md 内容中的 YAML frontmatter 与正文
 */
export function parseSkillFrontmatterInfo(content: string): SkillFrontmatterInfo {
  const normalized = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  const fmMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)

  if (!fmMatch) {
    return {
      hasFrontmatter: false,
      body: normalized,
    }
  }

  const headerBlock = fmMatch[0]
  const rawFrontmatter = fmMatch[1] ?? ''
  const body = normalized.slice(headerBlock.length)

  const entries: Record<string, string> = {}
  let currentKey = ''
  let isFolded = false

  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const isIndented = /^\s/.test(line)

    if (!isIndented) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) {
        currentKey = ''
        continue
      }

      const key = line.slice(0, colonIdx).trim()
      const raw = line.slice(colonIdx + 1).trim()

      if (raw === '|' || raw === '>') {
        currentKey = key
        isFolded = raw === '>'
        entries[key] = ''
        continue
      }

      currentKey = key
      isFolded = false
      entries[key] = raw.replace(/^["']|["']$/g, '')
    } else if (currentKey) {
      const text = line.trim()
      if (!text) {
        if (entries[currentKey]) entries[currentKey] += '\n'
        continue
      }
      const sep = isFolded ? ' ' : '\n'
      entries[currentKey] = entries[currentKey] ? `${entries[currentKey]}${sep}${text}` : text
    }
  }

  return {
    hasFrontmatter: true,
    rawFrontmatter,
    headerBlock,
    body,
    name: entries.name?.trim(),
    displayName: entries.displayName?.trim(),
    description: entries.description?.trim(),
    version: entries.version?.trim(),
    group: entries.group?.trim(),
    icon: entries.icon?.trim(),
    category: entries.category?.trim(),
  }
}

/**
 * 规范化 Skill 名称以满足 Pi SDK 规范（仅允许小写字母、数字和连字符，且不连续，首尾无连字符）
 */
export function sanitizeSkillName(raw: string | undefined, fallback: string): string {
  const source = (raw && raw.trim()) || fallback
  let sanitized = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (sanitized.length > MAX_SKILL_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/, '')
  }

  return sanitized || 'skill'
}

/**
 * 规范化 Skill description：单行、去除多余空白、严格截断在 1024 字符以内
 */
export function sanitizeSkillDescription(raw: string): string {
  const cleaned = raw.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= MAX_SKILL_DESCRIPTION_LENGTH) {
    return cleaned
  }
  return cleaned.slice(0, MAX_SKILL_DESCRIPTION_LENGTH).trim()
}

/**
 * 从 Markdown 正文中提取首个可用的一句话摘要作为兜底 description
 */
export function extractDescriptionFromMarkdownBody(body: string): string {
  // 移除代码块，避免提取到代码
  const stripped = body.replace(/```[\s\S]*?```/g, '')

  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 优先提取引用块: > 这是描述
    if (trimmed.startsWith('>')) {
      const quote = trimmed.replace(/^>+\s*/, '').trim()
      if (quote) return quote
      continue
    }

    // 跳过标题、列表项、分割线、HTML注释和表格
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('-') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('+') ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('---') ||
      trimmed.startsWith('***')
    ) {
      continue
    }

    // 清洗 Markdown 行内格式（如加粗、链接）
    const cleanText = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()

    if (cleanText.length >= 2) {
      return cleanText
    }
  }

  return ''
}

interface ExternalSkillMetadata {
  name?: string
  displayName?: string
  description?: string
  version?: string
}

/**
 * 尝试从目录中的 JSON 元数据文件（metadata.json, _meta.json, package.json, .market.json）提取元数据
 */
function readExternalSkillMetadata(skillDir: string): ExternalSkillMetadata {
  const meta: ExternalSkillMetadata = {}
  const candidateFiles = ['metadata.json', '_meta.json', 'package.json', '.market.json']

  for (const filename of candidateFiles) {
    const fullPath = join(skillDir, filename)
    if (!existsSync(fullPath)) continue

    try {
      const raw = readFileSync(fullPath, 'utf-8')
      const json = JSON.parse(raw) as Record<string, unknown>

      if (!meta.name && typeof json.name === 'string' && json.name.trim()) {
        meta.name = json.name.trim()
      }
      if (!meta.name && typeof json.slug === 'string' && json.slug.trim()) {
        meta.name = json.slug.trim()
      }
      if (!meta.displayName && typeof json.displayName === 'string' && json.displayName.trim()) {
        meta.displayName = json.displayName.trim()
      }
      if (!meta.description && typeof json.description === 'string' && json.description.trim()) {
        meta.description = json.description.trim()
      }
      if (!meta.description && typeof json.desc === 'string' && json.desc.trim()) {
        meta.description = json.desc.trim()
      }
      if (!meta.description && typeof json.summary === 'string' && json.summary.trim()) {
        meta.description = json.summary.trim()
      }
      if (!meta.version && typeof json.version === 'string' && json.version.trim()) {
        meta.version = json.version.trim()
      }
    } catch {
      // 忽略无法解析的元数据文件
    }
  }

  return meta
}

/**
 * 确保指定技能目录下的 SKILL.md 拥有合规的 YAML frontmatter 与 non-empty 的 description。
 * 如果缺少或无效，则从 metadata.json 或 Markdown 正文中提取并自动补全。
 *
 * @param skillDir 技能所在的绝对或相对目录
 * @param defaultSlug 技能目录的标识（作为 name 兜底）
 * @returns 是否修改并写回了文件
 */
export function ensureSkillDirectoryFrontmatter(skillDir: string, defaultSlug?: string): boolean {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    return false
  }

  let content: string
  try {
    content = readFileSync(skillMdPath, 'utf-8')
  } catch (err) {
    console.warn(`[Skill 自愈] 读取 SKILL.md 失败: ${skillMdPath}`, err)
    return false
  }

  const info = parseSkillFrontmatterInfo(content)
  const slug = defaultSlug || basename(skillDir)

  const hasValidDescription = Boolean(info.description && info.description.trim().length > 0)
  const hasValidName = Boolean(info.name && info.name.trim().length > 0)

  // 如果已经具备有效 name 和非空 description，无需修改
  if (info.hasFrontmatter && hasValidDescription && hasValidName) {
    return false
  }

  // 需要自愈补全
  const external = readExternalSkillMetadata(skillDir)

  // 解析最终 description
  let rawDesc = info.description || external.description || external.displayName
  if (!rawDesc || !rawDesc.trim()) {
    rawDesc = extractDescriptionFromMarkdownBody(info.body)
  }
  if (!rawDesc || !rawDesc.trim()) {
    rawDesc = `${info.name || external.displayName || slug} 技能`
  }
  const finalDescription = sanitizeSkillDescription(rawDesc)

  // 解析最终 name
  const rawName = info.name || external.name || slug
  const finalName = sanitizeSkillName(rawName, slug)

  const displayName = info.displayName || external.displayName
  const version = info.version || external.version

  let newContent = ''

  if (info.hasFrontmatter && info.rawFrontmatter) {
    // 已经有 frontmatter，但在缺少 description 或 name 时做精准补充
    const lines = info.rawFrontmatter.split(/\r?\n/)
    let foundDesc = false
    let foundName = false

    const newLines = lines.map((line) => {
      if (/^\s*description\s*:/.test(line)) {
        foundDesc = true
        return `description: ${JSON.stringify(finalDescription)}`
      }
      if (/^\s*name\s*:/.test(line)) {
        foundName = true
        return `name: ${finalName}`
      }
      return line
    })

    if (!foundName) {
      newLines.unshift(`name: ${finalName}`)
    }
    if (!foundDesc) {
      newLines.push(`description: ${JSON.stringify(finalDescription)}`)
    }

    newContent = `---\n${newLines.join('\n').trim()}\n---\n\n${info.body.trimStart()}`
  } else {
    // 完全缺少 frontmatter，新建标准头
    const headerLines = [
      '---',
      `name: ${finalName}`,
    ]
    if (displayName) {
      headerLines.push(`displayName: ${displayName}`)
    }
    headerLines.push(`description: ${JSON.stringify(finalDescription)}`)
    if (version) {
      headerLines.push(`version: ${JSON.stringify(version)}`)
    }
    headerLines.push('---')
    headerLines.push('')

    newContent = `${headerLines.join('\n')}\n${info.body.trimStart()}`
  }

  try {
    writeFileSync(skillMdPath, newContent, 'utf-8')
    console.log(`[Skill 自愈] 已自动补全 Skill Frontmatter: ${skillMdPath}`)
    return true
  } catch (err) {
    console.error(`[Skill 自愈] 写回 SKILL.md 失败: ${skillMdPath}`, err)
    return false
  }
}

/**
 * 递归/批量检查并自愈传入的所有技能根路径或独立技能目录
 */
export function ensureSkillPathsSanitized(skillPaths: string[] | undefined): void {
  if (!skillPaths || skillPaths.length === 0) return

  for (const rootPath of skillPaths) {
    if (!rootPath || !existsSync(rootPath)) continue

    try {
      const stats = statSync(rootPath)
      if (!stats.isDirectory()) continue

      const directSkillMd = join(rootPath, 'SKILL.md')
      if (existsSync(directSkillMd)) {
        // 当前路径本身就是一个 Skill 目录
        ensureSkillDirectoryFrontmatter(rootPath, basename(rootPath))
        continue
      }

      // 否则当前路径是存放多个 Skills 的父目录（如 .agents/skills/）
      const entries = readdirSync(rootPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const childDir = join(rootPath, entry.name)
        if (existsSync(join(childDir, 'SKILL.md'))) {
          ensureSkillDirectoryFrontmatter(childDir, entry.name)
        }
      }
    } catch {
      // 忽略文件权限等偶发错误
    }
  }
}
