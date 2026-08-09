import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agentStyles = readFileSync(join(import.meta.dir, 'AgentView.css'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

describe('Agent 思考状态动画契约', () => {
  test('Given Agent 正在思考 When 展示模型气泡 Then 跑马灯复刻 Working 的周期并与方块加载图标同步', () => {
    expect(agentStyles).toContain('animation: agent-thinking-marquee 1.35s linear infinite;')
    expect(globalStyles).toContain('animation: spinner 1.35s infinite ease-in-out;')
  })

  test('Given Agent 正在思考 When 展示模型气泡 Then 跑马灯以 Working 的灰白高光由右向左推进', () => {
    expect(agentStyles).toContain('background: linear-gradient(90deg, #7f7f87 0%, #f1f1f3 42%, #7f7f87 84%);')
    expect(agentStyles).toContain('background-position: 220% 0;')
    expect(agentStyles).toContain('background-position: 0 0;')
  })
})
