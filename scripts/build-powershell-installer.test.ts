import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const buildScript = readFileSync(join(import.meta.dir, '..', 'build.ps1'), 'utf8')

describe('Windows 构建脚本固定安装程序发布', () => {
  test('先重命名固定文件，再调用 COS 安装包发布脚本', () => {
    expect(buildScript).toContain("'Copis-Setup.exe'")
    expect(buildScript).toContain('Move-Item -LiteralPath $installerPath -Destination $fixedInstallerPath -Force')
    expect(buildScript).toContain("'publish:windows-installer'")
    expect(buildScript).toContain('[switch]$SkipCosUpload')
  })
})
