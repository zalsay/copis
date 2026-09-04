import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildBrowserPageCursorSource,
  resolveBrowserPageCursorResourcePath,
} from './browser-page-cursor'

const cursorSvg = readFileSync(join(import.meta.dir, '../../../resources/cursor_rainbow.svg'), 'utf8')
const cursorSvgDataUrl = `data:image/svg+xml;base64,${Buffer.from(cursorSvg, 'utf8').toString('base64')}`

describe('AI 浏览器模拟鼠标脚本', () => {
  test('Given 单独构建主进程且 dist/resources 缺失 When 加载指针素材 Then 回退到应用 resources 目录', () => {
    const moduleDir = join(import.meta.dir, '../../../dist')
    const cwd = join(import.meta.dir, '../../..')
    const sourceResourcePath = join(cwd, 'resources/cursor_rainbow.svg')

    expect(resolveBrowserPageCursorResourcePath({
      moduleDir,
      resourcesPath: join(import.meta.dir, '../../../missing-resources'),
      cwd,
      exists: (candidate) => candidate === sourceResourcePath,
    })).toBe(sourceResourcePath)
  })

  test('Given 有效坐标 When 移动指针 Then 生成固定定位且不可交互的页面节点', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('data-copis-ai-browser-cursor')
    expect(source).toContain('pointer-events:none')
    expect(source).toContain('position:fixed')
    expect(source).not.toContain('linear-gradient')
    expect(source).not.toContain('clip-path')
    expect(source).toContain('window.innerWidth / 2')
    expect(source).toContain('window.innerHeight / 2')
    expect(source).toContain('transition:left 420ms ease,top 420ms ease')
    expect(source).toContain('__copisAiBrowserCursorX')
    expect(source).toContain('__copisAiBrowserCursorY')
    expect(source).toContain('const waitForCursorMove')
    expect(source).toContain('window.setTimeout(resolve, 500)')
    expect(source.match(/window\.requestAnimationFrame\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    const delay = Number(source.match(/window\.setTimeout\(resolve, (\d+)\)/)?.[1])
    expect(delay).toBeGreaterThanOrEqual(60)
    expect(delay).toBeLessThanOrEqual(100)
    expect(source).toContain('120')
    expect(source).toContain('80')
  })

  test('Given 页面指针脚本 When 注入指针 Then 指针视觉尺寸为 44x56', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    expect(source).toContain('width:44px;height:56px')
  })

  test('Given 页面指针脚本 When 首次执行或移动 Then 先从中央平滑移动并在完成后返回', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    const paintIndex = source.indexOf('return waitForCursorPaint()')
    const moveIndex = source.indexOf('cursor.style.left = x + \'px\'')
    const resultIndex = source.lastIndexOf('return { ok: true, x, y, phase }')

    expect(source).toContain('window.innerWidth / 2')
    expect(source).toContain('window.innerHeight / 2')
    expect(source).toContain('transition:left 420ms ease,top 420ms ease')
    expect(moveIndex).toBeGreaterThan(paintIndex)
    expect(resultIndex).toBeGreaterThan(moveIndex)
  })

  test('Given WebContentsView 未调度动画帧 When 注入指针 Then 独立计时器仍会结束等待', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    expect(source).toContain('window.setTimeout(finish, 120)')
  })

  test('Given 透明矢量指针素材 When 注入页面 Then 使用 SVG data URL 且不嵌入 PNG 背景', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    expect(source).toContain(cursorSvgDataUrl)
    expect(cursorSvg).toContain('<filter')
    expect(cursorSvg).toContain('feGaussianBlur')
    expect(cursorSvg).not.toContain('<image')
    expect(cursorSvg).not.toContain('data:image/png')
    expect(source).not.toContain('/Volumes/RC500/dev/copis')
  })

  test('Given 按下状态 When 生成脚本 Then 脚本包含按下视觉状态', () => {
    expect(buildBrowserPageCursorSource({ phase: 'press', x: 10, y: 20 })).toContain('press')
  })

  test('Given 非有限或负坐标 When 生成脚本 Then 坐标被限制为页面安全数值', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: Number.POSITIVE_INFINITY, y: -20 })

    expect(source).toContain('const x = 0')
    expect(source).toContain('const y = 0')
    expect(source).not.toContain('Infinity')
    expect(source).not.toContain('-20')
  })

  test('Given hide 阶段 When 生成脚本 Then 删除已有指针节点', () => {
    const source = buildBrowserPageCursorSource({ phase: 'hide' })

    expect(source).toContain('clearTimeout')
    expect(source).toContain('.remove()')
    expect(source).toContain('return { ok: true }')
  })

  test('Given 指针节点 When 自动隐藏 When 生成脚本 Then 保留定时器和令牌安全约束', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    const movementWaitIndex = source.indexOf('return moveNeeded ? waitForCursorMove() : undefined')
    const scheduleIndex = source.lastIndexOf('scheduleCursorHide()')

    expect(source).toContain('window.setTimeout(() =>')
    expect(source).toContain('2000')
    expect(source).toContain('__copisAiBrowserCursorToken')
    expect(source).toContain('if (cursor && cursor.__copisAiBrowserCursorToken === token) cursor.remove()')
    expect(scheduleIndex).toBeGreaterThan(movementWaitIndex)
  })

  test('Given 自动隐藏已移除指针节点 When 下一次 action 注入指针 Then 从页面级最后坐标继续移动', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 240, y: 160 })

    expect(source).toContain('window.__copisAiBrowserCursorState')
    expect(source).toContain('cursorState.x')
    expect(source).toContain('cursorState.y')
    expect(source).toContain(': cursorState.x')
    expect(source).toContain(': cursorState.y')
    expect(source).toContain('cursorState.x = x')
    expect(source).toContain('cursorState.y = y')
  })

  test('Given 外部资源完全不存在（如打包自包含 Pi Worker 环境） When 初始化指针 Then 使用内置默认 SVG 且绝不抛出异常', () => {
    expect(resolveBrowserPageCursorResourcePath({
      resourcesPath: '/non-existent-resources-path',
      moduleDir: '/$bunfs/root',
      cwd: '/non-existent-cwd',
      exists: () => false,
    })).toBeUndefined()

    // 验证即使资源路径不存在，buildBrowserPageCursorSource 也正常返回有效脚本，不崩溃
    expect(() => buildBrowserPageCursorSource({ phase: 'move', x: 50, y: 50 })).not.toThrow()
  })
})
