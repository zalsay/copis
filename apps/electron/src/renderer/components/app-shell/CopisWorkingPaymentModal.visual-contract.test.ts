import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const paymentStyles = readFileSync(join(import.meta.dir, 'CopisWorkingPaymentModal.css'), 'utf8')
const paymentSource = readFileSync(join(import.meta.dir, 'CopisWorkingPaymentModal.tsx'), 'utf8')
const ordersStyles = readFileSync(join(import.meta.dir, 'CopisWorkingOrdersPanel.css'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

describe('Working 支付视觉契约', () => {
  test('Given 支付主操作 When 读取品牌色 Then 使用 Copis primary token 且二维码保持高对比', () => {
    expect(globalStyles).toContain('--ui-primary: #f3af6b;')
    expect(globalStyles).toContain('--ui-primary-foreground: #2b2137;')
    expect(paymentStyles).toContain('background: var(--ui-primary);')
    expect(paymentStyles).toContain('color: var(--ui-primary-foreground, white);')
    expect(paymentStyles).toContain('background: white;')
    expect(paymentStyles).not.toContain('hsl(var(--ui-primary)')
  })

  test('Given 订单状态 When 切换亮暗主题 Then 成功状态保持可读并沿用语义色', () => {
    expect(ordersStyles).toContain('color: hsl(142 70% 35%);')
    expect(ordersStyles).toContain('.dark .copis-working-order-status.paid')
    expect(ordersStyles).toContain('color: hsl(142 65% 78%);')
    expect(ordersStyles).toContain('color: hsl(var(--destructive));')
    expect(ordersStyles).not.toContain('var(--primary)')
    expect(ordersStyles).not.toContain('color: var(--muted-foreground)')
  })

  test('Given 支付弹窗 When 展示套餐与 VIP 权益 Then 不显示冗余价格说明', () => {
    expect(paymentSource).not.toContain('价格和到账数量以服务端为准')
    expect(paymentSource).not.toContain('本次开通')
    expect(paymentSource).not.toContain('服务端价格 ¥')
    expect(paymentSource).toContain('VIP 配置暂未开放。')
  })

  test('Given VIP 权益对比 When 展示能力 Then 仅突出专家团队与定时任务', () => {
    expect(paymentSource).not.toContain('云盘容量')
    expect(paymentSource).not.toContain('会话等待')
    expect(paymentSource).not.toContain('高峰期排队')
    expect(paymentSource).toContain("{ label: '专家团队', free: '不可用', vip: '可使用' }")
    expect(paymentSource).toContain("{ label: '定时任务', free: '不可用', vip: '可使用' }")
    expect(paymentSource).toContain('解锁专家团队和定时任务。')
  })
})
