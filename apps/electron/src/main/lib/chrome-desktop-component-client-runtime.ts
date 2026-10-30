import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isChromeDesktopComponentMetadata } from '@copis/shared'
import { getFunctionalModulePaths, readActiveFunctionalModule, type ActiveFunctionalModule } from './functional-module-store'

const MODULE_NAME = 'chrome-desktop-cli'
export const MAX_COMPONENT_OUTPUT_BYTES = 64 * 1024
export const MAX_COMPONENT_IMAGE_BYTES = 1024 * 1024

export interface ComponentCommand {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}
export interface ComponentCommandResult {
  stdout: string
  exitCode: number | null
}
export type ComponentCommandExecutor = (command: ComponentCommand) => Promise<ComponentCommandResult>

export interface ChromeDesktopComponentClientOptions {
  moduleRootDir?: string
  resolveComponent?: (rootDir: string) => ActiveFunctionalModule | undefined | Promise<ActiveFunctionalModule | undefined>
  installComponent?: (rootDir: string) => Promise<unknown>
  executeCommand?: ComponentCommandExecutor
  platform?: NodeJS.Platform
  arch?: string
  commandTimeoutMs?: number
}

export interface ComponentInstallation {
  path: string
  helperPath: string
  version: string
}
export interface ComponentRuntime extends ComponentInstallation {
  directory: string
  framesDirectory: string
  controller: AbortController
  commands: Set<Promise<unknown>>
  stopping?: Promise<void>
}

