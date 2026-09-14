import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const selectorSource = readFileSync(new URL('./ModelSelector.tsx', import.meta.url), 'utf8')
const surfaceSource = readFileSync(new URL('../agent/AgentConversationSurface.tsx', import.meta.url), 'utf8')
const welcomeComposerSource = readFileSync(new URL('../welcome/WelcomeComposer.tsx', import.meta.url), 'utf8')

test('Given 浏览器 Composer 的模型选择器 When 打开 Then 使用紧贴 Composer 向上展开的 Popover 抽屉', () => {
  expect(selectorSource).toContain("placement?: 'dialog' | 'composer'")
  expect(selectorSource).toContain('<PopoverContent')
  expect(selectorSource).toContain('side="top"')
  expect(selectorSource).toContain('sideOffset={8}')
  expect(selectorSource).toContain('role="listbox"')
  expect(selectorSource).toContain('role="option"')
  expect(selectorSource).toContain('aria-selected={isSelected}')
  expect(selectorSource).toContain("placement === 'dialog' && modelDescription")
  expect(selectorSource).toContain('w-[min(220px,calc(100vw-2rem))]')
  expect(selectorSource).not.toContain('w-[min(420px,calc(100vw-2rem))]')
})

test('Given 普通 Agent 会话和浏览器 Composer When 渲染 ModelSelector Then 仅浏览器使用 Composer 抽屉', () => {
  expect(surfaceSource).toContain("placement={compact ? 'composer' : 'dialog'}")
  expect(surfaceSource).toContain('composerMode')
  expect(welcomeComposerSource).toContain('composerMode')
  expect(surfaceSource).toContain('useSharedOpenState={!compact}')
  expect(surfaceSource).not.toContain('\n          useSharedOpenState\n')
  expect(selectorSource).toContain('<Dialog open={open} onOpenChange={setOpen}>')
  expect(selectorSource).toContain('<Popover open={open} onOpenChange={setOpen}>')
})

test('Given 主进程渠道列表已加载 When Composer 构建模型选项 Then 不再从组件重复拼接内置渠道', () => {
  expect(selectorSource).not.toContain('additionalChannels')
  expect(selectorSource).not.toContain('createCopisWorkingChannel')
  expect(selectorSource).not.toContain('workingClientConfigAtom')
  expect(surfaceSource).not.toContain('additionalChannels=')
  expect(welcomeComposerSource).not.toContain('additionalChannels=')
  expect(welcomeComposerSource).toContain('COPIS_WORKING_CHANNEL_IDS')
})

test('Given Z.ai 分组与 GLM 模型 When Composer 使用 Copis 标识 Then 仍展示智谱 Logo', () => {
  expect(selectorSource).toContain('COPIS_WORKING_ZHIPU_CHANNEL_ID')
  expect(selectorSource).toContain('function usesZhipuLogo')
  expect(selectorSource).toContain('!usesZhipuLogo(option)')
  expect(selectorSource).toContain('const useZhipuLogo = usesZhipuLogo(first)')
})

test('Given 专业模式生效 When 打开模型选择器 Then 强制过滤第三方 Provider 及通识模型并提示专业模式生效', () => {
  expect(selectorSource).toContain('professionalModeAtom')
  expect(selectorSource).toContain('isProfessional?: boolean')
  expect(selectorSource).toContain('isProfessional')
  expect(selectorSource).toContain('[COPIS_WORKING_CHANNEL_ID]')
  expect(selectorSource).toContain("includeProviders: composerMode && !isProfessional ? ['zhipu'] : undefined")
  expect(selectorSource).toContain('COPIS_WORKING_GLOBAL_MODEL_ID')
  expect(selectorSource).toContain('!(o.channelId === COPIS_WORKING_CHANNEL_ID && o.modelId === COPIS_WORKING_GLOBAL_MODEL_ID)')
  expect(selectorSource).toContain('CodexLogoIcon')
  expect(selectorSource).toContain('专业模式生效中：已过滤第三方渠道与通识模型，仅展示 Copis 快速/专家与自定义模型')
})

