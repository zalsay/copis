import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 补丁执行后用真实 Node 校验每个 Web 客户端入口，避免语法错误直到 Electron 启动才暴露。 */
export function validateDshClientRuntime(
  runtimeRoot: string,
  nodePath = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(),
): number {
  const scope = join(runtimeRoot, 'node_modules', '@deepseek-ai')
  let checked = 0
  for (const name of readdirSync(scope).sort()) {
    const entrypoint = join(scope, name, 'lib', 'client.js')
    if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) continue
    try {
      execFileSync(nodePath, ['--check', entrypoint], { stdio: 'pipe' })
      checked += 1
    } catch (cause) {
      throw new Error(`DSH 客户端脚本语法校验失败: ${name}`, { cause })
    }
  }
  return checked
}
