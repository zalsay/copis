# 聊天室 Delta 帧身份兼容扩展

日期：2026-09-30。用户已确认独立能力与源端稳定公开 frameId 方案。本设计是 `2026-09-28-chatroom-online-execution-repair-design.md` 的补充，不改变 Agent 执行权限、COS、房间配置或离线不排队规则。实现与测试由 Luna Worker 按任务完成，root review/独立验证；不提交、推送、合并、部署或改实际 flags。

## 问题与目标

现 `agent.delta` 只有 `invocationId`、`delta`，不含持久 seq。两个相同内容的合法片段与同帧重复传输不可区分。不能按文本去重，不能借用全局持久事件 cursor。源端需要给一个已经授权并接受的 delta 广播生成一次稳定公开身份，接收端按该身份应用一次。

## 协商与兼容

- 能力精确名称：`agent-delta-frame-id-v1`。
- 与 `agent-ready-v1`、`invocation-ack-v1` 独立；本能力只选择接收格式，不能授权 SDK、声明 ready、改变 invocation 状态或设备认领。
- E 默认 `DeltaFrameID=false`，Native 默认正式协议 opt-in 仍关闭。Task7e 会补正式 typed config，当前只测试显式 options，不编辑真实 `.env`。
- 新接收者必须在同一 WS 的订阅请求、服务端支持列表及初始 room snapshot 回显中实际选中此能力。HTTP 广告本身不等于选中。
- 同一广播中，选中者接收 `{ invocationId, delta, frameId }`，未选中者接收原 `{ invocationId, delta }`。不在 shared legacy payload 上直接加字段，不向旧严格解析器发送未知字段。
- Native 可解析受限可选字段，但只允许当前已选中 socket 的 ID 模式进入公开 SSE；legacy 无 ID 继续按到达顺序追加，不声称能识别 legacy wire 重复。

## 帧身份与服务端来源

- `frameId` 精确为 32 位小写十六进制，来自 `crypto/rand` 16 bytes；不包含 user、device、executor、requestId、ACK、路径、内容摘要或时间戳。
- E 在 `agent.delta` 的现有成员、owner/device、executor、状态验证成功之后，为一次广播生成一次 ID。所有新能力接收者拿到相同 ID；投递、克隆、SSE 转发或同一事件再分发时保留该 ID。
- 这是已接受的**广播事件身份**，不是 host 命令幂等键。两个独立合法命令即使文本相同，也生成不同 ID；本扩展不把不可识别的命令重提交当成同一帧。
- 随机源失败则不广播无身份的新格式，不降级或伪造 ID；沿现有错误处理返回失败，完整最终回复仍由现有完成协议保存。
- 新能力选择存到 Hub 能访问的每连接客户端状态；只在 `agent.delta` 投递时使用专用 projector，不能改变其它事件、私有 ACK 或调用路由。
- Hub 不持锁等待 SQL、网络或实际发送；两种 wire event 构造一次，逐接收者选用。沿现有 queue/backpressure/detach 行为。

## Native 与 Renderer

Native 的 capability 枚举/解析、WS 初始 snapshot 交集、transient delta 校验及公开 SSE 保留可选 frameId。缺失、未知能力或旧服务端 404 不开启新格式。已选择 ID 模式却收到非法 ID，或未选择却收到 ID，安全拒绝该帧；不改 Main delta 命令、模型适配器或私有生命周期确认。

多房间初始握手采用有界 FIFO：snapshot 继续进入内部收集/一致性判断；在全套同代初始 snapshot 完成前，面向观察者的后续事件（不只是 delta，包含同 invocation 终态/调用）缓冲，选择确认后按 wire 到达顺序释放。控制级 ACK 可按原 request/generation 校验处理，不因此改变 SDK 准入。每 socket 最多256事件及1,048,576原始JSON bytes；任一超限、初始cap不一致/无效、断线或generation变化时关闭该socket、清缓冲/原pending并沿既有恢复机制，不释放旧事件。缓冲仅限已连接握手窗口，不是离线任务队列；不按房间提前授予全socket能力。

Renderer 的去重键是当前账号/房间生命周期内的 `(roomId, invocationId, frameId)`。SSE/socket 代际仍在上层过滤；重连不会清掉同一 invocation 的已观察 ID，防止同帧重传重复追加。账号重置、房间删除/重入和真实 invocation 终态清理专属集合，不跨房间/账号共享。

- 同 ID、同 delta：忽略第二次，不重置 startedAt、不重复 unread、不变终态。
- 不同 ID、相同 delta：都保留（例如 `哈` + `哈`）。
- 同 ID、不同 delta：不追加冲突文本，标记仅本地流式预览诊断；不伪造服务端 failed、不运行或重跑模型。真实最终回复可结束该本地提示。
- legacy 无 ID：保留原顺序追加；不基于内容、时间或显示名猜身份。
- 终态后迟到 delta：保持已确认终态，不重建运行指示器或 delta 集合。

## 有界预览状态

frame ID 去重集合每 invocation 上限 8,192，当前账号全局上限 32,768。只管理活跃预览，完成/失败/删除/重置释放集合。达到上限时暂停该 invocation 的增量预览，保留已显示文本及真实运行状态，并明确提示“流式预览已暂停，等待完整回复”；不驱逐已见 ID 后再允许它追加，也不影响完整回复落库、工具运行或 Main pending 结果。

这是一项内存安全工程边界，不是模型输出限制。完整回复仍以现有 `message.created`/completed 确认源展示。local preview 字段只在 Renderer 状态，不能发回服务端，也不传到 Main 执行 DTO。

## 验收

1. 同一房间包含新能力接收者和 legacy 接收者，同一次 delta 广播前者有合法 ID、后者精确旧 payload；其它事件完全不变。
2. 两个合法相同文本片段有不同 ID；重发同一个带 ID 事件只追加一次；同 ID 改内容拒绝预览，不伪造终态。
3. requested/supported/selected 交集与跨 socket、未收齐多 room snapshot 规则保持；第三能力不激活 ready/ACK 或 SDK。
4. Native 严格拒绝错误类型/格式/额外私有字段，legacy 通路仍成功；public SSE 不含 private proof。
5. Renderer 跨账号、房间、socket 迟到帧无污染，重连保持去重，终态单调；集合边界不丢完整回复、不无限增长。
6. 所有测试用临时目录、隔离 PG 32768、miniredis/假服务；无用户 Native 51730/51740、真实 Memory/COS/模型或业务 DB 请求。Bun 每 file 独立进程、网络 trap 必须 attempts=0。
7. 不更改 README/AGENTS；最终由用户在真实 Electron 窗口验收，不能用截图替代。

## Ruling 与风险

Ruling: 使用随机事件 ID 与有界预览集合，不额外设计持久 delta 日志/累计全文协议 — 现系统 transient 不重放历史，随机 ID 可保持同一广播身份且不改变 token 语义 — 成本是旧协议无法无损去重、极长预览会暂停而等待完整回复；必须明确提示，不能声称无限流式保障。

实际部署 Hub 路由、正式 flags 开启与回滚仍是原 Task7 发布门禁。本补充的用户确认不是发布或 production mutation 授权。
