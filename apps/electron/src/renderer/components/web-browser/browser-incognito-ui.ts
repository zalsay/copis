import type { WebTabState } from '@copis/shared'

export interface IncognitoActionState {
  visible: boolean
  disabled: boolean
  active: boolean
  label: string
  description: string
}

/** 将主进程页签状态转换为地址栏无痕按钮的展示和可用状态。 */
export function getIncognitoActionState(tab: WebTabState | null): IncognitoActionState {
  if (!tab) {
    return {
      visible: false,
      disabled: true,
      active: false,
      label: '无痕模式',
      description: 'Copis 首页不支持无痕页签',
    }
  }

  if (tab.isIncognito) {
    return {
      visible: true,
      disabled: true,
      active: true,
      label: '无痕模式已启用',
      description: '当前页签使用独立的临时浏览会话',
    }
  }

  if (tab.canActivateIncognito) {
    return {
      visible: true,
      disabled: false,
      active: false,
      label: '启用无痕模式',
      description: '启用后使用独立的临时浏览会话',
    }
  }

  return {
    visible: true,
    disabled: true,
    active: false,
    label: '无法启用无痕模式',
    description: '当前页签已打开过地址，请新建空白页签后再启用无痕模式',
  }
}
