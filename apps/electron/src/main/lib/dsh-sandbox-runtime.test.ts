import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const runtimeRoot = process.env.COPIS_DSH_TEST_RUNTIME_ROOT

// 验证指定的官方运行时，不注入补丁；实际 Host 的 Bash 验收另通过已启动服务执行。
test.skipIf(!runtimeRoot)('Given 官方 DSH 运行时 When 检查包与权限处理 Then 包含同级幂等及空白理由修复且不存在自定义裁剪', () => {
  const root = join(runtimeRoot!, 'node_modules/@deepseek-ai')
  for (const name of ['dsh', 'dsh-tool-bash', 'dsh-sandbox']) {
    expect(JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')).version).toBe('0.2.2-alpha.2')
  }
  const bash = readFileSync(join(root, 'dsh-tool-bash/lib/index.js'), 'utf8')
  const sandbox = readFileSync(join(root, 'dsh-sandbox/lib/index.js'), 'utf8')
  const policy = readFileSync(join(root, 'dsh-sandbox-policy/lib/index.js'), 'utf8')
  expect(bash).toContain('args.sandbox_permissions === effectiveMode')
  expect(bash).toContain('validateBashArgs(args, standingPolicy?.mode)')
  expect(sandbox).toContain('if (mode === effectiveMode) return effectiveMode')
  expect(policy).not.toContain('Copis：仅在当前请求中裁剪')
  expect(bash).not.toContain('Follow the current session policy in sandbox:policy')
})


// subprocess-local 使用 Node 24 API；必须在随模块提供的 Node 中验证，不能给 Bun 打兼容补丁。
const nodePath = process.env.COPIS_DSH_TEST_NODE

test.skipIf(!runtimeRoot || !nodePath)('Given 官方完整 Bash 链路和最高权限且无审批服务 When 同级权限携带空白理由 Then 真实命令执行成功并无需审批', () => {
  const output = execFileSync(nodePath!, [join(import.meta.dir, 'test-fixtures/dsh-official-bash-check.mjs'), runtimeRoot!], { encoding: 'utf8', timeout: 30000 })
  expect(JSON.parse(output)).toEqual({ bashCalls: 3, exitCodes: [0, 0, 0], approvalServiceAbsent: true })
})
