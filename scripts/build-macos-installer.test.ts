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
    expect(buildScript).toContain('publish:client-update')
    expect(buildScript).toContain('--skip-cos-upload')
    expect(rootPackage.scripts?.['publish:macos-installer']).toBeDefined()
  })

  test('当前版本带架构后缀不存在时回退到 electron-builder 默认命名', () => {
    const architecturePath = 'VERSIONED_DMG="$APP_DIR/out/Copis-$APP_VERSION-$MAC_ARCH.dmg"'
    const architectureCheck = 'if [[ ! -f "$VERSIONED_DMG" ]]'
    const defaultPath = 'VERSIONED_DMG="$APP_DIR/out/Copis-$APP_VERSION.dmg"'
    const firstCheck = buildScript.indexOf(architectureCheck)
    const secondCheck = buildScript.indexOf(architectureCheck, firstCheck + architectureCheck.length)

    expect(buildScript).toContain(architecturePath)
    expect(buildScript).toContain(defaultPath)
    expect(buildScript.indexOf(architecturePath)).toBeLessThan(buildScript.indexOf(defaultPath))
    expect(firstCheck).toBeGreaterThan(buildScript.indexOf(architecturePath))
    expect(secondCheck).toBeGreaterThan(buildScript.indexOf(defaultPath))
    expect(secondCheck).toBeGreaterThan(firstCheck)
    expect(secondCheck).toBeLessThan(buildScript.indexOf('cp -f "$VERSIONED_DMG" "$FIXED_DMG"'))
  })

  test('没有当前版本安装包时仍然终止构建，避免继续发布旧产物', () => {
    const defaultPath = 'VERSIONED_DMG="$APP_DIR/out/Copis-$APP_VERSION.dmg"'
    const defaultCheck = 'if [[ ! -f "$VERSIONED_DMG" ]]'
    const missingMessage = '未找到当前版本安装包，已检查带架构和默认命名'
    const secondCheck = buildScript.indexOf(defaultCheck, buildScript.indexOf(defaultCheck) + defaultCheck.length)
    const failureExit = buildScript.indexOf('exit 1', secondCheck)
    const copyCommand = buildScript.indexOf('cp -f "$VERSIONED_DMG" "$FIXED_DMG"')

    expect(buildScript).toContain(defaultPath)
    expect(buildScript).toContain(missingMessage)
    expect(secondCheck).toBeGreaterThan(0)
    expect(failureExit).toBeGreaterThan(secondCheck)
    expect(copyCommand).toBeGreaterThan(failureExit)
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
    expect(buildScript).toContain('query-functional-module-min-version.ts')
    expect(buildScript).toContain('--platform darwin --arch "$MAC_ARCH"')
    expect(buildScript).toContain('bump-electron-version.ts --set "$PLATFORM_MIN_VERSION"')
  })

  test('安装包上传成功后再更新客户端 manifest', () => {
    expect(buildScript.indexOf('publish:macos-installer')).toBeLessThan(buildScript.indexOf('publish:client-update'))
  })
})
