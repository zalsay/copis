import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { patchDshComposerModelSelectionSource, patchDshCordisPanelSource, validateNativeDshDetails } from './prepare-dsh-module'
import { patchDshComposerHistorySource } from '../apps/electron/src/main/lib/dsh-composer-history-patch'
import { patchDshHeroLogoSource } from '../apps/electron/src/main/lib/dsh-hero-logo-patch'

const root = process.env.COPIS_DSH_RC2_RUNTIME_ROOT

test.skipIf(!root)('官方 RC2 客户端：保留 Copis 补丁，详情使用已迁移的原生模块', () => {
  const source = (name: string) => readFileSync(join(root!, 'node_modules/@deepseek-ai', name, 'lib/client.js'), 'utf8')
  const conversation = source('dsh-client-ui-conversation')
  const patches = [
    [source('dsh-client-ui-model-selection'), patchDshComposerModelSelectionSource, 'const triggerLabel=triggerModelLabel;'],
    [source('dsh-client-ui-cordis'), patchDshCordisPanelSource, 'Copis 请您确认'],
    [conversation, patchDshComposerHistorySource, 'this.attachmentIds.length === 0'],
    [conversation, (value: string) => patchDshHeroLogoSource(value, '<svg></svg>'), 'copis-hero-logo-light'],
  ] as const
  for (const [original, patch, marker] of patches) {
    const result = patch(original)
    expect(result).not.toBe(original)
    expect(result).toContain(marker)
    expect(patch(result)).toBe(result)
    expect(() => new Script(result)).not.toThrow()
  }
  expect(() => validateNativeDshDetails(root!)).not.toThrow()
})
