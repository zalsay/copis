import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 仅加载指定的官方运行时，在独立临时目录中执行 printf，不读取用户会话或 Profile。
const require = createRequire(join(process.argv[2], 'package.json'))
const { Context } = require('@deepseek-ai/cordis')
const ctx = new Context()
const dir = mkdtempSync(join(tmpdir(), 'copis-official-bash-'))
try {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-agent', 'dsh-tools', 'dsh-subprocess-local', 'dsh-fs-local']) {
    const plugin = require(`@deepseek-ai/${name}`)
    await ctx.plugin(plugin.default ?? plugin)
  }
  for (const [name, config] of [
    ['dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: dir }],
    ['dsh-sandbox-local', {}],
    ['dsh-bash-sandbox', {}],
    ['dsh-shell-env', { dshHome: dir }],
    ['dsh-working-directory', { defaultDirectory: dir }],
    ['dsh-tool-bash', { enableRunInBackground: false }],
  ]) {
    const plugin = require(`@deepseek-ai/${name}`)
    await ctx.plugin(plugin.default ?? plugin, config)
  }
  assert.equal(ctx.get('approval'), undefined)
  const tool = ctx.tools.get('bash')
  assert.ok(tool)
  const exitCodes = []
  for (const permissionArgs of [{ sandbox_permissions: 'danger-full-access', justification: ' ' }, { justification: ' ' }, {}]) {
    const value = await tool.execute({ command: 'printf "COPIS_OFFICIAL_ALPHA_BASH_OK\\n"', description: '只读验证官方 Bash', timeoutMs: 10000, workdir: dir, run_in_background: false, ...permissionArgs }, { signal: new AbortController().signal, callId: 'copis-official-bash-test', deferContext() {} })
    assert.equal(value.kind, 'foreground')
    assert.equal(value.exitCode, 0)
    assert.ok(JSON.stringify(value).includes('COPIS_OFFICIAL_ALPHA_BASH_OK'))
    exitCodes.push(value.exitCode)
  }
  console.log(JSON.stringify({ bashCalls: exitCodes.length, exitCodes, approvalServiceAbsent: true }))
} finally {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
