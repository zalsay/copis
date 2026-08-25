import { describe, expect, test } from 'bun:test'
import { cleanHtmlContent } from './memory-ingestion-service'

describe('Memory Ingestion Service / cleanHtmlContent 测试', () => {
  test('Given 包含 script, style 和标签的 HTML When cleanHtmlContent Then 剔除无用标签并提取标题与正文', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Copis 架构指南</title>
          <style>body { color: red; }</style>
          <script>console.log("secret")</script>
        </head>
        <body>
          <header><nav><a href="/">Home</a></nav></header>
          <main>
            <h1>Copis 概览</h1>
            <p>Copis 是一款集成通用 AI Agent 的桌面应用。&amp; 强大。</p>
            <div>
              <h2>核心特性</h2>
              <ul>
                <li>支持本地 SQLite 长期记忆</li>
                <li>基于 Electron 与 Bun 构建</li>
              </ul>
            </div>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `

    const { title, content } = cleanHtmlContent(rawHtml)

    expect(title).toBe('Copis 架构指南')
    expect(content).not.toContain('console.log')
    expect(content).not.toContain('body { color: red; }')
    expect(content).not.toContain('Copyright 2026')
    expect(content).toContain('Copis 概览')
    expect(content).toContain('Copis 是一款集成通用 AI Agent 的桌面应用。& 强大。')
    expect(content).toContain('支持本地 SQLite 长期记忆')
  })
})
