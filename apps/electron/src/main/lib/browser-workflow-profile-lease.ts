interface ProfileLeaseOwner {
  sessionId: string
}

const activeProfileLeases = new Map<string, ProfileLeaseOwner>()

export function acquireBrowserWorkflowProfileLease(partition: string, sessionId: string): () => void {
  const current = activeProfileLeases.get(partition)
  if (current) {
    throw new Error(`Browser Workflow Profile 正在被另一个运行占用: ${partition}`)
  }
  activeProfileLeases.set(partition, { sessionId })
  let released = false
  return (): void => {
    if (released) return
    released = true
    if (activeProfileLeases.get(partition)?.sessionId === sessionId) {
      activeProfileLeases.delete(partition)
    }
  }
}
