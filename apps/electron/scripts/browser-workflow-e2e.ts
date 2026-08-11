import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const electronRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(electronRoot, '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'copis-browser-workflow-e2e-'))
const bundledMain = join(tempRoot, 'browser-workflow-e2e-main.cjs')
const esbuildBinary = join(repositoryRoot, 'node_modules/.bin/esbuild')
const electronBinary = process.env.ELECTRON_BINARY ?? join(repositoryRoot, 'node_modules/.bin/electron')

function run(
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

  const buildExitCode = await run(esbuildBinary, [
    join(electronRoot, 'scripts/browser-workflow-e2e-main.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundledMain}`,
    '--external:electron',
    '--external:@earendil-works/pi-coding-agent',
    '--external:@earendil-works/pi-agent-core',
    '--external:@earendil-works/pi-ai',
  ])
  if (buildExitCode !== 0) {
    exitCode = buildExitCode
  } else {
    const e2eUserData = join(tempRoot, 'user-data')
    const e2eHome = join(tempRoot, 'home')
    exitCode = await run(
      electronBinary,
      [bundledMain],
      {
        ...process.env,
        HOME: e2eHome,
        USERPROFILE: e2eHome,
        COPIS_BROWSER_WORKFLOW_E2E: '1',
        COPIS_BROWSER_WORKFLOW_E2E_VISIBLE: '1',
        COPIS_E2E_USER_DATA: e2eUserData,
        COPIS_REPO_ROOT: repositoryRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      electronRoot,
    )
  }
} catch (error) {
  console.error('[Browser Workflow E2E] 执行失败', error)
  exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(exitCode)
