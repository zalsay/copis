export function moveWebTab<T>(items: readonly T[], fromIndex: number, targetIndex: number): T[] {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex)) return [...items]
  if (fromIndex < 0 || fromIndex >= items.length || targetIndex < 0 || targetIndex >= items.length) return [...items]
  if (fromIndex === targetIndex) return [...items]

  const next = [...items]
  const removed = next.splice(fromIndex, 1)
  if (removed.length === 0) return [...items]
  const item = removed[0]!
  next.splice(targetIndex, 0, item)
  return next
}
