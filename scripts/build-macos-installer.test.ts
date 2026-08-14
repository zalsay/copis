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

  test('固定文件名不包含版本号', () => {
    const fixedLine = buildScript.split('\n').find((line) => line.includes('FIXED_DMG='))

    expect(fixedLine).toContain('Copis-$MAC_ARCH.dmg')
    expect(fixedLine).not.toContain('$APP_VERSION')
  })
})
