import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsSource = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.tsx'), 'utf8')
const settingsStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')

describe('Working 设置页 VIP 摘要', () => {
  test('Given 钻石余额 When 查看账户卡片 Then 将预计对话次数作为左下角标签显示', () => {
    expect(settingsSource).toContain('const estimatedConversationCount = Math.floor(diamondBalance / 0.5)')
    expect(settingsSource).toContain('copis-working-settings-balance-conversation-count')
    expect(settingsSource).toContain("预计 {loading ? '--' : formatTokens(estimatedConversationCount)} 次对话")
    expect(settingsSource).not.toContain('用于 Working 与创作任务的 AI 消耗')
  })

  test('Given 已邀请用户 When 查看账户卡片 Then 将邀请人数作为左下角标签显示', () => {
    expect(settingsSource).toContain('copis-working-settings-invite-user-count')
    expect(settingsSource).toContain('已邀请 {settings?.invitedUsers.length ?? 0} 位用户')
    expect(settingsSource).not.toContain('copis-working-settings-invite-stats')
  })

  test('Given 用户查看邀请卡 When 阅读邀请说明 Then 显示钻石奖励说明', () => {
    expect(settingsSource).toContain('邀请好友使用，获取钻石奖励')
    expect(settingsSource).not.toContain('一个账号体验家庭与工作两种空间，分享 π 的陪伴与交付能力。')
  })

  test('Given 邀请人数位于左下角标签 When 展示邀请码 Then 邀请码框为标签预留垂直空间', () => {
    expect(settingsStyles).toContain('.copis-working-settings-invite-code {')
    expect(settingsStyles).toContain('margin-top: 6px;')
  })

  test('Given 非 VIP 用户 When 查看账户卡片 Then 摘要与权益对比表保持一致', () => {
    expect(settingsSource).toContain('钻石按标准消耗，专家团队和定时任务暂不可用。')
    expect(settingsSource).not.toContain('云文档容量')
  })

  test('Given VIP 用户 When 查看账户卡片 Then 将到期时间作为左下角标签显示', () => {
    expect(settingsSource).toContain('钻石消耗节省 20%，可使用专家团队和定时任务。')
    expect(settingsSource).toContain('copis-working-settings-vip-expiry')
    expect(settingsSource).toContain('有效期至 {formatDate(vipExpiresAt)}')
    expect(settingsSource).toContain("isVip ? '续费 VIP' : '升级 VIP'")
  })
})
