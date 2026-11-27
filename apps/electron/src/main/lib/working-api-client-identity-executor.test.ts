import { expect, test } from 'bun:test'
import { WorkingApiClient } from './working-api-client'

test('Given 启动时缓存账号尚未准备 When Rust 认证状态补齐 Then 通知执行器重试绑定', async () => {
  const store = {getToken:()=>null,getRefreshToken:()=>null,getUser:()=>null,save:()=>{},clear:()=>{}}
  const client = new WorkingApiClient({tokenStore:store,baseUrl:'http://127.0.0.1:51730',fetchImpl:async()=>new Response(JSON.stringify({authenticated:true,user:{id:7}}),{status:200})})
  const seen:(string|null)[]=[];const unsubscribe=client.subscribeIdentity(()=>seen.push(client.getCachedUser() ? String(client.getCachedUser()!.id) : null))
  expect(client.getCachedUser()).toBeNull();await client.getAuthState();expect(seen).toEqual(['7']);unsubscribe()
})
