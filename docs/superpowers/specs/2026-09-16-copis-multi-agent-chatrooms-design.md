# Copis 多 Agent 聊天室设计

日期：2026-09-16

状态：设计已确认，等待规格审阅

## 1. 目标

在 Copis 左侧菜单新增多人聊天室能力。已登录账号可以创建聊天室并成为主理人，
通过 4 位字母或数字分享码邀请其他 Copis 用户直接加入。主理人可以从自己的现有
工作区派生最多 3 个聊天室 Agent；真人成员或 Agent 都可以通过结构化 `@` 唤起一个
或多个 Agent。

聊天室的成员、消息、事件、分享码和附件元数据由 edu-api 持久化；聊天室 Agent 的
session、执行文件、来源工作区绑定和授权配置保存在主理人客户端的专属本地工作区。
实时消息复用并扩展 edu-api 现有 WebSocket 能力，Copis 仍保持 Rust 是 edu-api 的
唯一认证网络出口。

## 2. 已确认的产品约束

- 分享码由主理人创建，为 4 位 `[A-Z0-9]`，输入不区分大小写，服务端统一转为大写。
- 已登录用户输入有效分享码后直接加入，无需主理人审批。
- 一个聊天室最多添加 3 个 Agent，可以来自不同现有工作区。
- 聊天室 Agent 是独立实例，不复用来源工作区的既有会话。
- 每个 Agent 拥有独立 session 和执行目录，默认读取当前消息及最近 50 条聊天室消息。
- 主理人可以调整 Agent 上下文消息数量。
- 一条消息可以同时 `@` 多个 Agent，被提及的 Agent 并行执行并分别回复。
- Agent 回复可以继续结构化 `@Agent`；同一调用链最多 3 跳，且每个 Agent 最多执行一次。
- 主理人客户端离线时，Agent 调用立即失败并显示离线，不排队、不延迟执行。
- 主理人可以分别决定是否向某个聊天室 Agent共享来源工作区记忆与 Skill。
- 共享只允许 Agent 在回答中使用能力，其他成员不能查看或下载原始记忆与 Skill。
- 敏感工具授权只能由主理人客户端批准，其他成员不能代批。
- edu-api 签发短期、最小权限 COS STS；Copis 客户端使用现有 COS SDK 直传直下。
- Agent 的本地生成文件不会自动上传，只有明确发送到聊天室的文件才进入 COS。

## 3. 当前事实

### 3.1 Copis

- `native/http-api-server` 已持有 `AuthSession`，浏览器与 Electron 的 edu-api 请求经本机
  Rust Gateway 转发，Renderer 和 Electron 不持有 Working JWT。
- Rust HTTP API 当前基于 `TcpListener` 提供本机 HTTP/SSE 能力，尚未提供远端聊天室
  WebSocket 客户端。
- Electron 已有 Agent Orchestrator、AgentSessionManager、AgentWorkspaceManager、全局
  Agent 事件监听与按工作区隔离的 Memory/Skill 能力。
- Renderer 全部业务状态使用 Jotai；左侧菜单与标签页系统已经存在。
- 根依赖已有 `cos-nodejs-sdk-v5@3.0.0`，本功能复用该依赖，不新增 COS SDK。

### 3.2 edu-api

- 现有 `/api/chatroom/:room_id/ws` 支持家庭聊天室、成员广播、消息持久化和单个 `@Pi`。
- 当前 `ChatRoom` 强绑定 `FamilyID`，没有通用主理人、分享码、多 Agent、事件游标或
  客户端幂等模型。
- 当前 WebSocket 用查询参数 JWT 鉴权。Copis 不直接采用该模式，由 Rust AuthSession
  代表本机客户端建立连接。
- edu-api 已有 COS STS 签发、按对象前缀限制读写权限及 `HEAD` 校验能力，可复用为
  聊天室附件授权基础。

## 4. 非目标

