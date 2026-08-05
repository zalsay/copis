import type { SkillMeta } from '@copis/shared'
import { parseBuiltinSkillMarkdown } from './builtin-skill-catalog-parser'

const rawSkillFiles = import.meta.glob('../../../../default-skills/*/SKILL.md', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, unknown>

function skillSlugFromPath(path: string): string | undefined {
  return path.match(/default-skills\/([^/]+)\/SKILL\.md$/)?.[1]
}

/** 构建时读取内置 Skill 的元数据；正文不会进入返回对象。 */
export const builtinSkillCatalog: SkillMeta[] = Object.entries(rawSkillFiles)
  .flatMap(([path, raw]) => {
    const slug = skillSlugFromPath(path)
    if (!slug || typeof raw !== 'string') return []
    return [parseBuiltinSkillMarkdown(raw, slug)]
  })
  .sort((left, right) => left.name.localeCompare(right.name))
