import assert from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const electronRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(electronRoot, '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'copis-browser-workflow-e2e-'))
const bundledMain = join(tempRoot, 'browser-workflow-e2e-main.cjs')
const esbuildBinary = join(repositoryRoot, 'node_modules/.bin/esbuild')
const electronBinary = process.env.ELECTRON_BINARY ?? join(repositoryRoot, 'node_modules/.bin/electron')

function resolveNodeExecutable(): string {
  if (process.env.COPIS_E2E_NODE_EXECUTABLE) return process.env.COPIS_E2E_NODE_EXECUTABLE
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  const output = execFileSync(lookup, ['node'], { encoding: 'utf8' }).trim()
  const executable = output.split(/\r?\n/, 1)[0]
  if (!executable) throw new Error('找不到 E2E 所需的 Node.js 运行时')
  return executable
}

interface RunProcessResult {
  code: number
  stdout: string
  stderr: string
}

const isWindows = process.platform === 'win32'

function killProcessTree(pid: number): void {
  if (isWindows) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

function runCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = repositoryRoot,
  timeoutMs = 90_000,
): Promise<RunProcessResult> {
  return new Promise((resolveExit) => {
    let settled = false
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
    })

    let timer: NodeJS.Timeout | undefined

    const cleanup = (code: number, signal?: NodeJS.Signals | null, shouldKill = false): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (shouldKill && child.pid && !child.killed) {
        killProcessTree(child.pid)
      }
      resolveExit({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    }

    timer = setTimeout(() => {
      console.error(`[Browser Workflow E2E] 子进程执行超时 (${timeoutMs}ms): ${command}`)
      cleanup(124, null, true)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      process.stderr.write(chunk)
    })

    child.once('error', (error) => {
      console.error(`[Browser Workflow E2E] 启动失败: ${command}`, error)
      cleanup(1, null, true)
    })

    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[Browser Workflow E2E] 子进程被 ${signal} 终止`)
        cleanup(1, signal, true)
      } else {
        cleanup(code ?? 1, null, false)
      }
    })
  })
}

function runInherit(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = repositoryRoot,
): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    })
    child.once('error', (error) => {
      console.error(`[Browser Workflow E2E] 启动失败: ${command}`, error)
      resolveExit(1)
    })
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[Browser Workflow E2E] 子进程被 ${signal} 终止`)
        resolveExit(1)
      } else {
        resolveExit(code ?? 1)
      }
    })
  })
}

