/**
 * DSH 「基金股市」服务管控层。
 *
 * 负责与本地 DSH CLI 协同管理 trading-web 纯行情与展示 Profile：
 * - 仅保留行情展示、图表呈现与 Agent 对话能力；
 * - 绝不预留或开放实盘交易指令、撤单或下单闸门；
 * - 进程生命周期（启动/停止/状态提取）与 URL 凭证解析。
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FundStockTerminalStatus } from '@copis/shared'
import { resolveDshCommand, resolveDshNode } from './dsh-runtime'

interface DshTradingServerState {
  process: ChildProcess | null
  status: FundStockTerminalStatus
}

const state: DshTradingServerState = {
  process: null,
  status: {
    running: false,
  },
}

export function getDshTradingStatus(): FundStockTerminalStatus {
  return { ...state.status }
}

/** 确保 ~/.dsh/profiles/trading-web 存在并配置为纯展示模式 */
export function ensureTradingWebProfile(dshRootDir = join(homedir(), '.dsh')): string {
  const profileDir = join(dshRootDir, 'profiles', 'trading-web')
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
  }

  // 写入纯展示模式配置文件，明确禁止交易指令插件
  const configPath = join(profileDir, 'cordis.json')
  if (!existsSync(configPath)) {
    const config = {
      $schema: 'https://cordis.moe/schema.json',
      features: {
        tradingExecution: false,
        liveTrading: false,
        orderRouting: false,
        readOnlyMarketData: true,
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  return profileDir
}

/** 启动 DSH 「基金股市」Web 服务 */
export async function startDshTradingServer(options: {
  dshCommand?: string
  dshNode?: string
  dshRootDir?: string
  timeoutMs?: number
} = {}): Promise<FundStockTerminalStatus> {
  if (state.status.running && state.status.url) {
    return { ...state.status }
  }

  const dshCmd = options.dshCommand || resolveDshCommand()
  const dshNode = options.dshNode || resolveDshNode()

  if (!dshCmd) {
    state.status = {
      running: false,
      error: '未找到已激活的 dsh 运行时，将使用内置纯前端图表模式',
    }
    return { ...state.status }
  }

  ensureTradingWebProfile(options.dshRootDir)

  const timeoutMs = options.timeoutMs ?? 15000

  return new Promise<FundStockTerminalStatus>((resolve) => {
    let settled = false

    const env = {
      ...process.env,
      COPIS_READONLY_TRADING: '1',
      ...(dshNode ? { COPIS_DSH_NODE: dshNode } : {}),
    }

    const child = spawn(dshCmd, ['--profile', 'trading-web', '--no-open'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    state.process = child

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        // 超时仍未拿到 URL 时保留进程但记录状态
        if (!state.status.url) {
          state.status = {
            running: !child.killed,
            port: state.status.port || 3080,
            url: `http://127.0.0.1:${state.status.port || 3080}`,
          }
        }
        resolve({ ...state.status })
      }
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      const urlMatch = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:\/[^\s]*)?/)
      if (urlMatch && urlMatch[1]) {
        const port = parseInt(urlMatch[1], 10)
        state.status = {
          running: true,
          port,
          url: urlMatch[0],
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ...state.status })
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const errText = chunk.toString('utf-8')
      console.warn('[DSH 基金股市]', errText.trim())
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      state.process = null
      state.status = {
        running: false,
        error: err.message,
      }
      if (!settled) {
        settled = true
        resolve({ ...state.status })
      }
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      state.process = null
      state.status = {
        running: false,
        error: code !== 0 ? `进程非正常退出 (code ${code})` : undefined,
      }
    })
  })
}

/** 停止 DSH 「基金股市」服务 */
export function stopDshTradingServer(): FundStockTerminalStatus {
  if (state.process) {
    try {
      if (process.platform === 'win32' && state.process.pid) {
        spawn('taskkill', ['/pid', state.process.pid.toString(), '/T', '/F'])
      } else {
        state.process.kill('SIGTERM')
      }
    } catch {
      // 忽略已终止进程
    }
    state.process = null
  }

  state.status = {
    running: false,
  }

  return { ...state.status }
}
