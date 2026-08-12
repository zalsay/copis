#!/usr/bin/env bun
import { build, context, type BuildOptions } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

export const MANIFEST_URL_DEFINE = '__COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__'
export const DEFAULT_FUNCTIONAL_MODULE_MANIFEST_URL = 'https://download.meetlife.com.cn/copis/client/stable/manifest.json'
export const UPDATER_URL_DEFINE = '__COPIS_UPDATER_URL__'
export const DEFAULT_UPDATER_URL = 'https://download.meetlife.com.cn/copis/updates/stable'

export function loadBuildEnvironment(
  envFilePath: string,
  runtimeEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const fileEnv = existsSync(envFilePath)
    ? parseEnv(readFileSync(envFilePath, 'utf8'))
    : {}
  return { ...fileEnv, ...runtimeEnv }
}

export function resolveManifestBuildConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const configuredUrl = env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL?.trim()
    || DEFAULT_FUNCTIONAL_MODULE_MANIFEST_URL
  const updaterUrl = env.COPIS_UPDATER_URL?.trim() || DEFAULT_UPDATER_URL
  return {
    [MANIFEST_URL_DEFINE]: JSON.stringify(configuredUrl),
    [UPDATER_URL_DEFINE]: JSON.stringify(updaterUrl),
  }
}

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')

if (import.meta.main) {
  const buildEnvironment = loadBuildEnvironment(join(repoRoot, '.env'), process.env)
  const options: BuildOptions = {
    entryPoints: [join(appDir, 'src/main/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(appDir, 'dist/main.cjs'),
    external: [
      'electron',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
    ],
    define: resolveManifestBuildConfig(buildEnvironment),
  }
  if (process.argv.includes('--watch')) {
    const buildContext = await context(options)
    await buildContext.watch()
    console.log('[build:main] 正在监听主进程文件变更')
  } else {
    await build(options)
  }
}
