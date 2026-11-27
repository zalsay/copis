import React from 'react'

export interface RoomAgentOption {
  id: string
  name: string
  roomAgentId?: string
}

export function readRoomAgentOptions(raw: unknown): RoomAgentOption[] {
  if (!Array.isArray(raw)) throw new Error('无法读取本机智能体列表')
  const seen = new Set<string>()
  return raw.map(option => {
    if (!option || typeof option !== 'object') throw new Error('本机智能体信息无效')
    const { id, name, roomAgentId } = option
    if (typeof id !== 'string' || !id.trim() || seen.has(id) || typeof name !== 'string' || !name.trim() ||
        (roomAgentId !== undefined && (typeof roomAgentId !== 'string' || !roomAgentId.trim())))
      throw new Error('本机智能体信息无效')
    seen.add(id)
    return roomAgentId === undefined ? { id, name } : { id, name, roomAgentId }
  })
}

export function RoomAgentPicker({ options, selected, onChange, allowSelection = true, disabled = false }: {
  options: RoomAgentOption[]
  selected: string[]
  onChange: (ids: string[]) => void
  allowSelection?: boolean
  disabled?: boolean
}) {
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-2">
      <legend className="mb-2 text-sm font-medium">共享给本群的智能体 <span className="text-muted-foreground">{selected.length}/{allowSelection ? 1 : 0}</span></legend>
      <p className="text-xs text-muted-foreground">成员 @ 后由群主设备依次回答，使用群主的模型额度，不共享本机文件。</p>
      <div className="max-h-52 overflow-y-auto">
        {options.map(({ id, name }) => {
          const checked = selected.includes(id)
          return <label key={id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
            <input type="checkbox" aria-label={name} checked={checked} disabled={!checked && !allowSelection}
              onChange={() => {
                if (allowSelection) onChange(checked && selected.length === 1 ? [] : [id])
                else if (checked) onChange(selected.filter(key => key !== id))
              }} />
            <span className="truncate" title={name}>{name}</span>
          </label>
        })}
        {!options.length && <p className="text-sm text-muted-foreground">此设备没有可选的工作区智能体。</p>}
      </div>
    </fieldset>
  )
}
