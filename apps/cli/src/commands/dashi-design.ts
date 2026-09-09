/**
 * copis dashi-design — 设计大师（Claude Design）生成、导出、校验与预览受限命令入口。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { register } from '../registry'
import { errorLine, EXIT_ERROR, EXIT_OK, EXIT_USAGE, info } from '../output'

export const ALLOWED_DASHI_DESIGN_SUBCOMMANDS = [
  'version',
  'scaffold',
  'export',
  'validate',
  'preview',
  'check-latest-version',
] as const

export type DashiDesignSubcommand = (typeof ALLOWED_DASHI_DESIGN_SUBCOMMANDS)[number]

function findDashiDesignSkillRoot(): string | undefined {
  if (process.env.COPIS_DASHI_DESIGN_ROOT && existsSync(process.env.COPIS_DASHI_DESIGN_ROOT)) {
    return process.env.COPIS_DASHI_DESIGN_ROOT
  }

  const candidates = [
    resolve(__dirname, '../../../electron/default-skills/dashi-design'),
    resolve(__dirname, '../../electron/default-skills/dashi-design'),
    resolve(process.cwd(), 'apps/electron/default-skills/dashi-design'),
    resolve(process.cwd(), '.agents/skills/dashi-design'),
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

register({
  name: 'dashi-design',
  summary: '设计大师（Claude Design）组件脚手架、导出、校验与预览',
  usage: 'dashi-design <subcommand> [args...]',
  run: (ctx) => {
    const raw = ctx.rawArgs ?? ctx.args.positionals
    const subcommand = raw[0]

    if (!subcommand) {
      errorLine('缺少设计大师子命令')
      info(`支持的子命令: ${ALLOWED_DASHI_DESIGN_SUBCOMMANDS.join(', ')}`)
      return EXIT_USAGE
    }

    if (!ALLOWED_DASHI_DESIGN_SUBCOMMANDS.includes(subcommand as DashiDesignSubcommand)) {
      errorLine(`未知设计大师子命令: ${subcommand}`)
      info(`支持的子命令: ${ALLOWED_DASHI_DESIGN_SUBCOMMANDS.join(', ')}`)
      return EXIT_USAGE
    }

    if (subcommand === 'version') {
      info('dashi-design v1.0.0 (Claude Design Engine)')
      return EXIT_OK
    }

    if (subcommand === 'check-latest-version') {
      // 保持静默检查
      return EXIT_OK
    }

    const skillRoot = findDashiDesignSkillRoot()
    if (!skillRoot) {
      errorLine('未找到设计大师（dashi-design）技能目录，请确保已正确安装并激活设计大师 Skill')
      return EXIT_ERROR
    }

    const nodeExecutable = findNodeExecutable()
    let scriptRelative: string

    switch (subcommand) {
      case 'scaffold':
        scriptRelative = 'scripts/scaffold.mjs'
        break
      case 'export':
        scriptRelative = 'scripts/export-standalone.mjs'
        break
      case 'validate':
        scriptRelative = 'scripts/validate.mjs'
        break
      case 'preview':
        scriptRelative = 'scripts/preview.mjs'
        break
      default:
        errorLine(`未实现的设计大师子命令: ${subcommand}`)
        return EXIT_ERROR
    }

    const scriptPath = join(skillRoot, scriptRelative)
    if (!existsSync(scriptPath)) {
      errorLine(`目标脚本不存在: ${scriptPath}`)
      return EXIT_ERROR
    }

    // 过滤掉子命令本身，保留后续的所有参数
    const childArgs = [scriptPath, ...raw.slice(1)]

    const result = spawnSync(nodeExecutable, childArgs, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        DASHI_DESIGN_SKILL_ROOT: skillRoot,
      },
    })

    if (result.error) {
      errorLine(`执行设计大师子命令失败: ${result.error.message}`)
      return EXIT_ERROR
    }

    return result.status ?? EXIT_ERROR
  },
})
