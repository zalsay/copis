import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./AutomationsListView.tsx', import.meta.url), 'utf8')

describe('定时任务列表刷新', () => {
  test('Given Rust 已在当前窗口启动后创建任务 When 用户进入定时任务 Then 列表重新读取持久化任务', () => {
    expect(source).toContain('React.useEffect(() => {')
    expect(source).toContain('void refreshList().catch((error) =>')
    expect(source).toContain('[定时任务] 刷新失败:')
    expect(source).toMatch(/React\.useEffect\(\(\) => \{\s*void refreshList\(\)\.catch\(\(error\) => \{/)
  })
})
