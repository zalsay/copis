import React, { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { readRoomAgentOptions, RoomAgentPicker, type RoomAgentOption } from './RoomAgentPicker'
import { RoomDialog } from './RoomDialog'
import { newShareCode } from './shared-room-data'
import { roomDirectoryAction, roomDirectoryAtom } from './shared-room-directory'

type Props = { form: 'create' | 'join'; userId: string }

export function SharedRoomForm(props: Props) {
  return <FormFields key={`${props.userId}:${props.form}`} {...props} />
}

function FormFields({ form, userId }: Props) {
  const { busy, loading, error, creation } = useAtomValue(roomDirectoryAtom)
  const dispatch = useSetAtom(roomDirectoryAction)
  const creating = form === 'create'
  const [name, setName] = useState('')
  const [code, setCode] = useState(() => creating ? newShareCode() : '')
  const [options, setOptions] = useState<RoomAgentOption[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [optionError, setOptionError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const needsOptions = creating && !creation
  useEffect(() => {
    if (!needsOptions) return
    let active = true
    setOptionError('')
    void window.electronAPI.dshGroupChat.sharedRoomCommand(userId, { action: 'agentOptions' })
      .then(raw => { if (active) setOptions(readRoomAgentOptions(raw)) })
      .catch(err => { if (active) setOptionError(err instanceof Error ? err.message : '读取本机智能体失败') })
    return () => { active = false }
  }, [userId, needsOptions, attempt])

  const agents = creation ? [creation.agent] : (options ?? []).filter(a => selected.includes(a.id))
  const locked = busy || !!creation
  const disabled = busy || loading || (!creation && (!/^[A-Z0-9]{4}$/.test(code) ||
    (creating && (!name.trim() || agents.length !== 1))))
  const cancel = () => { if (!busy) void dispatch({ kind: 'cancel' }) }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!disabled) void dispatch({ kind: 'submit', name, code, agents })
  }
  return (
    <RoomDialog title={creating ? '创建群聊' : '加入群聊'} busy={busy} onClose={cancel}>
      <form onSubmit={submit} className="grid gap-3">
        {creating && (
          <label className="grid gap-1.5 text-sm">
            群名称
            <Input autoFocus disabled={locked} aria-label="共享群名称" placeholder="输入群名称"
              maxLength={128} value={creation?.room.name ?? name} onChange={e => setName(e.target.value)} />
          </label>
        )}
        <label className="grid gap-1.5 text-sm">
          分享码
          <Input autoFocus={!creating} disabled={locked} aria-label="四位分享码"
            placeholder="4 位字母或数字" maxLength={4} value={creation?.code ?? code}
            onChange={e => setCode(e.target.value.trim().toUpperCase())} />
        </label>
        {creating && (creation || options ? (
          <RoomAgentPicker options={creation ? agents : options ?? []} selected={agents.map(a => a.id)}
            onChange={setSelected} disabled={locked} />
        ) : optionError ? (
          <div>
            <p role="alert" className="text-xs text-destructive">{optionError}</p>
            <Button size="sm" variant="ghost" type="button" onClick={() => setAttempt(n => n + 1)}>重新加载</Button>
          </div>
        ) : <p role="status" className="text-sm text-muted-foreground">正在读取本机智能体…</p>)}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" type="submit" disabled={disabled}>
            {creation ? (busy ? '正在登记…' : '重试登记') : creating ? '创建' : '加入群聊'}
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={cancel}>
            {creation ? '关闭' : '取消'}
          </Button>
        </div>
      </form>
    </RoomDialog>
  )
}

export default SharedRoomForm
