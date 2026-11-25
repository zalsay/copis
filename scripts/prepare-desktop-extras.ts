import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'
import type { FunctionalModuleBinaryInput } from './functional-module-publisher'

const appDir = resolve(import.meta.dir, '../apps/electron')

export function desktopModuleInputs(platform: FunctionalModulePlatform, arch: FunctionalModuleArchitecture, version: string): FunctionalModuleBinaryInput[] {
  const entries = {
    'pi-worker': platform === 'win32' ? 'bin/copis.exe' : 'bin/copis',
    'pi-web-extension': 'node_modules/pi-web-access/index.ts',
    'default-resources': 'tutorial.md',
  }
  return Object.entries(entries).map(([module, entrypoint]) => ({
    module, platform, arch, version, entrypoint, format: 'tar.gz', required: false,
    binaryPath: join(appDir, 'dist/desktop-extras', `${platform}-${arch}`, module + '.tar.gz'),
  }))
}

function prepare(): void {
  const platform = process.platform as FunctionalModulePlatform
  const arch = process.arch as FunctionalModuleArchitecture
  for (const script of ['build:cli', 'copy:pi-extensions']) {
    execFileSync(process.execPath, ['run', script], { cwd: appDir, stdio: 'inherit' })
  }
  const stage = mkdtempSync(join(tmpdir(), 'copis-desktop-extras-'))
  try {
    for (const item of desktopModuleInputs(platform, arch, '')) {
      const root = join(stage, item.module)
      let archiveRoot = root
      if (item.module === 'pi-web-extension') {
        archiveRoot = join(appDir, 'resources/pi-extensions')
      } else if (item.module === 'pi-worker') {
        mkdirSync(join(root, 'bin'), { recursive: true })
        for (const file of [platform === 'win32' ? 'copis.exe' : 'copis', 'photon_rs_bg.wasm']) {
          copyFileSync(join(appDir, 'resources/bin', `${platform}-${arch}`, file), join(root, 'bin', file))
        }
      } else {
        // 只发布仓库跟踪的素材和技能文件。
        const paths = execFileSync('git', ['ls-files', '-z', '--', 'default-skills', 'resources/tutorial.md', 'resources/copis-logos', 'resources/cursor_rainbow.svg', 'src/renderer/assets/bots/copis-logos/*.png'], { cwd: appDir, encoding: 'utf8' })
        for (const file of paths.split('\0').filter(Boolean)) {
          const dest = join(root, file.replace(/^(resources|src\/renderer\/assets\/bots)\//, ''))
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(join(appDir, file), dest)
        }
      }
      mkdirSync(dirname(item.binaryPath), { recursive: true })
      const temporary = item.binaryPath + '.' + process.pid + '.tmp'
      try {
        execFileSync('tar', ['--format=ustar', '-czf', temporary, '-C', archiveRoot, '.'], { stdio: 'inherit' })
        renameSync(temporary, item.binaryPath)
      } finally {
        rmSync(temporary, { force: true })
      }
      console.log(`已生成 ${item.binaryPath}`)
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) prepare()
