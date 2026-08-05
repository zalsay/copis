import { describe, expect, test } from 'bun:test'
import type {
  MemoryEntry,
  MemoryMaintenanceApplyInput,
  MemoryMaintenanceApplyResponse,
  MemoryMaintenanceState,
} from '@copis/shared'
import {
  MemoryMaintenanceService,
  MEMORY_MAINTENANCE_CAPTURE_THRESHOLD,
  parseMaintenanceActions,
} from './pi-memory-maintenance'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'memory-scratch-1',
    scope: 'workspace',
    workspaceSlug: 'project-a',
    kind: 'scratch',
    title: '临时状态',
    content: '当前任务需要保留的状态',
    tags: ['auto-capture'],
    source: 'agent',
    createdAt: 1,
    updatedAt: 1,
    capturedAt: 1,
    revision: 1,
    archived: false,
    ...overrides,
  }
}

function state(captureCount: number, lastConsolidatedCaptureCount = 0): MemoryMaintenanceState {
  return {
    workspaceSlug: 'project-a',
    captureCount,
    lastConsolidatedCaptureCount,
  }
}

function response(nextState: MemoryMaintenanceState): MemoryMaintenanceApplyResponse {
  return { entries: [], state: nextState }
}

describe('Memory maintenance action parser', () => {
  test('Given当前 scratch When promote JSON 合法 Then生成受限 action', () => {
    const actions = parseMaintenanceActions(JSON.stringify({ actions: [
      { operation: 'promote', id: 'memory-scratch-1', expectedRevision: 1, kind: 'project' },
    ] }), [entry()])
    expect(actions).toEqual([{
      operation: 'promote',
      id: 'memory-scratch-1',
      expectedRevision: 1,
      kind: 'project',
    }])
  })

  test('Given未知 id 或非法 revision When parse Then整批拒绝', () => {
    expect(() => parseMaintenanceActions(JSON.stringify({ actions: [
      { operation: 'archive', id: 'memory-other', expectedRevision: 1 },
    ] }), [entry()])).toThrow()
    expect(() => parseMaintenanceActions(JSON.stringify({ actions: [
      { operation: 'promote', id: 'memory-scratch-1', expectedRevision: 0, kind: 'fact' },
    ] }), [entry()])).toThrow()
  })
})

describe('Memory maintenance keyed queue', () => {
  test('Given token threshold 强制维护 When captureCount 未到10 Then仍通过同一 apply 队列提交', async () => {
    let plannerCount = 0
    let applyCount = 0
    const service = new MemoryMaintenanceService({
      client: {
        list: async () => ({ entries: [entry()], total: 1, limit: 50 }),
        maintenanceState: async () => state(1),
        applyMaintenance: async (input) => {
          applyCount += 1
          return response(state(input.expectedCaptureCount, input.expectedCaptureCount))
        },
      },
      planner: async () => {
        plannerCount += 1
        return []
      },
    })

    await service.runManual({ workspaceSlug: 'project-a', policy: 'writable' })

    expect(plannerCount).toBe(1)
    expect(applyCount).toBe(1)
  })

  test('Given未到10条 scratch When maybeRun Then不调用模型和 apply', async () => {
    let applyCount = 0
    const service = new MemoryMaintenanceService({
      client: {
        list: async () => ({ entries: [entry()], total: 1, limit: 50 }),
        maintenanceState: async () => state(MEMORY_MAINTENANCE_CAPTURE_THRESHOLD - 1),
        applyMaintenance: async () => {
          applyCount += 1
          return response(state(9, 9))
        },
      },
      planner: async () => {
        throw new Error('不应调用 planner')
      },
    })

    await service.maybeRun({ workspaceSlug: 'project-a', policy: 'writable' })
    expect(applyCount).toBe(0)
  })

  test('Given达到阈值的 scratch When两个维护同时到达 Then只推进一次 marker', async () => {
    let current = state(MEMORY_MAINTENANCE_CAPTURE_THRESHOLD)
    let applyCount = 0
    let resolvePlanner!: () => void
    const plannerGate = new Promise<void>((resolve) => { resolvePlanner = resolve })
    const service = new MemoryMaintenanceService({
      client: {
        list: async () => ({ entries: [entry()], total: 1, limit: 50 }),
        maintenanceState: async () => current,
        applyMaintenance: async (input: MemoryMaintenanceApplyInput) => {
          applyCount += 1
          current = state(input.expectedCaptureCount, input.expectedCaptureCount)
          return response(current)
        },
      },
      planner: async () => {
        if (applyCount === 0) await plannerGate
        return []
      },
    })

    const first = service.maybeRun({ workspaceSlug: 'project-a', policy: 'writable' })
    const second = service.maybeRun({ workspaceSlug: 'project-a', policy: 'writable' })
    resolvePlanner()
    await Promise.all([first, second])
    expect(applyCount).toBe(1)
  })

  test('Given visible policy When maintenance requested Then不读取或写入', async () => {
    let stateReads = 0
    const service = new MemoryMaintenanceService({
      client: {
        list: async () => ({ entries: [], total: 0, limit: 50 }),
        maintenanceState: async () => {
          stateReads += 1
          return state(10)
        },
        applyMaintenance: async () => response(state(10, 10)),
      },
    })
    await service.maybeRun({ workspaceSlug: 'project-a', policy: 'visible' })
    expect(stateReads).toBe(0)
  })
})
