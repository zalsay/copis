import type { BrowserWorkflowStatus } from '@copis/shared'

export type BrowserWorkflowToolbarAction = 'start-recording' | 'stop-recording' | 'open-agent'

export function getBrowserWorkflowToolbarAction(status: BrowserWorkflowStatus): BrowserWorkflowToolbarAction {
  if (status.state === 'recording' || (status.state === 'paused_cdp_detached' && !status.run)) {
    return 'stop-recording'
  }
  if (status.state === 'idle' || status.state === 'error') return 'start-recording'
  return 'open-agent'
}
