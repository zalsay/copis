export interface BrowserAgentSessionCandidate {
  id: string
  workspaceId?: string
}

export interface BrowserAgentSessionSelectionInput {
  persistedSessionId: string | null
  projectId: string | null
  availableWorkspaceIds: readonly string[]
  sessions: readonly BrowserAgentSessionCandidate[]
}

export interface BrowserAgentSessionSelection {
  sessionId: string | null
  shouldCreate: boolean
}

export interface BrowserAgentWorkspaceCandidate {
  id: string
  slug: string
}

export const browserAgentUnmountPolicy = {
  unbindContext: true,
  preserveSessionId: true,
} as const

/** 选择仍存在、具备工作区且属于当前网页项目的最近 AI浏览器会话。 */
export function selectBrowserAgentSession(
  input: BrowserAgentSessionSelectionInput,
): BrowserAgentSessionSelection {
  const persistedSession = input.persistedSessionId
    ? input.sessions.find((session) => session.id === input.persistedSessionId)
    : undefined
  const hasProject = input.projectId !== null
    && input.availableWorkspaceIds.includes(input.projectId)
  const canReuse = hasProject
    && persistedSession?.workspaceId === input.projectId
    && input.availableWorkspaceIds.includes(persistedSession.workspaceId ?? '')

  return canReuse
    ? { sessionId: persistedSession.id, shouldCreate: false }
    : { sessionId: null, shouldCreate: true }
}

/** 按当前网页关联、默认工作区、当前项目的既有顺序解析 AI浏览器项目。 */
export function resolveBrowserAgentWorkspaceId(
  associatedWorkspaceId: string | null | undefined,
  workspaces: readonly BrowserAgentWorkspaceCandidate[],
  currentWorkspaceId: string | null,
): string | null {
  const availableIds = new Set(workspaces.map((workspace) => workspace.id))
  if (associatedWorkspaceId && availableIds.has(associatedWorkspaceId)) return associatedWorkspaceId
  return workspaces.find((workspace) => workspace.slug === 'default')?.id
    ?? (currentWorkspaceId && availableIds.has(currentWorkspaceId) ? currentWorkspaceId : null)
    ?? workspaces[0]?.id
    ?? null
}

export interface BrowserAgentCreatedSession {
  id: string
}

export interface BrowserAgentSessionSwitchResult {
  sessionId: string
  previousSessionId: string | null
  previousBindingReleased: boolean
}

/** 新会话绑定成功后再解除旧绑定，旧绑定失败也保持新会话为活动会话。 */
export async function createAndSwitchBrowserAgentSession(
  currentSessionId: string | null,
  createSession: () => Promise<BrowserAgentCreatedSession>,
  bindSession: (sessionId: string) => Promise<void>,
  unbindSession: (sessionId: string) => Promise<void>,
  canActivate: () => boolean = () => true,
): Promise<BrowserAgentSessionSwitchResult> {
  const nextSession = await createSession()
  await bindSession(nextSession.id)

  if (!canActivate()) {
    await unbindSession(nextSession.id).catch(() => undefined)
    return {
      sessionId: currentSessionId ?? nextSession.id,
      previousSessionId: null,
      previousBindingReleased: true,
    }
  }

  let previousBindingReleased = true
  if (currentSessionId && currentSessionId !== nextSession.id) {
    try {
      await unbindSession(currentSessionId)
    } catch {
      previousBindingReleased = false
    }
  }

  return {
    sessionId: nextSession.id,
    previousSessionId: currentSessionId && currentSessionId !== nextSession.id ? currentSessionId : null,
    previousBindingReleased,
  }
}
