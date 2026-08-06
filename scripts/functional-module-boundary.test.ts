import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}
const electronPackage = JSON.parse(
  readFileSync(join(repoRoot, 'apps/electron/package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const electronBuilder = readFileSync(
  join(repoRoot, 'apps/electron/electron-builder.yml'),
  'utf8',
)
const buildScript = readFileSync(join(repoRoot, 'build.ps1'), 'utf8')
const buildShellScript = readFileSync(join(repoRoot, 'build.sh'), 'utf8')
const deployScript = readFileSync(join(repoRoot, 'deploy.ps1'), 'utf8')
const deployShellScript = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8')
const buildManifestScript = readFileSync(join(repoRoot, 'scripts/build-functional-module-manifest.ts'), 'utf8')

describe('功能模块发布边界', () => {
  test('Electron 只负责下载，COS 上传工具属于仓库级开发脚本', () => {
    expect(electronPackage.dependencies?.['cos-nodejs-sdk-v5']).toBeUndefined()
    expect(electronPackage.devDependencies?.['cos-nodejs-sdk-v5']).toBeUndefined()
    expect(electronPackage.scripts?.['publish:functional-modules']).toBeUndefined()
    expect(rootPackage.devDependencies?.['cos-nodejs-sdk-v5']).toBe('3.0.0')
    expect(rootPackage.scripts?.['publish:functional-modules']).toBeDefined()
    expect(existsSync(join(repoRoot, 'apps/electron/scripts/publish-functional-modules.ts'))).toBe(false)
    expect(existsSync(join(repoRoot, 'scripts/publish-functional-modules.ts'))).toBe(true)
    expect(electronBuilder).toContain('!node_modules/cos-nodejs-sdk-v5/**')
  })

  test('默认构建不编译 Rust 或执行 COS 发布', () => {
    expect(electronPackage.scripts?.build).not.toContain('build:http-api-server')
    expect(buildScript).not.toContain('build:http-api-server')
    expect(buildScript).not.toContain('publish:functional-modules')
    expect(buildShellScript).toContain('bun run build')
    expect(buildShellScript).not.toContain('build:http-api-server')
    expect(buildShellScript).not.toContain('publish:functional-modules')
    expect(deployScript).toContain('build:http-api-server')
    expect(deployScript).toContain('publish:functional-modules')
    expect(deployShellScript).toContain('build:http-api-server')
    expect(deployShellScript).toContain('publish:functional-modules')
    expect(deployShellScript).toContain('--build-app')
  })

  test('部署入口在读取发布配置前加载根目录 .env', () => {
    expect(deployShellScript).toContain('load_dotenv "$ROOT_DIR/.env"')
    expect(deployShellScript).toContain('if [[ -n "${!key+x}" ]]')
    expect(deployShellScript).toContain('PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-}"')
    expect(deployScript).toContain('Import-DotEnvFile')
    expect(deployScript).toContain("Join-Path $rootDir '.env'")
  })

  test('Rust-only 部署入口不要求本地 OfficeCLI', () => {
    expect(buildManifestScript).toContain('--rust')
    expect(deployShellScript).toContain('--rust')
    expect(deployScript).toContain('[switch]$RustOnly')
    expect(deployScript).toContain("'--rust'")
  })

  test('OfficeCLI-only 部署入口不要求本地 Rust API', () => {
    expect(buildManifestScript).toContain('--officecli')
    expect(deployShellScript).toContain('--officecli')
    expect(deployScript).toContain('[switch]$OfficeCliOnly')
    expect(deployScript).toContain("'--officecli'")
  })
})
