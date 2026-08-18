import { beforeAll, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  readonly stdin = {
    destroyed: false,
    write: mock(() => true),
  }
  killed = false

  constructor() {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
  }

  kill(): void {
    this.killed = true
  }
}

const fakeChildren: FakeChild[] = []
let lastSpawnEnvironment: NodeJS.ProcessEnv | undefined
mock.module('node:child_process', () => ({
  spawn: (_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    lastSpawnEnvironment = options.env
    const child = new FakeChild()
    fakeChildren.push(child)
    return child
  },
}))

let startBrowserWorkflowPlaywrightScript: typeof import('./browser-workflow-playwright-executor')['startBrowserWorkflowPlaywrightScript']

beforeAll(async () => {
  ;({ startBrowserWorkflowPlaywrightScript } = await import('./browser-workflow-playwright-executor'))
})

function createInput(onEvent: (event: unknown) => void) {
  return {
    nodeExecutable: '/runtime/node',
    scriptPath: '/workflow/playwright/v1.mjs',
    cdpEndpoint: 'http://127.0.0.1:43123',
    targetId: 'target-1',
    playwrightCoreEntrypoint: '/modules/playwright-core/index.js',
    artifactDirectory: '/workflow/artifacts/run-1',
    variables: { secret: 'cookie-secret' },
    signal: new AbortController().signal,
    onEvent,
  }
}

test('Given 脚本发送错误事件 When 子进程以非零状态退出 Then 保留脚本的具体失败原因', async () => {
  const events: unknown[] = []
  const session = startBrowserWorkflowPlaywrightScript(createInput((event) => events.push(event)))
  const child = fakeChildren.at(-1)!
  child.stdout.emit('data', JSON.stringify({ type: 'error', message: '步骤 step-1（click）失败: endpoint=http://127.0.0.1:43123 variable=cookie-secret' }) + '\n')
  child.stderr.emit('data', 'endpoint=http://127.0.0.1:43123 variable=cookie-secret\n')
  child.emit('close', 1)

  await expect(session.promise).rejects.toThrow('步骤 step-1（click）失败: endpoint=[已隐藏] variable=[已隐藏]')
  expect(events).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain('cookie-secret')
})

test('Given 脚本没有结构化错误事件 When stderr 包含运行参数 Then 诊断过滤运行参数', async () => {
  const session = startBrowserWorkflowPlaywrightScript(createInput(() => undefined))
  const child = fakeChildren.at(-1)!
  child.stderr.emit('data', 'endpoint=http://127.0.0.1:43123 variable=cookie-secret\n真实错误\n')
  child.emit('close', 1)

  await expect(session.promise).rejects.toThrow('[已隐藏]')
  await expect(session.promise).rejects.not.toThrow('cookie-secret')
})

test('Given E2E Node 兼容环境 When 启动脚本 Then 仅传给 Workflow 子进程', async () => {
  const input = Object.assign(createInput(() => undefined), {
    nodeEnvironment: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const session = startBrowserWorkflowPlaywrightScript(input)
  const child = fakeChildren.at(-1)!
  child.emit('close', 0)

  await expect(session.promise).resolves.toBeUndefined()
  expect(lastSpawnEnvironment?.ELECTRON_RUN_AS_NODE).toBe('1')
})
