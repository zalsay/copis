import { describe, expect, test } from 'bun:test'

const html = await Bun.file(new URL('./index.html', import.meta.url)).text()
const css = await Bun.file(new URL('./styles.css', import.meta.url)).text()

function mediaBlocks(source: string, feature: string): string[] {
  const blocks: string[] = []
  const marker = `@media (${feature})`
  let searchFrom = 0
  while (true) {
    const start = source.indexOf(marker, searchFrom)
    if (start === -1) break
    const braceStart = source.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end === -1) break
    blocks.push(source.slice(start, end))
    searchFrom = end
  }
  return blocks
}

describe('landing page 静态契约', () => {
  test('index.html 与 styles.css 非空', () => {
    expect(html.length).toBeGreaterThan(0)
    expect(css.length).toBeGreaterThan(0)
  })

  test('AI 浏览器自动化 section 位于 hero 与 workflow 之间，且带独立 id/class/aria-labelledby', () => {
    const heroIndex = html.indexOf('<section class="hero"')
    const browserIndex = html.indexOf('<section class="browser-automation-section"')
    const workflowIndex = html.indexOf('<section class="workflow-section"')

    expect(heroIndex).toBeGreaterThan(-1)
    expect(browserIndex).toBeGreaterThan(heroIndex)
    expect(workflowIndex).toBeGreaterThan(browserIndex)

    const browserSection = html.slice(browserIndex, workflowIndex)
    expect(browserSection).toMatch(/id="browser-automation"/)
    expect(browserSection).toMatch(/aria-labelledby="browser-automation-title"/)
    expect(html).toContain('id="browser-automation-title"')
  })

  test('右侧文案包含指定 eyebrow、标题与说明', () => {
    const browserIndex = html.indexOf('browser-automation-section')
    const copy = html.slice(browserIndex, html.indexOf('workflow-section'))

    expect(copy).toContain('AI 浏览器自动化')
    expect(copy).toContain('看见页面，')
    expect(copy).toContain('<span>再替你推进。</span>')
    expect(copy).toContain('内置 AI 浏览器')
    expect(copy).toContain('观察')
    expect(copy).toContain('授权')
    expect(copy).toContain('可追踪')
  })

  test('3 个步骤标记按顺序出现：打开页面 / 观察状态 / 执行操作', () => {
    const copyStart = html.indexOf('class="browser-automation-copy"')
    expect(copyStart).toBeGreaterThan(-1)
    const copy = html.slice(copyStart, html.indexOf('workflow-section'))

    const steps = ['打开页面', '观察状态', '执行操作']
    let cursor = -1
    for (const step of steps) {
      const stepIndex = copy.indexOf(step)
      expect(stepIndex).toBeGreaterThan(-1)
      expect(stepIndex).toBeGreaterThan(cursor)
      cursor = stepIndex
    }
  })

  test('AI 浏览器渲染图具备语义 aria-label、装饰元素 aria-hidden 与操作状态', () => {
    const browserIndex = html.indexOf('<figure class="ai-browser"')
    const figureEnd = html.indexOf('</figure>', browserIndex)

    expect(browserIndex).toBeGreaterThan(-1)
    const figure = html.slice(browserIndex, figureEnd)

    expect(figure).toMatch(/aria-label="[^"]*AI 浏览器[^"]*"/)
    expect(figure).toMatch(/aria-hidden="true"/)
    expect(figure).toContain('ai-browser-address')
    expect(figure).toContain('ai-browser-page')

    const statusStart = html.indexOf('class="ai-browser-status"')
    expect(statusStart).toBeGreaterThan(-1)
    const status = html.slice(statusStart, statusStart + 200)
    expect(status).toMatch(/role="status"/)
    expect(status).toMatch(/观察|执行/)
  })

  test('不引入远程资源与额外脚本', () => {
    expect(html).not.toMatch(/src="https?:/)
    expect(html).not.toMatch(/url\(https?:/)
    expect(css).not.toMatch(/url\(https?:/)
    expect(html.match(/<script/g)?.length ?? 0).toBe(1)
  })

  test('CSS 桌面两列布局：浏览器画面在左、文案在右', () => {
    expect(css).toMatch(/\.browser-automation-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.[\d.]+fr\)\s+minmax\([\d.]+px,\s*0\.[\d.]+fr\)/)
    expect(css).toMatch(/\.browser-automation-media\s*\{[^}]*min-width:\s*0/)
  })

  test('CSS <=760px 与 <=420px 堆叠且不溢出', () => {
    const small = mediaBlocks(css, 'max-width: 760px').find((block) => block.includes('.browser-automation-layout')) ?? ''
    const tiny = mediaBlocks(css, 'max-width: 420px').find((block) => block.includes('.browser-automation-section')) ?? ''

    expect(small.length).toBeGreaterThan(0)
    expect(small).toMatch(/grid-template-columns:\s*1fr/)
    expect(tiny.length).toBeGreaterThan(0)
    expect(tiny).toMatch(/min-width:\s*0/)
  })

  test('低强度动效受 prefers-reduced-motion 约束', () => {
    const noPreference = mediaBlocks(css, 'prefers-reduced-motion: no-preference')[0] ?? ''
    const reduce = mediaBlocks(css, 'prefers-reduced-motion: reduce')[0] ?? ''

    expect(noPreference).toContain('.ai-pointer')
    expect(noPreference).toContain('animation:')
    expect(reduce).toContain('.ai-pointer')
    expect(reduce).toMatch(/animation:\s*none/)
  })

  test('不再使用 teal/cyan 变量或青蓝色 hex/rgb 值', () => {
    // teal/cyan 变量（定义或 var() 引用）不允许出现
    expect(css).not.toMatch(/--teal|--cyan/i)
    expect(html).not.toMatch(/--teal|--cyan/i)

    // 绿色强调变量仍存在，青蓝强调已替换为绿色体系
    expect(css).toMatch(/--green:\s*#[0-9a-f]{6}/i)

    // 青蓝色系 hex：原 teal 强调色、hover、toast 底色、青白文字，以及常见 teal/cyan/sky 色板
    const tealCyanHex = [
      '#6ee7d8',
      '#93f2e6',
      '#203b33',
      '#c8d9d2',
      '#dcfdf7',
      '#0d9488',
      '#14b8a6',
      '#2dd4bf',
      '#5eead4',
      '#99f6e4',
      '#0891b2',
      '#06b6d4',
      '#22d3ee',
      '#67e8f9',
      '#a5f3fc',
      '#0ea5e9',
      '#38bdf8',
    ]
    for (const hex of tealCyanHex) {
      expect(html.toLowerCase()).not.toContain(hex)
      expect(css.toLowerCase()).not.toContain(hex)
    }

    // 青蓝色 rgb/rgba 值
    expect(css).not.toMatch(/rgba?\(\s*110,\s*231,\s*216/i)
    expect(css).not.toMatch(/rgba?\(\s*45,\s*212,\s*191/i)
    expect(css).not.toMatch(/rgba?\(\s*34,\s*211,\s*238/i)
  })
})

describe('landing logo 契约', () => {
  test('index.html 与 styles.css 不再引用 ./assets/main-logo.png', () => {
    expect(html).not.toContain('./assets/main-logo.png')
    expect(css).not.toContain('./assets/main-logo.png')
    expect(html).not.toMatch(/main-logo\.png/)
    expect(css).not.toMatch(/main-logo\.png/)
  })

  test('index.html 中 5 处 logo 引用全部替换为 ../mian-logo.svg', () => {
    expect(html.match(/\.\.\/mian-logo\.svg/g)?.length ?? 0).toBe(5)
  })

  test('styles.css hero-image 背景使用 ../mian-logo.svg', () => {
    expect(css).toMatch(/url\(["']?\.\.\/mian-logo\.svg["']?\)/)
  })

  test('../mian-logo.svg 文件存在', async () => {
    const exists = await Bun.file(new URL('../mian-logo.svg', import.meta.url)).exists()
    expect(exists).toBe(true)
  })
})
