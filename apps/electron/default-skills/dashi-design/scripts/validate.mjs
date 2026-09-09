#!/usr/bin/env node
/**
 * validate.mjs — 设计大师产物自检与语法/规范静态校验工具
 *
 * 用法：
 *   node validate.mjs --input ./design.dc.html
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function parseArgs(args) {
  const result = { input: '' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') result.input = args[++i]
  }
  if (!result.input && args[0] && !args[0].startsWith('-')) {
    result.input = args[0]
  }
  return result
}

function validateDcHtml(content) {
  const errors = []
  const warnings = []
  const passes = []

  // 1. 检查根标签
  if (!/<x-dc[\s>]/i.test(content)) {
    errors.push('缺少 <x-dc> 根元素。Design Component 必须包裹在 <x-dc>...</x-dc> 内。')
  } else {
    passes.push('通过: 包含 <x-dc> 根元素')
  }

  // 2. 检查 helmet
  if (!/<helmet[\s>]/i.test(content)) {
    warnings.push('建议包含 <helmet> 块声明基础样式重置和 :root CSS 变量。')
  } else {
    passes.push('通过: 包含 <helmet> 样式隔离块')
  }

  // 3. 检查 support.js 引用
  if (!/src=["'][^"']*support\.js["']/i.test(content) && !/<script>.*__dc.*<\/script>/is.test(content)) {
    warnings.push('未检测到 ./support.js 运行时引用或内联脚本。离线打开可能无法渲染。')
  } else {
    passes.push('通过: 包含运行时引擎驱动')
  }

  // 4. 检查 data-props 语法
  const propsMatch = content.match(/data-props=(['"])(.*?)\1/s)
  if (propsMatch) {
    let raw = propsMatch[2]
    // 处理 &quot; 转义
    raw = raw.replace(/&quot;/g, '"')
    try {
      JSON.parse(raw)
      passes.push('通过: data-props 参数声明是合法 JSON')
    } catch (e) {
      errors.push(`data-props 不是合法的 JSON 格式: ${e.message}`)
    }
  }

  // 5. 反 AI 模板味模式检查
  const antiSlopPatterns = [
    { pattern: /linear-gradient\([^)]*(?:#ff0080|#7928ca|#ff4b4b|#ff007f)/i, msg: '发现高饱和粉紫渐变，建议改用低饱和单色+精致 accent。' },
    { pattern: /backdrop-filter:\s*blur\(1[0-9]px\)/i, msg: '发现重度玻璃态 (glassmorphism)，建议使用微妙阴影或硬边几何卡片。' },
    { pattern: /border-radius:\s*(?:9999px|50px)/i, msg: '发现超大药丸 (pill) 按钮，常规卡片与按钮建议使用 6px~12px 圆角。' }
  ]

  for (const { pattern, msg } of antiSlopPatterns) {
    if (pattern.test(content)) {
      warnings.push(`审美提醒: ${msg}`)
    }
  }

  // 6. 幻灯片字号下限检查
  if (/component-from-global-scope=["']deck-stage["']/i.test(content)) {
    if (/font-size:\s*(?:1[0-8]|20)px/i.test(content)) {
      warnings.push('幻灯片文字底线：deck 模式下文字建议 >= 24px（标题 48~96px 起步），避免远距离无法看清。')
    }
  }

  return { errors, warnings, passes }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) {
    console.error('用法: node validate.mjs --input <file.dc.html>')
    process.exit(1)
  }

  const inputFile = resolve(process.cwd(), args.input)
  if (!existsSync(inputFile)) {
    console.error(`[dashi-design] 校验文件不存在: ${inputFile}`)
    process.exit(1)
  }

  const content = readFileSync(inputFile, 'utf8')
  const { errors, warnings, passes } = validateDcHtml(content)

  console.log(`\n=== 设计大师校验报告: ${inputFile} ===`)
  for (const p of passes) console.log(`  ✓ ${p}`)
  for (const w of warnings) console.warn(`  ⚠ ${w}`)
  for (const e of errors) console.error(`  ✗ ${e}`)

  if (errors.length > 0) {
    console.error(`\n校验失败: 发现 ${errors.length} 处错误，${warnings.length} 处警告。`)
    process.exit(1)
  } else {
    console.log(`\n校验通过！(${warnings.length} 处建议)`)
    process.exit(0)
  }
}

main()
