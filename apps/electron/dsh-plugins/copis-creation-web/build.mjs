#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const pluginId = packageJson.name

mkdirSync(join(pluginDir, 'lib'), { recursive: true })

const result = await Bun.build({
  entrypoints: [join(pluginDir, 'src', 'client.tsx')],
  target: 'browser',
  format: 'cjs',
  jsx: {
    runtime: 'automatic',
    importSource: 'react',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  minify: false,
})

if (!result.success) {
  console.error('Copis Creation Web 客户端插件构建失败:', result.logs)
  process.exit(1)
}

const bundledCode = await result.outputs[0].text()
const outputCode = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${bundledCode}
    exports.apply = typeof apply !== "undefined" ? apply : undefined;
    exports.inject = typeof inject !== "undefined" ? inject : undefined;
    exports.default = { apply: exports.apply, inject: exports.inject };
    return module.exports;
  }
});\n`

writeFileSync(join(pluginDir, 'lib', 'client.js'), outputCode, 'utf8')
console.log(`[build] Copis Creation Web 客户端插件已构建: ${pluginId}`)
