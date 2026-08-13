import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { AgentSessionMeta, AgentWorkspace, WorkingDiamondPackage } from '@copis/shared'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentRuntimeAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { workingHistorySelectionAtom } from '@/atoms/working-atoms'
import { isAgentSessionMeta, sanitizeAgentSessions } from '@/lib/agent-session-list'
import { useOpenSession } from './useOpenSession'

const DEFAULT_WORKSPACE_SLUG = 'default'

export function buildCopisDiamondPurchasePrompt(packageValue: WorkingDiamondPackage): string {
  const goodsName = packageValue.goodsName?.trim() || 'Copis 钻石'
  return [
    '我已在 Copis 设置中明确确认购买以下钻石套餐，请开始支付流程。',
    '',
    '<copis_diamond_purchase>',
    `套餐 ID：${packageValue.id}`,
    `商品：${goodsName}`,
    `价格：${packageValue.currency} ${packageValue.amount}`,
    `钻石：${packageValue.diamonds}`,
    '</copis_diamond_purchase>',
    '',
    '请调用 alipay-payment-skill，并严格按以下流程执行：1. 先使用 copis_working_payment 的 orders.pending 查询是否已有待支付订单；若订单可继续支付，优先继续支付，不能创建新订单。2. 没有可继续订单时，使用 alipay_bot 的 wallet.check 确认钱包已开通并授权。3. 使用 copis_working_payment 的 packages.list 复核套餐 ID、价格和钻石数量。4. 两项检查都通过后才使用 order.create 创建订单，生成并显示支付二维码。5. 创建成功后等待支付结果自动确认并完成到账。不要再调用其他支付动作或支付查询动作。若钱包或套餐不满足条件，停止创建订单并进入重新选择或官方钱包开通流程。',
  ].join('\n')
}

export function buildCopisVipUpgradePrompt(): string {
  return [
    '我已在 Copis 设置中明确确认升级或续费 Copis VIP，请开始支付流程。',
    '',
    '<copis_vip_upgrade>',
    '</copis_vip_upgrade>',
    '',
    '请调用 alipay-payment-skill，并严格按以下流程执行：1. 使用 alipay_bot 的 wallet.check 确认钱包已开通并授权。2. 确认当前请求是 Copis VIP 升级或续费，价格、权益和赠送钻石以服务端配置为准。3. 钱包检查通过后才使用 copis_working_payment 的 vip.create 创建订单，生成并显示支付二维码。4. 创建成功后等待支付结果自动确认并完成到账。不要再调用其他支付动作或支付查询动作。若钱包未就绪，停止创建订单并进入官方钱包开通流程。',
  ].join('\n')
}

function findDefaultWorkspace(workspaces: readonly AgentWorkspace[]): AgentWorkspace | undefined {
  return workspaces.find((workspace) => workspace.slug === DEFAULT_WORKSPACE_SLUG)
    ?? workspaces.find((workspace) => workspace.name === '默认项目')
}

export type StartCopisDiamondPurchase = (packageValue: WorkingDiamondPackage) => Promise<void>
export type StartCopisVipUpgrade = () => Promise<void>

/** 在独立的默认项目会话中提交已确认的钻石套餐，避免打断用户正在进行的项目对话。 */
export function useStartCopisDiamondPurchase(): StartCopisDiamondPurchase {
  const startPurchaseConversation = useStartCopisPurchaseConversation()

  return React.useCallback(async (packageValue: WorkingDiamondPackage): Promise<void> => {
    await startPurchaseConversation('购买钻石', buildCopisDiamondPurchasePrompt(packageValue))
  }, [startPurchaseConversation])
}

export function useStartCopisVipUpgrade(): StartCopisVipUpgrade {
  const startPurchaseConversation = useStartCopisPurchaseConversation()

  return React.useCallback(async (): Promise<void> => {
    await startPurchaseConversation('升级 VIP', buildCopisVipUpgradePrompt())
  }, [startPurchaseConversation])
}

type StartCopisPurchaseConversation = (title: string, prompt: string) => Promise<void>

function useStartCopisPurchaseConversation(): StartCopisPurchaseConversation {
  const openSession = useOpenSession()
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const agentRuntime = useAtomValue(agentRuntimeAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAgentWorkspaces = useSetAtom(agentWorkspacesAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setWorkingHistorySelection = useSetAtom(workingHistorySelectionAtom)

  return React.useCallback(async (title: string, prompt: string): Promise<void> => {
    if (!agentChannelId) throw new Error('Agent 渠道尚未就绪，请稍后重试')

    const workspaces = await window.electronAPI.listAgentWorkspaces()
    const workspace = findDefaultWorkspace(workspaces)
    if (!workspace) throw new Error('未找到默认项目，无法发起支付对话')

    setAgentWorkspaces(workspaces)
    setCurrentWorkspaceId(workspace.id)
    setWorkingHistorySelection(null)
    window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)

    const session = await window.electronAPI.createAgentSession(
      title,
      agentChannelId,
      workspace.id,
      agentModelId ?? undefined,
    )
    if (!isAgentSessionMeta(session)) throw new Error('创建支付会话失败')
    setAgentSessions((current) => [session, ...sanitizeAgentSessions(current).filter((item) => item.id !== session.id)])
    openSession('agent', session.id, session.title)

    await sendCopisPaymentMessage({
      session,
      workspaceId: workspace.id,
      agentChannelId,
      agentModelId,
      agentRuntime,
      prompt,
    })
  }, [agentChannelId, agentModelId, agentRuntime, openSession, setAgentSessions, setAgentWorkspaces, setCurrentWorkspaceId, setWorkingHistorySelection])
}

interface SendCopisPaymentMessageInput {
  session: AgentSessionMeta
  workspaceId: string
  agentChannelId: string
  agentModelId: string | null
  agentRuntime: AgentSessionMeta['agentRuntime']
  prompt: string
}

async function sendCopisPaymentMessage(input: SendCopisPaymentMessageInput): Promise<void> {
  await window.electronAPI.sendAgentMessage({
    sessionId: input.session.id,
    userMessage: input.prompt,
    rawUserMessage: input.prompt,
    channelId: input.session.channelId ?? input.agentChannelId,
    modelId: input.session.modelId ?? input.agentModelId ?? undefined,
    agentRuntime: input.session.agentRuntime ?? input.agentRuntime,
    workingMode: input.session.workingMode,
    workspaceId: input.workspaceId,
    startedAt: Date.now(),
    mentionedSkills: ['alipay-payment-skill'],
  })
}
