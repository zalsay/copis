import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const buildScript = readFileSync(join(import.meta.dir, '..', 'build.sh'), 'utf8')
const rootPackage = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>
}

describe('macOS 构建脚本固定安装程序发布', () => {
  test('构建后复制为固定文件名，再调用 COS 安装包发布脚本', () => {
    expect(buildScript).toContain('cp -f "$VERSIONED_DMG" "$FIXED_DMG"')
    expect(buildScript).toContain('Copis-$MAC_ARCH.dmg')
    expect(buildScript).toContain('publish:macos-installer')
    expect(buildScript).toContain('--skip-cos-upload')
    expect(rootPackage.scripts?.['publish:macos-installer']).toBeDefined()
  })

  test('固定安装包上传配置在检查前加载根目录 .env', () => {
    const loadCall = buildScript.indexOf('load_dotenv "$ROOT_DIR/.env"')
    const configCheck = buildScript.indexOf('if [[ -z "${COS_PUBLIC_BASE_URL:-}" || -z "${COS_BUCKET_URL:-}" ]]')

    expect(loadCall).toBeGreaterThanOrEqual(0)
    expect(configCheck).toBeGreaterThan(loadCall)
  })

  test('固定文件名不包含版本号', () => {
    const fixedLine = buildScript.split('\n').find((line) => line.includes('FIXED_DMG='))

    expect(fixedLine).toContain('Copis-$MAC_ARCH.dmg')
    expect(fixedLine).not.toContain('$APP_VERSION')
  })

  test('支持 --new 自动递增 Electron 应用 patch 版本', () => {
    expect(buildScript).toContain('--new)')
    expect(buildScript).toContain('bump-electron-version.ts --new')
  })
})
