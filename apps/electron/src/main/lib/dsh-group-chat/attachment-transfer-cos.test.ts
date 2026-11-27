import { afterAll, expect, mock, test } from 'bun:test'
const now = Math.floor(Date.now() / 1000)
const grant = {attachmentId:'att-1', bucket:'test-123456',region:'ap-shanghai',objectKey:'private/chatroom-v2/r/att-1', credentials:{tmpSecretId:'id',tmpSecretKey:'key',sessionToken:'token',startTime:now,expiredTime:now+600}}
let uploadParams: Record<string, unknown> = {}
let urlParams: Record<string, unknown> = {}
mock.module('cos-nodejs-sdk-v5', () => ({default: class {
  async putObject(params: Record<string,unknown>) { uploadParams = params; return {ETag:'"etag"'} }
  getObjectUrl(params: Record<string,unknown>, callback: (error: null, result: {Url:string}) => void) { urlParams = params; callback(null,{Url:'https://test-123456.cos.ap-shanghai.myqcloud.com/private/chatroom-v2/r/att-1?signature=private'}) }
}}))
const { createAttachmentTransfer } = await import('./attachment-transfer')
const originalFetch = globalThis.fetch
afterAll(() => {globalThis.fetch = originalFetch; mock.restore()})
test('COS SDK 上传保存原始文件名 metadata，下载使用 HTTPS 签名并读取响应头', async () => {
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe('error')
    return new Response(new Uint8Array([1]), {headers:{'content-type':'image/png','x-cos-meta-original-name':encodeURIComponent('图片.png')}})
  }) as typeof fetch
  const transfer = createAttachmentTransfer({revision:()=>1,command:async command => command.action === 'internalAttachmentFinalize' ? {data:{attachmentId:'att-1',roomId:command.roomId,sizeBytes:command.sizeBytes,sha256:command.sha256,status:'ready'}} : {data:grant}})
  expect(await transfer.upload({roomId:'r', name:'图片.png',mimeType:'image/png',bytes:new Uint8Array([1])})).toEqual({id:'att-1'})
  expect(uploadParams['x-cos-meta-original-name']).toBe(encodeURIComponent('图片.png'))
  expect(uploadParams.ContentType).toBe('image/png')
  expect(await transfer.download({roomId:'r',attachmentId:'att-1'})).toEqual({bytes:new Uint8Array([1]),name:'图片.png',mimeType:'image/png'})
  expect(urlParams).toMatchObject({Bucket:'test-123456',Region:'ap-shanghai',Key:'private/chatroom-v2/r/att-1',Sign:true,Protocol:'https:'})
})
