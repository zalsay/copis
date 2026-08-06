#!/usr/bin/env bun
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

export const MANIFEST_URL_DEFINE = '__COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__'

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
  return {
    [MANIFEST_URL_DEFINE]: JSON.stringify(env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL?.trim() ?? ''),
  }
}

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')

if (import.meta.main) {
  const buildEnvironment = loadBuildEnvironment(join(repoRoot, '.env'), process.env)
  await build({
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
  })
}
