import React, { useEffect, useState } from 'react'
import type { DshRoomModelCatalog, DshRoomModelSelection } from '@copis/shared'
import { AppSelect } from '@/components/ui/select'
import type { RoomRequest } from './useSharedRoomFeed'

export function isRoomModel(value: unknown): value is DshRoomModelSelection {
  return !!value && typeof value === 'object' && 'channelId' in value && 'modelId' in value &&
    typeof value.channelId === 'string' && !!value.channelId.trim() && typeof value.modelId === 'string' && !!value.modelId.trim()
}
export const sameModel = (a: DshRoomModelSelection, b: DshRoomModelSelection) => a.channelId === b.channelId && a.modelId === b.modelId

function readMenu(raw: unknown): DshRoomModelCatalog {
  if (!raw || typeof raw !== 'object' || !('current' in raw) || (raw.current !== null && !isRoomModel(raw.current)) ||
      !('options' in raw) || !Array.isArray(raw.options) || !raw.options.every((o): o is DshRoomModelCatalog['options'][number] =>
        isRoomModel(o) && 'name' in o && typeof o.name === 'string' && !!o.name.trim()))
    throw new Error('本群回答模型列表无效')
  return { current: raw.current, options: raw.options }
}

/** 父级按群和已登记智能体隔离此编辑器，卸载后忽略迟到的候选。 */
export function RoomModelPicker({ roomId, roomAgentId, request, draft, onChange, disabled }: {
  roomId: string; roomAgentId: string; request: RoomRequest; draft?: DshRoomModelSelection
  onChange: (model?: DshRoomModelSelection) => void; disabled: boolean
}) {
  const [menu, setMenu] = useState<DshRoomModelCatalog>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void request({ action: 'roomModelOptions', roomId, roomAgentId }).then(readMenu).then(result => {
      if (active) setMenu(result)
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : '读取本群回答模型失败') })
    return () => { active = false }
  }, [request, roomId, roomAgentId])
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>
  if (!menu) return <p role="status" className="text-xs text-muted-foreground">正在读取本群回答模型…</p>
  if (!menu.options.length) return <p role="status" className="text-xs text-muted-foreground">暂无可选的回答模型。</p>
  const choice = draft ?? menu.current
  const selected = choice ? menu.options.findIndex(o => sameModel(o, choice)) : -1
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
    <span className="text-sm">本群回答模型</span>
    <AppSelect
      aria-label="本群回答模型" disabled={disabled}
      value={selected < 0 ? '' : String(selected)}
      title={menu.options[selected]?.name}
      options={menu.options.map((option, index) => ({value: String(index), label: option.name}))}
      triggerClassName="min-w-0 text-left [&>span]:min-w-0 [&>svg]:shrink-0"
      contentClassName="w-[var(--radix-select-trigger-width)] min-w-0 bg-[var(--copis-search-panel-bg)] [overflow-wrap:anywhere]"
      onValueChange={value => {
        const option = menu.options[Number(value)]
        onChange(option && (!menu.current || !sameModel(option, menu.current)) ? option : undefined)
      }}
    />
    {!menu.current && <p role="status" className="text-xs text-muted-foreground">暂无有效的当前模型，选择并保存后生效。</p>}
  </div>
}
