import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import { createCopisResourceLoaderOptions } from './pi-resource-loader-overrides'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('Pi Skill 资源加载', () => {
  test('Given .agents/skills 下存在 Skill When Pi runtime reload Then 发现该 Skill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-pi-resource-loader-'))
    tempRoots.push(root)
    const skillDir = join(root, '.agents', 'skills', 'codex-compatible-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: codex-compatible-skill\ndescription: test\n---\n\n# Test\n',
      'utf-8',
    )

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      noSkills: true,
      additionalSkillPaths: [join(root, '.agents', 'skills')],
    })
    await loader.reload()

    expect(loader.getSkills().skills.map((skill) => skill.name)).toContain('codex-compatible-skill')
  })

  test('Given cwd 及其父目录存在 Agent 指令文件 When Copis 创建 Pi loader Then 不加载这些文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-pi-resource-loader-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'CLAUDE.md'), '# legacy instructions\n', 'utf-8')
    writeFileSync(join(root, 'AGENTS.md'), '# legacy instructions\n', 'utf-8')

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      noSkills: true,
      ...createCopisResourceLoaderOptions(),
    })
    await loader.reload()

    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
  })

  test('Given 项目根与父目录均存在 AGENTS.md When Copis 创建 Pi loader Then 仍返回空 agentsFiles', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'copis-pi-resource-loader-parent-'))
    tempRoots.push(parent)
    const root = join(parent, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '# 项目根指令\n', 'utf-8')
    writeFileSync(join(parent, 'AGENTS.md'), '# 父目录指令\n', 'utf-8')

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      noSkills: true,
      ...createCopisResourceLoaderOptions(),
    })
    await loader.reload()

    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
  })
})
