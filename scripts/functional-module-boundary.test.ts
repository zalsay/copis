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
const startDevScript = readFileSync(join(repoRoot, 'start-dev.sh'), 'utf8')
const buildManifestScript = readFileSync(join(repoRoot, 'scripts/build-functional-module-manifest.ts'), 'utf8')
const prepareAlipayBotScript = readFileSync(join(repoRoot, 'scripts/prepare-alipay-bot-module.ts'), 'utf8')

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
    expect(buildScript).toContain('publish:windows-installer')
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

  test('部署完成日志从最终 manifest 读取实际发布的模块版本', () => {
    expect(deployShellScript).toContain('MANIFEST_OUTPUT="$APP_DIR/dist/functional-modules/manifest.json"')
    expect(deployShellScript).toContain('--manifest-output "$MANIFEST_OUTPUT"')
    expect(deployShellScript).toContain('PUBLISHED_MODULE_VERSIONS=')
    expect(deployShellScript).toContain('功能模块发布完成：$PLATFORM/$ARCH $PUBLISHED_MODULE_VERSIONS')
    expect(deployScript).toContain("@('--manifest-output', $manifestPath)")
    expect(deployScript).toContain('实际模块版本：')
  })

  test('OfficeCLI-only 部署入口不要求本地 Rust API', () => {
    expect(buildManifestScript).toContain('--officecli')
    expect(deployShellScript).toContain('--officecli')
    expect(deployScript).toContain('[switch]$OfficeCliOnly')
    expect(deployScript).toContain("'--officecli'")
  })

  test('Shell 默认部署会准备官方支付宝智能体 CLI，并只允许当前平台本机构建', () => {
    expect(rootPackage.scripts?.['prepare:alipay-bot-module']).toBeDefined()
    expect(deployShellScript).toContain('--alipay-bot')
    expect(deployShellScript).toContain('prepare:alipay-bot-module')
    expect(deployShellScript).toContain('--alipay-bot-archive')
    expect(deployShellScript).toContain('支付宝智能体 CLI 必须在目标平台和架构准备')
    expect(deployShellScript).toContain('read_alipay_bot_version')
    expect(deployShellScript).toContain('COPIS_REFRESH_ALIPAY_BOT_CLI')
    expect(buildManifestScript).toContain('--alipay-bot')
    expect(deployScript).toContain('[switch]$AlipayBotOnly')
    expect(deployScript).toContain("'--alipay-bot'")
  })

  test('start-dev 会准备隔离的支付宝智能体 CLI 并传入开发 Rust API', () => {
    expect(startDevScript).toContain('prepare:alipay-bot-module')
    expect(startDevScript).toContain('COPIS_DEV_ALIPAY_BOT_DIR')
    expect(startDevScript).toContain('COPIS_ALIPAY_BOT_CLI')
    expect(startDevScript).toContain('COPIS_ALIPAY_BOT_NODE')
  })

  test('官方支付宝安装器有超时和有限重试，避免部署流程无限阻塞', () => {
    expect(prepareAlipayBotScript).toContain('OFFICIAL_INSTALLER_ATTEMPTS = 3')
    expect(prepareAlipayBotScript).toContain('DEFAULT_OFFICIAL_INSTALLER_TIMEOUT_MS = 180_000')
    expect(prepareAlipayBotScript).toContain('COPIS_ALIPAY_BOT_INSTALL_TIMEOUT_MS')
    expect(prepareAlipayBotScript).toContain('官方安装器第 ${attempt} 次失败，正在重试')
  })

  test('Shell 部署入口允许单独指定 Node.js runtime 模块版本', () => {
    expect(deployShellScript).toMatch(
      /--node-runtime-version\)\s+require_value "\$1" "\$\{2:-\}"\s+NODE_RUNTIME_VERSION="\$2"/s,
    )
  })

  test('Shell 默认部署会准备官方 OfficeCLI 并自动解析 Node.js 24 构建源', () => {
    expect(rootPackage.scripts?.['prepare:officecli-module']).toBeDefined()
    expect(deployShellScript).toContain('prepare:officecli-module')
    expect(deployShellScript).toContain('--officecli-version "$OFFICECLI_VERSION"')
    expect(deployShellScript).toContain('resolve_node_runtime_source')
    expect(deployShellScript).toContain('v24.*')
    expect(deployShellScript).toContain('--source "$NODE_RUNTIME_SOURCE"')
  })
})
