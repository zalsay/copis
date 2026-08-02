import type { WorkingEvent } from '@proma/shared'

export type WorkingRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped'

export interface WorkingRunState {
  status: WorkingRunStatus
  lastEvent?: WorkingEvent
  toolCallCount: number
  fileChangeCount: number
  todoCount: number
  error?: string
}

/** Derive the current local Working run state from the normalized event history. */
export function deriveWorkingRunState(events: readonly WorkingEvent[]): WorkingRunState {
  const state: WorkingRunState = {
    status: 'idle',
    toolCallCount: 0,
    fileChangeCount: 0,
    todoCount: 0,
  }

  for (const event of events) {
    state.lastEvent = event
    switch (event.type) {
      case 'run_started':
        state.status = 'running'
        state.error = undefined
        break
      case 'tool_call':
        state.toolCallCount += 1
        break
      case 'file_change':
        state.fileChangeCount += 1
        break
      case 'patch':
        state.fileChangeCount += event.files.length
        break
      case 'todo':
        state.todoCount += event.todos.length
        break
      case 'run_completed':
        state.status = 'completed'
        state.error = undefined
        break
      case 'run_failed':
        state.status = 'failed'
        state.error = event.error
        break
      case 'run_stopped':
        state.status = 'stopped'
        state.error = undefined
        break
      case 'message_delta':
      case 'tool_result':
        break
    }
  }

  return state
}
