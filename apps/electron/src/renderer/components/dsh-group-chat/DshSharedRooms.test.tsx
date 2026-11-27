import { expect, test } from 'bun:test'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { DshGroupChatView } from './DshGroupChatView'
import { parseHTML } from 'linkedom'
import type { DshSharedRoomCommand } from '@copis/shared'
import { roomDirectoryAction, roomDirectoryAtom, useRoomSidebarBridge } from './shared-room-directory'
import { SharedRoomSection } from '../../../../dsh-plugins/copis-creation-web/src/SharedRoomSection'

// 连接原生侧栏的目录投影与主窗口状态，不给侧栏暴露群聊 API。
function RoomsHarness() {
  const intent = useRoomSidebarBridge(true, 1)
  return (
    <>
      <SharedRoomSection active wide directory={intent} open={intent} />
      <DshGroupChatView />
    </>
  )
}

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act

test('共享群使用当前账号读取历史和增量消息；切号后旧内容和分享码不可见', async () => {
  const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  }
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    navigator: w.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  w.HTMLElement.prototype.scrollIntoView = () => {}
  const calls: DshSharedRoomCommand[] = []
  const snapshots: unknown[] = []
  const clipboard: string[] = []
  let finishUpload!: () => void
  const firstUpload = new Promise<void>(resolve => { finishUpload = resolve })
  let failFirstSend!: () => void
  const firstReceipt = new Promise<void>(resolve => { failFirstSend = resolve })
  let attachmentSendAttempts = 0
  let queuedCount = 2
  const msg = {
    roomId: 'room1',
    messageId: 'm1',
    seq: 1,
    senderType: 'user',
    senderUserId: 22,
    content: '来自另一位成员',
    createdAt: '2026-11-26T10:00:00Z',
  }
  const room = {
    roomId: 'room1',
    name: '两人测试',
    roomKind: 'dsh_shared',
    hostUserId: 11,
    shareCode: 'A2B3',
    shareCodeEnabled: true,
    status: 'active',
  }
  Object.assign(w, {
    electronAPI: {
      writeClipboardText: async (text: string) => { clipboard.push(text) },
      dshCordis: {
        dispatchToClient: async (payload: unknown) => {
          snapshots.push(payload)
          w.dispatchEvent(Object.assign(new w.Event('message'), { data: payload }))
          return true
        },
      },
      dshGroupChat: {
        sharedRoomCommand: async (account: string, command: DshSharedRoomCommand) => {
          calls.push(command)
          if (command.action === 'list') return account === '11' ? [room] : []
          if (command.action === 'detail') return { room, agents: [{roomId:room.roomId,roomAgentId:'ag',ownerUserId:11,displayName:'小研',availability:queuedCount ? 'busy' : 'online',queuedCount}] }
          if (command.action === 'uploadAttachment') { await firstUpload; return {id:command.mimeType === 'image/png' ? 'img1' : 'att1'} }
          if (command.action === 'downloadAttachment' && command.attachmentId === 'img1') return {bytes:new Uint8Array([1]),name:'截图.png',mimeType:'image/png'}
          if (command.action === 'downloadAttachment') return {bytes:new Uint8Array([42]),name:'notes.txt',mimeType:'text/plain'}
          if (command.action === 'send' && command.attachmentIds?.length && ++attachmentSendAttempts === 1) { await firstReceipt; throw new Error('消息网络中断') }
          if (command.action === 'send') return { notExecuted:!!command.mentionAgentId, reason:'room_queue_full', message: {...msg, messageId:crypto.randomUUID(),seq:3,content:command.content,attachmentIds:command.attachmentIds} }
          if (command.action === 'messages') return [msg]
          if (command.action === 'events')
            return command.afterSeq >= 2 ? [] : [
              {
                roomId: 'room1',
                seq: 2,
                eventType: 'message.created',
                createdAt: msg.createdAt,
                payload: { ...msg, messageId: 'm2', seq: 2, content: '后来的一条' },
              },
            ]
          throw new Error('意外请求')
        },
      },
    },
  })
  const el = w.document.getElementById('root')!
  const root = createRoot(el as unknown as HTMLElement)
  const store = createStore()
  const signIn = (id: string) =>
    store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'fixture', user: { id } })
  try {
    await act(async () =>
      root.render(
        <Provider store={store}>
          <RoomsHarness />
        </Provider>,
      ),
    )
    expect(el.textContent).toContain('登录 Copis')
    expect(calls).toHaveLength(0)
    await act(async () => signIn('11'))
    expect(el.querySelector('[aria-label="群聊范围"]')).toBeNull()
    expect(el.textContent).not.toContain('本地群聊')
    expect(el.textContent).toContain('来自另一位成员')
    expect(el.textContent).toContain('后来的一条')
    expect(el.textContent).toContain('用户 22')
    expect(el.textContent).not.toContain('A2B3')
    const header = el.querySelector('main header')!
    expect(header?.textContent).toContain('两人测试')
    expect(header?.textContent).toContain('小研')
    expect(header?.textContent).toContain('思考中')
    expect(header?.textContent).toContain('排队 2')
    const { Simulate } = await import('react-dom/test-utils')
    const editor = el.querySelector<HTMLElement>('[role="textbox"][contenteditable]')!
    expect(editor).toBeTruthy()
    expect(el.querySelector('button.dsh-room-mention')).toBeNull()
    const send = () => act(async () => el.querySelector<HTMLElement>('[title="发送消息"]')!.click())
    let caret: Node | null = null
    Object.assign(w, { getSelection: () => ({ anchorNode: caret, anchorOffset: caret?.textContent?.length ?? 0,
      isCollapsed: true, collapse: (node: Node) => { caret = node } }) })
    const type = async (text: string, inputType = 'insertText') => act(async () => {
      caret = editor.appendChild(w.document.createTextNode(text))
      Simulate.input(editor, { nativeEvent: { inputType, data: text.at(-1) } as InputEvent })
    })
    const picker = el.querySelector<HTMLInputElement>('input[aria-label="选择文件"]')!
    expect(picker).toBeTruthy()
    const sample = new File(['notes'], 'notes.txt', {type:'text/plain'})
    Object.defineProperty(picker, 'files', {value:[sample], configurable:true})
    await act(async () => Simulate.change(picker))
    expect(el.textContent).toContain('notes.txt')
    const image = new File([new Uint8Array([1])], '截图.png', {type:'image/png'})
    async function paste(files: File[], items: Partial<DataTransferItem>[] = []) {
      let intercepted = false
      await act(async () => Simulate.paste(editor, {
        clipboardData: {files, items} as unknown as DataTransfer,
        preventDefault: () => { intercepted = true },
      }))
      return intercepted
    }
    expect(await paste([], [{kind:'string',type:'text/plain'}])).toBe(false)
    expect(await paste(Array<File>(20).fill(image))).toBe(true) // 已从 + 添加一个文件
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('最多 20 个附件')
    expect(el.querySelector('[aria-label="移除 截图.png"]')).toBeNull()
    expect(await paste([image], [{kind:'file',type:image.type,getAsFile:() => image}])).toBe(true)
    expect(el.querySelectorAll('[aria-label="移除 截图.png"]')).toHaveLength(1)
    expect(el.querySelector('[aria-label="待发送附件"] img')?.getAttribute('src')).toMatch(/^blob:/)
    expect(calls.some(c => c.action === 'uploadAttachment')).toBe(false)
    await act(async () => el.querySelector<HTMLElement>('[aria-label="移除 截图.png"]')!.click())
    await send()
    expect(!!el.querySelector('[aria-label="待发送附件"]')).toBe(false)
    expect(el.querySelector('.dsh-room-bubble [role="status"]')?.textContent).toContain('上传中')
    expect(el.querySelector('.dsh-room-bubble [aria-label="发送中的附件"]')?.textContent).toContain('notes.txt')
    expect(editor.getAttribute('contenteditable')).toBe('plaintext-only')
    await type('下一条草稿')
    await act(async () => finishUpload())
    expect(el.querySelector('.dsh-room-bubble [role="status"]')?.textContent).toContain('消息发送中')
    await act(async () => failFirstSend())
    expect(editor.textContent).toBe('下一条草稿')
    expect(el.querySelector('.dsh-room-bubble [role="alert"]')?.textContent).toContain('消息网络中断')
    await act(async () => el.querySelector<HTMLElement>('.dsh-room-bubble [aria-label="重试发送"]')!.click())
    expect(editor.textContent).toBe('下一条草稿')
    expect(el.querySelectorAll('[aria-label="发送中的附件"]')).toHaveLength(0)
    editor.textContent = ''; await type('')
    const sends = calls.filter(c => c.action === 'send')
    expect(sends[0]?.clientMessageId).toBe(sends[1]?.clientMessageId)
    expect(calls.filter(c => c.action === 'uploadAttachment')).toHaveLength(1)
    expect(sends[1]?.content).toBe('附件：notes.txt')
    expect(calls.filter(c => c.action === 'send').at(-1)).toMatchObject({attachmentIds:['att1']})
    expect(!!el.querySelector('[aria-label="查看附件 1"]')).toBe(false)
    expect(calls.at(-1)).toEqual({action:'downloadAttachment',roomId:'room1',attachmentId:'att1'})
    expect(el.querySelector('a[download="notes.txt"]')?.getAttribute('href')).toMatch(/^blob:/)
    expect(await paste([], [{kind:'file',type:image.type,getAsFile:() => image}])).toBe(true)
    await send()
    expect(calls.filter(c => c.action === 'uploadAttachment').at(-1)).toMatchObject({name:'截图.png',mimeType:'image/png'})
    expect(el.querySelector('.dsh-room-bubble img[alt="截图.png"]')?.getAttribute('src')).toMatch(/^blob:/)
    expect(el.querySelector('.dsh-room-bubble a[download="截图.png"]')).toBeNull()
    expect(calls.filter(c => c.action === 'downloadAttachment' && c.attachmentId === 'img1')).toHaveLength(1)
    await type('文本里提到了 @小研', 'insertFromPaste')
    await send()
    expect(calls.filter(c => c.action === 'send').at(-1)?.mentionAgentId).toBeUndefined()
    await type('帮我看看 @')
    expect(editor.querySelector('[contenteditable="false"]')?.textContent).toBe('@小研')
    expect(el.querySelector('[role="listbox"]')).toBeNull()
    await type('我的问题')
    const unsupported = new File(['<svg/>'], '图.svg', {type:'image/svg+xml'})
    await paste([unsupported])
    const beforeImageSend = calls.filter(c => c.action === 'send').length
    await send()
    expect(calls.filter(c => c.action === 'send')).toHaveLength(beforeImageSend)
    expect(header?.textContent).toContain('PNG、JPEG、WebP 或 GIF')
    await act(async () => el.querySelector<HTMLElement>('[aria-label="移除 图.svg"]')!.click())
    await paste([image])
    await send()
    expect(calls.filter(c => c.action === 'send').at(-1)).toMatchObject({mentionAgentId:'ag',attachmentIds:['img1'],content:'帮我看看 @小研 我的问题'})
    expect(header?.textContent).toContain('本群等待队列已满')
    expect(editor.textContent).toBe('')
    await type('user@')
    expect(editor.querySelector('[contenteditable="false"]')).toBeNull()
    editor.textContent = ''
    await type('＠')
    await act(async () => Simulate.keyDown(editor, { key: 'Backspace' }))
    expect(editor.querySelector('[contenteditable="false"]')).toBeNull()
    expect(editor.textContent).toBe('')
    await type('普通发送')
    await send()
    expect(calls.filter(c => c.action === 'send').at(-1)?.mentionAgentId).toBeUndefined()

    expect(header?.textContent).toContain('排队 2')
    await act(async () => header.querySelector<HTMLElement>('[aria-label="群聊管理"]')!.click())
    expect(el.textContent).toContain('A2B3')
    // 即使网页没有剪贴板 API，顶栏也应通过 Electron 复制当前群的码。
    await act(async () => header.querySelector<HTMLElement>('[aria-label="复制分享码"]')!.click())
    expect(clipboard).toEqual(['A2B3'])
    expect(header.textContent).toContain('已复制')
    expect(snapshots.at(-1)).toMatchObject({
      rooms: [{ id: 'room1', name: '两人测试' }],
      selected: 'room1',
    })
    expect(JSON.stringify(snapshots)).not.toContain('A2B3')
    expect(JSON.stringify(snapshots)).not.toContain('来自另一位成员')
    expect(el.querySelector('aside')).toBeNull()
    expect(el.textContent).not.toContain('允许完全访问')
    expect(calls).toContainEqual({ action: 'events', roomId: 'room1', afterSeq: 1 })
    queuedCount = 0
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3150)) })
    expect(header.textContent).toContain('空闲')
    expect(header.textContent).toContain('排队 0')
    expect(header.textContent).not.toContain('思考中')
    await act(async () => signIn('22'))
    expect(el.textContent).not.toContain('来自另一位成员')
    expect(el.textContent).not.toContain('A2B3')
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, old)
  }
})

