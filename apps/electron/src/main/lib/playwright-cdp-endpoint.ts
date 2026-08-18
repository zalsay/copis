import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_INTERVAL_MS = 50

interface PlaywrightCdpApp {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
  getPath(name: 'userData'): string
}

export interface PlaywrightCdpEndpointOptions {
  userDataPath?: string
  timeoutMs?: number
  retryIntervalMs?: number
  readFileImpl?: (path: Parameters<typeof readFile>[0], encoding: 'utf8') => Promise<string>
}

let configuredUserDataPath: string | undefined
let configured = false
let discoveredEndpoint: string | undefined
let discoveryPromise: Promise<string> | undefined

/** 在 Electron ready 前开启一次性本地 CDP 端口；地址只留在主进程内存。 */
export function configurePlaywrightCdpEndpoint(electronApp: PlaywrightCdpApp = app): void {
  if (!configured) {
    electronApp.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    electronApp.commandLine.appendSwitch('remote-debugging-port', '0')
    configured = true
  }
  configuredUserDataPath ??= electronApp.getPath('userData')
}

/** 读取 Chromium 写入的 DevToolsActivePort，并返回供主进程内部使用的 HTTP endpoint。 */
export function getPlaywrightCdpEndpoint(
  options: PlaywrightCdpEndpointOptions = {},
): Promise<string> {
  if (discoveredEndpoint && !options.userDataPath) return Promise.resolve(discoveredEndpoint)
  if (!discoveryPromise || options.userDataPath) {
    discoveryPromise = discoverEndpoint(options).then((endpoint) => {
      if (!options.userDataPath) discoveredEndpoint = endpoint
      return endpoint
    })
  }
  return discoveryPromise
}

async function discoverEndpoint(options: PlaywrightCdpEndpointOptions): Promise<string> {
  const userDataPath = options.userDataPath ?? configuredUserDataPath ?? app.getPath('userData')
  const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const retryIntervalMs = Math.max(1, Math.min(500, Math.floor(options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)))
  const readFileImpl: (path: Parameters<typeof readFile>[0], encoding: 'utf8') => Promise<string>
    = options.readFileImpl ?? (readFile as unknown as (path: Parameters<typeof readFile>[0], encoding: 'utf8') => Promise<string>)
  const activePortPath = join(userDataPath, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    try {
      const body = await readFileImpl(activePortPath, 'utf8')
      const port = parseDevToolsPort(body)
      if (port !== undefined) return `http://127.0.0.1:${port}`
    } catch {
      // Chromium may create the file shortly after app ready; continue bounded polling.
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, deadline - Date.now())))
  }
  throw new Error('未能发现浏览器自动化 CDP endpoint')
}

function parseDevToolsPort(body: string): number | undefined {
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine || !/^\d+$/.test(firstLine)) return undefined
  const port = Number(firstLine)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

function clampTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(60_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}
