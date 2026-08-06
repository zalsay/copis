import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type {
  BrowserLocatorBundle,
  BrowserWorkflowVersion,
  BrowserWorkflowRunSummary,
} from '@copis/shared'
import {
  createWebTab,
  disposeWebTabs,
  detachWebTabCdpForTest,
  getWebTabState,
  navigateWebTab,
  sendWebTabCdpCommandInternal,
  setWebTabHostWindow,
  subscribeWebTabLifecycle,
  updateWebTabBounds,
  waitForWebTabLoad,
} from '../src/main/lib/web-tab-manager'
import { createBrowserPageControlService } from '../src/main/lib/browser-page-control-service'
import { resolveBrowserPageControlState } from '../src/main/lib/browser-page-control-policy'
import {
  continueBrowserWorkflowRun,
  runBrowserWorkflow,
} from '../src/main/lib/browser-workflow-runner'
import { subscribeBrowserWorkflowStatus } from '../src/main/lib/browser-workflow-service'
import { saveBrowserWorkflow } from '../src/main/lib/browser-workflow-store'
import { ensureDefaultWorkspace } from '../src/main/lib/agent-workspace-manager'

interface FixtureServers {
  readonly mainOrigin: string
  readonly frameOrigin: string
  readonly mainServer: Server
  readonly frameServer: Server
}

interface E2EResult {
  readonly pageControl: {
    readonly observed: boolean
    readonly askRejected: boolean
    readonly typed: boolean
    readonly crossOriginRevoked: boolean
  }
  readonly workflow: BrowserWorkflowRunSummary
  readonly ambiguousError: string
  readonly detachWorkflow: BrowserWorkflowRunSummary
  readonly detachPaused: boolean
}

async function runPageControlE2E(
  tabId: string,
  fixtures: FixtureServers,
): Promise<E2EResult['pageControl']> {
  let authorizedOrigin: string | undefined
  const service = createBrowserPageControlService({
    getContext: () => ({ tabId }),
    getControlMode: () => resolveBrowserPageControlState(getWebTabState(tabId)?.url ?? '', authorizedOrigin).mode,
    getTab: getWebTabState,
    sendCommand: sendWebTabCdpCommandInternal,
    navigate(id, url) {
      navigateWebTab({ tabId: id, url })
    },
  })

  await waitForWebTabLoad(tabId, 10_000)
  const first = await service.observe('browser-page-control-e2e')
  const email = first.elements.find((element) => element.name === 'Email')
  const goNext = first.elements.find((element) => element.name === 'Go next')
  if (!email || !goNext) throw new Error('page control E2E did not observe expected elements')

  let askRejected = false
  try {
    await service.click('browser-page-control-e2e', goNext.ref)
  } catch (error) {
    askRejected = error instanceof Error && error.message.includes('授权')
  }
  if (!askRejected) throw new Error('page control E2E did not reject mutation in ask mode')

  authorizedOrigin = fixtures.mainOrigin
  await service.typeText('browser-page-control-e2e', email.ref, 'browser-agent@example.test')
  const typedSnapshot = await service.observe('browser-page-control-e2e')
  const typed = typedSnapshot.text.includes('Email: browser-agent@example.test')
  if (!typed) throw new Error('page control E2E did not update React controlled input')

  await service.navigate('browser-page-control-e2e', `${fixtures.frameOrigin}/popup`)
  await waitForWebTabLoad(tabId, 10_000)
  const crossOriginRevoked = resolveBrowserPageControlState(
    getWebTabState(tabId)?.url ?? '',
    authorizedOrigin,
  ).mode === 'ask'
  if (!crossOriginRevoked) throw new Error('page control E2E did not revoke authorization after cross-Origin navigation')

  return { observed: first.text.includes('Workflow start'), askRejected, typed, crossOriginRevoked }
}

const userDataDir = process.env.COPIS_E2E_USER_DATA
if (userDataDir) app.setPath('userData', userDataDir)

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port')
  return address.port
}