- 第一版不支持转让主理人。
- 第一版不允许普通成员添加或配置 Agent。
- 第一版不把聊天室内容自动写回来源工作区长期记忆。
- 第一版不共享 Agent 的原始 session、思考内容、记忆条目或 Skill 文件。
- 第一版不提供 Agent 调用排队；主理人设备或 Agent 离线即终止本次调用。
- 第一版不让多个 Agent 共享同一个可写执行目录。
- 不改变旧家庭聊天室前端和既有接口的行为。
- 本设计阶段不修改 `AGENTS.md` 或 `README.md`；功能实现导致状态变化时另行取得用户
  许可后同步文档。

## 5. 总体架构

```text
Copis Renderer
  |- 左侧聊天室列表、房间界面、Jotai 状态
  `- 本机 HTTP 发命令 / SSE 收事件
                |
                v
本机 Rust ChatRoomGateway
  |- 持有 AuthSession，维护 edu-api WebSocket
  |- 重连、游标补偿、幂等和事件顺序
  |- 请求聊天室 HTTP API 与 COS STS
  `- 不向 Electron Main 或 Renderer 暴露 Working JWT
                |
                v
edu-api Chatroom v2
  |- 房间、成员、分享码、Agent 公共信息
  |- 消息、事件、调用链和附件元数据
  |- WebSocket 广播与定向 Agent invocation
  `- 签发限定对象 Key 的 COS STS
                |
                v
Electron Main ChatRoomAgentCoordinator
  |- 接收 Rust 转发的定向 invocation
  |- 调用现有 Agent Orchestrator
  |- 管理聊天室本地 workspace/session
  |- 发起主理人权限审批
  `- 将流式 Agent 事件交给 Rust 回传 edu-api
```

### 5.1 选型理由

采用“Rust 维护远端 WebSocket，Renderer 使用本机 HTTP + SSE”的结构：

- 继续使用 edu-api 现有 WebSocket 实时链路；
- 保持 Working JWT 只属于 Rust AuthSession；
- 聊天室页面卸载后仍能维持 Agent 在线与后台调用；
- 复用 Rust 已有本机 HTTP/SSE、重连和错误映射边界；
- Electron Main 只负责本地 Agent、文件和权限，不重新成为 edu-api 认证出口。

COS 是单独的受限数据通道。edu-api 只把短期 STS 返回到本机 Rust，再交给 Electron
Main 中的 COS SDK 完成单对象上传或下载；Renderer 只接收进度与结果，不直接持有
Working JWT、COS 长期密钥或本地绝对路径。

## 6. 信任与所有权边界

| 数据或能力 | 权威来源 | 可见范围 |
|---|---|---|
| 房间、成员、消息、事件、分享码 | edu-api | 当前房间成员 |
| Agent 公共名称、头像、在线/执行状态 | edu-api | 当前房间成员 |
| Agent 来源工作区、设备绑定、本地路径 | 主理人客户端 | 主理人本机 |
| Agent session 与执行文件 | 主理人客户端 | 对应房间 Agent |
| 来源记忆与 Skill 内容 | 主理人客户端 | 获授权的对应 Agent，只读 |
| 附件对象 | 私有 COS Bucket | 持有效 STS 的当前成员 |
| Working JWT | Rust AuthSession | Rust 进程 |
| COS 长期密钥 | edu-api 服务端环境 | edu-api 服务端 |
| 敏感工具批准 | 主理人 Electron Main | 主理人本人 |

每个 Copis 安装生成稳定 `deviceId`。聊天室 Agent 绑定“主理人用户 ID + deviceId”，
避免主理人多设备在线时重复执行。设备标识不向普通成员显示。

## 7. edu-api 数据模型

通用聊天室使用 v2 表或等价迁移结构，不在旧家庭聊天室字段上继续堆叠可空语义。
旧 `ChatRoom`、`ChatRoomMember`、`ChatRoomMessage` 保留用于兼容现有家庭聊天室。

### 7.1 Room

关键字段：

