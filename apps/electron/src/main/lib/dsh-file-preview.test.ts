import { describe, expect, test, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import {
  resolveDshFilePath,
  isBinaryBuffer,
  readDshFile,
  listDshDirectory,
  MAX_DSH_TEXT_FILE_SIZE,
} from './dsh-file-service'

describe('DSH 文件预览与定位服务 (dsh-file-service)', () => {
  const testDir = join(tmpdir(), `copis-dsh-file-preview-test-${Date.now()}`)

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('Given 相对路径与 cwd When 解析路径 Then 正确拼接至 cwd', () => {
    const cwd = '/my/test/workspace'
    const resolved = resolveDshFilePath('src/index.ts', cwd)
    expect(resolved).toBe(join(cwd, 'src/index.ts'))
  })

  test('Given 用户主目录缩写 ~/ When 解析路径 Then 展开 homedir', () => {
    const resolved = resolveDshFilePath('~/projects/demo/app.vue')
    expect(resolved).toBe(join(homedir(), 'projects/demo/app.vue'))
  })

  test('Given 绝对路径 When 解析路径 Then 直接保留绝对路径', () => {
    const abs = '/var/log/system.log'
    expect(resolveDshFilePath(abs, '/other/cwd')).toBe(abs)
  })

  test('Given 空字符缓冲区 When 校验二进制 Then 正确识别', () => {
    const textBuf = Buffer.from('hello world', 'utf8')
    expect(isBinaryBuffer(textBuf)).toBe(false)

    const binBuf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])
    expect(isBinaryBuffer(binBuf)).toBe(true)
  })

  test('Given 普通文本文件 When 读取文件 Then 返回 UTF-8 内容与成功状态', () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'hello.ts')
    writeFileSync(filePath, 'export const greeting = "hello";', 'utf8')

    const result = readDshFile('hello.ts', testDir)
    expect(result.success).toBe(true)
    expect(result.content).toBe('export const greeting = "hello";')
    expect(result.isImage).toBe(false)
    expect(result.path).toBe(filePath)
    expect(result.size).toBeGreaterThan(0)
  })

  test('Given 不存在的文件 When 读取文件 Then 返回友好错误提示', () => {
    const result = readDshFile('nonexistent.txt', testDir)
    expect(result.success).toBe(false)
    expect(result.error).toContain('文件不存在')
  })

  test('Given 目录路径 When 读取文件 Then 拒绝并返回非普通文件提示', () => {
    mkdirSync(testDir, { recursive: true })
    const result = readDshFile(testDir)
    expect(result.success).toBe(false)
    expect(result.error).toContain('目标路径不是普通文件')
  })

  test('Given PNG 图片文件 When 读取文件 Then 返回 Base64 Data URL', () => {
    mkdirSync(testDir, { recursive: true })
    const imgPath = join(testDir, 'sample.png')
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(imgPath, pngHeader)

    const result = readDshFile(imgPath)
    expect(result.success).toBe(true)
    expect(result.isImage).toBe(true)
    expect(result.content).toMatch(/^data:image\/png;base64,/)
  })

  test('Given SVG 图片文件 When 读取文件 Then 返回 image/svg+xml Data URL', () => {
    mkdirSync(testDir, { recursive: true })
    const svgPath = join(testDir, 'icon.svg')
    writeFileSync(svgPath, '<svg></svg>', 'utf8')

    const result = readDshFile(svgPath)
    expect(result.success).toBe(true)
    expect(result.isImage).toBe(true)
    expect(result.content).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  test('Given 二进制文件 When 读取文件 Then 触发二进制保护并拒绝文本预览', () => {
    mkdirSync(testDir, { recursive: true })
    const binPath = join(testDir, 'data.bin')
    const binData = Buffer.from([0x01, 0x02, 0x00, 0x04, 0x05])
    writeFileSync(binPath, binData)

    const result = readDshFile(binPath)
    expect(result.success).toBe(false)
    expect(result.binary).toBe(true)
    expect(result.error).toContain('该文件为二进制文件')
  })

  test('Given 超过 2MB 的大文件 When 读取文件 Then 触发超大文件保护', () => {
    mkdirSync(testDir, { recursive: true })
    const largePath = join(testDir, 'huge.log')
    // 写入超过 2MB 的文本内容
    const chunk = 'a'.repeat(1024 * 1024)
    writeFileSync(largePath, chunk + chunk + 'extra')

    const result = readDshFile(largePath)
    expect(result.success).toBe(false)
    expect(result.tooLarge).toBe(true)
    expect(result.error).toContain('超过 2MB 限制')
  })

  test('Given 工作区目录包含文件夹与文件 When 列出目录 Then 目录排在文件前且排序正确', () => {
    mkdirSync(testDir, { recursive: true })
    mkdirSync(join(testDir, 'src'), { recursive: true })
    mkdirSync(join(testDir, 'docs'), { recursive: true })
    writeFileSync(join(testDir, 'README.md'), '# Title', 'utf8')
    writeFileSync(join(testDir, 'package.json'), '{}', 'utf8')

    const entries = listDshDirectory(undefined, testDir)
    expect(entries.length).toBe(4)

    // 前两项为目录且按字母排序
    expect(entries[0]!.name).toBe('docs')
    expect(entries[0]!.isDirectory).toBe(true)
    expect(entries[1]!.name).toBe('src')
    expect(entries[1]!.isDirectory).toBe(true)

    // 后两项为文件且按字母排序
    expect(entries[2]!.name).toBe('package.json')
    expect(entries[2]!.isDirectory).toBe(false)
    expect(entries[2]!.size).toBeGreaterThanOrEqual(2)
    expect(entries[3]!.name).toBe('README.md')
    expect(entries[3]!.isDirectory).toBe(false)
  })

  test('Given 存在 node_modules、.git、.DS_Store 与点开头的配置 When 列出目录 Then 过滤垃圾目录并保留配置文件', () => {
    mkdirSync(testDir, { recursive: true })
    mkdirSync(join(testDir, '.git'), { recursive: true })
    mkdirSync(join(testDir, 'node_modules'), { recursive: true })
    mkdirSync(join(testDir, 'src'), { recursive: true })
    writeFileSync(join(testDir, '.DS_Store'), 'dummy')
    writeFileSync(join(testDir, '.gitignore'), 'node_modules\n', 'utf8')
    writeFileSync(join(testDir, '.env'), 'KEY=123\n', 'utf8')
    writeFileSync(join(testDir, 'index.ts'), 'console.log(1);', 'utf8')

    const entries = listDshDirectory(testDir)
    const names = entries.map((e) => e.name)

    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.DS_Store')

    expect(names).toContain('src')
    expect(names).toContain('index.ts')
    expect(names).toContain('.gitignore')
    expect(names).toContain('.env')
  })

  test('Given 不存在的目录路径 When 列出目录 Then 返回空数组', () => {
    const entries = listDshDirectory(join(testDir, 'not-exist'))
    expect(entries).toEqual([])
  })

  test('Given 子目录相对路径 When 列出目录 Then 正确返回子目录下条目', () => {
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'components', 'Button.vue'), '<template></template>', 'utf8')

    const entries = listDshDirectory('src/components', testDir)
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('Button.vue')
    expect(entries[0]!.isDirectory).toBe(false)
  })
})

