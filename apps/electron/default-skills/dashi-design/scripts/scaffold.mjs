#!/usr/bin/env node
/**
 * scaffold.mjs — 设计大师项目/组件脚手架生成器
 *
 * 用法：
 *   node scaffold.mjs --template prototype --output ./my-prototype.dc.html
 *   node scaffold.mjs --template slides --output ./pitch.dc.html --title "产品路演"
 *   node scaffold.mjs --template doc --output ./resume.dc.html
 */
import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(SCRIPT_DIR, '../runtime')

function parseArgs(args) {
  const result = { template: 'prototype', output: 'design.dc.html', title: '设计作品', copyRuntime: true }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--template' || args[i] === '-t') result.template = args[++i]
    else if (args[i] === '--output' || args[i] === '-o') result.output = args[++i]
    else if (args[i] === '--title') result.title = args[++i]
    else if (args[i] === '--no-copy-runtime') result.copyRuntime = false
  }
  return result
}

const TEMPLATES = {
  prototype: (title) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    *{ box-sizing:border-box }
    html,body{ margin:0; height:100%; background:#f3f2ee }
  </style>
</helmet>

<div style="min-height:100%; display:flex; align-items:center; justify-content:center; padding:32px 0">
  <x-import component-from-global-scope="IOSDevice" from="./ios-frame.jsx"
            title="${title}" dark="{{ false }}" hint-size="402px,874px">
    <div style="height:100%; display:flex; flex-direction:column; background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
      <div style="padding:16px 20px; border-bottom:1px solid #f0ede6">
        <h1 style="margin:0; font-size:22px; font-weight:700; color:#18181b">${title}</h1>
        <p style="margin:4px 0 0; font-size:13px; color:#71717a">精选方案与功能流转</p>
      </div>

      <div style="flex:1; overflow-y:auto; padding:16px 20px">
        <sc-for list="{{ items }}" as="item" hint-placeholder-count="3">
          <div style="padding:16px; margin-bottom:12px; border:1px solid #e4e4e7; border-radius:12px; background:#fafafa; transition:all 0.2s ease"
               style-hover="border-color:#18181b; transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,0.05)">
            <div style="font-size:16px; font-weight:600; color:#18181b">{{ item.title }}</div>
            <div style="font-size:13px; color:#52525b; margin-top:4px; line-height:1.5">{{ item.desc }}</div>
            <button onClick="{{ item.onSelect }}"
                    style="margin-top:12px; padding:8px 14px; border:0; border-radius:8px; background:#18181b; color:#fff; font-size:13px; font-weight:500; cursor:pointer">
              立即体验
            </button>
          </div>
        </sc-for>
      </div>
    </div>
  </x-import>
</div>
</x-dc>

<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#18181b","tsType":"string"}}'>
class Component extends DCLogic {
  state = { selectedId: null }
  renderVals() {
    const accent = this.props.accent ?? '#18181b'
    const items = [
      { id: '1', title: '智能任务洞察', desc: '根据上下文自动拆解执行拓扑，提供清晰链路。', onSelect: () => this.setState({ selectedId: '1' }) },
      { id: '2', title: '全景交互看板', desc: '即时反馈设计参数变更，多维联动一目了然。', onSelect: () => this.setState({ selectedId: '2' }) },
      { id: '3', title: '端到端离线打包', desc: '无任何外部网络依赖，单文件自给自足。', onSelect: () => this.setState({ selectedId: '3' }) }
    ]
    return { items, accent }
  }
}
</script>
</body>
</html>
`,

  slides: (title) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    *{ box-sizing:border-box; }
    html,body{ margin:0; height:100%; background:#09090b; }
    :root{
      --type-title:64px; --type-subtitle:40px; --type-body:28px; --type-small:22px;
      --pad-x:96px; --pad-y:80px;
    }
  </style>
</helmet>

<x-import component-from-global-scope="deck-stage" from="./deck-stage.js"
          width="1920" height="1080" hint-size="100%,100%">

  <section data-label="Title" data-speaker-notes="开场介绍：阐述核心背景与愿景"
           style="background:radial-gradient(ellipse at 80% 20%, #1e1e24 0%, #09090b 70%); color:#fafafa; padding:var(--pad-y) var(--pad-x); display:flex; flex-direction:column; justify-content:center">
    <div style="font-size:var(--type-small); font-weight:600; text-transform:uppercase; letter-spacing:3px; color:#a1a1aa; margin-bottom:24px">Product Deck</div>
    <h1 style="margin:0 0 24px; font-size:var(--type-title); font-weight:700; line-height:1.1; letter-spacing:-1px">${title}</h1>
    <p style="margin:0; font-size:var(--type-subtitle); color:#a1a1aa; max-width:1100px; line-height:1.4">
      用 HTML 当画笔的高保真交互设计系统，拒绝平庸模板，赋能极致产品体验。
    </p>
  </section>

  <section data-label="Vision" data-speaker-notes="第二页：展开核心三大优势"
           style="background:#09090b; color:#fafafa; padding:var(--pad-y) var(--pad-x); display:flex; flex-direction:column; justify-content:center">
    <h2 style="margin:0 0 48px; font-size:var(--type-subtitle); font-weight:700; color:#fafafa">核心价值主张</h2>
    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:32px">
      <div style="padding:36px; border:1px solid #27272a; border-radius:16px; background:#141417">
        <div style="font-size:var(--type-small); font-weight:600; color:#38bdf8; margin-bottom:12px">01 · 零网络依赖</div>
        <div style="font-size:24px; color:#d4d4d8; line-height:1.5">纯本地离线运行时，双击即可无缝展示与演示。</div>
      </div>
      <div style="padding:36px; border:1px solid #27272a; border-radius:16px; background:#141417">
        <div style="font-size:var(--type-small); font-weight:600; color:#4ade80; margin-bottom:12px">02 · 动态可微调</div>
        <div style="font-size:24px; color:#d4d4d8; line-height:1.5">自带参数面板，一键调节配色、排版密度与布局模式。</div>
      </div>
      <div style="padding:36px; border:1px solid #27272a; border-radius:16px; background:#141417">
        <div style="font-size:var(--type-small); font-weight:600; color:#f43f5e; margin-bottom:12px">03 · 工程师交接包</div>
        <div style="font-size:24px; color:#d4d4d8; line-height:1.5">一键导出 tokens.json 与标准规范，无缝交付工程实现。</div>
      </div>
    </div>
  </section>

</x-import>
</x-dc>

<script type="text/x-dc" data-dc-script data-props='{}'>
class Component extends DCLogic {
  renderVals() { return {} }
}
</script>
</body>
</html>
`,

  doc: (title) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    *{ box-sizing:border-box }
    html,body{ margin:0; height:100%; background:#e4e2dd }
  </style>
</helmet>

<x-import component-from-global-scope="doc-page" from="./doc-page.js"
          paper="A4" padding="28mm 24mm">
  <div style="font-family:'Charter','Georgia',serif; color:#1a1a1a; line-height:1.6">
    <div style="border-bottom:2px solid #1a1a1a; padding-bottom:16px; margin-bottom:24px; display:flex; justify-content:space-between; align-items:baseline">
      <h1 style="margin:0; font-size:28pt; font-weight:700; letter-spacing:-0.5px">${title}</h1>
      <div style="font-family:sans-serif; font-size:9pt; color:#666; text-transform:uppercase; letter-spacing:1px">设计规范与报告</div>
    </div>

    <p style="font-size:11pt; color:#333; margin-bottom:20pt; line-height:1.7">
      本文档由设计大师自动化构建，遵循专业排版流与分页几何标准。所有段落与间距均经过严密排版校准，支持打印与一键导出高保真 PDF。
    </p>

    <h2 style="font-family:sans-serif; font-size:13pt; font-weight:600; color:#1a1a1a; border-bottom:1px solid #ddd; padding-bottom:4pt; margin:18pt 0 10pt">
      一、核心设计原则
    </h2>
    <ul style="font-size:10.5pt; color:#444; padding-left:18pt; margin:0 0 16pt">
      <li style="margin-bottom:6pt"><strong>上下文优先</strong>：所有品牌调性与数据均从真实业务源中提取，杜绝凭空臆造。</li>
      <li style="margin-bottom:6pt"><strong>严谨字阶</strong>：标题、副标与正文字号呈几何级递进，层级一目了然。</li>
      <li style="margin-bottom:6pt"><strong>自适应分页</strong>：基于 doc-page 标准分页容器，避免任何跨页断行灾难。</li>
    </ul>
  </div>
</x-import>
</x-dc>

<script type="text/x-dc" data-dc-script data-props='{}'>
class Component extends DCLogic {
  renderVals() { return {} }
}
</script>
</body>
</html>
`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const templateFn = TEMPLATES[args.template] || TEMPLATES.prototype
  const content = templateFn(args.title)
  const targetFile = resolve(process.cwd(), args.output)
  const targetDir = dirname(targetFile)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  writeFileSync(targetFile, content, 'utf8')
  console.log(`[dashi-design] 已创建设计文件: ${targetFile}`)

  if (args.copyRuntime) {
    const runtimeTargetDir = join(targetDir, 'runtime')
    const vendorTargetDir = join(runtimeTargetDir, 'vendor')
    mkdirSync(vendorTargetDir, { recursive: true })

    const filesToCopy = [
      'support.js',
      'deck-stage.js',
      'doc-page.js',
      'image-slot.js',
      'ios-frame.compiled.js',
      'android-frame.compiled.js',
      'animations.compiled.js',
      'three-d-stage.js'
    ]

    for (const file of filesToCopy) {
      const src = join(RUNTIME_DIR, file)
      if (existsSync(src)) {
        copyFileSync(src, join(targetDir, file))
        copyFileSync(src, join(runtimeTargetDir, file))
      }
    }

    for (const v of ['react.production.min.js', 'react-dom.production.min.js']) {
      const vSrc = join(RUNTIME_DIR, 'vendor', v)
      if (existsSync(vSrc)) {
        copyFileSync(vSrc, join(vendorTargetDir, v))
        const directVendor = join(targetDir, 'vendor')
        mkdirSync(directVendor, { recursive: true })
        copyFileSync(vSrc, join(directVendor, v))
      }
    }
    console.log(`[dashi-design] 已就地同步运行时与组件库到: ${targetDir}`)
  }
}

main()
