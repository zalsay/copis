# 聊天室 v2 清理、投递与终态恢复补充设计

日期：2026-09-23
状态：待书面确认

本设计补齐已批准的《Copis 多 Agent 聊天室设计》中的三个可靠性缺口，不改变分享码、Agent 数量、深度限制、权限或消息 `seq` 规则。实现涉及 ai-education 的 edu-api 与 Copis 的 Rust 网关、Renderer；不修改 `AGENTS.md`、`README.md`，不部署。

## 1. 异步清理进入运行态

edu-api 在数据库初始化完成后启动一个可取消的聊天室维护 worker，启动时立即运行，之后按固定间隔重试。每轮先调用现有 `CleanupExpiredPendingAttachments`，再调用 `CleanupDeletingRooms`；单项失败记录中文错误日志，不阻止下一轮，也不把 COS 删除放在数据库事务内。现有存储层的 claim、状态校验和幂等标记仍是权威边界。worker 只处理 edu-api 元数据和授权对象，绝不删除主理人客户端本地目录。测试覆盖启动执行、周期重试、取消退出，以及失败不阻断另一项清理。

## 2. 定向投递失败与未确认调用

`SendToDevice` 只有至少一个匹配目标的活连接成功入队时才返回成功；无房间、无目标连接或全部发送队列不可用时返回明确的离线/背压错误。HTTP 与 WS 消息提交后，投递失败使用服务端受信任的原子状态转移，仅把仍为 `created` 的 invocation 标为 `failed`、错误码 `agent_offline`，再广播 `agent.failed`。已 `accepted` 或已到终态的调用不得被迟到的失败覆盖。目标解析和 payload 构建失败分别留下明确诊断；无效 payload 使用既有 `invalid_invocation` 终态。

入队不等于客户端已收到。维护 worker 另行扫描创建超过 30 秒仍为 `created` 的 invocation，原子失败并发布 `agent.failed`；这只是防止断线竞态留下永久待办，不排队或重新执行 Agent。在线但超过 30 秒未确认也按本次调用失败处理。失败广播若遇断线，由第 3 节的终态补拉恢复。

## 3. 重连后补拉终态

不把 invocation 终态改成占用消息 `seq` 的公开 RoomEvent，也不把房间全部历史终态塞进无界 `room.snapshot`。edu-api 新增仅活跃成员可调用的分页只读接口 `GET /api/chatrooms/v2/rooms/:room_id/invocations/terminal`，返回最小公开字段：`invocationId`、`roomId`、`traceId`、`targetAgentId`、`triggerMessageId`、`depth`、`status`、可选 `failureCode` 和 `finishedAt`。按不可变 `invocationId` 排序，用严格向前的游标分页；拒绝跨房间访问，不返回设备哈希、对象 key 或内部错误。

edu-api 完成某房间 WS 订阅和两次消息游标补拉后，发送一个不占 `seq` 的 `room.recovery_ready` 标记。Rust 网关校验并转发该标记；Renderer 收到后，通过本地 Rust HTTP facade 分页补拉该房间的全部终态，合并到 Jotai 的 invocation 状态。实时流先建立、终态后读取，因此查询过程中新增的终态也会经实时事件送达；重复终态按 invocation ID 幂等合并。首次连接与每次重连都执行补拉，旧客户端忽略新标记也不影响消息链路。补拉失败只标记该房间恢复失败并随重连重试，不能伪称已同步。

## 验收与边界

- Given 删除房间或 pending 附件过期，When worker 执行，Then COS 对象和对应远端元数据进入终态；失败后下轮可重试，本地目录不受影响。
- Given 主理人设备在事务提交后断开，When 定向发送找不到可用接收者，Then invocation 立即失败为 `agent_offline`；入队后未在 30 秒内 `accepted` 的调用最终失败，且不启动第二次执行。
- Given 成员断线期间错过 `agent.failed` 或 `agent.completed`，When 房间订阅 ready 后补拉，Then 页面恢复准确终态；非成员不能读取，分页不能漏项或无限循环。
- Go、Rust 和 Renderer 各有定向回归测试；运行现有相关测试和构建检查。既有与本修复无关的 edu-api 测试失败单独列出，不伪报全套通过。