let exitCode = 0
try {
  if (!existsSync(esbuildBinary)) throw new Error(`找不到 esbuild: ${esbuildBinary}`)
  if (!existsSync(electronBinary)) throw new Error(`找不到 Electron: ${electronBinary}`)

  console.log('[Browser Workflow E2E] 编译 E2E 宿主脚本...')
  const buildExitCode = await runInherit(esbuildBinary, [
    join(electronRoot, 'scripts/browser-workflow-e2e-main.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundledMain}`,
    '--external:electron',
    '--external:@earendil-works/pi-coding-agent',
    '--external:@earendil-works/pi-agent-core',
    '--external:@earendil-works/pi-ai',
    '--external:playwright-core',
  ])
  if (buildExitCode !== 0) {
    exitCode = buildExitCode
  } else {
    // 阶段 1: 正常产品语义进程验证 (Normal Startup Probe)
    console.log('\n=== 阶段 1: 正常产品语义进程验证 (无全局调试端口) ===')
    const normalUserData = join(tempRoot, 'normal-user-data')
    const normalHome = join(tempRoot, 'normal-home')
    const normalRun = await runCapture(
      electronBinary,
      [bundledMain],
      {
        ...process.env,
        HOME: normalHome,
        USERPROFILE: normalHome,
        COPIS_BROWSER_WORKFLOW_E2E: '1',
        COPIS_E2E_MODE: 'normal-probe',
        COPIS_E2E_USER_DATA: normalUserData,
        COPIS_REPO_ROOT: repositoryRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      electronRoot,
    )

    if (normalRun.code !== 0) {
      throw new Error(`正常模式 Electron 探针执行失败，退出码: ${normalRun.code}`)
    }

    const devToolsPortPath = join(normalUserData, 'DevToolsActivePort')
    const devToolsPortCreated = existsSync(devToolsPortPath)
    if (devToolsPortCreated) {
      throw new Error(`正常模式隔离 userData 目录异常生成了 DevToolsActivePort: ${devToolsPortPath}`)
    }
    console.log('[Browser Workflow E2E] 正常模式 userData 验证通过: 未生成 DevToolsActivePort')

    const normalMatch = normalRun.stdout.match(/NORMAL_PROBE_RESULT\s+(\{[^\n]+\})/)
    if (!normalMatch) {
      throw new Error('未能解析正常模式探针输出结果 (NORMAL_PROBE_RESULT)')
    }
    const normalProbeResult = JSON.parse(normalMatch[1])
    console.log('[Browser Workflow E2E] 正常模式结果汇总:', JSON.stringify(normalProbeResult, null, 2))

    // 字段级断言：验证所有正常启动布尔条件均为 true
    assert.strictEqual(normalProbeResult.ok, true, '正常模式 probe 必须返回 ok: true')
    assert.strictEqual(normalProbeResult.noRemoteDebuggingPortArg, true, '正常启动进程参数不得包含 remote-debugging-port')
    assert.strictEqual(normalProbeResult.noRemoteDebuggingAddressArg, true, '正常启动进程参数不得包含 remote-debugging-address')
    assert.strictEqual(normalProbeResult.noRemoteDebuggingPortSwitch, true, '正常启动命令行开关不得包含 remote-debugging-port')
    assert.strictEqual(normalProbeResult.noRemoteDebuggingAddressSwitch, true, '正常启动命令行开关不得包含 remote-debugging-address')
    assert.strictEqual(normalProbeResult.ordinaryTabWebDriverFalse, true, '普通页签 navigator.webdriver 必须为 false')
    assert.strictEqual(normalProbeResult.ordinaryTabDebuggerNotAttached, true, '普通页签 debugger 必须未挂载')
    assert.strictEqual(normalProbeResult.oauthChildDebuggerNotAttached, true, 'OAuth 子窗口 debugger 必须未挂载')
    assert.strictEqual(normalProbeResult.oauthParentDebuggerNotAttached, true, 'OAuth 父页签 debugger 必须未挂载')
    assert.strictEqual(normalProbeResult.oauthChildSharesSession, true, 'OAuth 子窗口必须共享父页签 session Cookie')
    assert.strictEqual(normalProbeResult.oauthChildClosed, true, 'OAuth 子窗口必须正常关闭')
    assert.strictEqual(normalProbeResult.agentTabLeaseAttached, true, 'Agent 绑定页签必须按需附加 debugger')
    assert.strictEqual(normalProbeResult.ordinaryTabsRemainDetached, true, '未绑定的普通页签必须保持 detached')
    assert.strictEqual(normalProbeResult.agentTabLeaseReleased, true, 'Agent 解绑后页签必须 detach')
    assert.strictEqual(normalProbeResult.agentOpenTabAttached, true, 'Agent open 页签必须按需附加 debugger')
    assert.strictEqual(normalProbeResult.agentOpenTabReleased, true, 'Agent open 页签解绑后必须 detach')

    // 阶段 2: 专用测试/Instrumented 进程验证
    console.log('\n=== 阶段 2: 专用测试进程验证 (Node CDP 探针、页面控制、Workflow 运行与交接) ===')
    const instrumentedUserData = join(tempRoot, 'instrumented-user-data')
    const instrumentedHome = join(tempRoot, 'instrumented-home')
    const nodeExecutable = resolveNodeExecutable()
    const instrumentedRun = await runCapture(
      electronBinary,
      [bundledMain],
      {
        ...process.env,
        HOME: instrumentedHome,
        USERPROFILE: instrumentedHome,
        COPIS_BROWSER_WORKFLOW_E2E: '1',
        COPIS_BROWSER_WORKFLOW_E2E_VISIBLE: '1',
        COPIS_E2E_MODE: 'instrumented',
        COPIS_E2E_USER_DATA: instrumentedUserData,
        COPIS_E2E_NODE_EXECUTABLE: nodeExecutable,
        COPIS_REPO_ROOT: repositoryRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      electronRoot,
    )

    if (instrumentedRun.code !== 0) {
      throw new Error(`测试模式 Electron 执行失败，退出码: ${instrumentedRun.code}`)
    }

    const instrumentedMatch = instrumentedRun.stdout.match(/INSTRUMENTED_E2E_RESULT\s+(\{[^\n]+\})/)
    if (!instrumentedMatch) {
      throw new Error('未能解析测试模式输出结果 (INSTRUMENTED_E2E_RESULT)')
    }
    const instrumentedResult = JSON.parse(instrumentedMatch[1])
    console.log('[Browser Workflow E2E] 测试模式结果汇总:', JSON.stringify(instrumentedResult, null, 2))

    // 字段级断言：验证所有测试模式结果满足预期
    assert.strictEqual(instrumentedResult.ok, true, '测试模式必须返回 ok: true')
    assert.strictEqual(instrumentedResult.nodeCdpVerified, true, 'Node CDP 探针必须验证通过')
    assert.strictEqual(instrumentedResult.pageControl.observed, true, '页面控制必须成功 observe 元素')
    assert.strictEqual(instrumentedResult.pageControl.askRejected, true, '页面控制 ask 模式必须拒绝写操作')
    assert.strictEqual(instrumentedResult.pageControl.typed, true, '页面控制授权后必须成功更新受控输入')
    assert.strictEqual(instrumentedResult.pageControl.crossOriginRevoked, true, '跨域导航后必须撤回授权')

    assert.strictEqual(instrumentedResult.workflow.summary.status, 'completed', '主 Workflow 必须完成')
    assert.strictEqual(instrumentedResult.workflow.workflowTabCreated, true, '主 Workflow 必须创建专用页签')
    assert.strictEqual(instrumentedResult.workflow.workflowTabAttachedDuringRun, true, '主 Workflow 运行期间必须附加 CDP')
    assert.strictEqual(instrumentedResult.workflow.workflowTabClosedOrDetached, true, '主 Workflow 完成后必须清理释放页签/CDP')

    assert.ok(
      typeof instrumentedResult.ambiguousError === 'string' &&
      (instrumentedResult.ambiguousError.includes('AMBIGUOUS_TARGET') ||
       instrumentedResult.ambiguousError.includes('匹配到多个元素') ||
       instrumentedResult.ambiguousError.includes('歧义')),
      `歧义定位必须拒绝执行并返回歧义错误，实际为: ${instrumentedResult.ambiguousError}`,
    )

    assert.strictEqual(instrumentedResult.detachWorkflow.status, 'completed', 'CDP 断开恢复 Workflow 必须最终完成')
    assert.strictEqual(instrumentedResult.detachPaused, true, 'CDP 断开后必须发布 paused_cdp_detached 状态')

    assert.strictEqual(instrumentedResult.failureHandoff.errorCaught, true, '预期的失败步骤必须抛出错误')
    assert.strictEqual(instrumentedResult.failureHandoff.promotedTabAttached, true, '失败交接后页签必须提升并持有 Agent CDP lease')
    assert.strictEqual(instrumentedResult.failureHandoff.promotedTabReleased, true, '失败交接页签在 Agent 解绑后必须释放 CDP')

    console.log('\n================== E2E 机器可校验通过证据汇总 ==================')
    console.log('1. 正常启动进程参数无 remote-debugging-port/address: 通过')
    console.log('2. 正常启动隔离 userData 未生成 DevToolsActivePort: 通过')
    console.log('3. 正常普通 HTTP 页签 navigator.webdriver === false: 通过')
    console.log('4. 普通页签 webContents.debugger.isAttached() === false: 通过')
    console.log('5. 普通页签 window.open OAuth 原生子窗口共享 session 且父/子均不附加 debugger，子窗口可关闭: 通过')
    console.log('6. Agent open 与显式绑定仅目标页签持有 lease 并在释放后 detach，其他页签保持 detached: 通过')
    console.log('7. Workflow 专用页签运行时 attach，执行完毕/清理后释放: 通过')
    console.log('8. Workflow 多页签 popup、detach/resume、歧义失败与 failure handoff 行为: 全部通过')
    console.log('9. 专用 E2E 入口 Node CDP 探针 (configurePlaywrightCdpEndpoint / getPlaywrightCdpEndpoint): 通过')
    console.log('=================================================================\n')
  }
} catch (error) {
  console.error('[Browser Workflow E2E] 执行失败', error)
  exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(exitCode)
