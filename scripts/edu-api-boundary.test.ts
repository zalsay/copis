import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

describe('edu-api 远端出口边界', () => {
  test('Electron 与 Renderer Working facade 不得构造远端 edu-api 请求', () => {
    const electronWorkingClient = readRepoFile('apps/electron/src/main/lib/working-api-client.ts')
    const rendererFiles = [
      'apps/electron/src/renderer/lib/http-api-bridge.ts',
      'apps/electron/src/renderer/lib/working-skill-market-api.ts',
      'apps/electron/src/renderer/lib/workspace-skills-api.ts',
    ]

    expect(electronWorkingClient).not.toContain('COPIS_BACKEND_URL')
    expect(electronWorkingClient).not.toContain('fetchImpl(`${this.baseUrl}')
    for (const relativePath of rendererFiles) {
      expect(readRepoFile(relativePath)).not.toContain('COPIS_BACKEND_URL')
    }
  })

  test('Rust Working 业务模块不得保留 edu-api 直连 helper', () => {
    const skillMarket = readRepoFile('native/http-api-server/src/skill_market.rs')
    const workingModel = readRepoFile('native/http-api-server/src/working_model.rs')
    const main = readRepoFile('native/http-api-server/src/main.rs')

    expect(skillMarket).not.toContain('request_working_http')
    expect(skillMarket).not.toContain('COPIS_BACKEND_URL')
    expect(workingModel).not.toContain('COPIS_BACKEND_URL')
    expect(main).not.toContain('/api/internal/working-auth/request')
  })
})
