import type { SkillMeta } from '@copis/shared'

const FRONTMATTER_KEYS = new Set(['name', 'displayName', 'description', 'group', 'icon', 'version'])

/** 仅解析内置 Skill 的 frontmatter，避免把完整 Skill 正文带入 UI 状态。 */
export function parseBuiltinSkillMarkdown(content: string, slug: string): SkillMeta {
  const meta: SkillMeta = {
    slug,
    name: slug,
    enabled: true,
  }
  const match = content.replace(/^\uFEFF/, '').match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match?.[1]) return meta

  const entries: Record<string, string> = {}
  let currentKey = ''
  let folded = false

  for (const line of match[1].split('\n')) {
    const indented = /^\s/.test(line)
    if (!indented) {
      const separator = line.indexOf(':')
      if (separator < 0) {
        currentKey = ''
        folded = false
        continue
      }

      const key = line.slice(0, separator).trim()
      if (!FRONTMATTER_KEYS.has(key)) {
        currentKey = ''
        folded = false
        continue
      }

      const rawValue = line.slice(separator + 1).trim()
      currentKey = key
      folded = rawValue === '>'
      entries[key] = rawValue === '|' || rawValue === '>'
        ? ''
        : rawValue.replace(/^['"]|['"]$/g, '')
      continue
    }

    if (!currentKey) continue
    const text = line.trim()
    if (!text) {
      if (entries[currentKey]) entries[currentKey] += '\n'
      continue
    }
    const separator = folded ? ' ' : '\n'
    entries[currentKey] = entries[currentKey]
      ? `${entries[currentKey]}${separator}${text}`
      : text
  }

  if (entries.name) meta.name = entries.name.trim()
  if (entries.displayName) meta.displayName = entries.displayName.trim()
  if (entries.description) meta.description = entries.description.trim()
  if (entries.group) meta.group = entries.group.trim()
  if (entries.icon) meta.icon = entries.icon.trim()
  if (entries.version) meta.version = entries.version.trim()
  return meta
}
