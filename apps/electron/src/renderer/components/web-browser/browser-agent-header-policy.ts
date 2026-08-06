import type { BrowserPageControlMode, BrowserWorkflowStatus } from '@copis/shared'

export interface BrowserAgentHeaderState {
  mode: BrowserPageControlMode
  tone: 'safe' | 'warning'
  originLabel: string
  canAuthorize: boolean
}

export function getBrowserAgentHeaderState(status: BrowserWorkflowStatus): BrowserAgentHeaderState {
  let originLabel = ''
  try {
    originLabel = status.pageOrigin ? new URL(status.pageOrigin).host : ''
  } catch {
    originLabel = ''
  }
  const mode = status.controlMode === 'authorized' ? 'authorized' : 'ask'
  return {
    mode,
    tone: mode === 'authorized' ? 'warning' : 'safe',
    originLabel,
    canAuthorize: Boolean(originLabel),
  }
}