- `room_id`：服务端 UUID，公开稳定标识。
- `name`：房间名称。
- `host_user_id`：主理人账号。
- `share_code`：标准化大写的 4 位 `[A-Z0-9]`，活跃或归档房间范围内唯一。
- `share_code_enabled`：是否允许使用当前码加入。
- `status`：`active | archived | deleting | deleted`。
- `next_seq`：房间事件单调递增序号的分配源。
- `created_at`、`updated_at`、`archived_at`。

分享码不是房间主键。更换分享码时旧码立即失效；关闭分享码不影响已有成员。
服务端使用唯一索引处理随机码冲突，不依赖先查后写。

### 7.2 Member

关键字段：

- `room_id`、`user_id` 唯一组合；
- `role`：`host | member`；
- `status`：`active | left | removed`；
- `joined_at`、`last_read_seq`。

在线状态是 WebSocket 连接派生的临时状态，不作为授权依据。退出或被移除后，所有
HTTP、WebSocket、历史和 STS 请求立即重新校验成员状态。

### 7.3 Agent

edu-api 只保存公共注册信息：

- `room_agent_id`：服务端生成 UUID；
- `room_id`、`owner_user_id`、`device_id_hash`；
- `display_name`、`avatar`；
- `status`：`online | busy | offline | disabled`；
- `lease_expires_at`：客户端心跳租约；
- `created_at`、`updated_at`。

同一房间的 Agent 名称不区分大小写且不可重复，房间最多 3 个。来源工作区 ID、
模型凭据、本地路径、记忆策略详情和 Skill 内容不得上传。

### 7.4 Message 与 RoomEvent

消息字段：

- `message_id`、`room_id`、`seq`；
- `sender_type`：`user | agent | system`；
- `sender_user_id` 或 `sender_agent_id`；
- `content`；
- `mention_agent_ids`：结构化 Agent ID 数组；
- `attachment_ids`；
- `client_message_id`：发送端生成的 UUID；
- `trace_id`、`parent_message_id`、`depth`；
- `created_at`。

`(room_id, sender identity, client_message_id)` 建立唯一约束，保证断线重发幂等。
每条已提交消息同时生成带同一 `seq` 的持久化房间事件。非消息管理事件也进入统一
`RoomEvent` 流，使客户端能按 `after_seq` 补拉缺口。

### 7.5 AgentInvocation

关键字段：

- `invocation_id`、`room_id`、`trace_id`；
- `target_agent_id`、`trigger_message_id`；
- `depth`：真人起始消息为 0，Agent 继续调用时加 1；
- `status`：`created | accepted | running | completed | failed | rejected`；
- `failure_code`；
- `created_at`、`accepted_at`、`finished_at`。

`(trace_id, target_agent_id)` 唯一，保证一个 Agent 在同一调用链最多执行一次。
服务端只在 `depth < 3` 时创建下一跳 invocation；超过限制时保留消息内容并生成
`invocation_limit_reached` 系统事件，不再调用。

### 7.6 Attachment

关键字段：

- `attachment_id`、`room_id`、`uploader_user_id`；
- `object_key`：服务端生成，不接受客户端自选；
- `original_name`、`mime_type`、`size_bytes`、`sha256`、`etag`；
- `status`：`pending | ready | attached | deleted`；
- `message_id`、`created_at`、`expires_at`。

客户端和聊天室消息不暴露 `object_key`，只使用 `attachment_id`。

## 8. HTTP 与实时协议

具体 URL 可在实现计划中按 edu-api 现有路由风格落位，但契约必须覆盖以下能力：

- 创建、列表、读取、更新、归档、恢复和永久删除房间；
- 使用分享码直接加入、退出、移除成员和更新已读序号；
- 创建、更名、移除 Agent 和续租 Agent 在线状态；
- 分页读取消息与按 `after_seq` 补拉事件；
- 为消息生成 `client_message_id` 幂等写入；
- 创建附件上传授权、完成校验、下载授权和消息绑定；
- Rust 使用 AuthSession 建立的聊天室 v2 WebSocket。

