import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface PackageManifest {
  name?: string
  bin?: Record<string, string>
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', relativePath), 'utf-8')) as PackageManifest
}

test('Given workspace package manifests When checking the Copis contract Then all first-party names use the new scope', () => {
  const packagePaths = [
    'packages/shared/package.json',
    'packages/core/package.json',
    'packages/session-core/package.json',
    'packages/ui/package.json',
    'apps/cli/package.json',
    'apps/electron/package.json',
  ]

  for (const packagePath of packagePaths) {
    expect(readManifest(packagePath).name).toMatch(/^@copis\//)
  }

  expect(readManifest('apps/cli/package.json').bin).toEqual({ copis: './src/index.ts' })
})

test('Given the root scripts When running Copis workspace commands Then they target the new Electron package', () => {
  const root = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }

  for (const script of Object.values(root.scripts ?? {})) {
    expect(script).not.toContain('@proma/electron')
  }
})
