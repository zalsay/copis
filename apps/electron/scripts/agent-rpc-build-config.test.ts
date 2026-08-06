import { describe, expect, test } from 'bun:test'

interface ElectronPackageJson {
  scripts?: Record<string, string>
}

const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json() as ElectronPackageJson
const buildScript = packageJson.scripts?.['build:agent-rpc-worker'] ?? ''
const watchScript = packageJson.scripts?.['watch:agent-rpc-worker'] ?? ''

const requiredExternalPackages = [
  '--external:electron',
  '--external:undici',
  '--external:@earendil-works/pi-coding-agent',
  '--external:@earendil-works/pi-agent-core',
  '--external:@earendil-works/pi-ai',
]

describe('Pi RPC Worker 构建脚本', () => {
  test('Given 开发 watcher When 重建 Worker Then 与正式构建保持相同 external 运行时边界', () => {
    for (const externalPackage of requiredExternalPackages) {
      expect(buildScript).toContain(externalPackage)
      expect(watchScript).toContain(externalPackage)
    }
  })
})
