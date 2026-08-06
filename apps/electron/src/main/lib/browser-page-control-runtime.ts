import { createBrowserPageControlService } from './browser-page-control-service'
import {
  getBrowserAgentContext,
  getBrowserPageControlMode,
} from './browser-workflow-service'
import {
  getWebTabState,
  navigateWebTab,
  sendWebTabCdpCommandInternal,
} from './web-tab-manager'

export const browserPageControl = createBrowserPageControlService({
  getContext: getBrowserAgentContext,
  getControlMode: getBrowserPageControlMode,
  getTab: getWebTabState,
  sendCommand: sendWebTabCdpCommandInternal,
  navigate(tabId, url) {
    navigateWebTab({ tabId, url })
  },
})
