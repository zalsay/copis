import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./WebJavascriptPromptWindowApp.tsx', import.meta.url), 'utf8')

test('prompt 独立入口仅使用最小 bridge，并覆盖默认值、确认取消与键盘操作', () => {
  expect(source).toContain('window.webJavascriptPrompt.get')
  expect(source).toContain('window.webJavascriptPrompt.resolve')
  expect(source).toContain('window.webJavascriptPrompt.cancel')
  expect(source).toContain('defaultPrompt')
  expect(source).toContain('autoFocus')
  expect(source).toContain('Enter')
  expect(source).toContain('Escape')
  expect(source).toContain('确认')
  expect(source).toContain('取消')
  expect(source).not.toContain('window.electronAPI')
})