### 8.1 WebSocket 连接

Rust 使用 AuthSession 当前 access token 建立远端连接；token 只用于握手，不下发给
Electron Main 或 Renderer。连接注册 `deviceId` 和已订阅房间，重连时携带各房间最后
确认的 `seq`。

服务端必须校验当前用户确实是订阅房间成员；Agent invocation 还必须验证 Agent 的
`owner_user_id` 与连接用户一致、设备哈希匹配且租约有效。

### 8.2 事件类型

- `room.snapshot`：首次连接的房间、成员、Agent 与最新序号快照；
- `message.created`：用户、Agent 或系统消息已持久化；
- `member.presence_changed`、`agent.presence_changed`；
- `agent.invocation`：只定向到绑定主理人设备；
- `agent.accepted`、`agent.delta`、`agent.completed`、`agent.failed`；
- `room.updated`、`member.removed`、`agent.updated`；
- `attachment.updated`。

`agent.delta` 是临时流式事件，不作为最终消息历史；`agent.completed` 必须对应一条
已持久化的 Agent 消息。断线重连通过 `message.created` 和 invocation 最终状态恢复，
不要求补发每个 delta。

### 8.3 可靠性

- Rust 按房间记录最后连续处理的 `seq`，发现跳号时暂停应用后续事件并补拉缺口。
- 发送超时不等于失败；客户端用相同 `client_message_id` 查询或重试。
- edu-api 只有在 Agent 租约在线时创建 invocation；离线时原消息照常创建，同时产生
  `agent_offline` 结果，不形成待办。
- invocation 需要主理人客户端发送 `accepted` 后才能进入 running；重复投递只返回
  当前状态，不能再次启动 Agent。
- Rust 重连采用有上限的指数退避；鉴权失效交给 AuthSession 单次 refresh，再失败则
  关闭实时连接并通知 UI 登录失效。

## 9. 本地 ChatRoomGateway 与 Agent 协调器

### 9.1 Rust ChatRoomGateway

职责：

- 建立、维护和关闭 edu-api WebSocket；
- 通过 AuthSession 完成鉴权与 refresh；
- 维护订阅房间、事件游标、心跳和 Agent 租约；
- 将远端事件映射为本机 SSE；
- 接收本机 HTTP 命令并写回 WebSocket 或 edu-api HTTP；
- 过滤远端响应，避免 JWT、STS 和对象 Key进入普通 Renderer 事件；
- 将定向 invocation 通过现有受信任 Electron/Rust bridge 交给 Main 协调器。

Renderer 关闭聊天室页面不影响 Gateway 生命周期。退出登录、主理人移除 Agent、
关闭房间或应用退出时必须释放订阅和租约。

### 9.2 ChatRoomAgentCoordinator

职责：

- 校验 room/agent 本地绑定与 invocation 幂等状态；
- 并行启动一条消息中多个 Agent，彼此不阻塞；
- 使用现有 Agent Orchestrator 执行，复用流式事件、停止、权限和错误处理；
- 构建聊天室上下文并清理本地路径、环境变量和内部日志；
- 识别 Agent 输出中的结构化 Agent mention，创建下一跳消息与 invocation；
- 将 `accepted/delta/completed/failed` 经 Rust 发回 edu-api；
- 应用退出或连接丢失时停止尚未完成的聊天室 Agent 运行，不转为离线队列。

结构化 mention 由 Agent 输出协议产生，例如独立的 `mentionedAgentIds` 字段。仅在文本中
出现 `@名称` 不触发调用，防止模型无意唤起或名称歧义。

## 10. 本地工作区、session、记忆与 Skill

每个房间建立一个不出现在普通项目列表中的托管目录：

```text
~/.copis/agent-workspaces/chatrooms/{roomId}/
|- room.json
|- shared/
`- agents/
   `- {roomAgentId}/
      |- sessions/
      |- workspace-files/
      |  `- project/
      |     `- inbox/
      `- skills-snapshot/
