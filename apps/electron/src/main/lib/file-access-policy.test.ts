import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isPathWithinAuthorizedRoots } from './file-access-policy'

describe('file access policy', () => {
  test('keeps traversal and sibling-prefix paths outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-access-root-'))
    const sibling = `${root}-sibling`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(root, 'inside.txt'), 'inside', 'utf8')
    writeFileSync(join(sibling, 'outside.txt'), 'outside', 'utf8')

    try {
      expect(isPathWithinAuthorizedRoots(join(root, 'inside.txt'), [root])).toBe(true)
      expect(isPathWithinAuthorizedRoots(join(root, '..', `${root.split('/').pop()}-sibling`, 'outside.txt'), [root])).toBe(false)
      expect(isPathWithinAuthorizedRoots(join(sibling, 'outside.txt'), [root])).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('rejects a symlink that escapes the authorized workspace', () => {
    const base = mkdtempSync(join(tmpdir(), 'copis-access-symlink-'))
    const root = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(root, 'linked'))

    try {
      expect(isPathWithinAuthorizedRoots(join(root, 'linked', 'secret.txt'), [root])).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('allows a symlinked workspace root while still enforcing its real target', () => {
    const base = mkdtempSync(join(tmpdir(), 'copis-access-root-link-'))
    const realRoot = join(base, 'real-workspace')
    const linkedRoot = join(base, 'linked-workspace')
    mkdirSync(realRoot)
    writeFileSync(join(realRoot, 'inside.txt'), 'inside', 'utf8')
    symlinkSync(realRoot, linkedRoot)

    try {
      expect(isPathWithinAuthorizedRoots(join(linkedRoot, 'inside.txt'), [linkedRoot])).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
