import { describe, expect, test } from 'bun:test'
import { buildCopisDiamondPurchasePrompt, buildCopisVipUpgradePrompt } from './useStartCopisDiamondPurchase'

describe('Copis 钻石购买对话', () => {
  test('Given 设置页已选择套餐 When 构建购买消息 Then 要求 Agent 执行四步 Copis 支付流程', () => {
    const prompt = buildCopisDiamondPurchasePrompt({
      id: 12,
      goodsName: '100 钻石',
      amount: '9.90',
      amountCents: 990,
      currency: 'CNY',
      diamonds: 100,
    })

    expect(prompt).toContain('套餐 ID：12')
    expect(prompt).toContain('copis_working_payment 的 packages.list')
    expect(prompt).toContain('alipay_bot 的 wallet.check')
    expect(prompt).toContain('alipay-payment-skill')
    expect(prompt).toContain('orders.pending')
    expect(prompt).toContain('优先继续支付，不能创建新订单')
    expect(prompt).toContain('两项检查都通过后才使用 order.create')
    expect(prompt).toContain('生成并显示支付二维码')
    expect(prompt).toContain('等待支付结果自动确认并完成到账')
    expect(prompt).not.toContain('本机 Rust')
    expect(prompt).not.toMatch(/收银台|cashier|payment\.start|payment\.check|payment\.ack|402/i)
  })
})

describe('Copis VIP 升级对话', () => {
  test('Given 设置页确认升级 VIP When 构建购买消息 Then 要求 Agent 使用同一受控支付流程', () => {
    const prompt = buildCopisVipUpgradePrompt()

    expect(prompt).toContain('升级或续费 Copis VIP')
    expect(prompt).toContain('alipay-payment-skill')
    expect(prompt).toContain('alipay_bot 的 wallet.check')
    expect(prompt).toContain('copis_working_payment 的 vip.create')
    expect(prompt).toContain('生成并显示支付二维码')
    expect(prompt).toContain('等待支付结果自动确认并完成到账')
    expect(prompt).not.toMatch(/本机 Rust|payment\.start|payment\.check|payment\.ack|402/i)
  })
})
