# Copis Chatroom Rust Realtime Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在 Copis 的 Rust HTTP API 进程中增加同步聊天室实时网关，由 Rust 持有 edu-api WebSocket 与 Working JWT，为 Renderer 提供本机 HTTP/SSE，为 Electron Main 提供受控的 Agent bridge 和 COS STS facade。

**Architecture:** Rust 继续使用现有同步 TcpListener，由后台线程通过 tungstenite 维护带 Authorization: Bearer access-token 的 edu-api Chatroom v2 WebSocket；AuthSession 负责当前 token 和一次性 refresh。聊天室命令从本机 HTTP 进入，服务端事件经按房间游标排序、补缺和去重后发布到 SSE；定向 Agent invocation 通过现有 stdio 业务 bridge 交给 Electron Main。所有 COS 临时凭据只在 Rust 与 Electron Main 的内部调用链短暂传递，Renderer 只能得到状态和结果。

**Tech Stack:** Rust 2021、serde/serde_json、现有 AuthSession/EduApiClient、同步 std::thread/std::sync::mpsc/TcpListener、tungstenite 0.30.0（default-features=false、handshake、rustls-tls-native-roots）、Cargo 测试。

**Spec:** docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md

## Global Constraints

- 仅在 native/http-api-server 内实现 Phase 2；不改 edu-api、Electron Agent 协调器、Renderer、AGENTS.md 或 README.md。
- Rust 是 edu-api 的唯一认证网络出口；Working JWT 只从 AuthSession 读取并用于 WebSocket 握手或已认证 HTTP 请求，绝不写入 HTTP/SSE/bridge 事件、日志、错误正文或返回给 Renderer。
- 上游 WebSocket 必须使用 Authorization header，禁止把 JWT 放进 query string；连接 URL 将 http/https 转为 ws/wss，路径固定为 /api/chatrooms/v2/ws。
- 使用同步 TcpListener 和线程模型，不引入 Tokio、async-std 或新的异步运行时。
- AuthSession 遇 WebSocket 握手 401 只调用一次 refresh_single_flight，使用新 token 重试一次；第二次 401 清理认证状态并发布 auth_expired，不得无限 refresh。
- 分享码由主理人指定；Rust 不自行生成或猜测分享码，提交前只做非空和长度转发，服务端负责 [A-Z0-9]{4} 标准化与唯一性。
- 服务端与客户端都遵守 invocation depth：真人消息为 0，Agent 续唤为 1/2，depth >= 3 只保留消息并发布 invocation_limit_reached，不再发送 invocation；同一 trace_id + target_agent_id 只执行一次。
- 一个聊天室最多 3 个 Agent；Rust 不绕过 edu-api 的上限、成员、房间状态、设备哈希和 lease 校验。主理人或 Agent 离线时立即返回 agent_offline，不建立队列。
- Rust 按房间记录最后连续 seq；发现跳号时暂停该房间实时事件、用 after_seq 补拉并按序发布，补缺完成前不得应用后续事件；重复事件只能被丢弃。
- 重连采用有上限指数退避：1、2、4、8、16、30 秒，连续 8 次失败后标记 realtime_reconnecting/realtime_unavailable 并等待下一次显式订阅或命令触发连接。
- SSE 订阅独立于聊天室页面生命周期；页面关闭只断开该 SSE 客户端，后台网关继续维护连接、房间游标和 lease，应用退出、logout、移除 Agent 或 gateway shutdown 时清理订阅和 lease。
- 所有本机输入、上游 JSON 和 bridge JSON 都按结构化 serde 类型解析；拒绝未知方法、非法 room/agent ID、空 body、超过现有 HTTP body 上限或无法解析的 seq。
- COS STS facade 只允许返回 SDK 所需白名单字段：bucket、region、objectKey、tmpSecretId、tmpSecretKey、sessionToken、startTime、expiredTime、action；不透传上游对象，不记录或持久化这些字段，不让 Renderer 路由返回这些字段。
- COS object key 必须以 edu-api 返回值为准，客户端不能自选或覆盖；upload grant 只接受 PutObject/分片上传/中止，download grant 只接受单对象 GetObject。
- 新增注释与日志优先中文；日志只允许 requestId、roomId、messageId、traceId、invocationId、事件类型、状态码和耗时，不输出完整正文、绝对路径、Authorization、JWT、STS 或 COS key。
- 每个任务先新增失败测试并单独运行确认 RED，再写最小实现确认 GREEN；每个任务独立提交。
- 实现前运行 cargo search tungstenite --limit 5 与 cargo tree -i tungstenite 复核版本；依赖只允许固定为 0.30.0。本计划不递增包版本、不安装其他依赖。

