import { describe, expect, test } from 'bun:test'
import { readRoomInvocation } from './shared-room-invocation'

describe('共享群定向调用边界', () => {
  const binding = { roomId: 'room-1', roomAgentId: 'agent-1' }
  const message = () => ({ messageId: 'msg-1', sender: { type: 'user', id: '1', displayName: 'A' }, mentionedAgentIds:['agent-1'], text: '群消息' })
  const event = () => ({
    type: 'agent.invocation', roomId: 'room-1', payload: {
      invocationId: 'inv-1', depth:0, sender:{type:'user',id:'1'}, targetAgentId: 'agent-1', triggerMessageId: 'msg-1',
      messages: [message()] as [ReturnType<typeof message>],
    },
  })
  test('Given 可信绑定和目标消息 When 收到定向调用 Then 只提取该群触发文本', () => {
    expect(readRoomInvocation(binding, event())).toEqual({ invocationId: 'inv-1', text: '群消息' })
  })
  test('拒绝其他群、其他智能体、缺少触发消息和非文本', () => {
    const otherRoom = event(); otherRoom.roomId = 'room-2'
    const otherAgent = event(); otherAgent.payload.targetAgentId = 'agent-2'
    const noTrigger = event(); noTrigger.payload.triggerMessageId = 'msg-2'
    const noText = event(); noText.payload.messages[0].text = ' '
    for (const input of [otherRoom, otherAgent, noTrigger, noText]) expect(readRoomInvocation(binding, input)).toBeNull()
  })
  test('只采纳被 @ 的触发消息的附件，不接收历史消息或伪造地址', () => {
    const frame = event()
    const trigger = { ...message(), attachmentIds:['img-1','img-2'] }
    const read = (ids: unknown) => readRoomInvocation(binding, { ...frame, payload:{...frame.payload, messages:[
      {...message(), messageId:'older', attachmentIds:['private-old']}, {...trigger, attachmentIds:ids},
    ]} })
    expect(read(trigger.attachmentIds)?.attachmentIds).toEqual(['img-1','img-2'])
    for (const bad of [['../private'], ['img-1','img-1'], [3], Array(21).fill('a'), 'url']) expect(read(bad)).toBeNull()
  })
  test('允许服务端合法的标点调用标识', () => {
    const input = event(); input.payload.invocationId = 'inv.1:2'
    expect(readRoomInvocation(binding, input)?.invocationId).toBe('inv.1:2')
  })
  test('拒绝重复触发消息和非公开发送者类型', () => {
    const duplicate = event(); duplicate.payload.messages.push(duplicate.payload.messages[0])
    const privateMessage = event(); privateMessage.payload.messages[0].sender.type = 'private'
    expect(readRoomInvocation(binding, duplicate)).toBeNull()
    expect(readRoomInvocation(binding, privateMessage)).toBeNull()
  })
})

test('Given 其他 agent 触发 When 收到自动调用 Then 拒绝执行', () => {
  const frame = {type:'agent.invocation',roomId:'r',payload:{invocationId:'i',targetAgentId:'a',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'agent'},text:'自动调用'}]}}
  expect(readRoomInvocation({roomId:'r',roomAgentId:'a'},frame)).toBeNull()
})

test('Given 触发文本没有 @ 当前 agent When 收到定向事件 Then 拒绝执行', () => {
  const frame = {type:'agent.invocation',roomId:'r',payload:{invocationId:'i',targetAgentId:'a',triggerMessageId:'m',depth:0,sender:{type:'user',id:'1'},messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['other'],text:'普通消息'}]}}
  expect(readRoomInvocation({roomId:'r',roomAgentId:'a'},frame)).toBeNull()
})
test('Given 合法 @ 但文本超过模型上限 When 解析 Then 保留调用以便协议明确失败而非静默丢弃', () => {
  const frame={type:'agent.invocation',roomId:'r',payload:{invocationId:'i',targetAgentId:'a',triggerMessageId:'m',depth:0,sender:{type:'user',id:'1'},messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['a'],text:'x'.repeat(32769)}]}}
  expect(readRoomInvocation({roomId:'r',roomAgentId:'a'},frame)?.invocationId).toBe('i')
})
