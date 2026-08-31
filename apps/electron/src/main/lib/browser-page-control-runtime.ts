import { createBrowserPageControlService } from './browser-page-control-service'
import {
  getBrowserAgentContext,
  isBrowserPageAdvancedAuthorizationEnabled,
  getBrowserPageControlMode,
  resolveBrowserPageUploadPaths,
  sendBrowserPageControlCdpCommand,
} from './browser-workflow-service'
import {
  getWebTabState,
  navigateWebTab,
} from './web-tab-manager'

export const browserPageControl = createBrowserPageControlService({
  getContext: getBrowserAgentContext,
  getControlMode: getBrowserPageControlMode,
  isAdvancedAuthorizationEnabled: isBrowserPageAdvancedAuthorizationEnabled,
  resolveUploadPaths: resolveBrowserPageUploadPaths,
  getTab: getWebTabState,
  sendCommand: sendBrowserPageControlCdpCommand,
  navigate(tabId, url) {
    navigateWebTab({ tabId, url })
  },
})
