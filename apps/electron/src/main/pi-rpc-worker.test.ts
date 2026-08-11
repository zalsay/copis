import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { serializeWorkerCommand, type AgentRpcWorkerCommand } from './lib/agent-rpc-protocol'

const repoRoot = resolve(import.meta.dir, '../../..')
const workerEntry = resolve(import.meta.dir, 'pi-rpc-worker.ts')

describe('Pi RPC worker payment EOF race', () => {
  test('Given immediate stdin close When payment capability is still running Then writes payment_result before exit', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      }, 300)
    })
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', resolveListen)
    })

    const address = server.address() as AddressInfo
    const command: AgentRpcWorkerCommand = {
      type: 'payment',
      requestId: 'payment-request-1',
      config: {
        sessionId: 'payment-session-1',
        request: { action: 'wallet.check' },
      },
    }
    const child = spawn(process.execPath, [workerEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COPIS_PI_PAYMENT_CAPABILITY_TOKEN: 'test-payment-token',
        COPIS_HTTP_API_PORT: String(address.port),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.stdin.write(serializeWorkerCommand(command))
    child.stdin.end()

    const settled = await Promise.race([
      once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<'timeout'>((resolveTimeout) => {
        setTimeout(() => resolveTimeout('timeout'), 5_000)
      }),
    ])
    if (settled === 'timeout') {
      child.kill()
      throw new Error(`Worker 未在 5 秒内退出\nstderr:\n${stderr}`)
    }
    const [exitCode] = settled

    try {
      expect(stderr).toBe('')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('"type":"payment_result"')
      expect(stdout).toContain('"ok":true')
    } finally {
      server.close()
    }
  })
})
