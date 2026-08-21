/**
 * copis dashi-ppt — Dashi PPT 幻灯片生成、校验与导出受限命令入口。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { register } from '../registry'
import { errorLine, EXIT_ERROR, EXIT_OK, EXIT_USAGE, info, UsageError } from '../output'

export const ALLOWED_DASHI_SUBCOMMANDS = [
  'version',
  'layout:query',
  'inspect:layout',
  'props:safe',
  'goal:scaffold',
  'media:stage',
  'render',
  'validate:goal-spec',
  'validate:swiss',
  'validate:goal-copy',
  'validate:four-variant-quality',
  'preview',
  'export:pptx',
  'export:pdf',
  'check-latest-version',
] as const

export type DashiSubcommand = (typeof ALLOWED_DASHI_SUBCOMMANDS)[number]

function findDashiProjectRoot(): string | undefined {
  if (process.env.COPIS_DASHI_PPT_PROJECT_ROOT && existsSync(process.env.COPIS_DASHI_PPT_PROJECT_ROOT)) {
    return process.env.COPIS_DASHI_PPT_PROJECT_ROOT
  }
  if (process.env.COPIS_DASHI_PPT_ROOT) {
    const candidate = join(process.env.COPIS_DASHI_PPT_ROOT, 'project')
    if (existsSync(candidate)) return candidate
  }

  const candidates = [
    resolve(__dirname, '../../../electron/default-skills/dashi-ppt/project'),
    resolve(__dirname, '../../electron/default-skills/dashi-ppt/project'),
    resolve(process.cwd(), 'apps/electron/default-skills/dashi-ppt/project'),
    resolve(process.cwd(), '.agents/skills/dashi-ppt/project'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

function findNodeExecutable(): string {
  if (process.env.COPIS_NODE_EXECUTABLE && existsSync(process.env.COPIS_NODE_EXECUTABLE)) {
    return process.env.COPIS_NODE_EXECUTABLE
  }
  if (process.env.COPIS_RUNTIME_ROOT) {
    const candidate = join(process.env.COPIS_RUNTIME_ROOT, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

function findSharedNodeModulesRoot(): string | undefined {
  if (process.env.COPIS_NODE_MODULES_ROOT && existsSync(process.env.COPIS_NODE_MODULES_ROOT)) {
    return process.env.COPIS_NODE_MODULES_ROOT
  }

  const candidates = [
    resolve(__dirname, '../../../../node_modules'),
    resolve(__dirname, '../../../node_modules'),
    resolve(__dirname, '../../node_modules'),
    resolve(process.cwd(), 'node_modules'),
    resolve(process.cwd(), 'apps/electron/node_modules'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

register({
  name: 'dashi-ppt',
  summary: 'Dashi PPT 幻灯片生成、校验与导出',
  usage: 'dashi-ppt <subcommand> [args...]',
  run: (ctx) => {
    const raw = ctx.rawArgs ?? ctx.args.positionals
    const subcommand = raw[0]

    if (!subcommand) {
      errorLine('缺少 Dashi PPT 子命令')
      info(`支持的子命令: ${ALLOWED_DASHI_SUBCOMMANDS.join(', ')}`)
      return EXIT_USAGE
    }

    if (!ALLOWED_DASHI_SUBCOMMANDS.includes(subcommand as DashiSubcommand)) {
      errorLine(`未知 Dashi PPT 子命令: ${subcommand}`)
      info(`支持的子命令: ${ALLOWED_DASHI_SUBCOMMANDS.join(', ')}`)
      return EXIT_USAGE
    }

    if (subcommand === 'version') {
      info('dashi-ppt v0.4.11 (upstream 0.4.11)')
      return EXIT_OK
    }

    const projectRoot = findDashiProjectRoot()
    if (!projectRoot) {
      errorLine('未找到 Dashi PPT 项目根目录，请确保已正确安装并激活 Dashi PPT Skill')
      return EXIT_ERROR
    }

    const nodeExecutable = findNodeExecutable()
    const nodeModulesRoot = findSharedNodeModulesRoot()

    let scriptRelative: string
    const extraArgs: string[] = []

    switch (subcommand) {
      case 'layout:query':
        scriptRelative = 'scripts/layout-query.mjs'
        break
      case 'inspect:layout':
        scriptRelative = 'scripts/inspect-layout.mjs'
        break
      case 'props:safe':
        scriptRelative = 'scripts/write-safe-props.mjs'
        break
      case 'goal:scaffold':
        scriptRelative = 'scripts/goal-scaffold.mjs'
        break
      case 'media:stage':
        scriptRelative = 'scripts/stage-media.mjs'
        break
      case 'render':
        scriptRelative = 'scripts/render-goal-deck.jsx'
        break
      case 'validate:goal-spec':
        scriptRelative = 'scripts/validate-goal-spec.mjs'
        break
      case 'validate:swiss':
        scriptRelative = 'scripts/validate-swiss-deck.mjs'
        break
      case 'validate:goal-copy':
        scriptRelative = 'scripts/validate-goal-copy.mjs'
        break
      case 'validate:four-variant-quality':
        scriptRelative = 'scripts/validate-four-variant-quality.mjs'
        break
      case 'preview':
        scriptRelative = 'scripts/start-preview-server.mjs'
        break
      case 'export:pptx':
        scriptRelative = 'scripts/export-pptx.mjs'
        break
      case 'export:pdf':
        scriptRelative = 'scripts/export-pptx.mjs'
        extraArgs.push('--pdf')
        break
      case 'check-latest-version':
        scriptRelative = '../scripts/check_latest_version.mjs'
        break
      default:
        errorLine(`未处理的子命令: ${subcommand}`)
        return EXIT_USAGE
    }

    const scriptPath = join(projectRoot, scriptRelative)
    if (!existsSync(scriptPath)) {
      errorLine(`未找到脚本文件: ${scriptPath}`)
      return EXIT_ERROR
    }

    // 过滤并组装参数：去掉子命令本身和前置的 '--'
    const passedRawArgs = raw.slice(1)
    const normalizedArgs: string[] = []
    let skipDoubleDash = true
    for (const arg of passedRawArgs) {
      if (skipDoubleDash && arg === '--') {
        skipDoubleDash = false
        continue
      }
      skipDoubleDash = false
      normalizedArgs.push(arg)
    }

    // render 命令如果使用 --goal 和 --output，按顺序转换为目标参数
    let finalArgs: string[]
    if (subcommand === 'render') {
      const goalIndex = normalizedArgs.indexOf('--goal')
      const outputIndex = normalizedArgs.indexOf('--output')
      if (goalIndex >= 0 && outputIndex >= 0 && normalizedArgs[goalIndex + 1] && normalizedArgs[outputIndex + 1]) {
        finalArgs = [normalizedArgs[goalIndex + 1]!, normalizedArgs[outputIndex + 1]!]
      } else {
        finalArgs = normalizedArgs
      }
    } else {
      finalArgs = [...extraArgs, ...normalizedArgs]
    }

    const nodePath = nodeModulesRoot
      ? (process.env.NODE_PATH ? `${nodeModulesRoot}${delimiter}${process.env.NODE_PATH}` : nodeModulesRoot)
      : process.env.NODE_PATH

    const proc = spawnSync(nodeExecutable, [scriptPath, ...finalArgs], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(nodePath && { NODE_PATH: nodePath }),
        ...(nodeModulesRoot && { COPIS_NODE_MODULES_ROOT: nodeModulesRoot }),
        COPIS_DASHI_PPT_PROJECT_ROOT: projectRoot,
        INIT_CWD: process.cwd(),
      },
    })

    if (proc.error) {
      errorLine(`执行失败: ${proc.error.message}`)
      return EXIT_ERROR
    }

    return proc.status === null ? EXIT_ERROR : proc.status
  },
})