## File Structure

| Path | Responsibility |
| --- | --- |
| native/http-api-server/Cargo.toml | 固定 tungstenite 0.30.0 的同步 WebSocket TLS/handshake feature。 |
| native/http-api-server/src/chatroom_protocol.rs | Chatroom v2 URL、命令、事件、invocation、游标、STS 白名单类型和结构化校验。 |
| native/http-api-server/src/chatroom_protocol_tests.rs | 协议序列化、WebSocket URL、depth/seq、敏感字段过滤测试。 |
| native/http-api-server/src/chatroom_client.rs | 带 AuthSession 的同步 WebSocket connector、单次 refresh、收发线程、重连退避和关闭。 |
| native/http-api-server/src/chatroom_client_tests.rs | fake socket/transport 驱动的鉴权、重连、订阅和命令测试。 |
| native/http-api-server/src/chatroom_gateway.rs | 房间订阅/cursor/seq gap、SSE subscriber、HTTP facade、Agent bridge、lease 清理和 COS STS facade。 |
| native/http-api-server/src/chatroom_gateway_tests.rs | gateway 状态机、补缺/去重、SSE、bridge、离线、shutdown 和 STS 不泄漏测试。 |
| native/http-api-server/src/main.rs | 注册模块、启动 gateway、将 chatroom 路由接入同步 listener，并在退出时 shutdown。 |
| native/http-api-server/src/main_tests.rs | 路由、internal token、Renderer/bridge 敏感字段边界测试。 |

## Interfaces

