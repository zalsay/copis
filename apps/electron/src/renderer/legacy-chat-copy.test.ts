import { expect, test } from 'bun:test'

const LEGACY_CHAT_COPY = [
  'Chat / Agent',
  'Chat 模式',
  'Chat 或 Agent',
  'ChatHeader',
]

test('仅 Agent 模式文案不再宣传已删除的 Chat 工作流', async () => {
  const sourcePaths = [
    ...await Array.fromAsync(new Bun.Glob('**/*.ts').scan({ cwd: import.meta.dir })),
    ...await Array.fromAsync(new Bun.Glob('**/*.tsx').scan({ cwd: import.meta.dir })),
  ].filter((source) => !source.includes('.test.') && source !== 'atoms/app-mode.ts')

  for (const source of sourcePaths) {
    const content = await Bun.file(`${import.meta.dir}/${source}`).text()

    for (const copy of LEGACY_CHAT_COPY) {
      expect(content).not.toContain(copy)
    }
  }
})
