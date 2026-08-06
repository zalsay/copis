import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const deployScript = readFileSync(join(repoRoot, 'deploy.ps1'), 'utf8')

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
})
