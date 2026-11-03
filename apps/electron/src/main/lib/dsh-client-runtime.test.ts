import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDshClientRuntime } from './dsh-client-runtime-validation'

const runtimeRoot = process.env.COPIS_DSH_TEST_RUNTIME_ROOT
const nodePath = process.env.COPIS_DSH_TEST_NODE

test.skipIf(!nodePath)('Given 任意客户端 bundle 存在括号语法错误 When 准备 DSH 模块 Then 构建必须在产出前明确拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'copis-dsh-invalid-client-'))
  try {
    const lib = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-directory-picker-native/lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'client.js'), 'function apply(ctx) { ctx.run(() => ctx.other();); }')
    expect(() => validateDshClientRuntime(root, nodePath)).toThrow('DSH 客户端脚本语法校验失败')
    writeFileSync(join(lib, 'client.js'), 'function apply(ctx) { ctx.run(() => ctx.other()); }')
    expect(validateDshClientRuntime(root, nodePath)).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!runtimeRoot || !nodePath)('Given 已组装的真实官方运行时 When 校验全部客户端入口 Then 所有 bundle 均可由实际 Node 解析', () => {
  expect(validateDshClientRuntime(runtimeRoot!, nodePath)).toBeGreaterThan(0)
})
