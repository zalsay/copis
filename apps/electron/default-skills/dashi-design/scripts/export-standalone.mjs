#!/usr/bin/env node
/**
 * export-standalone.mjs — 将 .dc.html 打包为 100% 离线自给自足的单文件 HTML
 *
 * 用法：
 *   node export-standalone.mjs --input ./design.dc.html --output ./dist/standalone.html
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(SCRIPT_DIR, '../runtime')

function parseArgs(args) {
  const result = { input: '', output: '' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') result.input = args[++i]
    else if (args[i] === '--output' || args[i] === '-o') result.output = args[++i]
  }
  if (!result.input && args[0] && !args[0].startsWith('-')) {
    result.input = args[0]
    if (args[1] && !args[1].startsWith('-')) result.output = args[1]
  }
  return result
}

function escapeScriptClosing(content) {
  return content.replace(/<\/script/gi, '<\\/script')
}

function assembleStandalone(inputPath) {
  const content = readFileSync(inputPath, 'utf8')
  const baseDir = dirname(inputPath)

  // 1. 读取基础运行时
  const reactUmd = readFileSync(join(RUNTIME_DIR, 'vendor/react.production.min.js'), 'utf8')
  const reactDomUmd = readFileSync(join(RUNTIME_DIR, 'vendor/react-dom.production.min.js'), 'utf8')
  const supportJs = readFileSync(join(RUNTIME_DIR, 'support.js'), 'utf8')

  // 2. 检测引用的预制件
  const importedFiles = new Set()
  const importRegex = /from=["'](\.[^"']+)["']/g
  let match
  while ((match = importRegex.exec(content)) !== null) {
    const relPath = match[1]
    const filename = basename(relPath)
    importedFiles.add(filename)
  }

  // 映射 JSX 到 compiled.js
  const resolvedSiblings = []
  for (const f of importedFiles) {
    let target = f
    if (f.endsWith('.jsx')) {
      target = f.replace(/\.jsx$/, '.compiled.js')
    }
    // 优先从 inputPath 所在目录找，其次从 runtime 目录找
    const localCandidate = join(baseDir, target)
    const runtimeCandidate = join(RUNTIME_DIR, target)
    if (existsSync(localCandidate)) {
      resolvedSiblings.push(readFileSync(localCandidate, 'utf8'))
    } else if (existsSync(runtimeCandidate)) {
      resolvedSiblings.push(readFileSync(runtimeCandidate, 'utf8'))
    }
  }

  // 3. 移除外链 support.js
  let cleanHtml = content.replace(
    /<script[^>]*src=["'][^"']*support\.js["'][^>]*>\s*<\/script>/gi,
    ''
  )

  // 4. 组装内联脚本列表：React -> ReactDOM -> 预制件 -> support.js
  const inlinedScripts = [
    reactUmd,
    reactDomUmd,
    ...resolvedSiblings,
    supportJs
  ]

  const scriptTags = inlinedScripts
    .map((s) => `<script>${escapeScriptClosing(s)}</script>`)
    .join('\n')

  // 5. 注入到 </body> 之前（保证 x-dc 已解析并在 DOM 中）
  let finalHtml
  if (/<\/body>/i.test(cleanHtml)) {
    finalHtml = cleanHtml.replace(/<\/body>/i, `\n${scriptTags}\n</body>`)
  } else {
    finalHtml = cleanHtml + `\n${scriptTags}\n`
  }

  return finalHtml
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) {
    console.error('用法: node export-standalone.mjs --input <file.dc.html> [--output <out.html>]')
    process.exit(1)
  }

  const inputFile = resolve(process.cwd(), args.input)
  if (!existsSync(inputFile)) {
    console.error(`[dashi-design] 输入文件不存在: ${inputFile}`)
    process.exit(1)
  }

  const outputFile = resolve(
    process.cwd(),
    args.output || args.input.replace(/\.dc\.html?$/i, '.standalone.html')
  )

  const outputDir = dirname(outputFile)
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  const standaloneHtml = assembleStandalone(inputFile)
  writeFileSync(outputFile, standaloneHtml, 'utf8')
  console.log(`[dashi-design] 离线自足 HTML 导出完成: ${outputFile} (${Math.round(standaloneHtml.length / 1024)} KB)`)
}

main()
