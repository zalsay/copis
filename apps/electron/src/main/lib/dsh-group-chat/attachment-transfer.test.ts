import { expect, test } from 'bun:test'
import { DSH_ROOM_ATTACHMENT_MAX_BYTES } from '@copis/shared'
import { createAttachmentTransfer } from './attachment-transfer'

const now = Math.floor(Date.now() / 1000)
const grant = { attachmentId: 'att-1', bucket: 'test-123456', region: 'ap-shanghai', objectKey: 'private/chatroom-v2/r/att-1', credentials: { tmpSecretId: 'secret-id', tmpSecretKey: 'secret-key', sessionToken: 'token', startTime: now, expiredTime: now + 600 } }
function fixture() {
  let revision = 1
  const commands: any[] = []
  const transfer = createAttachmentTransfer({ revision: () => revision, command: async (command) => { commands.push(command); return command.action === 'internalAttachmentFinalize' ? { attachmentId: 'att-1', roomId:command.roomId, sizeBytes:command.sizeBytes, sha256:command.sha256, status:'ready' } : { data: grant } }, upload: async () => 'etag', download: async () => new Response(new Uint8Array([1, 2])) })
  return { transfer, commands, change: () => revision++ }
}

test('Given 文件 When 上传 Then 申请临时授权并确认附件，只返回 ID', async () => {
  const f = fixture()
  expect(await f.transfer.upload({ roomId: 'r', name: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array([1, 2]) })).toEqual({ id: 'att-1' })
  expect(f.commands.map(c => c.action)).toEqual(['internalAttachmentUpload', 'internalAttachmentFinalize'])
  expect(f.commands[0]).toMatchObject({ roomId: 'r', fileName: 'a.txt', sizeBytes: 2, sha256: 'a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222' })
})
test('Given 超限或非法输入 When 上传 Then 不请求授权', async () => {
  const f = fixture()
  await expect(f.transfer.upload({ roomId:'r', name:'../x', mimeType:'text/plain', bytes:new Uint8Array(1) })).rejects.toThrow()
  await expect(f.transfer.upload({ roomId:'r', name:'a', mimeType:'text/plain', bytes:new Uint8Array(DSH_ROOM_ATTACHMENT_MAX_BYTES + 1) })).rejects.toThrow()
  expect(f.commands).toHaveLength(0)
})
test('Given 下载响应 When 超限 Then 不返回内容', async () => {
  const transfer = createAttachmentTransfer({ revision: () => 1, command: async () => ({ data: grant }), upload: async () => '', download: async () => new Response(new Uint8Array(DSH_ROOM_ATTACHMENT_MAX_BYTES + 1)) })
  await expect(transfer.download({ roomId:'r', attachmentId:'att-1' })).rejects.toThrow()
})
test('Given 下载途中切换账号 When 返回 Then 丢弃响应', async () => {
  const f = fixture(); const pending = f.transfer.download({roomId:'r', attachmentId:'att-1'}); f.change()
  await expect(pending).rejects.toThrow()
})
test('Given 授权的附件 ID 不匹配 When 下载 Then 拒绝传输', async () => {
  const f = fixture(); await expect(f.transfer.download({roomId:'r', attachmentId:'different'})).rejects.toThrow()
})