test('共享群可创建、加入和发送；成员退出与群主解散均需二次确认，失败保留当前群', async () => {
  const { Simulate } = await import('react-dom/test-utils')
  const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  }
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    navigator: w.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  w.HTMLElement.prototype.scrollIntoView = () => {}
  Object.assign(w.HTMLElement.prototype, {
    showPopover() {},
    showModal(this: HTMLElement) { this.setAttribute('open', '') },
    close(this: HTMLElement) { this.removeAttribute('open') },
  })
  const makeRoom = (id: string, name: string, code: string) => ({
    roomId: id,
    name,
    hostUserId: 11,
    shareCode: code,
    shareCodeEnabled: true,
    status: 'active',
  })
  const joined = { ...makeRoom('joined', '加入的共享群', 'ABCD'), hostUserId: 22 }
  let joins = 0
  const members = new Map<string, string>()
  const modelReads: DshSharedRoomCommand[] = []
  let edits = 0
  const savedOperations: string[] = []
  const exits: string[] = []
  const persisted: (typeof joined)[] = []
  const sends: string[] = []
  Object.assign(w, {
    electronAPI: {
      dshCordis: {
        dispatchToClient: async (payload: unknown) => {
          w.dispatchEvent(Object.assign(new w.Event('message'), { data: payload }))
          return true
        },
      },
      dshGroupChat: {
        sharedRoomCommand: async (user: string, c: DshSharedRoomCommand) => {
          expect(user).toBe('11')
          switch (c.action) {
            case 'list':
              return persisted
            case 'events':
            case 'messages':
              return []
            case 'detail': {
              const room = persisted.find(r => r.roomId === c.roomId)!
              const names = c.roomId === 'made' ? members : new Map([['other', '群主的助手']])
              return { room, agents: Array.from(names, ([id, name]) => ({ roomId: c.roomId,
                ownerUserId: room.hostUserId, roomAgentId: id, displayName: name, availability: 'offline' })) }
            }
            case 'roomModelOptions':
              modelReads.push(c)
              return { current: { channelId: 'c', modelId: 'm' }, options: [{ channelId: 'c', modelId: 'm', name: '本群模型' }] }
            case 'agentOptions':
              expect(c.roomId).not.toBe('joined') // 普通成员不读取本机候选。
              return ['助教', '审阅'].map(name => ({ id:name, name, roomAgentId:members.has('a'+name) ? 'a'+name : undefined }))
            case 'registerAgent':
              savedOperations.push(c.operationId)
              if(c.workspaceId === '审阅' && edits++ === 0) throw Error('登记失败')
              members.set('a'+c.workspaceId, c.workspaceId)
              return {roomAgentId:'a'+c.workspaceId}
            case 'removeAgent':
              members.delete(c.roomAgentId)
              return {roomAgentId:c.roomAgentId}
            case 'create':
              persisted.push(makeRoom('made', c.name, c.shareCode))
              return persisted[0]
            case 'join':
              expect(c.shareCode).toBe('ABCD')
              if (++joins === 1) throw Error('测试加入失败')
              persisted.push(joined)
              return joined
            case 'leave':
            case 'dissolve':
              exits.push(`${c.action}:${c.roomId}`)
              if (exits.length === 1) throw Error('退群请求失败')
              return { roomId: c.roomId }
            case 'send':
              sends.push(c.clientMessageId)
              if (sends.length === 1) throw Error('测试网络中断')
              return {
                message: {
                  messageId: 'mine',
                  roomId: c.roomId,
                  seq: 1,
                  senderType: 'user',
                  senderUserId: 11,
                  content: c.content,
                  createdAt: '2026-11-26T08:00:00Z',
                },
              }
          }
        },
      },
    },
  })
  const el = w.document.getElementById('root')!,
    root = createRoot(el as unknown as HTMLElement)
  const change = async (selector: string, value: string) =>
    act(async () => {
      const input = el.querySelector(selector) as unknown as HTMLInputElement
      if (input.hasAttribute('contenteditable')) {
        input.textContent = value
        Simulate.input(input)
      } else {
        input.value = value
        Simulate.change(input)
      }
    })
  const button = (name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  const store = createStore()
  store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'fixture', user: { id: '11' } })
  const formSubmit = () =>
    act(async () => Simulate.submit(el.querySelector('form') as unknown as HTMLFormElement))
  try {
    await act(async () =>
      root.render(
        <Provider store={store}>
          <RoomsHarness />
        </Provider>,
      ),
    )
    await act(async () => button('群聊操作').click())
    await act(async () => button('创建群聊').click())
    expect(el.querySelector('dialog[open]')).toBeTruthy()
    await change('[aria-label="共享群名称"]', '开发讨论')
    const check = async (name: string) => act(async () => {
      const box = el.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`)!
      box.checked = !box.checked
      Simulate.change(box as unknown as HTMLInputElement)
    })
    await check('助教')
    await formSubmit()
    expect(el.querySelector('h2')?.textContent).toBe('开发讨论')
    const manage = () => act(async () => button('群聊管理').click())
    const editRoster = async () => { await manage(); await act(async () => button('群智能体').click()) }
    await editRoster()
    expect(el.querySelector<HTMLInputElement>('input[aria-label="助教"]')?.checked).toBe(true)
    await check('助教')
    await check('审阅')
    await act(async () => button('保存智能体').click())
    expect(el.querySelector('dialog')?.textContent).toContain('登记失败')
    expect(members.size).toBe(0)
    expect(el.querySelector('dialog')?.textContent).toContain('暂无共享智能体')
    await act(async () => button('保存智能体').click())
    expect(savedOperations.at(-1)).toBe(savedOperations.at(-2))
    expect([...members.values()]).toEqual(['审阅'])
    expect(el.querySelector('dialog')).toBeNull()
    const openJoin = async () => {
      await act(async () => button('群聊操作').click())
      await act(async () => button('加入群聊').click())
    }
    await change('[contenteditable="plaintext-only"]', '留在开发讨论的草稿')
    await openJoin()
    expect(el.querySelector('main')?.closest('.hidden')).toBeNull()
    expect(el.querySelector('dialog[open]')?.textContent).toContain('加入群聊')
    await act(async () => Simulate.keyDown(el.querySelector('dialog')!, {key: 'Escape'}))
    expect(el.querySelector('dialog')).toBeNull()
    expect(el.querySelector('[contenteditable="plaintext-only"]')?.textContent).toBe('留在开发讨论的草稿')
    await openJoin()
    await change('[aria-label="四位分享码"]', 'abcd')
    await formSubmit()
    expect(el.querySelector('dialog [role="alert"]')?.textContent).toContain('测试加入失败')
    expect(el.querySelector<HTMLInputElement>('dialog input')?.value).toBe('ABCD')
    expect(button('开发讨论').getAttribute('aria-current')).toBe('page')
    await formSubmit()
    expect(el.querySelector('dialog')).toBeNull()
    expect(el.querySelector('h2')?.textContent).toBe('加入的共享群')
    expect(el.querySelector('aside')).toBeNull()
    expect(button('加入的共享群').getAttribute('aria-current')).toBe('page')
    await act(async () => button('群聊协作').click())
    expect(button('加入的共享群')).toBeNull()
    expect(el.querySelector('h2')?.textContent).toBe('加入的共享群')
    await act(async () => button('群聊协作').click())
    await act(async () => button('开发讨论').click())
    expect(el.querySelector('h2')?.textContent).toBe('开发讨论')
    await act(async () => button('加入的共享群').click())
    await change('[contenteditable="plaintext-only"]', '留在加入群的草稿')
    const openOtherMenu = async () => {
      const more = button('管理「开发讨论」')
      expect(more).toBeTruthy()
      await act(async () => more.click())
      expect(button('加入的共享群').getAttribute('aria-current')).toBe('page')
      return el.querySelector('[aria-label="开发讨论管理菜单"]')!
    }
    const rosterMenu = await openOtherMenu()
    await act(async () => rosterMenu.querySelector<HTMLElement>('[aria-label="群智能体"]')!.click())
    expect(el.querySelector('dialog[open]')?.textContent).toContain('审阅')
    expect(button('保存智能体')).toBeTruthy()
    await act(async () => Simulate.keyDown(el.querySelector('dialog')!, {key:'Escape'}))
    expect(el.querySelector('[contenteditable="plaintext-only"]')?.textContent).toBe('留在加入群的草稿')
    const exitMenu = await openOtherMenu()
    await act(async () => exitMenu.querySelector<HTMLElement>('[aria-label="解散群"]')!.click())
    expect(el.querySelector('dialog')?.textContent).toContain('解散「开发讨论」')
    await act(async () => Simulate.keyDown(el.querySelector('dialog')!, {key:'Escape'}))
    expect(exits).toEqual([])
    await change('[contenteditable="plaintext-only"]', '试发消息')
    const send = () => act(async () => el.querySelector<HTMLElement>('[title="发送消息"]')!.click())
    await send()
    expect(el.textContent).toContain('测试网络中断')
    await send()
    expect(sends).toHaveLength(2)
    expect(sends[0]).toBe(sends[1])
    expect(el.querySelector('[contenteditable="plaintext-only"]')?.textContent).toBe('')
    expect(el.textContent).toContain('试发消息')
    const clickText = async (label: string) => {
      const target = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)
      expect(target).toBeTruthy()
      await act(async () => target!.click())
    }
    await editRoster()
    expect(el.querySelector('dialog')?.textContent).toContain('群主的助手')
    expect(el.querySelector('dialog')?.textContent).toContain('离线')
    expect(el.querySelector('dialog input[type=checkbox]')).toBeNull()
    expect(button('保存智能体')).toBeNull()
    expect(el.querySelector('dialog [role="combobox"][aria-label="本群回答模型"]')).toBeNull()
    expect(modelReads).toEqual([
      { action: 'roomModelOptions', roomId: 'made', roomAgentId: 'a助教' },
      { action: 'roomModelOptions', roomId: 'made', roomAgentId: 'a审阅' },
    ])
    await clickText('关闭')
    await manage()
    expect(el.querySelector('[aria-label="复制分享码"]')).toBeNull()
    await clickText('退出群')
    expect(el.textContent).toContain('退出「加入的共享群」')
    await clickText('取消')
    expect(exits).toEqual([])
    await manage()
    await clickText('退出群')
    await clickText('确认退出')
    expect(el.querySelector('dialog')?.textContent).toContain('退群请求失败')
    expect(button('加入的共享群').getAttribute('aria-current')).toBe('page')
    await clickText('确认退出')
    expect(button('加入的共享群')).toBeNull()
    expect(button('开发讨论').getAttribute('aria-current')).toBe('page')
    await manage()
    await clickText('解散群')
    expect(el.textContent).toContain('解散「开发讨论」')
    await clickText('确认解散')
    expect(exits).toEqual(['leave:joined', 'leave:joined', 'dissolve:made'])
    expect(button('开发讨论')).toBeNull()
    expect(el.textContent).toContain('请在左侧')
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, old)
  }
})


test('退出操作锁定所选群和角色，重复提交与换号前的迟到回执不影响新目录', async () => {
  const old = globalThis.window
  const store = createStore()
  const calls: DshSharedRoomCommand[] = []
  let finish!: (value: unknown) => void
  const pending = new Promise((resolve) => { finish = resolve })
  const room = { roomId: 'one', hostUserId: 11, status: 'active', name: '测试群' }
  Object.assign(globalThis, { window: { electronAPI: { dshGroupChat: {
    sharedRoomCommand: async (_user: string, c: DshSharedRoomCommand) => {
      calls.push(c)
      if (c.action === 'list') return [room, { ...room, roomId: 'two' }]
      return pending
    },
  } } } })
  const signIn = (id: string) => store.set(workingAuthStateAtom, {
    authenticated: true, backendUrl: 'fixture', user: { id },
  })
  try {
    signIn('22')
    await store.set(roomDirectoryAction, { kind: 'ensure' })
    await store.set(roomDirectoryAction, { kind: 'dissolve', id: 'one' })
    await store.set(roomDirectoryAction, { kind: 'leave', id: 'two' })
    expect(calls).toEqual([{ action: 'list' }])
    await store.set(roomDirectoryAction, { kind: 'manage', id: 'one', action: 'leave' })
    const first = store.set(roomDirectoryAction, { kind: 'leave', id: 'one' })
    await store.set(roomDirectoryAction, { kind: 'leave', id: 'one' })
    expect(calls).toHaveLength(2)
    signIn('11')
    await store.set(roomDirectoryAction, { kind: 'ensure' })
    finish({ roomId: 'one' })
    await first
    expect(store.get(roomDirectoryAtom)).toMatchObject({ selected: 'one', busy: false })
    expect(store.get(roomDirectoryAtom).rooms[0]?.role).toBe('host')
  } finally {
    Object.assign(globalThis, { window: old })
  }
})

test('侧栏管理未选中的群：复制用最新分享码；错误角色、越过确认及其他群的操作不生效', async () => {
  const old = globalThis.window
  const store = createStore()
  const rooms = ['a','b','c'].map((roomId, i) => ({ roomId, name: `群 ${roomId}`, hostUserId: i ? 11 : 22,
    status: 'active', shareCodeEnabled: true, shareCode: 'ABCD' }))
  const calls: DshSharedRoomCommand[] = [], clipboard: string[] = []
  Object.assign(globalThis, { window: { electronAPI: {
    writeClipboardText: async (s: string) => { clipboard.push(s) },
    dshGroupChat: { sharedRoomCommand: async (_: string, c: DshSharedRoomCommand) => {
      calls.push(c)
      if (c.action === 'list') return rooms
      if (c.action === 'detail' && c.roomId === 'b') return {room: {...rooms[1], shareCode: 'NEW1'}}
      if (c.action === 'dissolve') return {roomId:c.roomId}
      throw Error('意外请求')
    } },
  } } })
  try {
    store.set(workingAuthStateAtom, {authenticated:true, backendUrl:'fixture', user:{id:'11'}})
    await store.set(roomDirectoryAction, {kind:'ensure'})
    await store.set(roomDirectoryAction, {kind:'manage',id:'a',action:'copy'})
    await store.set(roomDirectoryAction, {kind:'manage',id:'b',action:'copy'})
    expect(clipboard).toEqual(['NEW1'])
    await store.set(roomDirectoryAction, {kind:'dissolve',id:'b'})
    await store.set(roomDirectoryAction, {kind:'manage',id:'b',action:'dissolve'})
    await store.set(roomDirectoryAction, {kind:'dissolve',id:'c'})
    expect(calls).toEqual([{action:'list'},{action:'detail',roomId:'b'}])
    await store.set(roomDirectoryAction, {kind:'dissolve',id:'b'})
    expect(calls.at(-1)).toEqual({action:'dissolve',roomId:'b'})
    expect(store.get(roomDirectoryAtom)).toMatchObject({ selected:'a', management:null, rooms:[{id:'a'},{id:'c'}] })
  } finally { Object.assign(globalThis, { window: old }) }
})
