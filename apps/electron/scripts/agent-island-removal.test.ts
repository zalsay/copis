import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronDir = join(import.meta.dir, '..')
const repoRoot = join(electronDir, '..', '..')

function readElectronFile(...segments: string[]): string {
  return readFileSync(join(electronDir, ...segments), 'utf8')
}

describe('Agent Island 已移除', () => {
  test('Given Electron 构建 When 检查运行时入口 Then 不再包含 Island 构建、打包或窗口桥接', () => {
    const packageJson = JSON.parse(readElectronFile('package.json')) as { scripts?: Record<string, string> }
    const scripts = packageJson.scripts ?? {}
    const builderConfig = readElectronFile('electron-builder.yml')
    const mainEntry = readElectronFile('src', 'main', 'index.ts')
    const preload = readElectronFile('src', 'preload', 'index.ts')
    const rendererEntry = readElectronFile('src', 'renderer', 'main.tsx')
    const settings = readElectronFile('src', 'types', 'settings.ts')
    const sharedTypes = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'types', 'index.ts'), 'utf8')
    const removedFiles = [
      'native/agent-island/macos-agent-island-helper.swift',
      'scripts/build-agent-island-native.ts',
      'src/main/lib/agent-island-service.ts',
      'src/main/lib/agent-island-planning.ts',
      'src/main/lib/agent-island-plan-quota.ts',
      'src/main/lib/agent-island-window.ts',
      'src/main/lib/mac-agent-island-native-host.ts',
      'src/main/lib/macos-version.ts',
      'src/renderer/components/agent-island/AgentIslandApp.tsx',
      'src/renderer/components/agent-island/agent-island.css',
      'src/renderer/components/agent-island/mascot.ts',
    ]

    expect(removedFiles.every((file) => !existsSync(join(electronDir, file)))).toBe(true)
    expect(Object.keys(scripts).some((name) => name.includes('agent-island'))).toBe(false)
    expect(scripts.build).not.toContain('agent-island')
    expect(builderConfig).not.toContain('agent-island')
    expect(mainEntry).not.toContain('agent-island')
    expect(preload).not.toContain('agentIsland')
    expect(rendererEntry).not.toContain('AgentIsland')
    expect(settings).not.toContain('agentIsland')
    expect(sharedTypes).not.toContain('./agent-island')
  })
})