```

### 10.1 `room.json`

只保存本地信息：

- 房间 ID、主理人账号 ID 和本机 deviceId；
- roomAgentId 到来源工作区 ID 的映射；
- Agent 名称、模型与基础配置快照；
- 上下文消息数量，默认 50；
- 记忆共享、Skill 共享开关；
- Skill 快照版本或摘要；
- 最后处理的房间事件序号与 invocation 幂等记录。

配置使用原子写入，不使用 `localStorage` 或新增本地数据库。

### 10.2 session 与上下文

- 每个 roomAgentId 使用一个独立长期 session；
- 首次唤起注入触发消息及最近 N 条房间消息，默认 N=50；
- 后续在同一 session 中只补充尚未处理的新消息；
- 上下文保留发送者类型、显示名、messageId、Agent 调用链和附件引用；
- Agent 移除后停止 session，但本地目录默认归档，不静默删除；
- 来源工作区更新不会静默改变 Agent；主理人显式执行“同步来源配置”才更新快照。

### 10.3 共享记忆

开关默认关闭。开启后：

- Agent 只获得来源工作区 scope 的 `recall/read` 能力；
- 禁止 `capture/rewrite/archive`；
- 聊天室内容不写回来源记忆；
- 工具结果只进入 Agent 私有上下文，不直接作为聊天室消息；
- 其他成员无法列出、读取、导出或下载记忆原文。

### 10.4 共享 Skill

开关默认关闭。开启或手动同步时，将来源工作区当前启用 Skill 复制到该 Agent 的
`skills-snapshot/`。运行时只从快照读取，不从来源工作区实时加载。快照目录对 Agent
只读，其他聊天室成员不可见。

## 11. 工具权限与安全

- Agent 自动读写范围仅限自己的 `agents/{roomAgentId}/workspace-files/project/`。
- 从聊天室明确下载的附件进入对应 Agent 的 `project/inbox/`。
- 工作区外文件访问、危险 Shell、外部账号、支付和其他现有敏感能力必须请求主理人。
- 权限请求向主理人展示原始发起成员、完整 Agent 调用链、目标 Agent 和操作摘要。
- 普通成员只看到“等待主理人授权”等状态，看不到本地路径、完整危险命令或凭据。
- 主理人客户端断开或授权超时，本次调用失败，不排队、不自动重试。
- Agent 输出和工具结果在进入聊天室前清理绝对路径、环境变量、内部 token、密钥和日志。
- 服务端和客户端都执行三跳、单 Agent 单 trace 一次的约束，不能只依赖一端。

## 12. COS 附件链路

### 12.1 上传

1. Electron Main 计算文件名、大小、MIME 和 SHA-256，经 Rust 请求上传授权。
2. edu-api 校验登录、活跃成员、房间状态、文件限制和用户配额。
3. edu-api 创建 `pending` Attachment 和不可预测对象 Key，仅为该 Key 签发短期写 STS。
4. Electron Main 使用现有 `cos-nodejs-sdk-v5@3.0.0` 直传 COS，并向 Renderer 推送进度。
5. Electron Main 经 Rust 调用 finalize；edu-api 使用 COS `HEAD` 校验 Key、大小和 ETag，
   同时校验 SHA-256 声明与请求绑定后将附件置为 `ready`。
6. 消息发送只引用 `ready` attachmentId；绑定成功后状态变为 `attached`。

STS 权限只允许本次对象所需的上传、分片上传和中止动作，过期时间使用服务端允许的
最短实用值。STS、TmpSecretKey、SessionToken 和对象 Key 不写日志、不持久化。

### 12.2 下载

1. 客户端使用 attachmentId 请求下载授权；
2. edu-api 重新校验当前活跃成员和附件所属房间；
3. edu-api 为单一对象签发短期 `GetObject` STS；
4. Electron Main 使用 COS SDK 下载到用户选择的位置或 Agent inbox。

Bucket 保持私有，不生成长期公开 URL。退出或被移除成员不能再次取得 STS。

### 12.3 清理

- 未 finalize 或未绑定消息的对象按过期时间异步清理；
- 永久删除房间时先进入 `deleting`，异步删除附件对象，完成后标记 `deleted`；
- Agent 本地生成文件不会自动上传，只有明确附加到 Agent 回复时才走完整上传流程；
- 删除远端房间不自动删除主理人本地工作区，避免不可恢复的数据丢失。

## 13. Renderer 信息架构与交互

采用已确认的视觉布局：

- 左侧菜单新增“聊天室”分组，标题右侧同时提供“加入”和“创建”图标按钮；
- 分组内显示房间名称、未读数和连接状态；
- 点击房间后使用现有标签页系统打开，不覆盖当前 Agent 或项目页面；
- 折叠侧栏保留聊天室入口和未读提示；
- 中央区域显示消息流和输入区，右侧面板集中显示成员与最多 3 个 Agent；
- 房间头部显示分享码、人数、Agent 状态和主理人设置入口。

### 13.1 创建与加入

创建表单包含房间名称、4 位分享码、工作区 Agent 选择、显示名、记忆共享开关和 Skill
共享开关。Agent 计数明确显示 `n/3`。加入表单只要求 4 位分享码，自动大写并允许
小写输入。

### 13.2 消息与提及

- 输入 `@` 展示结构化 Agent 候选及在线、忙碌、离线、待授权状态；
- 一条消息可选多个 Agent；发送后每个 Agent 独立显示执行状态和流式回复；
- Agent 调用 Agent 时显示调用来源；达到限制时显示“已停止继续唤起”；
- Agent 离线仍可选择，但消息创建后立即返回离线结果，不排队；
- WebSocket 断开时保留 Jotai 内存草稿并显示重连状态，不自动提交未成功消息；
- 用户手动重试复用同一 `clientMessageId`。

### 13.3 附件状态

附件显示“等待授权、上传中、校验中、完成、失败”状态。只有 finalize 成功的附件可以
随消息发送。UI 不显示 COS Key、临时凭据或 Agent 本地绝对路径。

### 13.4 权限差异

主理人可以管理分享码、成员、Agent、授权策略、归档、恢复和永久删除。普通成员只能
查看、发消息、上传下载附件和退出房间。

## 14. Jotai 与全局生命周期

新增独立 `chatroom-atoms.ts`，至少按房间隔离：

- 房间列表、当前房间和详情；
- 消息、事件游标与未读数；
- 连接与重连状态；
- 成员与 Agent presence；
- invocation 与流式 delta；
- 附件上传下载状态；
- 当前输入草稿与结构化 mention。

服务端消息、成员与 STS 不写入 `localStorage`。纯 UI 草稿和展开状态先保存在 Jotai
内存；需要跨启动持久化的本地 Agent 绑定使用 `room.json` 配置文件。

Renderer 顶层挂载全局聊天室 SSE 监听器，使未打开房间也能更新未读与执行状态。
真正的 Agent invocation 执行由 Electron Main 的 ChatRoomAgentCoordinator 承担，
不依赖 Renderer 页面或 Hook 存活。

## 15. 房间生命周期

- `active`：允许加入、发送、Agent 调用和附件操作；
- `archived`：禁止新加入、发送、上传和 Agent 调用；已有成员可查看历史并下载附件；
- 主理人可以从 archived 恢复 active；
- 更换或暂停分享码立即失效，不影响已有成员；
- 成员退出或被移除后立即失去 WebSocket、历史与 STS 权限；
- 永久删除需二次确认，进入 deleting 后不可恢复；
- edu-api 异步清理消息关系和 COS 对象；
- 主理人本地 Agent 工作区只归档，必须另行明确确认才物理删除；
- 第一版不支持转让主理人，主理人账号删除时由服务端策略先归档房间。

## 16. 错误、限流与可观测性

### 16.1 分享码防枚举

4 位 `[A-Z0-9]` 仅有 1,679,616 种组合，必须同时采用：

- 按用户 ID、IP 和设备维度限流；
- 连续错误指数冷却和短时封禁；
- 统一“分享码无效或已失效”响应，避免泄漏房间是否存在；
- 登录后才能尝试加入；
- 记录不含明文凭据的安全审计事件。

### 16.2 稳定错误码

至少覆盖 `room_not_found`、`room_archived`、`not_room_member`、
`share_code_invalid`、`share_code_rate_limited`、`agent_limit_reached`、
`agent_offline`、`agent_busy`、`invocation_duplicate`、`invocation_depth_exceeded`、
`host_approval_timeout`、`attachment_not_ready`、`attachment_forbidden` 和
`realtime_reconnecting`。

### 16.3 日志

日志只记录 requestId、roomId、messageId、traceId、invocationId、事件类型、状态码和
耗时。禁止记录 Working JWT、Authorization、STS 临时凭据、COS 长期密钥、完整消息
正文、记忆原文、Skill 内容和本地绝对路径。

## 17. 分阶段交付

### 阶段一：edu-api Chatroom v2

- 通用房间、分享码、成员、Agent、消息、事件、invocation 和附件元数据；
- 扩展 WebSocket Hub，保留旧家庭聊天室兼容；
- 加入限流、幂等、事件序号、Agent 租约和三跳防循环；
- 复用 COS STS 与 `HEAD` 校验实现附件授权。

### 阶段二：Copis Rust 实时网关

- Rust 持有上游 WebSocket 和 AuthSession；
- 本机 HTTP 命令与 SSE 事件；
- 重连、游标补偿、后台订阅、Agent 租约和 COS STS facade；
- 验证 Renderer 与 Electron Main 不获得 Working JWT。

### 阶段三：本地 Agent 协调器

- 房间专属工作区和独立 session；
- 最多 3 个 Agent 并行和 Agent 调用 Agent；
- 只读来源记忆、Skill 快照、设备绑定和主理人权限审批；
- 流式结果回传及敏感信息清理。

### 阶段四：Renderer 与 COS 交互

- 左侧聊天室分组、创建/加入、消息和成员/Agent 面板；
- Jotai 全局状态、未读、结构化 mention 和错误状态；
- Electron Main COS SDK 直传直下及进度反馈；
- 真实 Electron 应用窗口验收。

每一阶段必须形成可独立测试和回滚的交付，不把四个子系统压成一个不可验收的大改动。

## 18. BDD 验收场景

### 18.1 创建与加入

```text
Given 已登录用户创建聊天室并输入分享码 a7k2
When edu-api 保存房间
Then 分享码标准化为 A7K2，创建者成为唯一主理人

