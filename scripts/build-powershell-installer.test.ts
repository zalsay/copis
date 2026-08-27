import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const buildScript = readFileSync(join(import.meta.dir, '..', 'build.ps1'), 'utf8')

describe('Windows 构建脚本固定安装程序发布', () => {
  test('先重命名固定文件，再调用 COS 安装包发布脚本', () => {
    expect(buildScript).toContain("'Copis-Setup.exe'")
    expect(buildScript).toContain('Move-Item -LiteralPath $installerPath -Destination $fixedInstallerPath -Force')
    expect(buildScript).toContain("'publish:windows-installer'")
    expect(buildScript).toContain("'publish:client-update'")
    expect(buildScript).toContain('[switch]$SkipCosUpload')
  })

  test('与 build.sh 对齐支持 .env 和 --skip-cos-upload', () => {
    expect(buildScript).toContain('Get-Content -LiteralPath $Path -Encoding UTF8')
    expect(buildScript).toContain("$env:COPIS_SKIP_COS_UPLOAD -eq '1'")
    expect(buildScript).toContain("'--skip-cos-upload' { $SkipCosUpload = $true }")
  })

  test('帮助输出列出所有 PowerShell 与兼容命令行参数', () => {
    expect(buildScript).toContain('function Show-BuildHelp')
    expect(buildScript).toContain('-SkipInstall')
    expect(buildScript).toContain('-FunctionalModuleManifestUrl <url>')
    expect(buildScript).toContain('-InstallerFileName <name>')
    expect(buildScript).toContain('-InstallerObjectKey <key>')
    expect(buildScript).toContain('-CosPublicBaseUrl <url>')
    expect(buildScript).toContain('-CosBucketUrl <url>')
    expect(buildScript).toContain('-ShowHelp, -Help, -h, --help')
    expect(buildScript).toContain("'--help' { $ShowHelp = $true }")
  })

  test('manifest 地址可选，缺省时保留应用内默认地址', () => {
    expect(buildScript).toContain("Set-FromEnvironment $FunctionalModuleManifestUrl 'COPIS_FUNCTIONAL_MODULE_MANIFEST_URL'")
    expect(buildScript).toContain('未指定功能模块 manifest 地址，将使用应用内默认地址。')
    expect(buildScript).not.toContain('功能模块 manifest 地址未配置')
  })

  test('低于 Windows 门槛时自动对齐，--new 仅在已对齐后递增 patch', () => {
    expect(buildScript).toContain("'--new' { $NewVersion = $true }")
    expect(buildScript).toContain('bump-electron-version.ts')
    expect(buildScript).toContain("[switch]$NewVersion")

    const versionRead = buildScript.indexOf('Get-Content -LiteralPath $electronPackagePath -Raw -Encoding UTF8 | ConvertFrom-Json')
    const queryCall = buildScript.indexOf('query-functional-module-min-version.ts')
    const setCall = buildScript.indexOf("'--set' $platformMinVersion")
    expect(queryCall).toBeGreaterThan(versionRead)
    expect(setCall).toBeGreaterThan(queryCall)
    expect(buildScript).toContain('query-functional-module-min-version.ts')
    expect(buildScript).toContain("'--platform' $targetPlatform '--arch' $targetArch")
    expect(buildScript).toContain("'--set' $platformMinVersion")
    expect(buildScript.indexOf('if ($NewVersion -and -not $versionAlignedToMin)')).toBeGreaterThan(setCall)
  })

  test('安装包上传成功后再更新客户端 manifest', () => {
    expect(buildScript.indexOf("'publish:windows-installer'")).toBeLessThan(buildScript.indexOf("'publish:client-update'"))
  })
})
