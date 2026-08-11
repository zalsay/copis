import { createBrowserPageControlService } from './browser-page-control-service'
import {
  getBrowserAgentContext,
  isBrowserPageAdvancedAuthorizationEnabled,
  getBrowserPageControlMode,
  resolveBrowserPageUploadPaths,
} from './browser-workflow-service'
import {
  getWebTabState,
  navigateWebTab,
  sendWebTabCdpCommandInternal,
} from './web-tab-manager'

export const browserPageControl = createBrowserPageControlService({
  getContext: getBrowserAgentContext,
  getControlMode: getBrowserPageControlMode,
  isAdvancedAuthorizationEnabled: isBrowserPageAdvancedAuthorizationEnabled,
  resolveUploadPaths: resolveBrowserPageUploadPaths,
  getTab: getWebTabState,
  sendCommand: sendWebTabCdpCommandInternal,
  navigate(tabId, url) {
    navigateWebTab({ tabId, url })
  },
})