Given 另一已登录用户输入 a7K2
When 分享码有效且房间处于 active
Then 用户无需审批直接加入，并收到 room.snapshot

Given 用户连续尝试无效分享码
When 达到用户、IP 或设备限额
Then edu-api 返回统一限流错误，不泄漏任何房间是否存在
```

### 18.2 多 Agent 与调用链

```text
Given 房间已有 3 个 Agent
When 主理人尝试添加第 4 个 Agent
Then edu-api 与客户端都拒绝操作，现有 Agent 不受影响

Given 一条真人消息同时结构化提及 Agent A 与 Agent B
When 两个 Agent 均在线
Then 两个 invocation 并行执行并分别流式回复

Given Agent A 的回复结构化提及 Agent B
When 当前 trace 尚未调用 B 且 depth 小于 3
Then B 被唤起并继承同一 traceId

Given 同一 trace 已调用 Agent A 或下一跳将达到 depth 3
When 回复再次提及对应 Agent
Then 文本正常展示，但不创建新 invocation，并显示停止原因

Given 主理人设备或目标 Agent 离线
When 任意成员发送对该 Agent 的提及
Then 消息正常持久化并立即显示 agent_offline，不创建待执行任务
```

### 18.3 本地隔离与共享策略

```text
Given 主理人从现有工作区添加聊天室 Agent
When Agent 首次运行
Then 创建独立 roomAgentId session 与执行目录，不写入来源工作区会话或项目目录

