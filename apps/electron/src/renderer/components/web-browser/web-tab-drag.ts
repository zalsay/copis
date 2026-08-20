export interface WebTabDropRect {
  id: string
  left: number
  right: number
}

export interface WebTabDragOffset {
  x: number
  y: number
}

export type WebTabDragMovePhase = 'pending' | 'active' | 'ignored'

export function getWebTabDragMovePhase(
  tabId: string,
  pendingTabId: string | null,
  activeTabId: string | null,
): WebTabDragMovePhase {
  if (activeTabId === tabId) return 'active'
  if (pendingTabId === tabId) return 'pending'
  return 'ignored'
}

type WebTabDragMouseTarget = Pick<Document, 'addEventListener' | 'removeEventListener'>

/**
 * 拖动开始后把鼠标事件提升到文档层，避免鼠标离开原 Tab 后 React 目标节点不再收到移动事件。
 */
export function attachWebTabDragMouseListeners(
  target: WebTabDragMouseTarget,
  onMove: (event: MouseEvent) => void,
  onEnd: (event: MouseEvent) => void,
): () => void {
  let listening = true

  const cleanup = (reason = '手动清理'): void => {
    if (!listening) return
    listening = false
    target.removeEventListener('mousemove', handleMouseMove)
    target.removeEventListener('mouseup', handleMouseUp)
    console.info('[网页页签拖动] 文档监听已清理:', reason)
  }

  const handleMouseMove = (event: Event): void => {
    if (!listening) return
    const mouseEvent = event as MouseEvent
    console.info('[网页页签拖动] 收到 mousemove:', {
      clientX: mouseEvent.clientX,
      clientY: mouseEvent.clientY,
      buttons: mouseEvent.buttons,
    })
    onMove(mouseEvent)
  }

  const handleMouseUp = (event: Event): void => {
    if (!listening) return
    const mouseEvent = event as MouseEvent
    console.info('[网页页签拖动] 收到 mouseup:', {
      clientX: mouseEvent.clientX,
      clientY: mouseEvent.clientY,
      buttons: mouseEvent.buttons,
    })
    cleanup('mouseup')
    onEnd(mouseEvent)
  }

  target.addEventListener('mousemove', handleMouseMove)
  target.addEventListener('mouseup', handleMouseUp)
  console.info('[网页页签拖动] 文档监听已注册')
  return cleanup
}

export function getWebTabDragOffset(
  startX: number,
  pointerX: number,
): WebTabDragOffset {
  return {
    x: pointerX - startX,
    y: 0,
  }
}

export function hasWebTabDragStarted(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = 6,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold
}

export function getWebTabDropIndex(
  pointerX: number,
  rects: readonly WebTabDropRect[],
  draggedTabId: string,
): number | null {
  if (!Number.isFinite(pointerX)) return null
  if (!rects.some((rect) => rect.id === draggedTabId)) return null

  const remainingRects = rects.filter((rect) => rect.id !== draggedTabId)
  const targetIndex = remainingRects.findIndex((rect) => pointerX < (rect.left + rect.right) / 2)
  return targetIndex === -1 ? remainingRects.length : targetIndex
}

export function getWebTabDropMarkerIndex(
  tabIds: readonly string[],
  draggedTabId: string,
  dropIndex: number,
): number | null {
  const sourceIndex = tabIds.indexOf(draggedTabId)
  if (sourceIndex < 0 || dropIndex < 0 || dropIndex >= tabIds.length) return null
  return sourceIndex < dropIndex ? dropIndex + 1 : dropIndex
}
