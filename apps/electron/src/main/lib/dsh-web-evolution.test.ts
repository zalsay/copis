import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const skillsRoot = join(__dirname, '../../../default-skills/dsh-web-evolution')
const skillFile = join(skillsRoot, 'SKILL.md')
const templateDir = join(skillsRoot, 'templates')
const templatePkg = join(templateDir, 'package.json')
const templateTsconfig = join(templateDir, 'tsconfig.json')
const templateClient = join(templateDir, 'src/client.tsx')
const templateBuild = join(templateDir, 'build.mjs')
const templateLib = join(templateDir, 'lib')

describe('DSH Web 自进化与扩展技能契约', () => {
  afterAll(() => {
    if (existsSync(templateLib)) {
      rmSync(templateLib, { recursive: true, force: true })
    }
  })

  test('Given dsh-web-evolution 技能 When 读取 SKILL.md Then 具备合规的元数据与核心插槽目录', () => {
    expect(existsSync(skillFile)).toBe(true)
    const content = readFileSync(skillFile, 'utf8')

    // 校验 YAML frontmatter
    expect(content).toContain('name: dsh-web-evolution')
    expect(content).toContain('displayName: DSH Web 自进化与扩展')
    expect(content).toContain('category: Copis 功能')

    // 校验核心插槽说明
    expect(content).toContain('details')
    expect(content).toContain('conversation.composer.dock')
    expect(content).toContain('shell.overlay')
    expect(content).toContain('conversation.chat.turnTail')

    // 校验自进化安全边界与 HMR 机制
    expect(content).toContain('绝对不要直接修改已安装的官方包')
    expect(content).toContain("patchReload: 'live'")
    expect(content).toContain('dsh-client-hmr')
    expect(content).toContain('apply(ctx')
  })

  test('Given dsh-web-evolution 模板工程 When 检查文件结构 Then 包含完整的客户端插件脚手架', () => {
    expect(existsSync(templatePkg)).toBe(true)
    expect(existsSync(templateTsconfig)).toBe(true)
    expect(existsSync(templateClient)).toBe(true)
    expect(existsSync(templateBuild)).toBe(true)

    const pkg = JSON.parse(readFileSync(templatePkg, 'utf8'))
    expect(pkg.name).toBe('@copis-ext/dsh-template-plugin')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.exports?.['./client']).toBe('./lib/client.js')

    const clientSrc = readFileSync(templateClient, 'utf8')
    expect(clientSrc).toContain('export function apply(ctx')
    expect(clientSrc).toContain("ctx.slots.inject('conversation.composer.dock'")
  })

  test('Given 模板插件源码 When 执行 build.mjs Then 产出符合 DSH ModuleLoader 规范的客户端 bundle', async () => {
    const buildProc = Bun.spawnSync(['bun', templateBuild], {
      cwd: templateDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(buildProc.exitCode).toBe(0)
    const stdout = buildProc.stdout.toString()
    expect(stdout).toContain('成功构建 DSH 客户端插件: @copis-ext/dsh-template-plugin -> lib/client.js')

    const builtBundle = join(templateLib, 'client.js')
    expect(existsSync(builtBundle)).toBe(true)

    const bundleContent = readFileSync(builtBundle, 'utf8')
    expect(bundleContent).toContain('window.__ModuleLoader__.load({')
    expect(bundleContent).toContain('id: "@copis-ext/dsh-template-plugin"')
    expect(bundleContent).toContain('apply:')
    expect(bundleContent).toContain('conversation.composer.dock')
    expect(bundleContent).toContain('--creation-ui-primary')
  })
})