test('Given 跨房间或跨附件的私有 key When 申请传输 Then 不访问 COS', async () => {
  for (const key of ['private/chatroom-v2/other/att-1', 'private/chatroom-v2/r/other', 'private/chatroom-v2/r/att-1/extra']) {
    let accessed = false
    const transfer = createAttachmentTransfer({ revision: () => 1, command: async () => ({data:{...grant, objectKey:key}}), upload: async () => { accessed = true; return 'etag' }, download: async () => { accessed = true; return new Response() } })
    await expect(transfer.download({roomId:'r', attachmentId:'att-1'})).rejects.toThrow()
    expect(accessed).toBe(false)
  }
})
test('Given COS 真实响应头 When 下载 Then 返回安全解码的文件名与类型', async () => {
  const transfer = createAttachmentTransfer({ revision: () => 1, command: async () => ({data:grant}), upload: async () => '', download: async () => new Response(new Uint8Array([9]), {headers:{'x-cos-meta-original-name': encodeURIComponent('图片 1.png'), 'content-type':'image/png'}}) })
  expect(await transfer.download({roomId:'r',attachmentId:'att-1'})).toEqual({bytes:new Uint8Array([9]),name:'图片 1.png',mimeType:'image/png'})
})
test('Given 不安全响应头 When 下载 Then 忽略名称与类型', async () => {
  const transfer = createAttachmentTransfer({ revision: () => 1, command: async () => ({data:grant}), upload: async () => '', download: async () => new Response(new Uint8Array([9]), {headers:{'x-cos-meta-original-name': '%2e%2e%2fsecret', 'content-type':'text/html; charset=utf-8'}}) })
  expect(await transfer.download({roomId:'r',attachmentId:'att-1'})).toEqual({bytes:new Uint8Array([9])})
})

test('Given 上传期间账号切换 When COS 完成 Then 不提交 finalize', async () => {
  let revision = 1; const actions: string[] = []
  const transfer = createAttachmentTransfer({ revision: () => revision, command: async command => { actions.push(command.action); return {data:grant} }, upload: async () => { revision++; return 'etag' }, download: async () => new Response() })
  await expect(transfer.upload({roomId:'r',name:'a.txt',mimeType:'text/plain',bytes:new Uint8Array([1])})).rejects.toThrow()
  expect(actions).toEqual(['internalAttachmentUpload'])
})
test('Given 服务端较小限制 When 文件超过限制 Then 不上传 COS', async () => {
  let uploaded = false
  const transfer = createAttachmentTransfer({revision:()=>1,command:async()=>({data:{...grant,maxSizeBytes:1}}),upload:async()=>{uploaded = true; return 'etag'},download:async()=>new Response()})
  await expect(transfer.upload({roomId:'r',name:'a.txt',mimeType:'text/plain',bytes:new Uint8Array([1,2])})).rejects.toThrow()
  expect(uploaded).toBe(false)
})
test('Given 上游错误含秘密 When 上传失败 Then 错误不向渲染进程泄露', async () => {
  const transfer = createAttachmentTransfer({revision:()=>1,command:async()=>{throw new Error('secret token private/key')},upload:async()=>'',download:async()=>new Response()})
  await expect(transfer.upload({roomId:'r',name:'a',mimeType:'text/plain',bytes:new Uint8Array([1])})).rejects.toThrow('附件上传失败或账号已切换')
})

test('按触发消息下载图片；非 Word 的普通文件仍跳过', async () => {
  const transfer = createAttachmentTransfer({ revision:() => 1, command:async cmd => {
    if (cmd.action !== 'internalAttachmentDownload') throw Error('只允许下载')
    expect(cmd.roomId).toBe('r')
    return {...grant, attachmentId:cmd.attachmentId, objectKey:`private/chatroom-v2/r/${cmd.attachmentId}`}
  }, download:async g => new Response(new Uint8Array([1,2]),{headers:{'content-type':g.attachmentId === 'photo' ? 'image/png' : 'application/pdf'}}) })
  expect(await transfer.downloadInvocationFiles('r',['file','photo'],()=>{})).toEqual([{mimeType:'image/png', bytes:new Uint8Array([1,2])}])
})


test('群里的 Word 即便是通用 MIME，也能凭 COS 原文件名交给当前调用',async()=>{
  const transfer=createAttachmentTransfer({revision:()=>1,command:async()=>grant,download:async()=>new Response(new Uint8Array([1,2]),{headers:{'content-type':'application/octet-stream','x-cos-meta-original-name':encodeURIComponent('原稿.docx')}})})
  expect(await transfer.downloadInvocationFiles('r',['att-1'],()=>{})).toEqual([{name:'原稿.docx',mimeType:'application/octet-stream',bytes:new Uint8Array([1,2])}])
})