后续任务必须沿用以下跨文件契约，不以相似名称替换。

    // chatroom_protocol.rs
    pub const CHATROOM_WS_PATH: &str = "/api/chatrooms/v2/ws";
    pub const CHATROOM_HTTP_PREFIX: &str = "/api/chatrooms/v2";
    pub const CHATROOM_INTERNAL_PREFIX: &str = "/api/internal/chatrooms";
    pub const CHATROOM_SSE_PATH: &str = "/api/chatrooms/v2/events";

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct RoomCursor {
        pub room_id: String,
        pub after_seq: u64,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
    pub enum ChatroomCommand {
        Subscribe { rooms: Vec<RoomCursor>, device_id: String },
        Unsubscribe { room_id: String },
        SendMessage { room_id: String, client_message_id: String, content: String, mention_agent_ids: Vec<String>, attachment_ids: Vec<String> },
        AgentAccepted { room_id: String, invocation_id: String, agent_id: String, device_id: String },
        AgentEvent { room_id: String, invocation_id: String, event: AgentEventPayload },
        RenewLease { room_id: String, agent_id: String, device_id: String },
        Close,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
    pub enum AgentEventPayload {
        Delta { text: String },
        Completed { content: String, mention_agent_ids: Vec<String>, attachment_ids: Vec<String> },
        Failed { code: String, message: String },
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct ProtocolError {
        pub code: String,
        pub message: String,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all_fields = "camelCase")]
    pub enum ChatroomEvent {
        #[serde(rename = "room.snapshot")]
        RoomSnapshot { room_id: String, latest_seq: u64, payload: Value },
        #[serde(rename = "message.created")]
        MessageCreated { room_id: String, seq: u64, payload: Value },
        #[serde(rename = "room.updated")]
        RoomUpdated { room_id: String, seq: u64, payload: Value },
        #[serde(rename = "member.removed")]
        MemberRemoved { room_id: String, seq: u64, payload: Value },
        #[serde(rename = "agent.updated")]
        AgentUpdated { room_id: String, seq: u64, payload: Value },
        #[serde(rename = "attachment.updated")]
        AttachmentUpdated { room_id: String, seq: u64, payload: Value },
        #[serde(rename = "member.presence_changed")]
        MemberPresenceChanged { room_id: String, payload: Value },
        #[serde(rename = "agent.presence_changed")]
        AgentPresenceChanged { room_id: String, payload: Value },
        #[serde(rename = "agent.invocation")]
        AgentInvocation { room_id: String, payload: Value },
        #[serde(rename = "agent.accepted")]
        AgentAccepted { room_id: String, payload: Value },
        #[serde(rename = "agent.delta")]
        AgentDelta { room_id: String, payload: Value },
        #[serde(rename = "agent.completed")]
        AgentCompleted { room_id: String, payload: Value },
        #[serde(rename = "agent.failed")]
        AgentFailed { room_id: String, payload: Value },
        #[serde(rename = "local.status")]
        LocalStatus { room_id: Option<String>, code: String, message: String },
    }

    impl ChatroomEvent {
        pub fn room_id(&self) -> Option<&str>;
        pub fn seq(&self) -> Option<u64>;
        pub fn kind(&self) -> &'static str;
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct CosStsGrant {
        pub bucket: String,
        pub region: String,
        pub object_key: String,
        pub tmp_secret_id: String,
        pub tmp_secret_key: String,
        pub session_token: String,
        pub start_time: u64,
        pub expired_time: u64,
        pub action: CosAction,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum CosAction { Upload, Download }

    pub fn chatroom_ws_url(base_url: &str) -> Result<String, ProtocolError>;
    pub fn parse_event(bytes: &[u8]) -> Result<ChatroomEvent, ProtocolError>;
    pub fn validate_invocation_depth(depth: u8) -> Result<(), ProtocolError>;
    pub fn normalize_room_id(value: &str) -> Result<String, ProtocolError>;
    pub fn filter_cos_sts(value: &Value, expected_action: CosAction) -> Result<CosStsGrant, ProtocolError>;
    pub fn public_event(value: &ChatroomEvent) -> Value;

    // chatroom_client.rs
    pub trait ChatroomSocket: Send {
        fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError>;
        fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError>;
        fn close(&mut self);
    }

    pub trait ChatroomSocketConnector: Send + Sync {
        fn connect(&self, url: &str, authorization: &str) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError>;
    }

    pub struct ChatroomClient {
    }
    impl ChatroomClient {
        pub fn new(auth: Arc<AuthSession>, url: String, connector: Arc<dyn ChatroomSocketConnector>, events: Sender<ChatroomClientEvent>) -> Self;
        pub fn start(&self);
        pub fn command(&self, command: ChatroomCommand) -> Result<(), ChatroomClientError>;
        pub fn shutdown(&self);
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct ChatroomClientError {
        pub code: String,
        pub message: String,
    }

    #[derive(Clone, Debug, PartialEq)]
    pub enum ChatroomClientEvent {
        Connected,
        Disconnected,
        Event(ChatroomEvent),
        Status { code: String, message: String },
    }

    // chatroom_gateway.rs
    pub trait ChatroomBridge: Send + Sync {
        fn send_invocation(&self, body: Vec<u8>) -> Result<(), String>;
        fn send_disconnected(&self, body: Vec<u8>) -> Result<(), String>;
    }

    pub struct ChatroomGateway { /* 所有字段私有，生命周期由 Arc 管理 */ }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct ChatroomGatewayError {
        pub status: u16,
        pub code: String,
        pub message: String,
    }
    impl ChatroomGateway {
        pub fn new(auth: Arc<AuthSession>, edu_base_url: String, connector: Arc<dyn ChatroomSocketConnector>, bridge: Arc<dyn ChatroomBridge>, device_id: String) -> Arc<Self>;
        pub fn start(self: &Arc<Self>);
        pub fn handle_http(&self, method: &str, target: &str, headers: &HashMap<String, String>, body: &[u8]) -> Result<GatewayHttpResponse, ChatroomGatewayError>;
        pub fn subscribe_sse(&self, room_ids: Vec<String>) -> Result<SseSubscription, ChatroomGatewayError>;
        pub fn shutdown_connection(&self);
        pub fn shutdown(&self);
    }

    pub enum GatewayHttpResponse {
        Json { status: u16, body: Value },
        Empty { status: u16 },
        Sse(SseSubscription),
    }
    pub struct SseSubscription { pub receiver: Receiver<Value> }
    pub fn is_chatroom_path(path: &str) -> bool;
    pub fn is_chatroom_internal_path(path: &str) -> bool;

    // main.rs
    pub(crate) fn handle_chatroom_http(stream: &mut TcpStream, request: &HttpRequest, origin: Option<&str>, gateway: &ChatroomGateway);
    fn resolve_chatroom_device_id() -> Result<String, String>;

### Task 1: Chatroom v2 Protocol and WebSocket Dependency

**Files:**
- Modify: native/http-api-server/Cargo.toml
- Modify: native/http-api-server/src/main.rs:16-35, 3850-3890
- Create: native/http-api-server/src/chatroom_protocol.rs
- Create: native/http-api-server/src/chatroom_protocol_tests.rs

**Interfaces:**
- Produces every type and function in the chatroom_protocol.rs block above for Tasks 2–4.
- Consumes the Phase 1 edu-api JSON envelope: event type, roomId, seq, payload; COS grant action is selected by route, never by arbitrary client input.

- [ ] **Step 1: Write the failing BDD tests**

在 chatroom_protocol_tests.rs 加入以下行为测试：

    #[test]
    fn given_lowercase_backend_url_when_building_ws_url_then_use_wss_and_fixed_path() {
        assert_eq!(chatroom_ws_url("https://edu.example/module/edu-api").unwrap(),
            "wss://edu.example/module/edu-api/api/chatrooms/v2/ws");
    }

    #[test]
    fn given_event_json_when_parsing_then_preserve_room_seq_and_payload() {
        let event = parse_event(br#"{"type":"message.created","roomId":"room-1","seq":7,"payload":{"messageId":"m-1"}}"#).unwrap();
        assert_eq!(event.room_id(), Some("room-1"));
        assert_eq!(event.seq(), Some(7));
        assert_eq!(event.kind(), "message.created");
    }

    #[test]
    fn given_depth_three_when_validating_then_reject_without_invocation() {
        assert!(validate_invocation_depth(3).is_err());
        assert!(validate_invocation_depth(2).is_ok());
    }

    #[test]
    fn given_upload_sts_with_extra_fields_when_filtering_then_keep_only_sdk_fields_and_action() {
        let value = serde_json::json!({"bucket":"b","region":"r","objectKey":"k","tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"token","startTime":1,"expiredTime":2,"action":"upload","authorization":"jwt","raw":"secret"});
        let grant = filter_cos_sts(&value, CosAction::Upload).unwrap();
        assert_eq!(grant.object_key, "k");
        let public = public_event(&ChatroomEvent::LocalStatus { room_id: None, code: "ok".into(), message: "ok".into() });
        assert!(!public.to_string().contains("tmpSecret"));
    }

- [ ] **Step 2: Run tests to verify RED**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_protocol_tests -- --nocapture

Expected: FAIL because the module, dependency, and exported protocol functions do not yet exist. A compile failure caused by malformed test JSON or an unrelated module is not acceptable.

- [ ] **Step 3: Add the pinned dependency and minimal protocol implementation**

先运行 cargo search tungstenite --limit 5 与 cargo tree -i tungstenite，确认没有已解析的冲突；在 dependencies 中加入：

    tungstenite = { version = "0.30.0", default-features = false, features = ["handshake", "rustls-tls-native-roots"] }

实现固定路径拼接时只允许 http:// 或 https://，去除 base URL 尾部 /，拒绝 query、fragment 和控制字符；parse_event 使用 serde 的 camelCase 字段映射并拒绝缺失 type、roomId。只有 message.created、room.updated、member.removed、agent.updated、attachment.updated 需要正整数 seq；room.snapshot 使用 latestSeq；presence 与 agent.invocation/accepted/delta/completed/failed 不占持久 seq。filter_cos_sts 从 data 或顶层读取一个对象，逐字段验证非空字符串/时间，按 CosAction 强制 action 白名单；缺少字段、action 不匹配或 expiredTime 不大于 startTime 都返回稳定 cos_sts_invalid。public_event 只输出 roomId、可选 seq/latestSeq、type 和面向 Renderer 的 payload，payload 递归移除 authorization、accessToken、refreshToken、tmpSecretId、tmpSecretKey、sessionToken、objectKey、absolutePath、localPath。

- [ ] **Step 4: Run tests to verify GREEN**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_protocol_tests -- --nocapture

Expected: all protocol tests PASS。

- [ ] **Step 5: Commit**

    git add native/http-api-server/Cargo.toml native/http-api-server/src/main.rs native/http-api-server/src/chatroom_protocol.rs native/http-api-server/src/chatroom_protocol_tests.rs
    git commit -m "feat(rust): define chatroom realtime protocol"

### Task 2: Authenticated Synchronous WebSocket Client

**Files:**
- Create: native/http-api-server/src/chatroom_client.rs
- Create: native/http-api-server/src/chatroom_client_tests.rs
- Modify: native/http-api-server/src/main.rs:16-35, 3850-3895
- Modify: native/http-api-server/src/auth_session.rs:587-630 only if a pub(crate) token accessor is required; preserve authenticated_request_with_headers and refresh_single_flight behavior.

**Interfaces:**
- Consumes ChatroomCommand, ChatroomEvent, chatroom_ws_url and AuthSession current_access_token/refresh_single_flight.
- Produces ChatroomClient, ChatroomSocket, ChatroomSocketConnector, ChatroomClientEvent and exact methods in the Interfaces block.

- [ ] **Step 1: Write the failing BDD tests**

使用 FakeConnector、FakeSocket 和 MemoryStorage，覆盖：

    #[test]
    fn given_ws_handshake_401_when_client_connects_then_refresh_once_and_retry_with_new_bearer() {}

    #[test]
    fn given_second_ws_401_after_refresh_when_client_connects_then_emit_auth_expired_and_stop() {}

    #[test]
    fn given_socket_event_when_reader_receives_then_emit_structured_event_without_jwt() {}

    #[test]
    fn given_disconnect_when_reader_retries_then_use_bounded_exponential_backoff() {}

    #[test]
    fn given_shutdown_when_socket_is_active_then_send_close_and_join_worker() {}

测试必须断言 connector 收到的 authorization 依次为 Bearer old-token、Bearer new-token，refresh 调用计数为 1；第二次 401 后没有第三次 connector 调用；任何 ChatroomClientEvent 的 JSON 都不包含 token。

- [ ] **Step 2: Run tests to verify RED**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_client_tests -- --nocapture

Expected: FAIL because client traits and implementation do not exist.

- [ ] **Step 3: Implement the synchronous connector and worker**

实现 TungsteniteConnector：使用 tungstenite::client::IntoClientRequest 构造 request，在 header 中写入 Authorization；只把 401 映射为 ChatroomClientError::Unauthorized。成功后将 WebSocket<MaybeTlsStream<TcpStream>> 包装为 ChatroomSocket，binary frame 按 UTF-8 JSON 解析，Ping/Pong 交给 tungstenite，Close 映射为断开。

ChatroomClient::start 只启动一个 reader/connection 线程；线程状态机为读取 token、连接、发送当前订阅快照、发送 Connected、循环收事件；遇 Unauthorized 时通过 AuthSession::refresh_single_flight 获得新 token 仅重连一次；其它失败按 1/2/4/8/16/30 秒和 8 次上限重连。command 将命令放入单一 mpsc::Sender，由连接线程串行写 socket，避免并发写 WebSocket。Tungstenite socket 设置不超过 1 秒的 read timeout，使循环能检查停止标志；shutdown 设置停止标志、发送 Close 并 join 线程，不能留下继续访问 AuthSession 或 bridge 的后台线程。

所有错误使用不含 token 的 ChatroomClientError { code: String, message: String }；日志只记录连接状态和耗时，不记录 URL query 或 Authorization value。

- [ ] **Step 4: Run tests to verify GREEN**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_client_tests -- --nocapture

Expected: all client tests PASS，包括 one-refresh-only 和 bounded backoff assertions。

- [ ] **Step 5: Commit**

    git add native/http-api-server/src/chatroom_client.rs native/http-api-server/src/chatroom_client_tests.rs native/http-api-server/src/main.rs native/http-api-server/src/auth_session.rs
    git commit -m "feat(rust): add authenticated chatroom websocket client"

### Task 3: Gateway State, Seq Gap Recovery, SSE, Bridge and STS Facade

**Files:**
- Create: native/http-api-server/src/chatroom_gateway.rs
- Create: native/http-api-server/src/chatroom_gateway_tests.rs
- Modify: native/http-api-server/src/main.rs:16-35, 137-200 only to declare the module and adapt Bridge to ChatroomBridge.

**Interfaces:**
- Consumes ChatroomClient, protocol types, AuthSession::authenticated_request and Arc<dyn ChatroomBridge>.
- Produces ChatroomGateway::new/start/handle_http/subscribe_sse/shutdown, GatewayHttpResponse, SseSubscription, is_chatroom_path and is_chatroom_internal_path.

- [ ] **Step 1: Write the failing BDD tests**

在 chatroom_gateway_tests.rs 使用 fake client events、fake ChatroomBridge、fake EduApiTransport 建立以下测试：

    #[test]
    fn given_seq_100_then_live_103_when_event_arrives_then_fetch_101_102_before_publishing_103() {}

    #[test]
    fn given_duplicate_seq_when_event_arrives_then_publish_once() {}

    #[test]
    fn given_sse_subscription_for_room_when_public_event_arrives_then_receive_filtered_event() {}

    #[test]
    fn given_agent_invocation_when_upstream_event_arrives_then_forward_only_sanitized_payload_to_bridge() {}

    #[test]
    fn given_internal_sts_route_when_grant_is_valid_then_return_grant_to_main_but_public_route_never_returns_secret_fields() {}

    #[test]
    fn given_offline_agent_invocation_result_when_message_is_submitted_then_return_agent_offline_without_local_queue() {}

    #[test]
    fn given_shutdown_when_gateway_has_subscriptions_and_leases_then_unsubscribe_and_release_all() {}

测试必须断言补拉请求为 GET /api/chatrooms/v2/rooms/room-1/events?after_seq=100，顺序为 101、102、103；SSE payload 不含 objectKey、tmpSecretKey、sessionToken；bridge body 不含 JWT；shutdown 后没有新的 command/lease renew。

- [ ] **Step 2: Run tests to verify RED**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_gateway_tests -- --nocapture

Expected: FAIL because gateway state, SSE and bridge adapter do not exist.

- [ ] **Step 3: Implement the gateway state machine**

ChatroomGateway 内部保存 Mutex<HashMap<String, RoomState>>、subscriber registry、client command sender、shutdown AtomicBool 和 lease registry。RoomState 至少含 last_contiguous_seq: u64、subscribed: bool、gap_recovery: bool；每个 SSE subscriber 保存订阅房间集合和 bounded mpsc::SyncSender<Value>，满载时丢弃 delta 类型但保留最终 message.created/agent.completed/agent.failed/LocalStatus。

收到持久化且带 seq 的事件时执行固定算法：seq 小于等于游标丢弃；seq 等于游标加一则提交游标并广播；seq 大于游标加一则设置 gap_recovery，暂停该房间事件，循环调用 AuthSession::authenticated_request("GET", "/api/chatrooms/v2/rooms/{roomId}/events?after_seq={last}", None)，解析 events 数组并按 seq 连续提交；补拉缺失下一 seq 或再次跳号时发布 realtime_gap 并保持重连状态，不把后续持久事件交给 SSE。presence 与 agent.invocation/accepted/delta/completed/failed 作为无 seq 临时事件直接分发，不推进游标；每次持久事件提交使用 room_id + seq 去重。

handle_http 只允许以下路径和方法，并把 JSON body 按结构化类型发送到 edu-api：

    GET    /api/chatrooms/v2/rooms
    POST   /api/chatrooms/v2/rooms
    GET    /api/chatrooms/v2/rooms/:roomId
    PATCH  /api/chatrooms/v2/rooms/:roomId
    POST   /api/chatrooms/v2/rooms/:roomId/archive
    POST   /api/chatrooms/v2/rooms/:roomId/restore
    DELETE /api/chatrooms/v2/rooms/:roomId
    POST   /api/chatrooms/v2/join
    POST   /api/chatrooms/v2/rooms/:roomId/leave
    GET    /api/chatrooms/v2/rooms/:roomId/messages
    GET    /api/chatrooms/v2/rooms/:roomId/events
    POST   /api/chatrooms/v2/rooms/:roomId/messages
    POST   /api/chatrooms/v2/rooms/:roomId/read
    POST   /api/chatrooms/v2/rooms/:roomId/agents
    PATCH  /api/chatrooms/v2/rooms/:roomId/agents/:agentId
    DELETE /api/chatrooms/v2/rooms/:roomId/agents/:agentId
    POST   /api/chatrooms/v2/rooms/:roomId/agents/:agentId/lease
    GET    /api/chatrooms/v2/events

POST /messages 强制生成/校验 UUID clientMessageId，只透传正文、attachmentIds 和结构化 mentionAgentIds；真人消息的 traceId、parentMessageId 和 depth 由 edu-api 生成或固定为 depth 0，Rust 拒绝 Renderer 提交这些内部字段。成功消息响应不二次发送相同 command，重试复用相同 idempotency key。

SSE subscribe_sse 先登记 subscriber，再发送每个请求房间的 room.snapshot/当前 status；每一帧使用现有 pi_rpc::format_sse_event 格式，事件只能由 public_event 生成。SSE 断开时移除 sender，不改变后台订阅。

实现 ChatroomBridge for Bridge：send_invocation 仅调用 Bridge::send_request 的 `/api/internal/chatrooms/invocations`，send_disconnected 调用 `/api/internal/chatrooms/disconnected`；bridge 响应只检查 2xx，错误映射为 bridge_unavailable，不把响应正文传回上游。远端 agent.invocation 仅向 bridge 转发 roomId、invocationId、traceId、targetAgentId、triggerMessageId、depth 和已清理上下文 payload；不含 token、本地路径、记忆、Skill 和 COS 字段。上游连接确认断开时只发送一次 disconnected 通知，恢复后不重放离线 invocation。

内部 COS facade 只在 /api/internal/chatrooms/cos/upload-grant、/api/internal/chatrooms/cos/download-grant 被调用，必须由 is_internal_token_valid 在 main 路由层校验；gateway 通过 AuthSession 请求 edu-api 后调用 filter_cos_sts，返回 CosStsGrant 给 Electron Main。普通 /api/chatrooms/v2 JSON 和 SSE 一律清理敏感字段。

Agent lease registry 每 20 秒发送一次 RenewLease，lease 到期或 room/agent 被移除立即发送 Unsubscribe 并删除 registry；shutdown 先停止 renew、发送所有 Unsubscribe/Close，再关闭 SSE receivers 和 client。

- [ ] **Step 4: Run tests to verify GREEN**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_gateway_tests -- --nocapture

Expected: all gateway tests PASS，且测试输出不出现 JWT、STS secret、COS key、消息正文或本地路径。

- [ ] **Step 5: Commit**

    git add native/http-api-server/src/chatroom_gateway.rs native/http-api-server/src/chatroom_gateway_tests.rs native/http-api-server/src/main.rs
    git commit -m "feat(rust): add chatroom gateway with sse and cursor recovery"

### Task 4: Synchronous TcpListener Wiring and Boundary Integration Tests

**Files:**
- Modify: native/http-api-server/src/main.rs (module imports, handle_connection parameters, route dispatch, startup/shutdown)
- Modify: native/http-api-server/src/main_tests.rs (BDD routing and boundary tests)

**Interfaces:**
- Consumes ChatroomGateway and path predicates from Task 3.
- Produces local routes /api/chatrooms/v2/*, /api/chatrooms/v2/events and /api/internal/chatrooms/* without exposing Working JWT or COS STS to Renderer.

- [ ] **Step 1: Write the failing BDD tests**

在 main_tests.rs 增加路由级测试：

    #[test]
    fn given_renderer_chatroom_request_when_routed_then_use_gateway_and_never_forward_to_business_bridge() {}

    #[test]
    fn given_internal_chatroom_invocation_without_internal_token_then_return_403() {}

    #[test]
    fn given_internal_cos_grant_with_valid_token_then_only_internal_response_contains_temporary_credentials() {}

    #[test]
    fn given_sse_request_when_connection_closes_then_main_does_not_shutdown_background_gateway() {}

    #[test]
    fn given_process_shutdown_when_gateway_is_running_then_close_ws_and_release_leases() {}

断言普通 Renderer 响应正文不含 access_token、refresh_token、Authorization、tmpSecretKey、sessionToken、objectKey；缺少 internal token 为 403；普通聊天室请求不落到原有 bridge.send_request；SSE 连接关闭后 gateway 仍可接收下一条 command。

- [ ] **Step 2: Run tests to verify RED**

Run: cargo test --manifest-path native/http-api-server/Cargo.toml chatroom -- --nocapture

Expected: FAIL because main.rs does not register the gateway or chatroom routes.

- [ ] **Step 3: Wire startup, routes and lifecycle**

在 main.rs 声明 mod chatroom_protocol; mod chatroom_client; mod chatroom_gateway;，初始化 ChatroomGateway::new(Arc::clone(&auth_session), edu_client.base_url().to_string(), Arc::new(TungsteniteConnector::default()), Arc::new(bridge_adapter), resolve_chatroom_device_id())，调用 start 后再 bind listener。resolve_chatroom_device_id 读取现有配置目录中的 `client-device.json`（`{ "version": 1, "deviceId": "...", "createdAt": number }`）；若不存在则生成随机 UUID 并以 0600 权限原子写入。Phase 3 Electron Main 复用同一文件并负责从旧 web-sync deviceId 迁移，两个进程不得各自生成不同 ID；device ID 不能进入普通 HTTP 响应或日志。

扩展 handle_connection 参数为 chatroom_gateway: Arc<ChatroomGateway>，在 is_private_auth_bridge_path 之后、其它业务 route 之前分流：

    if is_chatroom_path(path) || is_chatroom_internal_path(path) {
        handle_chatroom_http(&mut stream, &request, origin, &chatroom_gateway);
        // SSE handler 自己持有并关闭连接；普通响应在这里统一 shutdown。
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

handle_chatroom_http 对 /api/internal/chatrooms/* 先调用 is_internal_token_valid，失败返回 403 {"error":"聊天室内部接口未授权","code":"internal_token_required"}；对普通路径将 HttpRequest 的 method/target/headers/body 转成 gateway.handle_http 输入。JSON 只使用 send_json_response，SSE 使用 sse_headers_with_origin 和现有 SSE frame 格式，禁止把 GatewayHttpResponse::Sse 里的内部 grant 当普通 JSON 返回。

listener 线程把 gateway Arc 传给每个 connection handler；listener 退出或测试显式调用 shutdown 时执行 chatroom_gateway.shutdown。logout 的认证状态变化由已有 auth storage 逻辑触发 shutdown_connection/重新订阅状态，不清空本地 room cursor 文件；后续新命令重新建立连接并按 cursor 补缺。

内部 Main handler 只接收以下命令：`/api/internal/chatrooms/invocations/{invocationId}/accepted`、`/running`、`/delta`、`/completed`、`/failed`，以及 `/api/internal/chatrooms/cos/upload-grant`、`/download-grant`、`/finalize`。命令体仅包含 room/invocation/agent/device、事件状态和附件 ID；accepted 调用 `ChatroomCommand::AgentAccepted`，其余 invocation 状态调用 `ChatroomCommand::AgentEvent`，服务端根据 invocation 推导 trace/parent/depth。COS grant 临时凭据只在对应 upload/download 请求的同步响应中传给 Main，并在日志和 SSE 前过滤。

- [ ] **Step 4: Run focused and full Rust verification**

Run each command separately:

    cargo test --manifest-path native/http-api-server/Cargo.toml chatroom -- --nocapture
    cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_protocol_tests -- --nocapture
    cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_client_tests -- --nocapture
    cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_gateway_tests -- --nocapture
    cargo test --manifest-path native/http-api-server/Cargo.toml

Expected: all focused and full Rust tests PASS；已有 2 条 baseline dead-code warning 可保留，但不得新增包含 JWT/STS/COS key 的日志或 warning。用 rg -n 'access_token|refresh_token|tmpSecretKey|sessionToken|objectKey|Authorization' native/http-api-server/src/chatroom_*.rs 复核这些字段只出现在解析/过滤白名单和测试断言中，不出现在日志格式字符串或 public event 构造中。

- [ ] **Step 5: Commit**

    git add native/http-api-server/src/main.rs native/http-api-server/src/main_tests.rs native/http-api-server/src/chatroom_gateway.rs
    git commit -m "feat(rust): wire chatroom gateway into local api"

## Verification Matrix

完成四个任务后，在该 worktree 根目录执行：

    cargo fmt --manifest-path native/http-api-server/Cargo.toml -- --check
    cargo test --manifest-path native/http-api-server/Cargo.toml

必须在执行报告中人工核对：

- a7k2 创建后只能由 edu-api 返回 A7K2，Rust 不改写主理人指定值；分享码输入不区分大小写由服务端处理。
- 真人消息结构化提及 A/B 时，Rust 只保证事件顺序、bridge 定向和无重复，不在本地自行执行 Agent。
- Agent 续唤 depth 0/1/2 可转发，depth 3 只广播停止原因。
- 目标 Agent offline、lease 过期或主理人设备断开时立即发布 agent_offline，没有本地待办队列。
- seq gap 先补拉后广播，断线重试最多一次 refresh，重连退避有上限，退出时释放订阅和 lease。
- public HTTP/SSE 不含 Working JWT、COS STS 临时凭据、COS object key、来源记忆、Skill 内容或本地绝对路径；只有受 internal token 保护的 Main bridge 能取得 SDK 白名单 grant。

本 Phase 不做 Electron 实际窗口视觉验收；最终 Electron UI、COS SDK 上传下载、Agent 工作区与普通成员权限须由后续 Phase 3/4 自动化和用户在真实应用窗口确认。

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover fixed WebSocket path/header, AuthSession single refresh, sync listener/client, protocol depth and event types; Task 3 covers cursor/seq gap, subscriptions, SSE, reconnect status, offline/no queue, invocation bridge, lease cleanup and strict STS facade; Task 4 covers local HTTP/internal routes, startup/lifecycle and Renderer/Main boundary. Edu-api persistence, Agent orchestration, local workspace and Renderer UI remain outside Phase 2 by design.
- **Completeness scan:** 每个任务都有精确文件、签名、RED 命令、GREEN 命令、实现约束和提交命令；未发现未分配文件或未决实现选择。
- **Type consistency:** ChatroomCommand, ChatroomEvent, CosStsGrant, ChatroomSocketConnector, ChatroomClient, ChatroomBridge, ChatroomGateway, GatewayHttpResponse and SseSubscription are defined once in the Interfaces section and consumed with the same names/signatures in Tasks 1–4.
