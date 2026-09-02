import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWorkspaceFiles } from './lib/workspace-file-search'

let tempWorkspaceDir: string

beforeAll(() => {
  tempWorkspaceDir = mkdtempSync(join(tmpdir(), 'copis-workspace-search-test-'))
})

afterAll(() => {
  if (tempWorkspaceDir) {
    rmSync(tempWorkspaceDir, { recursive: true, force: true })
  }
})

describe('工作区文件搜索 (SEARCH_WORKSPACE_FILES)', () => {
  test('Given 默认项目根中包含超过 2000 条 .copis 嵌套文件且同级包含 project/ 目录 When 执行空 query 搜索 Then 跳过 .copis 并成功返回 project/ 目录及其文件', async () => {
    // 准备 > 2000 个 .copis 嵌套文件，模拟深度优先扫描耗尽 2000 上限的场景
    const copisDir = join(tempWorkspaceDir, '.copis', 'sessions')
    mkdirSync(copisDir, { recursive: true })
    for (let index = 0; index < 2050; index++) {
      writeFileSync(join(copisDir, `session-${index}.json`), `{"id": ${index}}`)
    }

    // 准备同级 project/ 目录和文件
    const projectDir = join(tempWorkspaceDir, 'project', 'src')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'index.ts'), 'console.log("hello")')
    writeFileSync(join(tempWorkspaceDir, 'project', 'README.md'), '# Project')

    const result = await searchWorkspaceFiles(tempWorkspaceDir, '', 20)

    const copisEntries = result.entries.filter(
      (entry) => entry.name === '.copis' || entry.path === '.copis' || entry.path.startsWith('.copis/') || entry.path.startsWith('.copis\\'),
    )
    expect(copisEntries).toHaveLength(0)

    const entryPaths = result.entries.map((entry) => entry.path)
    expect(entryPaths).toContain('project')
    expect(entryPaths).toContain(join('project', 'src', 'index.ts'))
    expect(entryPaths).toContain(join('project', 'README.md'))
  })

  test('Given 工作区包含 .copis 运行时目录与 project/ 业务文件 When 使用 query 搜索文件 Then 只返回 project 中的匹配项而不包含 .copis 内容', async () => {
    const result = await searchWorkspaceFiles(tempWorkspaceDir, 'index', 20)

    const entryPaths = result.entries.map((entry) => entry.path)
    expect(entryPaths).toContain(join('project', 'src', 'index.ts'))

    const copisEntries = result.entries.filter(
      (entry) => entry.name.includes('.copis') || entry.path.includes('.copis'),
    )
    expect(copisEntries).toHaveLength(0)
  })

  test('Given 工作区包含常规忽略目录 (node_modules, .git, dist) When 搜索文件 Then 保持对这些目录的忽略', async () => {
    const nodeModulesDir = join(tempWorkspaceDir, 'node_modules', 'pkg')
    mkdirSync(nodeModulesDir, { recursive: true })
    writeFileSync(join(nodeModulesDir, 'index.js'), 'module.exports = {}')

    const gitDir = join(tempWorkspaceDir, '.git', 'objects')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'obj1'), '')

    const result = await searchWorkspaceFiles(tempWorkspaceDir, '', 20)

    const nodeModulesEntries = result.entries.filter(
      (entry) => entry.name === 'node_modules' || entry.path.startsWith('node_modules'),
    )
    const gitEntries = result.entries.filter(
      (entry) => entry.name === '.git' || entry.path.startsWith('.git'),
    )
    expect(nodeModulesEntries).toHaveLength(0)
    expect(gitEntries).toHaveLength(0)
  })

  test('Given .copis 作为附加目录传入 When 执行搜索 Then 附加路径中的 .copis 目录也被排除', async () => {
    const externalCopisDir = join(tempWorkspaceDir, '.copis')
    const result = await searchWorkspaceFiles(tempWorkspaceDir, '', 20, [externalCopisDir])

    const copisEntries = result.entries.filter(
      (entry) => entry.name === '.copis' || entry.path.includes('.copis'),
    )
    expect(copisEntries).toHaveLength(0)
  })

  test('Given .copis 是指向运行时目录的符号链接 When 搜索根目录 Then 不显示该链接', async () => {
    const copisPath = join(tempWorkspaceDir, '.copis')
    const runtimeDirectory = join(tempWorkspaceDir, 'copis-runtime')
    rmSync(copisPath, { recursive: true, force: true })
    mkdirSync(runtimeDirectory, { recursive: true })
    writeFileSync(join(runtimeDirectory, 'session.json'), '{"id": "runtime"}')
    symlinkSync(runtimeDirectory, copisPath, 'dir')

    const result = await searchWorkspaceFiles(tempWorkspaceDir, '', 20)

    expect(result.entries.filter((entry) => entry.name === '.copis' || entry.path === '.copis')).toHaveLength(0)
  })
})
