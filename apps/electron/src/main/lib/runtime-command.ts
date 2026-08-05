import { execFile } from 'node:child_process'

export interface RuntimeCommandOptions {
  timeout?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

interface RuntimeCommandError extends Error {
  stderr?: string
}

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_MAX_BUFFER = 1024 * 1024

/** 异步执行环境检测命令，避免阻塞 Electron 主进程。 */
export function runRuntimeCommand(
  file: string,
  args: readonly string[],
  options: RuntimeCommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as RuntimeCommandError
          commandError.stderr = stderr
          reject(commandError)
          return
        }

        resolve(stdout)
      },
    )
  })
}

/** 执行需要保留原始字节的命令，例如 Windows 上的 wsl.exe 输出。 */
export function runRuntimeCommandBuffer(
  file: string,
  args: readonly string[],
  options: RuntimeCommandOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        encoding: 'buffer',
        env: options.env,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as RuntimeCommandError
          commandError.stderr = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
          reject(commandError)
          return
        }

        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
  })
}
