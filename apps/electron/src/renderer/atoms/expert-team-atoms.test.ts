import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  expertTeamCurrentRunAtom,
  expertTeamCurrentRunIdAtom,
  expertTeamCurrentSchemaAtom,
  expertTeamCurrentSchemaIdAtom,
  expertTeamRunsAtom,
  expertTeamSchemasAtom,
  expertTeamLoadingAtom,
  expertTeamLoadStateAtom,
} from './expert-team-atoms'

describe('expert team atoms', () => {
  test('按当前 id 派生 schema/run，状态仅由 load state 驱动', () => {
    const store = createStore()
    store.set(expertTeamSchemasAtom, [{ id: 'team', name: '团队', nodes: [], edges: [] }])
    store.set(expertTeamCurrentSchemaIdAtom, 'team')
    store.set(expertTeamRunsAtom, [{ id: 'run-1', schemaId: 'team', workspaceSlug: 'demo', status: 'queued', createdAt: 1 }])
    store.set(expertTeamCurrentRunIdAtom, 'run-1')

    expect(store.get(expertTeamCurrentSchemaAtom)?.id).toBe('team')
    expect(store.get(expertTeamCurrentRunAtom)?.status).toBe('queued')
    expect(store.get(expertTeamLoadingAtom)).toBe(false)
    store.set(expertTeamLoadStateAtom, { schemas: false, schema: false, binding: false, run: true, events: false, artifacts: false })
    expect(store.get(expertTeamLoadingAtom)).toBe(true)
  })
})
