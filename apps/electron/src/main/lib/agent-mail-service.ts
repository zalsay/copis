import { BrowserWindow } from 'electron'
import QRCode from 'qrcode'
import type { AgentMailAlias, AgentMailStatus } from '@copis/shared'
import { AGENT_MAIL_IPC_CHANNELS } from '@copis/shared'
import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_HTTP_API_PORT = 51730
const AGENT_MAIL_ENDPOINT = '/api/internal/agent/agent-mail'

function getHttpApiUrl(): string {
  const port = process.env.COPIS_HTTP_API_PORT ?? String(DEFAULT_HTTP_API_PORT)
  return `http://127.0.0.1:${port}${AGENT_MAIL_ENDPOINT}`
}

function getAgentFileToken(): string {
  return process.env.COPIS_PI_FILE_API_TOKEN?.trim() || 'internal-token'
}

export class AgentMailService {
  private static instance: AgentMailService | null = null
  private loginProcess: ChildProcess | null = null
  private currentStatus: AgentMailStatus = {
    installed: false,
    loggedIn: false,
    status: 'not_logged_in',
  }

  static getInstance(): AgentMailService {
    if (!AgentMailService.instance) {
      AgentMailService.instance = new AgentMailService()
    }
    return AgentMailService.instance
  }

  private broadcastStatus(status: AgentMailStatus): void {
    this.currentStatus = status
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(AGENT_MAIL_IPC_CHANNELS.STATUS_CHANGED, status)
      }
    }
  }

  async getStatus(): Promise<AgentMailStatus> {
    try {
      const resp = await fetch(getHttpApiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-copis-agent-file-token': getAgentFileToken(),
        },
        body: JSON.stringify({ action: 'auth.status' }),
      })

      if (!resp.ok) {
        this.currentStatus = {
          installed: false,
          loggedIn: false,
          status: 'not_installed',
          errorMessage: '无法连接 Agent Mail 本地服务',
        }
        return this.currentStatus
      }

      const statusJson = (await resp.json()) as { ok?: boolean; data?: { logged_in?: boolean; status?: string } }
      const isLoggedIn = statusJson?.data?.logged_in === true

      if (!isLoggedIn) {
        this.currentStatus = {
          installed: true,
          loggedIn: false,
          status: 'not_logged_in',
        }
        return this.currentStatus
      }

      // 获取当前用户及邮箱别名
      const meResp = await fetch(getHttpApiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-copis-agent-file-token': getAgentFileToken(),
        },
        body: JSON.stringify({ action: 'me' }),
      })

      if (meResp.ok) {
        const meJson = (await meResp.json()) as {
          ok?: boolean
          data?: {
            aliases?: AgentMailAlias[]
          }
        }
        const aliases = meJson?.data?.aliases ?? []
        const primary = aliases.find((a) => a.is_primary) ?? aliases[0]

        this.currentStatus = {
          installed: true,
          loggedIn: true,
          email: primary?.email,
          name: primary?.name,
          aliases,
          status: 'connected',
        }
      } else {
        this.currentStatus = {
          installed: true,
          loggedIn: true,
          status: 'connected',
        }
      }

      return this.currentStatus
    } catch {
      // 容错降级
      this.currentStatus = {
        installed: false,
        loggedIn: false,
        status: 'not_installed',
      }
      return this.currentStatus
    }
  }

  async startLogin(): Promise<{ authUrl: string; qrCodeDataUrl: string }> {
    this.cancelLogin()

    const cliCommand = process.env.COPIS_AGENTLY_CLI || 'agently-cli'

    return new Promise<{ authUrl: string; qrCodeDataUrl: string }>((resolve, reject) => {
      let resolved = false

      const child = spawn(cliCommand, ['auth', 'login'], {
        env: {
          ...process.env,
          PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        },
      })
      this.loginProcess = child

      let buffer = ''

      child.stdout.on('data', async (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        buffer += text

        // 提取 OAuth 授权 URL
        const match = buffer.match(/https:\/\/agent\.qq\.com\/page\/oauth\?[^\s\r\n]+/)
        if (match && !resolved) {
          resolved = true
          const authUrl = match[0]
          try {
            const qrCodeDataUrl = await QRCode.toDataURL(authUrl, {
              width: 280,
              margin: 2,
              errorCorrectionLevel: 'M',
            })
            this.broadcastStatus({
              installed: true,
              loggedIn: false,
              authUrl,
              status: 'authenticating',
            })
            resolve({ authUrl, qrCodeDataUrl })
          } catch (qrErr) {
            reject(qrErr)
          }
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
      })

      child.on('close', async (code) => {
        this.loginProcess = null
        if (code === 0) {
          const status = await this.getStatus()
          this.broadcastStatus(status)
        } else if (!resolved) {
          this.broadcastStatus({
            installed: true,
            loggedIn: false,
            status: 'error',
            errorMessage: buffer || `授权进程异常退出（代码 ${code}）`,
          })
          reject(new Error(buffer || `授权失败，进程退出代码: ${code}`))
        }
      })

      child.on('error', (err) => {
        this.loginProcess = null
        if (!resolved) {
          this.broadcastStatus({
            installed: false,
            loggedIn: false,
            status: 'error',
            errorMessage: err.message,
          })
          reject(err)
        }
      })
    })
  }

  cancelLogin(): void {
    if (this.loginProcess) {
      try {
        this.loginProcess.kill()
      } catch {
        // ignore
      }
      this.loginProcess = null
    }
  }

  async logout(): Promise<AgentMailStatus> {
    this.cancelLogin()
    try {
      await fetch(getHttpApiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-copis-agent-file-token': getAgentFileToken(),
        },
        body: JSON.stringify({ action: 'auth.logout' }),
      })
    } catch {
      // ignore
    }

    const nextStatus: AgentMailStatus = {
      installed: true,
      loggedIn: false,
      status: 'not_logged_in',
    }
    this.broadcastStatus(nextStatus)
    return nextStatus
  }
}
