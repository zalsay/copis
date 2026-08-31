import { spawn } from 'node:child_process'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import type {
  BrowserLocatorBundle,
  BrowserWorkflowVersion,
  BrowserWorkflowRunSummary,
} from '@copis/shared'
import {
  createWebTab,
  closeWebTab,
  disposeWebTabs,
  detachWebTabCdpForTest,
  getWebTabState,
  isWebTabCdpAttached,
  navigateWebTab,
  setWebTabHostWindow,
  subscribeWebTabLifecycle,
  updateWebTabBounds,
  waitForWebTabLoad,
} from '../src/main/lib/web-tab-manager'
import { createBrowserPageControlService } from '../src/main/lib/browser-page-control-service'
import {
  continueBrowserWorkflowRun,
  runBrowserWorkflow,
} from '../src/main/lib/browser-workflow-runner'
import {
  bindBrowserAgentContext,
  unbindBrowserAgentContext,
  openBrowserAgentTab,
  setBrowserPageControlMode,
  getBrowserPageControlMode,
  isBrowserPageAdvancedAuthorizationEnabled,
  resolveBrowserPageUploadPaths,
  sendBrowserPageControlCdpCommand,
  getBrowserAgentContext,
  subscribeBrowserWorkflowStatus,
} from '../src/main/lib/browser-workflow-service'
import { createAgentSession, updateAgentSessionMeta } from '../src/main/lib/agent-session-manager'
import { saveBrowserWorkflow } from '../src/main/lib/browser-workflow-store'
import { ensureDefaultWorkspace } from '../src/main/lib/agent-workspace-manager'
import { getFunctionalModulesDir } from '../src/main/lib/config-paths'
import { configurePlaywrightCdpEndpoint, getPlaywrightCdpEndpoint } from '../src/main/lib/playwright-cdp-endpoint'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  type FunctionalModulePackage,
} from '../src/main/lib/functional-module-store'

interface TrackedServer {
  readonly origin: string
  readonly close: () => Promise<void>
}

interface FixtureServers {
  readonly mainOrigin: string
  readonly frameOrigin: string
  readonly close: () => Promise<void>
}

interface NormalProbeResult {
  readonly noRemoteDebuggingPortArg: boolean
  readonly noRemoteDebuggingAddressArg: boolean
  readonly noRemoteDebuggingPortSwitch: boolean
  readonly noRemoteDebuggingAddressSwitch: boolean
  readonly ordinaryTabWebDriverFalse: boolean
  readonly ordinaryTabDebuggerNotAttached: boolean
  readonly oauthChildDebuggerNotAttached: boolean
  readonly oauthParentDebuggerNotAttached: boolean
  readonly oauthChildSharesSession: boolean
  readonly oauthChildClosed: boolean
  readonly agentTabLeaseAttached: boolean
  readonly ordinaryTabsRemainDetached: boolean
  readonly agentTabLeaseReleased: boolean
  readonly agentOpenTabAttached: boolean
  readonly agentOpenTabReleased: boolean
}

interface InstrumentedE2EResult {
  readonly nodeCdpVerified: boolean
  readonly pageControl: {
    readonly observed: boolean
    readonly askRejected: boolean
    readonly typed: boolean
    readonly crossOriginRevoked: boolean
  }
  readonly workflow: {
    readonly summary: BrowserWorkflowRunSummary
    readonly workflowTabCreated: boolean
    readonly workflowTabAttachedDuringRun: boolean
    readonly workflowTabClosedOrDetached: boolean
  }
  readonly ambiguousError: string
  readonly detachWorkflow: BrowserWorkflowRunSummary
  readonly detachPaused: boolean
  readonly failureHandoff: {
    readonly errorCaught: boolean
    readonly promotedTabAttached: boolean
    readonly promotedTabReleased: boolean
  }
}

const e2eMode = process.env.COPIS_E2E_MODE ?? 'instrumented'
const isNormalProbe = e2eMode === 'normal-probe'
const userDataDir = process.env.COPIS_E2E_USER_DATA
if (userDataDir) app.setPath('userData', userDataDir)

if (!isNormalProbe) {
  configurePlaywrightCdpEndpoint(app)
}

function logE2EStage(stage: string): void {
  console.log(`[Browser Workflow E2E] ${stage}`)
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await predicate()
    if (result) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待超时 (${timeoutMs}ms): ${description}`)
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port')
  return address.port
}

function createTrackedServer(
  requestListener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TrackedServer> {
  const server = createServer(requestListener)
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  return listen(server).then((port) => {
    const origin = `http://127.0.0.1:${port}`
    const close = async (): Promise<void> => {
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {}
      }
      sockets.clear()
      const serverAny = server as unknown as { closeAllConnections?: () => void }
      if (typeof serverAny.closeAllConnections === 'function') {
        try {
          serverAny.closeAllConnections()
        } catch {}
      }
      if (server.listening) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 1_000)
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    }
    return { origin, close }
  })
}

