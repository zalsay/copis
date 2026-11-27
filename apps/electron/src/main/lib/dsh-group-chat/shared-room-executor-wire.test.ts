import { test, expect } from 'bun:test'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SharedRoomExecutor } from './shared-room-executor'

test('Given edu-api wire 帧 When 真实 WebSocket 完成恢复和私有 ACK Then 单次提交并发送完成', async () => {
  const server = new WebSocketServer({port:0,host:'127.0.0.1'}); await new Promise<void>(r=>server.once('listening',r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 WebSocket 未分配 TCP 端口')
  const port = address.port, frames:any[]=[]; let calls=0; let authorization=''
  let finish!:()=>void; const done = new Promise<void>(r=>finish=r)
  server.on('connection',(socket:WebSocket,req:IncomingMessage)=>{
    authorization=String(req.headers.authorization)
    socket.on('message',(raw:RawData)=>{
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(new Uint8Array(raw))
      const frame=JSON.parse(bytes.toString('utf8'));frames.push(frame)
      if(frame.type==='subscribe') {
        socket.send(JSON.stringify({type:'room.snapshot',roomId:'r',payload:{room:{roomId:'r',hostUserId:1,roomKind:'dsh_shared',status:'active'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomId:'r',roomAgentId:'a',ownerUserId:1}]}}))
        socket.send(JSON.stringify({type:'room.recovery_ready',roomId:'r',payload:{}}))
      } else if(frame.type==='agent.ready') {
        socket.send(JSON.stringify({type:'command.ack',roomId:'r',payload:{requestId:frame.payload.requestId,command:frame.type,ok:true}}))
        socket.send(JSON.stringify({type:'agent.invocation',roomId:'r',payload:{invocationId:'inv',targetAgentId:'a',triggerMessageId:'msg',depth:0,sender:{type:'user',id:'2'},messages:[{messageId:'msg',sender:{type:'user',id:'2'},text:'@助手 你好',mentionedAgentIds:['a']}]}}))
      } else if(['agent.accepted','agent.running','agent.completed'].includes(frame.type)) {
        const status=frame.type.slice(6)
        socket.send(JSON.stringify({type:'command.ack',roomId:'r',payload:{requestId:frame.payload.requestId,command:frame.type,invocationId:'inv',ok:true,status}}))
        if(status==='completed') finish()
      }
    })
  })
  const dir=mkdtempSync(join(tmpdir(),'room-wire-'))
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'dev',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'助手'},{socket:()=>new WebSocket(`ws://127.0.0.1:${port}/api/chatrooms/v2/ws`,{headers:{Authorization:'Bearer test-token'}}),openModel:async()=>({submit:async()=>{calls++;return '回答'},revoke:async()=>{}}),journalDir:dir})
  try {
    await executor.start(); await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('wire timeout')),3000))])
    expect(authorization).toBe('Bearer test-token');expect(frames.map(x=>x.type)).toEqual(['subscribe','agent.ready','agent.accepted','agent.running','agent.completed']);expect(calls).toBe(1)
    expect(frames.at(-1).payload).toMatchObject({invocationId:'inv',content:'回答',mentionAgentIds:[],attachmentIds:[]})
  } finally {await executor.stop();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
})