export function componentError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`)
}
export function helperFailure(): Error {
  return componentError('CHROME_HELPER_FAILED', 'Chrome 组件不可用或协议无效，请到功能模块设置安装或重试')
}

export async function resolveComponentInstallation(options: ChromeDesktopComponentClientOptions): Promise<ComponentInstallation> {
  if ((options.platform ?? process.platform) !== 'darwin' || !['arm64', 'x64'].includes(options.arch ?? process.arch)) {
    throw componentError('CHROME_UNSUPPORTED_CONTEXT', 'Chrome 桌面组件仅支持 macOS')
  }
  try {
    const rootDir = options.moduleRootDir ?? (await import('./config-paths')).getFunctionalModulesDir()
    const resolver = options.resolveComponent ?? ((root: string) => readActiveFunctionalModule(getFunctionalModulePaths(root), MODULE_NAME))
    const managedRoot = join(resolve(rootDir), 'versions', MODULE_NAME)
    let active = await resolver(rootDir)
    // 旧组件只允许经既有安装器升级，不能执行旧入口或从 PATH 寻找替代。
    const legacy = active?.name === MODULE_NAME && basename(active.path) === 'copis-chrome'
    if (legacy) await managedFile(managedRoot, active!.path, true)
    if (!active || legacy) {
      if (options.installComponent) await options.installComponent(rootDir)
      else {
        const { installFunctionalModule } = await import('./functional-module-manager')
        await installFunctionalModule({ name: MODULE_NAME }, { rootDir })
      }
      // 安装器的返回值不提供信任边界，始终重读 module-store 的 active 指针。
      active = await resolver(rootDir)
    }
    if (!active || active.name !== MODULE_NAME || basename(active.path) !== 'mcc' || !active.version) throw helperFailure()
    const installation = inspectChromeDesktopComponent(rootDir, active, options.arch ?? process.arch)
    await prepareHelperExecutable(await realpath(managedRoot), installation.helperPath)
    return installation
  } catch {
    throw helperFailure()
  }
}

/** 复用执行前的受管路径/元数据校验；仅静态读取，不安装、不启动、不 chmod。 */
export function inspectChromeDesktopComponent(rootDir: string, active: ActiveFunctionalModule, arch: string): ComponentInstallation {
  if (active.name !== MODULE_NAME || basename(active.path) !== 'mcc' || !active.version) throw helperFailure()
  const managedRoot = join(resolve(rootDir), 'versions', MODULE_NAME)
  const cliPath = managedFile(managedRoot, active.path, true)
  const metadataPath = managedFile(managedRoot, join(dirname(active.path), 'module.json'))
  const metadata: unknown = JSON.parse(readBoundedMetadata(metadataPath).toString('utf8'))
  if (!isChromeDesktopComponentMetadata(metadata, { version: active.version, arch })) throw helperFailure()
  const helperPath = managedFile(managedRoot, join(dirname(active.path), metadata.helper))
  if (dirname(helperPath) !== dirname(cliPath) || lstatSync(helperPath).nlink !== 1) throw helperFailure()
  return { path: cliPath, helperPath, version: active.version }
}

function readBoundedMetadata(path: string): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_COMPONENT_OUTPUT_BYTES) throw helperFailure()
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw helperFailure()
    const buffer = Buffer.alloc(MAX_COMPONENT_OUTPUT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length === 0 || length > MAX_COMPONENT_OUTPUT_BYTES) throw helperFailure()
    return buffer.subarray(0, length)
  } finally { closeSync(fd) }
}

function isWithin(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

function managedFile(root: string, path: string, executable = false): string {
  if (!isAbsolute(path) || !isWithin(root, path)) throw helperFailure()
  // 连同 versions 与模块根目录逐级检查，拒绝在受管树中插入符号链接。
  const anchor = dirname(dirname(root))
  const canonicalAnchor = realpathSync(anchor)
  let cursor = anchor
  for (const part of relative(anchor, path).split(sep)) {
    cursor = join(cursor, part)
    const entry = lstatSync(cursor)
    if (entry.isSymbolicLink() || (cursor !== path && !entry.isDirectory())) throw helperFailure()
  }
  if (!lstatSync(path).isFile()) throw helperFailure()
  const canonical = realpathSync(path)
  if (canonical !== join(canonicalAnchor, relative(anchor, path))) throw helperFailure()
  if (executable) accessSync(canonical, constants.X_OK)
  return canonical
}

/** store 解包仅给入口恢复执行位；helper 必须在路径和协议验证后通过文件句柄恢复权限。 */
async function prepareHelperExecutable(managedRoot: string, helperPath: string): Promise<void> {
  const before = await lstat(helperPath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw helperFailure()
  const handle = await open(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw helperFailure()
    if ((opened.mode & 0o777) !== 0o755) await handle.chmod(0o755)
    await managedFile(managedRoot, helperPath, true)
    const current = await lstat(helperPath)
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw helperFailure()
  } finally { await handle.close() }
}

export async function createComponentRuntime(installation: ComponentInstallation): Promise<ComponentRuntime> {
  const hash = createHash('sha256').update(`${installation.path}\0${installation.version}`).digest('hex').slice(0, 10)
  let directory: string | undefined
  try {
    let base = await realpath(tmpdir())
    if (Buffer.byteLength(join(base, `cpc-${hash}-XXXXXX`, 'daemon.sock')) > 100) base = await realpath('/tmp')
    directory = await mkdtemp(join(base, `cpc-${hash}-`))
    await chmod(directory, 0o700)
    if (Buffer.byteLength(join(directory, 'daemon.sock')) > 100) throw helperFailure()
    const framesDirectory = join(directory, 'frames')
    await mkdir(framesDirectory, { mode: 0o700 })
    return { ...installation, directory, framesDirectory, controller: new AbortController(), commands: new Set() }
  } catch {
    if (directory) await rm(directory, { force: true, recursive: true }).catch(() => {})
    throw helperFailure()
  }
}

export function componentEnvironment(runtime: ComponentRuntime): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('COPIS_CHROME_') || key.startsWith('COPIS_DESKTOP_')) delete env[key]
  return { ...env, COPIS_DESKTOP_RUNTIME_DIR: runtime.directory, COPIS_DESKTOP_HELPER: runtime.helperPath }
}

/** stderr 丢弃，所有异常使用固定消息，避免把 argv 中的输入或连接凭据带出主进程。 */
export const executeComponentCommand: ComponentCommandExecutor = command => new Promise((resolveResult, reject) => {
  if (command.signal?.aborted) { reject(componentError('CHROME_CANCELLED', 'Chrome 操作已取消')); return }
  let stdoutBytes = 0
  const chunks: Buffer[] = []
  let failure: Error | undefined
  // 独立进程组也包含 CLI 启动中的 daemon/helper，避免取消发生在 socket 建立前留下孤儿进程。
  const child = spawn(command.executable, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'ignore'], shell: false, detached: true })
  const fail = (error: Error) => {
    failure ??= error
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch { child.kill('SIGKILL') }
  }
  const abort = () => fail(componentError('CHROME_CANCELLED', 'Chrome 操作已取消'))
  const timer = setTimeout(() => fail(componentError('CHROME_ACTION_UNCERTAIN', 'Chrome 组件响应超时，动作结果无法确认')), command.timeoutMs)
  command.signal?.addEventListener('abort', abort, { once: true })
  const cleanup = () => { clearTimeout(timer); command.signal?.removeEventListener('abort', abort) }
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > command.maxOutputBytes) fail(helperFailure())
    else chunks.push(chunk)
  })
  child.once('error', () => { cleanup(); reject(helperFailure()) })
  child.once('close', exitCode => {
    cleanup()
    if (failure) reject(failure)
    else resolveResult({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode })
  })
})

/** 文件先校验实际路径，再以 O_NOFOLLOW 打开并比对 inode，读取量始终有界。 */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > limit) throw helperFailure()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw helperFailure()
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length === 0 || length > limit) throw helperFailure()
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

export async function readComponentImage(runtime: ComponentRuntime, imagePath: unknown, width: number, height: number): Promise<string> {
  try {
    if (typeof imagePath !== 'string' || !isAbsolute(imagePath) || !isWithin(runtime.framesDirectory, imagePath)) throw helperFailure()
    // 原生帧必须直接属于自建 frames 目录；不接受子目录及路径规范化别名。
    if (dirname(imagePath) !== runtime.framesDirectory || resolve(imagePath) !== imagePath) throw helperFailure()
    for (const dir of [runtime.directory, runtime.framesDirectory]) {
      const metadata = await lstat(dir)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077 || await realpath(dir) !== dir) throw helperFailure()
    }
    if (await realpath(imagePath) !== imagePath) throw helperFailure()
    const bytes = await readBoundedFile(imagePath, MAX_COMPONENT_IMAGE_BYTES)
    const dimensions = jpegDimensions(bytes)
    if (dimensions.width !== width || dimensions.height !== height) throw helperFailure()
    return bytes.toString('base64')
  } catch { throw componentError('CHROME_CAPTURE_FAILED', 'Chrome 原生帧文件或 JPEG 元数据无效') }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw helperFailure()
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw helperFailure()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]!
    if (marker === 0xda || marker === 0xd9) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) throw helperFailure()
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw helperFailure()
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  throw helperFailure()
}