function html(body: string): Buffer {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Copis Browser Workflow Fixture</title></head><body>${body}</body></html>`)
}

async function runNormalProbe(): Promise<NormalProbeResult> {
  logE2EStage('启动正常模式 Electron 探针')
  const noRemoteDebuggingPortArg = !process.argv.some((arg) => arg.includes('remote-debugging-port'))
  const noRemoteDebuggingAddressArg = !process.argv.some((arg) => arg.includes('remote-debugging-address'))
  const noRemoteDebuggingPortSwitch = !app.commandLine.hasSwitch('remote-debugging-port')
  const noRemoteDebuggingAddressSwitch = !app.commandLine.hasSwitch('remote-debugging-address')

  if (!noRemoteDebuggingPortArg || !noRemoteDebuggingAddressArg || !noRemoteDebuggingPortSwitch || !noRemoteDebuggingAddressSwitch) {
    throw new Error('正常启动进程参数或开关异常包含了 remote-debugging 调试配置')
  }

  let normalOrigin = ''
  const fixtureServer = await createTrackedServer((request, response) => {
    const parsedUrl = new URL(request.url ?? '/', normalOrigin || 'http://127.0.0.1')
    const path = parsedUrl.pathname
    if (path === '/normal') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'copis_normal_auth=session_probe_token_12345; Path=/',
      })
      response.end(html(`
        <h1>Normal Tab Page</h1>
        <button id="open-oauth" type="button" onclick="window.open('${normalOrigin}/oauth-child', 'oauth_popup', 'width=600,height=500')">Open OAuth</button>
        <p id="cookie-status">Cookie set</p>
      `))
      return
    }
    if (path === '/oauth-child') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html(`
        <h1>OAuth Child Page</h1>
        <p id="child-cookie-status">OAuth child ready</p>
      `))
      return
    }
    if (path === '/agent-tab') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html(`
        <h1>Agent Tab Page</h1>
        <p id="agent-status">Agent tab ready</p>
      `))
      return
    }
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html('<h1>Not Found</h1>'))
  })
  normalOrigin = fixtureServer.origin

  let hostWindow: BrowserWindow | undefined
  let normalTabId: string | undefined
  let secondTabId: string | undefined
  let agentTabId: string | undefined
  let agentSessionId: string | undefined
  let popupWindow: BrowserWindow | undefined

  try {
    await app.whenReady()
    hostWindow = new BrowserWindow({ show: false, width: 1280, height: 900 })
    setWebTabHostWindow(hostWindow)

    logE2EStage('创建普通用户 HTTP 页签')
    const normalSnapshot = createWebTab({ url: `${fixtureServer.origin}/normal`, activate: true })
    normalTabId = normalSnapshot.activeTabId
    if (!normalTabId) throw new Error('未能创建普通页签')
    await waitForWebTabLoad(normalTabId, 10_000)

    const ordinaryTabDebuggerNotAttached = !isWebTabCdpAttached(normalTabId)
    if (!ordinaryTabDebuggerNotAttached) {
      throw new Error('普通页签不应处于 CDP attached 状态')
    }

    const normalWc = webContents.getAllWebContents().find((wc) => wc.getURL().includes('/normal'))
    if (!normalWc) throw new Error('未找到普通页签 webContents')
    const wcDebuggerAttached = normalWc.debugger.isAttached()
    if (wcDebuggerAttached) throw new Error('普通页签 webContents.debugger.isAttached() 应为 false')

    const webdriverValue = await normalWc.executeJavaScript('navigator.webdriver')
    const ordinaryTabWebDriverFalse = webdriverValue === false
    if (!ordinaryTabWebDriverFalse) {
      throw new Error(`普通页签 navigator.webdriver 应为 false，实际为: ${String(webdriverValue)}`)
    }

    logE2EStage('触发 OAuth 原生子窗口并验证 session 共享与 debugger 隔离')
    let popupTimer: NodeJS.Timeout | undefined
    let onWindow: ((childWin: BrowserWindow) => void) | undefined
    const cleanupPopupWait = () => {
      if (popupTimer) {
        clearTimeout(popupTimer)
        popupTimer = undefined
      }
      if (onWindow) {
        normalWc.removeListener('did-create-window', onWindow)
        onWindow = undefined
      }
    }

    try {
      const popupPromise = new Promise<BrowserWindow>((resolve, reject) => {
        onWindow = (childWin: BrowserWindow) => {
          cleanupPopupWait()
          resolve(childWin)
        }
        normalWc.once('did-create-window', onWindow)
        popupTimer = setTimeout(() => {
          cleanupPopupWait()
          reject(new Error('等待 OAuth did-create-window 事件超时'))
        }, 10_000)
      })

      // 使用 void 确保 window.open 的返回值不被 structuredClone 序列化导致异常
      await normalWc.executeJavaScript(`void window.open("${fixtureServer.origin}/oauth-child", "oauth_popup", "width=600,height=500")`)
      popupWindow = await popupPromise
    } catch (error) {
      cleanupPopupWait()
      throw error
    }

    if (!popupWindow || popupWindow.isDestroyed()) throw new Error('未能获取 OAuth 子窗口实例')
    const popupWc = popupWindow.webContents
    await waitForCondition(() => !popupWc.isDestroyed() && !popupWc.isLoading() && popupWc.getURL().includes('/oauth-child'), 'OAuth 子窗口页面加载完成', 10_000)

    const oauthChildDebuggerNotAttached = !popupWc.debugger.isAttached()
    if (!oauthChildDebuggerNotAttached) throw new Error('OAuth 子窗口 webContents.debugger.isAttached() 应为 false')

    const oauthParentDebuggerNotAttached = !isWebTabCdpAttached(normalTabId) && !normalWc.debugger.isAttached()
    if (!oauthParentDebuggerNotAttached) throw new Error('父页签在子窗口打开后不应附加 debugger')

    const childCookie = await popupWc.executeJavaScript('document.cookie')
    const oauthChildSharesSession = typeof childCookie === 'string' && childCookie.includes('session_probe_token_12345')
    if (!oauthChildSharesSession) throw new Error(`OAuth 子窗口未共享父页签 session Cookie: ${childCookie}`)

    popupWindow.close()
    await waitForCondition(() => popupWindow?.isDestroyed() === true, 'OAuth 子窗口关闭销毁', 5_000)
    const oauthChildClosed = popupWindow.isDestroyed()

    logE2EStage('验证 Agent 绑定与 open 的按需 CDP 附加与释放')
    const secondSnapshot = createWebTab({ url: `${fixtureServer.origin}/normal`, activate: false })
    secondTabId = secondSnapshot.tabs.find((t) => t.id !== normalTabId)?.id
    if (!secondTabId) throw new Error('未能创建第二个普通页签')
    await waitForWebTabLoad(secondTabId, 10_000)

    if (isWebTabCdpAttached(normalTabId) || isWebTabCdpAttached(secondTabId)) {
      throw new Error('未绑定 Agent 的普通页签应保持 detached')
    }

    const workspace = ensureDefaultWorkspace()
    const agentSession = createAgentSession('Normal Probe Agent', undefined, workspace.id)
    agentSessionId = agentSession.id

    bindBrowserAgentContext(agentSessionId, { tabId: normalTabId })
    const agentTabLeaseAttached = isWebTabCdpAttached(normalTabId)
    const ordinaryTabsRemainDetached = !isWebTabCdpAttached(secondTabId)
    if (!agentTabLeaseAttached || !ordinaryTabsRemainDetached) {
      throw new Error('Agent 绑定后只有目标页签应附加 debugger，其他普通页签保持 detached')
    }

    unbindBrowserAgentContext(agentSessionId)
    const agentTabLeaseReleased = !isWebTabCdpAttached(normalTabId) && !isWebTabCdpAttached(secondTabId)
    if (!agentTabLeaseReleased) {
      throw new Error('Agent 解绑后所有页签均应 detach')
    }

    const agentOpenTabResult = openBrowserAgentTab(agentSessionId, `${fixtureServer.origin}/agent-tab`)
    agentTabId = agentOpenTabResult.tabId
    await waitForWebTabLoad(agentTabId, 10_000)
    const agentOpenTabAttached = isWebTabCdpAttached(agentTabId)
      && !isWebTabCdpAttached(normalTabId)
      && !isWebTabCdpAttached(secondTabId)
    if (!agentOpenTabAttached) {
      throw new Error('Agent open 的页签应附加 debugger，且其他普通页签保持 detached')
    }

    unbindBrowserAgentContext(agentSessionId)
    const agentOpenTabReleased = !isWebTabCdpAttached(agentTabId)
    if (!agentOpenTabReleased) {
      throw new Error('Agent 解绑后 open 的页签应 detach')
    }

    return {
      noRemoteDebuggingPortArg,
      noRemoteDebuggingAddressArg,
      noRemoteDebuggingPortSwitch,
      noRemoteDebuggingAddressSwitch,
      ordinaryTabWebDriverFalse,
      ordinaryTabDebuggerNotAttached,
      oauthChildDebuggerNotAttached,
      oauthParentDebuggerNotAttached,
      oauthChildSharesSession,
      oauthChildClosed,
      agentTabLeaseAttached,
      ordinaryTabsRemainDetached,
      agentTabLeaseReleased,
      agentOpenTabAttached,
      agentOpenTabReleased,
    }
  } catch (error) {
    console.error('[Browser Workflow E2E] 正常模式探针发生异常:', error)
    throw error
  } finally {
    logE2EStage('清理正常模式探针资源')
    if (agentSessionId) {
      try { unbindBrowserAgentContext(agentSessionId) } catch {}
    }
    if (popupWindow && !popupWindow.isDestroyed()) {
      try { popupWindow.destroy() } catch {}
    }
    disposeWebTabs()
    if (hostWindow && !hostWindow.isDestroyed()) {
      try { hostWindow.destroy() } catch {}
    }
    await fixtureServer.close()
  }
}

async function verifyNodeCdpProtocol(): Promise<void> {
  const nodeExecutable = process.env.COPIS_E2E_NODE_EXECUTABLE
  if (!nodeExecutable) throw new Error('E2E 缺少 Node.js 运行时路径')
  const endpoint = await getPlaywrightCdpEndpoint()
  const probeSource = [
    'const endpoint = process.env.COPIS_E2E_CDP_ENDPOINT;',
    'const finish = (code) => process.exit(code);',
    'const timer = setTimeout(() => finish(1), 3000);',
    'fetch(endpoint + "/json/version").then((response) => response.json()).then((details) => {',
    '  const socket = new WebSocket(details.webSocketDebuggerUrl);',
    '  socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })));',
    '  socket.addEventListener("message", () => { clearTimeout(timer); socket.close(); finish(0); });',
    '  socket.addEventListener("error", () => finish(1));',
    '}).catch(() => finish(1));',
  ].join('\n')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExecutable, ['-e', probeSource], {
      env: { ...process.env, COPIS_E2E_CDP_ENDPOINT: endpoint },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', () => reject(new Error('E2E Node CDP 探针无法启动')))
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error('E2E Node CDP Browser.getVersion 未返回')))
  })
}

async function prepareNodeRuntimeForE2E(): Promise<void> {
  const source = process.env.COPIS_E2E_NODE_EXECUTABLE
  if (!source) throw new Error('E2E 缺少 Node.js 运行时路径')
  const sourceStats = statSync(source)
  const packageInfo: FunctionalModulePackage = {
    name: 'node-runtime',
    version: 'e2e',
    sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    size: sourceStats.size,
    format: 'binary',
    entrypoint: process.platform === 'win32' ? 'bin/node.exe' : 'bin/node',
    required: true,
  }
  const paths = getFunctionalModulePaths(getFunctionalModulesDir())
  await cacheFunctionalModule(paths, packageInfo, source)
  const versionDir = await assembleFunctionalModule(paths, packageInfo)
  await activateFunctionalModule(paths, packageInfo, versionDir)
  const entrypoint = join(versionDir, packageInfo.entrypoint)
  unlinkSync(entrypoint)
  if (process.platform === 'win32') {
    copyFileSync(source, entrypoint)
  } else {
    symlinkSync(source, entrypoint)
  }
}

async function createFixtureServers(): Promise<FixtureServers> {
  const reactSource = readFileSync(join(process.env.COPIS_REPO_ROOT ?? process.cwd(), 'node_modules/react/umd/react.development.js'))
  const reactDomSource = readFileSync(join(process.env.COPIS_REPO_ROOT ?? process.cwd(), 'node_modules/react-dom/umd/react-dom.development.js'))

  let frameOrigin = ''
  let mainOrigin = ''

  const frameServer = await createTrackedServer((request, response) => {
    const path = new URL(request.url ?? '/', frameOrigin || 'http://127.0.0.1').pathname
    if (path === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('<button id="frame-action" type="button">Frame action</button><p id="frame-result" style="display:none">Frame action complete</p><script>document.querySelector("#frame-action").addEventListener("click", () => { document.querySelector("#frame-result").style.display = "block" })</script>'))
      return
    }
    if (path === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('<input id="popup-value" type="text"><button id="popup-submit" type="button" onclick="window.location.href = `/popup-done`">Submit popup</button>'))
      return
    }
    if (path === '/popup-done') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('<h1>Popup complete</h1>'))
      return
    }
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html('<h1>Not found</h1>'))
  })
  frameOrigin = frameServer.origin

  const mainServer = await createTrackedServer((request, response) => {
    const path = new URL(request.url ?? '/', mainOrigin || 'http://127.0.0.1').pathname
    if (path === '/react.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      response.end(reactSource)
      return
    }
    if (path === '/react-dom.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      response.end(reactDomSource)
      return
    }
    let content: string
    if (path === '/start') {
      content = `
        <script src="/react.js"></script>
        <script src="/react-dom.js"></script>
        <div id="root"></div>
        <script>
          const h = React.createElement
          function Fixture() {
            const [email, setEmail] = React.useState('')
            const [tabPressed, setTabPressed] = React.useState(false)
            return h(React.Fragment, null,
              h('h1', null, 'Workflow start'),
              h('label', null, 'Email ', h('input', {
                id: 'email',
                type: 'text',
                value: email,
                onChange: (event) => setEmail(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Tab') setTabPressed(true) },
              })),
              h('p', { id: 'email-state' }, 'Email: ' + email),
              h('p', { id: 'tab-state' }, tabPressed ? 'Tab: pressed' : 'Tab: pending'),
              h('iframe', { name: 'cross-origin-frame', title: 'Cross origin frame', src: '${frameOrigin}/frame' }),
              h('button', { id: 'open-popup', type: 'button', onClick: () => window.open('${frameOrigin}/popup', 'copis-workflow-popup', 'width=640,height=480') }, 'Open popup'),
              h('button', { id: 'go-next', type: 'button', onClick: () => { window.location.href = '${mainServer.origin}/next' } }, 'Go next'),
            )
          }
          ReactDOM.createRoot(document.querySelector('#root')).render(h(Fixture))
        </script>`
    } else if (path === '/next') {
      content = '<h1>Workflow next page</h1><p id="next-state">Workflow next page complete</p>'
    } else if (path === '/ambiguous') {
      content = '<h1>Ambiguous target</h1><button>Duplicate</button><button>Duplicate</button>'
    } else if (path === '/delay') {
      content = '<h1>Detach fixture</h1><p id="delay-state">pending</p><script>setTimeout(() => { document.querySelector("#delay-state").textContent = "ready-after-delay" }, 2000)</script>'
    } else {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('<h1>Not found</h1>'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html(content))
  })
  mainOrigin = mainServer.origin

  return {
    mainOrigin,
    frameOrigin,
    close: async () => {
      await Promise.all([mainServer.close(), frameServer.close()])
    },
  }
}

function locator(
  strategy: BrowserLocatorBundle['strategies'][number],
  fingerprint: BrowserLocatorBundle['fingerprint'],
  framePath: BrowserLocatorBundle['framePath'] = { frameIds: [] },
): BrowserLocatorBundle {
  return { framePath, strategies: [strategy], fingerprint }
}

const buttonFingerprint = (name: string) => ({
  tagName: 'button',
  accessibleName: name,
  visible: true,
  enabled: true,
})

const inputFingerprint = (id: string) => ({
  tagName: 'input',
  inputType: 'text',
  accessibleName: id === 'email' ? 'Email' : undefined,
  visible: true,
  enabled: true,
})

async function runPageControlE2E(
  sessionId: string,
  tabId: string,
  fixtures: FixtureServers,
): Promise<InstrumentedE2EResult['pageControl']> {
  const service = createBrowserPageControlService({
    getContext: getBrowserAgentContext,
    getControlMode: getBrowserPageControlMode,
    isAdvancedAuthorizationEnabled: isBrowserPageAdvancedAuthorizationEnabled,
    resolveUploadPaths: resolveBrowserPageUploadPaths,
    getTab: getWebTabState,
    sendCommand: sendBrowserPageControlCdpCommand,
    navigate(id, url) {
      navigateWebTab({ tabId: id, url })
    },
  })

  logE2EStage('等待用户页签加载')
  await waitForWebTabLoad(tabId, 10_000)
  logE2EStage('读取用户页面元素')
  const first = await service.observe(sessionId)
  logE2EStage('用户页面元素读取完成')
  const email = first.elements.find((element) => element.name === 'Email')
  const goNext = first.elements.find((element) => element.name === 'Go next')
  if (!email || !goNext) throw new Error('页面控制 E2E 未找到预期元素')

  let askRejected = false
  try {
    await service.click(sessionId, goNext.ref)
  } catch (error) {
    askRejected = error instanceof Error && error.message.includes('授权')
  }
  if (!askRejected) throw new Error('页面控制 E2E 在 ask 模式下未拒绝写操作')

  setBrowserPageControlMode(sessionId, 'authorized')
  logE2EStage('输入页面字段')
  await service.typeText(sessionId, email.ref, 'browser-agent@example.test')
  const typedSnapshot = await service.observe(sessionId)
  const typed = typedSnapshot.text.includes('Email: browser-agent@example.test')
  if (!typed) throw new Error('页面控制 E2E 未能更新 React 受控输入框')

  await service.navigate(sessionId, `${fixtures.frameOrigin}/popup`)
  logE2EStage('等待跨域导航完成')
  await waitForWebTabLoad(tabId, 10_000)
  const crossOriginRevoked = getBrowserPageControlMode(sessionId) === 'ask'
  if (!crossOriginRevoked) throw new Error('页面控制 E2E 在跨域导航后未收回操作授权')

  return { observed: first.text.includes('Workflow start'), askRejected, typed, crossOriginRevoked }
}

function buildWorkflow(
  workflowId: string,
  mainOrigin: string,
  frameOrigin: string,
): BrowserWorkflowVersion {
  const framePath = { frameIds: [], frameUrls: [`${frameOrigin}/frame`] }
  const email = locator({ kind: 'id', value: 'email' }, inputFingerprint('email'))
  const frameAction = locator({ kind: 'id', value: 'frame-action' }, buttonFingerprint('Frame action'), framePath)
  const frameResult = locator({ kind: 'id', value: 'frame-result' }, { tagName: 'p', visible: true, enabled: true }, framePath)
  const openPopup = locator({ kind: 'id', value: 'open-popup' }, buttonFingerprint('Open popup'))
  const popupValue = locator({ kind: 'id', value: 'popup-value' }, inputFingerprint('popup-value'))
  const popupSubmit = locator({ kind: 'id', value: 'popup-submit' }, buttonFingerprint('Submit popup'))
  const goNext = locator({ kind: 'id', value: 'go-next' }, buttonFingerprint('Go next'))

  return {
    schemaVersion: 1,
    workflowId,
    version: 1,
    sourceRecordingId: `e2e-${workflowId}`,
    start: { tabAlias: 'main', url: `${mainOrigin}/start`, origin: mainOrigin },
    variables: [],
    steps: [
      { id: 'fill-email', type: 'fill', tabAlias: 'main', origin: mainOrigin, target: email, value: { kind: 'literal', value: 'e2e@example.test' } },
      { id: 'wait-email', type: 'wait', tabAlias: 'main', origin: mainOrigin, condition: { type: 'text', value: 'Email: e2e@example.test' } },
      { id: 'press-tab', type: 'press', tabAlias: 'main', origin: mainOrigin, target: email, key: 'Tab' },
      { id: 'wait-tab', type: 'wait', tabAlias: 'main', origin: mainOrigin, condition: { type: 'text', value: 'Tab: pressed' } },
      { id: 'click-frame', type: 'click', tabAlias: 'main', origin: mainOrigin, target: frameAction, expect: { type: 'visible', target: frameResult } },
      { id: 'open-popup', type: 'click', tabAlias: 'main', origin: mainOrigin, target: openPopup, expect: { type: 'newTab', tabAlias: 'popup' } },
      { id: 'fill-popup', type: 'fill', tabAlias: 'popup', origin: frameOrigin, target: popupValue, value: { kind: 'literal', value: 'popup-value' } },
      { id: 'submit-popup', type: 'click', tabAlias: 'popup', origin: frameOrigin, target: popupSubmit, expect: { type: 'navigation', urlPattern: '/popup-done$' } },
      { id: 'close-popup', type: 'closeTab', tabAlias: 'main', origin: mainOrigin, targetTabAlias: 'popup' },
      { id: 'go-next', type: 'click', tabAlias: 'main', origin: mainOrigin, target: goNext, expect: { type: 'navigation', urlPattern: '/next$' } },
      { id: 'assert-next', type: 'assert', tabAlias: 'main', origin: mainOrigin, condition: { type: 'text', value: 'Workflow next page complete', exact: false } },
    ],
    createdAt: Date.now(),
    createdBySessionId: 'browser-workflow-e2e',
    approval: { status: 'approved' },
  }
}

async function saveWorkflow(
  workspaceId: string,
  version: BrowserWorkflowVersion,
  allowedOrigins: string[],
): Promise<void> {
  saveBrowserWorkflow({
    workspaceId,
    sessionId: 'browser-workflow-e2e',
    name: version.workflowId,
    allowedOrigins,
    profileId: `e2e-${version.workflowId}`,
    unattendedAllowed: true,
    version,
  })
}

async function runMainWorkflow(workspaceId: string, fixtures: FixtureServers): Promise<InstrumentedE2EResult['workflow']> {
  const session = createAgentSession('Main Workflow Agent', undefined, workspaceId)
  const sessionId = session.id
  const version = buildWorkflow('workflow-e2e-main', fixtures.mainOrigin, fixtures.frameOrigin)
  await saveWorkflow(workspaceId, version, [fixtures.mainOrigin, fixtures.frameOrigin])

  let mainWorkflowTabId: string | undefined
  let workflowTabCreated = false
  let workflowTabAttachedDuringRun = false

  const removeLifecycle = subscribeWebTabLifecycle((event) => {
    if (event.type === 'created' && event.workflowOwned && !mainWorkflowTabId) {
      mainWorkflowTabId = event.tabId
      workflowTabCreated = true
    }
  })

  const runPromise = runBrowserWorkflow({
    workspaceId,
    sessionId,
    workflowId: version.workflowId,
    source: 'delegation',
  })

  try {
    await waitForCondition(() => mainWorkflowTabId !== undefined && isWebTabCdpAttached(mainWorkflowTabId), '等待主流程页签挂载 CDP', 5_000)
    workflowTabAttachedDuringRun = isWebTabCdpAttached(mainWorkflowTabId!)
    const summary = await runPromise
    const tabStateAfter = mainWorkflowTabId ? getWebTabState(mainWorkflowTabId) : undefined
    const workflowTabClosedOrDetached = !tabStateAfter || !isWebTabCdpAttached(mainWorkflowTabId!)

    return {
      summary,
      workflowTabCreated,
      workflowTabAttachedDuringRun,
      workflowTabClosedOrDetached,
    }
  } finally {
    removeLifecycle()
    try { unbindBrowserAgentContext(sessionId) } catch {}
  }
}

async function runAmbiguousWorkflow(workspaceId: string, mainOrigin: string): Promise<string> {
  const session = createAgentSession('Ambiguous Workflow Agent', undefined, workspaceId)
  const sessionId = session.id
  const target = locator(
    { kind: 'text', value: 'Duplicate', exact: true },
    { tagName: 'button', accessibleName: 'Duplicate', visible: true, enabled: true },
  )
  const version: BrowserWorkflowVersion = {
    schemaVersion: 1,
    workflowId: 'workflow-e2e-ambiguous',
    version: 1,
    start: { tabAlias: 'main', url: `${mainOrigin}/ambiguous`, origin: mainOrigin },
    variables: [],
    steps: [{ id: 'ambiguous-click', type: 'click', tabAlias: 'main', origin: mainOrigin, target }],
    createdAt: Date.now(),
    createdBySessionId: sessionId,
    approval: { status: 'approved' },
  }
  await saveWorkflow(workspaceId, version, [mainOrigin])
  try {
    await runBrowserWorkflow({
      workspaceId,
      sessionId,
      workflowId: version.workflowId,
      source: 'delegation',
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    try { unbindBrowserAgentContext(sessionId) } catch {}
  }
  throw new Error('ambiguous locator unexpectedly completed')
}

async function runDetachWorkflow(workspaceId: string, mainOrigin: string): Promise<{ summary: BrowserWorkflowRunSummary; paused: boolean }> {
  const session = createAgentSession('Detach Workflow Agent', undefined, workspaceId)
  const sessionId = session.id
  const version: BrowserWorkflowVersion = {
    schemaVersion: 1,
    workflowId: 'workflow-e2e-detach',
    version: 1,
    start: { tabAlias: 'main', url: `${mainOrigin}/delay`, origin: mainOrigin },
    variables: [],
    steps: [{ id: 'wait-after-detach', type: 'wait', tabAlias: 'main', origin: mainOrigin, condition: { type: 'text', value: 'ready-after-delay' }, timeoutMs: 10_000 }],
    createdAt: Date.now(),
    createdBySessionId: sessionId,
    approval: { status: 'approved' },
  }
  await saveWorkflow(workspaceId, version, [mainOrigin])

  let workflowTabId: string | undefined
  let paused = false
  const removeLifecycle = subscribeWebTabLifecycle((event) => {
    if (event.type === 'created' && event.workflowOwned && !workflowTabId) workflowTabId = event.tabId
  })
  const removeStatus = subscribeBrowserWorkflowStatus((_sessionId, status) => {
    if (status.sessionId === sessionId && status.state === 'paused_cdp_detached') paused = true
  })
  const runPromise = runBrowserWorkflow({
    workspaceId,
    sessionId,
    workflowId: version.workflowId,
    source: 'delegation',
  })
  try {
    await waitForCondition(() => workflowTabId !== undefined && isWebTabCdpAttached(workflowTabId), '等待 Workflow 页签挂载 CDP', 5_000)
    detachWebTabCdpForTest(workflowTabId!)
    await waitForCondition(() => paused, '等待发布 paused_cdp_detached 状态', 5_000)
    continueBrowserWorkflowRun(sessionId)
    return { summary: await runPromise, paused }
  } finally {
    removeLifecycle()
    removeStatus()
    try { unbindBrowserAgentContext(sessionId) } catch {}
  }
}

async function runFailureHandoffWorkflow(workspaceId: string, mainOrigin: string): Promise<InstrumentedE2EResult['failureHandoff']> {
  const session = createAgentSession('Failure Handoff Agent', undefined, workspaceId)
  const sessionId = session.id
  const version: BrowserWorkflowVersion = {
    schemaVersion: 1,
    workflowId: 'workflow-e2e-failure-handoff',
    version: 1,
    start: { tabAlias: 'main', url: `${mainOrigin}/start`, origin: mainOrigin },
    variables: [],
    steps: [
      {
        id: 'failing-assert',
        type: 'assert',
        tabAlias: 'main',
        origin: mainOrigin,
        condition: { type: 'text', value: 'This text does not exist and will definitely fail', exact: true },
        timeoutMs: 2_000,
      },
    ],
    createdAt: Date.now(),
    createdBySessionId: sessionId,
    approval: { status: 'approved' },
  }
  await saveWorkflow(workspaceId, version, [mainOrigin])

  let workflowTabId: string | undefined
  const removeLifecycle = subscribeWebTabLifecycle((event) => {
    if (event.type === 'created' && event.workflowOwned && !workflowTabId) {
      workflowTabId = event.tabId
    }
  })

  let errorCaught = false
  try {
    await runBrowserWorkflow({
      workspaceId,
      sessionId,
      workflowId: version.workflowId,
      source: 'delegation',
    })
  } catch {
    errorCaught = true
  } finally {
    removeLifecycle()
  }

  if (!errorCaught) throw new Error('预期的失败 Workflow 未能捕获到错误')
  if (!workflowTabId) throw new Error('未能捕获到失败 Workflow 的页签 ID')

  try {
    const promotedTabAttached = isWebTabCdpAttached(workflowTabId)
    if (!promotedTabAttached) throw new Error('失败交接后页签应持有 Agent CDP lease')

    unbindBrowserAgentContext(sessionId)
    const promotedTabReleased = !isWebTabCdpAttached(workflowTabId)
    if (!promotedTabReleased) throw new Error('Agent 解绑后失败交接页签应释放 CDP lease')

    closeWebTab(workflowTabId)
    return { errorCaught, promotedTabAttached, promotedTabReleased }
  } finally {
    try { unbindBrowserAgentContext(sessionId) } catch {}
    try { if (workflowTabId) closeWebTab(workflowTabId) } catch {}
  }
}

async function runInstrumentedE2E(): Promise<InstrumentedE2EResult> {
  const fixtures = await createFixtureServers()
  let window: BrowserWindow | undefined
  let pageControlSessionId: string | undefined
  try {
    await app.whenReady()
    logE2EStage('Electron 已就绪')
    window = new BrowserWindow({ show: true, width: 1280, height: 900 })
    window.focus()
    setWebTabHostWindow(window)
    await prepareNodeRuntimeForE2E()
    logE2EStage('Node 运行时已准备')

    const workspace = ensureDefaultWorkspace()
    logE2EStage('验证 Node CDP 协议')
    await verifyNodeCdpProtocol()

    logE2EStage('开始页面控制验证')
    const userTabSnapshot = createWebTab({ url: `${fixtures.mainOrigin}/start`, activate: true })
    const userTab = userTabSnapshot.tabs.at(-1)
    if (!userTab) throw new Error('E2E 用户页签创建失败')
    updateWebTabBounds({ tabId: userTab.id, bounds: { x: 0, y: 0, width: 1200, height: 820 } })

    const pageControlSession = createAgentSession('Page Control Session', undefined, workspace.id)
    pageControlSessionId = pageControlSession.id
    updateAgentSessionMeta(pageControlSessionId, { advancedAuthorization: false })
    bindBrowserAgentContext(pageControlSessionId, { tabId: userTab.id })
    if (!isWebTabCdpAttached(userTab.id)) {
      throw new Error('绑定 Agent 会话后用户页签应附加 debugger')
    }

    const pageControl = await runPageControlE2E(pageControlSessionId, userTab.id, fixtures)
    unbindBrowserAgentContext(pageControlSessionId)
    pageControlSessionId = undefined
    if (isWebTabCdpAttached(userTab.id)) {
      throw new Error('解绑 Agent 会话后用户页签应 detach debugger')
    }

    logE2EStage('开始主流程验证')
    const workflow = await runMainWorkflow(workspace.id, fixtures)

    logE2EStage('开始歧义元素验证')
    const ambiguousError = await runAmbiguousWorkflow(workspace.id, fixtures.mainOrigin)

    logE2EStage('开始 CDP 断开恢复验证')
    const detachWorkflow = await runDetachWorkflow(workspace.id, fixtures.mainOrigin)

    logE2EStage('开始失败交接验证')
    const failureHandoff = await runFailureHandoffWorkflow(workspace.id, fixtures.mainOrigin)

    return {
      nodeCdpVerified: true,
      pageControl,
      workflow,
      ambiguousError,
      detachWorkflow: detachWorkflow.summary,
      detachPaused: detachWorkflow.paused,
      failureHandoff,
    }
  } finally {
    logE2EStage('开始清理测试资源')
    if (pageControlSessionId) {
      try { unbindBrowserAgentContext(pageControlSessionId) } catch {}
    }
    disposeWebTabs()
    if (window && !window.isDestroyed()) window.destroy()
    await fixtures.close()
  }
}

async function main(): Promise<unknown> {
  if (isNormalProbe) {
    return runNormalProbe()
  }
  return runInstrumentedE2E()
}

void main().then((result) => {
  if (isNormalProbe) {
    console.log(`NORMAL_PROBE_RESULT ${JSON.stringify({ ok: true, ...(result as object) })}`)
  } else {
    console.log(`INSTRUMENTED_E2E_RESULT ${JSON.stringify({ ok: true, ...(result as object) })}`)
  }
  app.exit(0)
}, (error: unknown) => {
  console.error('BROWSER_WORKFLOW_E2E_ERROR', error)
  app.exit(1)
})
