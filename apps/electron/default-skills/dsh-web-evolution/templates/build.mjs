#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))
const id = pkg.name

mkdirSync(join(__dirname, 'lib'), { recursive: true })

// 1. 使用 Bun.build 将 src/client.tsx 打包为 CJS
const result = await Bun.build({
  entrypoints: [join(__dirname, 'src/client.tsx')],
  target: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  minify: false,
})

if (!result.success) {
  console.error('构建失败:', result.logs)
  process.exit(1)
}

const bundledCode = await result.outputs[0].text()

// 2. 包装为 DSH ClientModuleSystem 兼容的 ModuleLoader factory 协议
const outputCode = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundledCode}
    return module.exports;
  }
});\n`

writeFileSync(join(__dirname, 'lib/client.js'), outputCode, 'utf8')
console.log(`[build] 成功构建 DSH 客户端插件: ${id} -> lib/client.js`)