Given 共享记忆开启
When Agent 查询来源工作区记忆
Then 只允许 recall/read，禁止 capture/rewrite/archive，其他成员看不到记忆原文

Given 共享 Skill 开启
When Agent 运行
Then 只加载 skills-snapshot，来源工作区后续变化不会静默改变快照

Given Agent 请求工作区外文件或危险操作
When 权限请求产生
Then 只有主理人可以批准，普通成员看不到敏感参数且不能代批
```

### 18.4 附件与权限

```text
Given 活跃成员选择文件发送
When edu-api 签发上传 STS
Then STS 只允许服务端生成的对象 Key，客户端使用 COS SDK 直传

Given COS 上传完成但 finalize 的大小或 ETag 不匹配
When edu-api 执行 HEAD 校验
Then 附件保持不可发送并返回稳定错误

Given 成员已退出或被移除
When 该账号请求历史附件下载 STS
Then edu-api 拒绝授权，旧临时 STS 到期后不可续签

Given Agent 在本地产生文件
When 回复没有明确附带该文件
Then 文件只保留在主理人本地，不上传 COS
```

### 18.5 重连与生命周期

```text
Given Rust 已处理到房间 seq 100 后断线
When 重连快照最新 seq 为 104
Then Rust 先补拉 101 到 104，再恢复实时流，不重复消息或 invocation

