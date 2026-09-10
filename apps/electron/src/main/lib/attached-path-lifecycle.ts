import { listAgentSessions } from '../lib/agent-session-manager'
import { listAgentWorkspaces, getWorkspaceAttachedDirectories } from '../lib/agent-workspace-manager'
import { unwatchAttachedDirectory } from '../lib/workspace-watcher'

export function releaseDirectoryWatcherIfUnreferenced(dirPath: string): void {
  const isStillReferenced = listAgentWorkspaces().some((workspace) =>
    workspace.projectRootPath === dirPath
    || getWorkspaceAttachedDirectories(workspace.slug).includes(dirPath),
  ) || listAgentSessions().some((session) =>
    session.attachedDirectories?.includes(dirPath),
  )

  if (!isStillReferenced) unwatchAttachedDirectory(dirPath)
}