function html(body: string): Buffer {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Copis Browser Workflow Fixture</title></head><body>${body}</body></html>`)
}

function createFixtureServers(): Promise<FixtureServers> {
  const mainServer = createServer()
  const frameServer = createServer()
  return Promise.all([listen(mainServer), listen(frameServer)]).then(([mainPort, framePort]) => {
    const mainOrigin = `http://127.0.0.1:${mainPort}`
    const frameOrigin = `http://127.0.0.1:${framePort}`
    const reactSource = readFileSync(join(process.env.COPIS_REPO_ROOT ?? process.cwd(), 'node_modules/react/umd/react.development.js'))
    const reactDomSource = readFileSync(join(process.env.COPIS_REPO_ROOT ?? process.cwd(), 'node_modules/react-dom/umd/react-dom.development.js'))

    mainServer.on('request', (_request, response) => {
      const path = new URL(_request.url ?? '/', mainOrigin).pathname
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
                h('button', { id: 'go-next', type: 'button', onClick: () => { window.location.href = '${mainOrigin}/next' } }, 'Go next'),
              )
            }
            ReactDOM.createRoot(document.querySelector('#root')).render(h(Fixture))
          </script>`
      } else if (path === '/next') {
        content = '<h1>Workflow next page</h1><p id="next-state">Workflow next page complete</p>'
      } else if (path === '/ambiguous') {
        content = '<h1>Ambiguous target</h1><button>Duplicate</button><button>Duplicate</button>'
      } else if (path === '/delay') {
        content = '<h1>Detach fixture</h1><p id="delay-state">pending</p><script>setTimeout(() => { document.querySelector(\'#delay-state\').textContent = \"ready-after-delay\" }, 3000)</script>'
      } else {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        response.end(html('<h1>Not found</h1>'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html(content))
    })

    frameServer.on('request', (_request, response) => {
      const path = new URL(_request.url ?? '/', frameOrigin).pathname
      if (path === '/frame') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(html('<button id="frame-action" type="button">Frame action</button><p id="frame-result" style="display:none">Frame action complete</p><script>document.querySelector(\'#frame-action\').addEventListener(\'click\', () => { document.querySelector(\'#frame-result\').style.display = \'block\' })</script>'))
        return
      }
      if (path === '/popup') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(html('<h1>Popup</h1><input id="popup-value" type="text"><button id="popup-submit" type="button">Submit popup</button><script>document.querySelector(\'#popup-submit\').addEventListener(\'click\', () => { window.location.href = \'/popup-done\' })</script>'))
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

    return { mainOrigin, frameOrigin, mainServer, frameServer }
  })
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

async function runMainWorkflow(workspaceId: string, fixtures: FixtureServers): Promise<BrowserWorkflowRunSummary> {
  const version = buildWorkflow('workflow-e2e-main', fixtures.mainOrigin, fixtures.frameOrigin)
  await saveWorkflow(workspaceId, version, [fixtures.mainOrigin, fixtures.frameOrigin])
  return runBrowserWorkflow({
    workspaceId,
    sessionId: 'browser-workflow-e2e-main',
    workflowId: version.workflowId,
    source: 'delegation',
  })
}

async function runAmbiguousWorkflow(workspaceId: string, mainOrigin: string): Promise<string> {
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
    createdBySessionId: 'browser-workflow-e2e',
    approval: { status: 'approved' },
  }
  await saveWorkflow(workspaceId, version, [mainOrigin])
  try {
    await runBrowserWorkflow({
      workspaceId,
      sessionId: 'browser-workflow-e2e-ambiguous',
      workflowId: version.workflowId,
      source: 'delegation',
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('ambiguous locator unexpectedly completed')
}

async function runDetachWorkflow(workspaceId: string, mainOrigin: string): Promise<{ summary: BrowserWorkflowRunSummary; paused: boolean }> {
  const version: BrowserWorkflowVersion = {
    schemaVersion: 1,
    workflowId: 'workflow-e2e-detach',
    version: 1,
    start: { tabAlias: 'main', url: `${mainOrigin}/delay`, origin: mainOrigin },
    variables: [],
    steps: [{ id: 'wait-after-detach', type: 'wait', tabAlias: 'main', origin: mainOrigin, condition: { type: 'text', value: 'ready-after-delay' }, timeoutMs: 10_000 }],
    createdAt: Date.now(),
    createdBySessionId: 'browser-workflow-e2e',
    approval: { status: 'approved' },
  }
  await saveWorkflow(workspaceId, version, [mainOrigin])

  let workflowTabId: string | undefined
  let paused = false
  const removeLifecycle = subscribeWebTabLifecycle((event) => {
    if (event.type === 'created' && event.workflowOwned && !workflowTabId) workflowTabId = event.tabId
  })
  const removeStatus = subscribeBrowserWorkflowStatus((_sessionId, status) => {
    if (status.sessionId === 'browser-workflow-e2e-detach' && status.state === 'paused_cdp_detached') paused = true
  })
  const runPromise = runBrowserWorkflow({
    workspaceId,
    sessionId: 'browser-workflow-e2e-detach',
    workflowId: version.workflowId,
    source: 'delegation',
  })
  try {
    await sleep(500)
    if (!workflowTabId) throw new Error('detach E2E did not observe a Workflow tab')
    detachWebTabCdpForTest(workflowTabId)
    await sleep(500)
    if (!paused) throw new Error('detach E2E did not publish paused_cdp_detached')
    continueBrowserWorkflowRun('browser-workflow-e2e-detach')
    return { summary: await runPromise, paused }
  } finally {
    removeLifecycle()
    removeStatus()
  }
}

async function main(): Promise<E2EResult> {
  const fixtures = await createFixtureServers()
  let window: BrowserWindow | undefined
  try {
    await app.whenReady()
    window = new BrowserWindow({ show: true, width: 1280, height: 900 })
    window.focus()
    setWebTabHostWindow(window)
    const userTabSnapshot = createWebTab({ url: `${fixtures.mainOrigin}/start`, activate: true })
    const userTab = userTabSnapshot.tabs.at(-1)
    if (!userTab) throw new Error('E2E user tab was not created')
    updateWebTabBounds({ tabId: userTab.id, bounds: { x: 0, y: 0, width: 1200, height: 820 } })

    const workspace = ensureDefaultWorkspace()
    const pageControl = await runPageControlE2E(userTab.id, fixtures)
    const workflow = await runMainWorkflow(workspace.id, fixtures)
    const ambiguousError = await runAmbiguousWorkflow(workspace.id, fixtures.mainOrigin)
    const detachWorkflow = await runDetachWorkflow(workspace.id, fixtures.mainOrigin)
    return { pageControl, workflow, ambiguousError, detachWorkflow: detachWorkflow.summary, detachPaused: detachWorkflow.paused }
  } finally {
    disposeWebTabs()
    if (window && !window.isDestroyed()) window.destroy()
    await Promise.all([
      new Promise<void>((resolve) => fixtures.mainServer.close(() => resolve())),
      new Promise<void>((resolve) => fixtures.frameServer.close(() => resolve())),
    ])
  }
}

void main().then((result) => {
  console.log(`BROWSER_WORKFLOW_E2E_RESULT ${JSON.stringify({ ok: true, ...result })}`)
  app.quit()
}, (error: unknown) => {
  console.error('BROWSER_WORKFLOW_E2E_ERROR', error)
  app.exit(1)
})
