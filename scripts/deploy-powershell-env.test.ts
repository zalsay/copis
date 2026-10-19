import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const deployScript = readFileSync(join(repoRoot, 'deploy.ps1'), 'utf8')
const electronPlatformVersionScript = readFileSync(join(repoRoot, 'scripts/electron-platform-version.ts'), 'utf8')

describe('Windows 部署入口的 .env 加载', () => {
  test('在读取发布配置前加载根目录 .env，并保留进程环境变量优先级', () => {
    const loadCall = deployScript.indexOf("Import-DotEnvFile -Path (Join-Path $rootDir '.env')")
    const publicBaseUrlRead = deployScript.indexOf('$env:COS_PUBLIC_BASE_URL')

    expect(loadCall).toBeGreaterThanOrEqual(0)
    expect(publicBaseUrlRead).toBeGreaterThan(loadCall)
    expect(deployScript).toContain('$processEnvironment.ContainsKey($key)')
  })

  test('不会将 COS 密钥写入部署日志', () => {
    expect(deployScript).not.toMatch(/Write-Host[^\r\n]*COS_SECRET_(?:ID|KEY)/)
    expect(deployScript).not.toMatch(/Write-Host[^\r\n]*COS_BUCKET_URL/)
  })

  test('兼容 deploy.sh 使用的长横线开关', () => {
    expect(deployScript).toContain('ValueFromRemainingArguments = $true')
    expect(deployScript).toContain("'--rust' { $RustOnly = $true }")
    expect(deployScript).toContain("'--skip-publish' { $SkipPublish = $true }")
  })

  test('按目标平台读取应用版本，并以 UTF-8 解析应用元数据', () => {
    expect(deployScript).toContain('Get-Content -LiteralPath $Path -Encoding UTF8')
    expect(deployScript).toContain("'--get' '--platform' $Platform '--arch' $Arch")
    expect(deployScript).toContain("Join-Path $rootDir 'scripts\\bump-electron-version.ts'")
    expect(electronPlatformVersionScript).toContain("resolveElectronVersion(JSON.parse(readFileSync(packagePath, 'utf8')), platform, arch)")
    expect(deployScript).toContain('Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8')
    expect(deployScript).toContain("$entry = $entry -replace '^export\\s+', ''")
  })

  test('帮助参数和支付宝归档版本读取与 deploy.sh 对齐', () => {
    expect(deployScript).toContain("'-h' { Show-Help; exit 0 }")
    expect(deployScript).toContain("'--help' { Show-Help; exit 0 }")
    expect(deployScript).toContain('-RustOnly / --rust                   只发布 Rust HTTP API；每次自动递增 rust-http-api 版本')
    expect(deployScript).toContain("if ($RustOnly) { $releaseArguments += '--rust' }")
    expect(deployScript).toContain('function Read-AlipayBotVersion')
    expect(deployScript).toContain("'./runtime/package.json'")
    expect(deployScript).toContain('Read-AlipayBotVersion $alipayBotArchivePath')
  })

  test('-RustOnly / --rust 默认跳过依赖安装，并支持 -Install / --install 显式开启', () => {
    expect(deployScript).toContain('[switch]$Install')
    expect(deployScript).toContain("'--install' { $Install = $true }")
    expect(deployScript).toContain('$hasExplicitInstall')
    expect(deployScript).toContain('$hasExplicitSkipInstall')
    expect(deployScript).toContain('elseif (-not $hasExplicitSkipInstall -and $RustOnly)')
  })
})

test('Given PowerShell 发布 Chrome 模块 When 非 macOS 目标 Then 在构建前明确拒绝并保留 archive/version 转发', () => {
  const guard = "if ($ChromeDesktopCliOnly -and $Platform -ne 'darwin')"
  expect(deployScript).toContain('[switch]$ChromeDesktopCliOnly')
  expect(deployScript).toContain(guard)
  expect(deployScript.indexOf(guard)).toBeLessThan(deployScript.indexOf("@('run', 'build:http-api-server')"))
  expect(deployScript).toContain("'COPIS_CHROME_DESKTOP_CLI_ARCHIVE'")
  expect(deployScript).toContain("'COPIS_CHROME_DESKTOP_CLI_VERSION'")
  expect(deployScript).toContain("@('--chrome-desktop-cli-archive', $ChromeDesktopCliArchive)")
  expect(deployScript).toContain("@('--chrome-desktop-cli-version', $ChromeDesktopCliVersion)")
  expect(deployScript).toContain("$Platform -eq 'darwin' -and -not $RustOnly")
  expect(deployScript).toContain('prepare:chrome-desktop-cli-module')
  expect(deployScript).not.toContain('swiftc')
})

test('Given --chrome-cli短入口 When PowerShell解析 Then 与旧别名及可选归档/版本保持同一模块', () => {
  expect(deployScript).toContain("[Alias('chrome-cli', 'chrome-desktop-cli')]")
  expect(deployScript).toContain("'--chrome-cli' { $ChromeDesktopCliOnly = $true }")
  expect(deployScript).toContain("'--chrome-cli-archive' {")
  expect(deployScript).toContain('$ChromeDesktopCliArchive = Resolve-ChromeCliArgument')
  expect(deployScript).toContain("'--chrome-cli-version' {")
  expect(deployScript).toContain('$ChromeDesktopCliVersion = Resolve-ChromeCliArgument')
  expect(deployScript).toContain("$PSBoundParameters.ContainsKey('ChromeDesktopCliArchive')")
  expect(deployScript).toContain('$Specified -and $Current -cne $Incoming')
  expect(deployScript).toContain('elseif (-not $hasExplicitSkipInstall -and $ChromeDesktopCliOnly)')
  expect(deployScript).toContain('从源码重新构建并上传')
})
