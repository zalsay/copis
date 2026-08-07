import { atom } from 'jotai'
import type {
  ExpertTeamArtifact,
  ExpertTeamRun,
  ExpertTeamRunEvent,
  ExpertTeamSchema,
  ExpertTeamWorkspaceBinding,
} from '@copis/shared'
import { expertTeamApi } from '@/lib/expert-team-api'

export interface ExpertTeamLoadState {
  schemas: boolean
  schema: boolean
  binding: boolean
  run: boolean
  events: boolean
  artifacts: boolean
}

const initialLoadState: ExpertTeamLoadState = {
  schemas: false,
  schema: false,
  binding: false,
  run: false,
  events: false,
  artifacts: false,
}

export const expertTeamSchemasAtom = atom<ExpertTeamSchema[]>([])
export const expertTeamCurrentSchemaIdAtom = atom<string | null>(null)
export const expertTeamCurrentSchemaAtom = atom<ExpertTeamSchema | null>((get) => {
  const id = get(expertTeamCurrentSchemaIdAtom)
  return get(expertTeamSchemasAtom).find((schema) => schema.id === id) ?? null
})
export const expertTeamWorkspaceBindingAtom = atom<ExpertTeamWorkspaceBinding | null>(null)
export const expertTeamRunsAtom = atom<ExpertTeamRun[]>([])
export const expertTeamCurrentRunIdAtom = atom<string | null>(null)
export const expertTeamCurrentRunAtom = atom<ExpertTeamRun | null>((get) => {
  const id = get(expertTeamCurrentRunIdAtom)
  return get(expertTeamRunsAtom).find((run) => run.id === id) ?? null
})
export const expertTeamEventsAtom = atom<ExpertTeamRunEvent[]>([])
export const expertTeamArtifactsAtom = atom<ExpertTeamArtifact[]>([])
export const expertTeamLoadStateAtom = atom<ExpertTeamLoadState>(initialLoadState)
export const expertTeamLoadingAtom = atom((get) => Object.values(get(expertTeamLoadStateAtom)).some(Boolean))
export const expertTeamErrorAtom = atom<string | null>(null)

export const loadExpertTeamSchemasAtom = atom(null, async (_get, set): Promise<void> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, schemas: true })
  set(expertTeamErrorAtom, null)
  try {
    const schemas = await expertTeamApi.listSchemas()
    set(expertTeamSchemasAtom, schemas)
    const selectedId = _get(expertTeamCurrentSchemaIdAtom)
    if (!selectedId || !schemas.some((schema) => schema.id === selectedId)) {
      set(expertTeamCurrentSchemaIdAtom, schemas[0]?.id ?? null)
    }
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '加载专家团队失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})

export const loadExpertTeamSchemaAtom = atom(null, async (_get, set, schemaId: string): Promise<void> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, schema: true })
  set(expertTeamErrorAtom, null)
  try {
    const schema = await expertTeamApi.getSchema(schemaId)
    set(expertTeamSchemasAtom, (schemas) => schemas.some((item) => item.id === schema.id)
      ? schemas.map((item) => item.id === schema.id ? schema : item)
      : [...schemas, schema])
    set(expertTeamCurrentSchemaIdAtom, schema.id)
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '加载专家团队方案失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})

export const bindExpertTeamWorkspaceAtom = atom(null, async (_get, set, input: { workspaceSlug: string; schemaId: string; schemaRevision?: number; schemaRevisionId?: number }): Promise<ExpertTeamWorkspaceBinding> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, binding: true })
  set(expertTeamErrorAtom, null)
  try {
    const binding = await expertTeamApi.bindWorkspace(input.workspaceSlug, {
      schemaId: input.schemaId,
      ...(input.schemaRevision !== undefined ? { schemaRevision: input.schemaRevision } : {}),
      ...(input.schemaRevisionId !== undefined ? { schemaRevisionId: input.schemaRevisionId } : {}),
    })
    set(expertTeamWorkspaceBindingAtom, binding)
    return binding
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '绑定专家团队失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})

export const createExpertTeamRunAtom = atom(null, async (_get, set, input: Parameters<typeof expertTeamApi.createRun>[0]): Promise<ExpertTeamRun> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, run: true })
  set(expertTeamErrorAtom, null)
  try {
    const run = await expertTeamApi.createRun(input)
    set(expertTeamRunsAtom, (runs) => [run, ...runs.filter((item) => item.id !== run.id)])
    set(expertTeamCurrentRunIdAtom, run.id)
    return run
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '创建专家团队运行失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})

export const refreshExpertTeamRunAtom = atom(null, async (_get, set, runId: string): Promise<ExpertTeamRun> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, run: true, events: true, artifacts: true })
  set(expertTeamErrorAtom, null)
  try {
    const [run, events, artifacts] = await Promise.all([
      expertTeamApi.getRun(runId),
      expertTeamApi.listEvents(runId),
      expertTeamApi.listArtifacts(runId),
    ])
    set(expertTeamRunsAtom, (runs) => [run, ...runs.filter((item) => item.id !== run.id)])
    set(expertTeamCurrentRunIdAtom, run.id)
    set(expertTeamEventsAtom, events)
    set(expertTeamArtifactsAtom, artifacts)
    return run
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '加载专家团队运行失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})

export const cancelExpertTeamRunAtom = atom(null, async (_get, set, runId: string): Promise<ExpertTeamRun> => {
  set(expertTeamLoadStateAtom, { ...initialLoadState, run: true })
  set(expertTeamErrorAtom, null)
  try {
    const run = await expertTeamApi.cancelRun(runId)
    set(expertTeamRunsAtom, (runs) => runs.map((item) => item.id === run.id ? run : item))
    return run
  } catch (error) {
    set(expertTeamErrorAtom, error instanceof Error ? error.message : '取消专家团队运行失败')
    throw error
  } finally {
    set(expertTeamLoadStateAtom, { ...initialLoadState })
  }
})