Given 消息提交响应超时
When 客户端使用同一 clientMessageId 重试
Then edu-api 返回同一消息，不重复持久化或执行 Agent

Given 主理人归档聊天室
When 成员尝试发送消息或唤起 Agent
Then 操作被拒绝；已有成员仍可查看历史和下载已有附件

Given 主理人永久删除远端聊天室
When 异步清理完成
Then edu-api 与 COS 数据被清理，本地主理人工作区仅归档且不被自动删除
```

## 19. 验证要求

### edu-api

- Go 单元测试覆盖分享码唯一性与限流、成员授权、Agent 上限、租约、事件序号、消息
  幂等、调用链限制、STS policy 与 finalize 校验；
- WebSocket 集成测试覆盖双客户端广播、定向设备 invocation、重连补偿和旧家庭聊天室
  兼容；
- 数据迁移测试证明旧聊天室数据和路由不受影响。

### Copis Rust

- Rust 单元与集成测试覆盖 AuthSession WebSocket 鉴权、单次 refresh、重连退避、序号
  缺口、SSE 映射、退出清理和敏感字段过滤；
- 边界测试证明 Renderer/Electron Main 不接收 Working JWT。

### Electron Main 与 Renderer

- Bun BDD 测试覆盖本地目录隔离、配置原子写、记忆只读策略、Skill 快照、三 Agent
  并行、调用链幂等、权限归属和 COS 进度；
- Renderer 测试覆盖左侧入口、创建/加入、结构化 mention、未读、离线、重连、上传状态
  和主理人/普通成员权限差异；
- 运行 `bun run typecheck`、Electron main/renderer build 与新增聚焦测试。

自动化验证通过后，必须由用户在真实 Electron 应用窗口确认：

- 左侧聊天室分组及其“加入”“创建”入口；
- 创建、分享码加入、多人实时消息；
- 多 Agent 并行、Agent 调用 Agent 与三跳停止提示；
- 主理人授权弹窗和普通成员不可代批；
- COS 上传、下载、断线恢复、归档与恢复；
- 实际交互与视觉效果。

不得使用截图、截图比对、`about:blank` 或仅主 Renderer DOM 检查代替上述用户验收。

## 20. 文档同步

实现导致功能状态变化后，需要同步更新仓库 `AGENTS.md` 和 `README.md` 中的项目结构、
架构、运行时能力、文件存储和验证命令。根据仓库规则，这两份文档必须先获得用户明确
许可后才能修改。
