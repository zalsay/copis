use crate::auth_session::{AuthError, AuthSession};
use crate::chatroom_client::{ChatroomClient, ChatroomClientEvent, ChatroomSocketConnector};
use crate::chatroom_protocol::{
    chatroom_ws_url, filter_cos_sts, normalize_room_id, public_event, sanitize_public,
    validate_invocation_depth, AgentEventPayload, ChatroomCommand, ChatroomEvent, CosAction,
    RoomCursor, CHATROOM_HTTP_PREFIX, CHATROOM_INTERNAL_PREFIX, CHATROOM_SSE_PATH,
};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 4096;
const SSE_CAPACITY: usize = 64;
const SSE_RESERVED_SLOT: usize = SSE_CAPACITY - 1;
const LEASE_DURATION: Duration = Duration::from_secs(60);
const LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(20);
const MAX_RECOVERY_PAGE: usize = 500;
const TASK_WORKER_COUNT: usize = 4;
const TASK_QUEUE_CAPACITY: usize = 64;

pub(crate) trait GatewayClock: Send + Sync {
    fn now(&self) -> Instant;
}

struct SystemGatewayClock;

impl GatewayClock for SystemGatewayClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Gateway HTTP 传输抽象，生产实现从 AuthSession 读取 Working token。
pub trait GatewayTransport: Send + Sync {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<GatewayTransportResponse, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayTransportResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

struct AuthGatewayTransport {
    auth: Arc<AuthSession>,
}

impl GatewayTransport for AuthGatewayTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<GatewayTransportResponse, String> {
        match self.auth.authenticated_request(method, path, body) {
            Ok(response) => Ok(GatewayTransportResponse {
                status: response.status,
                body: response.body,
            }),
            Err(AuthError::Upstream {
                status,
                code,
                message,
            }) => Ok(GatewayTransportResponse {
                status,
                body: serde_json::json!({"error": message, "code": code})
                    .to_string()
                    .into_bytes(),
            }),
            Err(error) => Err(auth_error_message(&error)),
        }
    }
}

fn auth_error_message(error: &AuthError) -> String {
    match error {
        AuthError::Upstream { status, code, .. } => {
            format!("上游请求失败（HTTP {status}，{code}）")
        }
        _ => error.to_string(),
    }
}

/// 供 Rust 到 Electron Main 的受控桥接边界。
pub trait ChatroomBridge: Send + Sync {
    fn send_invocation(&self, body: Vec<u8>, shutdown: &AtomicBool) -> Result<(), String>;
    fn send_disconnected(&self, body: Vec<u8>, shutdown: &AtomicBool) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatroomGatewayError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl ChatroomGatewayError {
    fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}

pub enum GatewayHttpResponse {
    Json { status: u16, body: Value },
    Empty { status: u16 },
    Sse(SseSubscription),
}

pub struct SseSubscription {
    pub receiver: SseReceiver,
    _guard: SseSubscriptionGuard,
}

pub struct SseReceiver {
    receiver: mpsc::Receiver<Value>,
    occupancy: Arc<AtomicUsize>,
}

impl SseReceiver {
    pub fn recv(&self) -> Result<Value, mpsc::RecvError> {
        self.receiver.recv().map(|value| {
            self.occupancy.fetch_sub(1, Ordering::AcqRel);
            value
        })
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<Value, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout).map(|value| {
            self.occupancy.fetch_sub(1, Ordering::AcqRel);
            value
        })
    }

    pub fn try_recv(&self) -> Result<Value, mpsc::TryRecvError> {
        self.receiver.try_recv().map(|value| {
            self.occupancy.fetch_sub(1, Ordering::AcqRel);
            value
        })
    }
}

struct SseSubscriptionGuard {
    subscribers: Weak<Mutex<HashMap<u64, Subscriber>>>,
    subscriber_id: u64,
}

impl Drop for SseSubscriptionGuard {
    fn drop(&mut self) {
        if let Some(subscribers) = self.subscribers.upgrade() {
            subscribers.lock().unwrap().remove(&self.subscriber_id);
        }
    }
}

fn try_send_sse(
    sender: &mpsc::SyncSender<Value>,
    occupancy: &AtomicUsize,
    value: Value,
) -> Result<(), mpsc::TrySendError<Value>> {
    occupancy.fetch_add(1, Ordering::AcqRel);
    match sender.try_send(value) {
        Ok(()) => Ok(()),
        Err(error) => {
            occupancy.fetch_sub(1, Ordering::AcqRel);
            Err(error)
        }
    }
}

struct Subscriber {
    rooms: HashSet<String>,
    sender: mpsc::SyncSender<Value>,
    occupancy: Arc<AtomicUsize>,
}

struct RoomState {
    last_contiguous_seq: u64,
    subscribed: bool,
    gap_recovery: bool,
    recovering: bool,
    snapshot: Option<ChatroomEvent>,
    buffered: BTreeMap<u64, ChatroomEvent>,
}

impl RoomState {
    fn new() -> Self {
        Self {
            last_contiguous_seq: 0,
            subscribed: false,
            gap_recovery: false,
            recovering: false,
            snapshot: None,
            buffered: BTreeMap::new(),
        }
    }
}

struct LeaseState {
    room_id: String,
    room_agent_id: String,
    device_id: String,
    expires_at: Instant,
    next_renew_at: Instant,
}

enum GatewayTask {
    Recover(String),
    Invocation(ChatroomEvent),
    Disconnected(Vec<u8>),
}

#[cfg(test)]
struct TaskGate {
    loaded: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

enum Route<'a> {
    Rooms,
    Room(&'a str),
    Archive(&'a str),
    Restore(&'a str),
    Leave(&'a str),
    MemberRemove(&'a str, &'a str),
    Read(&'a str),
    Messages(&'a str),
    Events(&'a str),
    Agents(&'a str),
    Agent(&'a str, &'a str),
    Lease(&'a str, &'a str),
    Join,
    LocalSse,
    InternalUpload,
    InternalDownload,
    InternalFinalize,
    InternalInvocation(&'a str, &'a str),
}

pub struct ChatroomGateway {
    client: Arc<ChatroomClient>,
    transport: Arc<dyn GatewayTransport>,
    bridge: Arc<dyn ChatroomBridge>,
    device_id: String,
    rooms: Mutex<HashMap<String, RoomState>>,
    subscribers: Arc<Mutex<HashMap<u64, Subscriber>>>,
    leases: Mutex<HashMap<(String, String), LeaseState>>,
    next_subscriber_id: AtomicU64,
    client_events: Mutex<Option<mpsc::Receiver<ChatroomClientEvent>>>,
    event_worker: Mutex<Option<JoinHandle<()>>>,
    started: AtomicBool,
    shutdown: AtomicBool,
    disconnected_notified: AtomicBool,
    pending_disconnected: AtomicBool,
    clock: Arc<dyn GatewayClock>,
    last_lease_tick: Mutex<Instant>,
    task_sender: Mutex<Option<mpsc::SyncSender<GatewayTask>>>,
    task_workers: Mutex<Vec<JoinHandle<()>>>,
    #[cfg(test)]
    task_gate: Mutex<Option<TaskGate>>,
}

impl ChatroomGateway {
    pub fn new(
        auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        let transport = Arc::new(AuthGatewayTransport { auth });
        Self::new_with_transport(
            transport.auth.clone(),
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
        )
    }

    // 测试使用此传输边界，避免真实网络、DNS 和认证状态参与网关状态机测试。
    pub(crate) fn new_with_transport(
        _auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        transport: Arc<dyn GatewayTransport>,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        Self::new_with_transport_and_clock(
            _auth,
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
            Arc::new(SystemGatewayClock),
        )
    }

    pub(crate) fn new_with_transport_and_clock(
        _auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        transport: Arc<dyn GatewayTransport>,
        clock: Arc<dyn GatewayClock>,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        let url = chatroom_ws_url(&edu_base_url)
            .map_err(|_| invalid_request("聊天室实时服务地址不合法"))?;
        let (events, receiver) = mpsc::channel();
        Ok(Arc::new(Self {
            client: Arc::new(ChatroomClient::new(_auth, url, connector, events)),
            transport,
            bridge,
            device_id,
            rooms: Mutex::new(HashMap::new()),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            leases: Mutex::new(HashMap::new()),
            next_subscriber_id: AtomicU64::new(1),
            client_events: Mutex::new(Some(receiver)),
            event_worker: Mutex::new(None),
            started: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            disconnected_notified: AtomicBool::new(false),
            pending_disconnected: AtomicBool::new(false),
            last_lease_tick: Mutex::new(clock.now()),
            clock,
            task_sender: Mutex::new(None),
            task_workers: Mutex::new(Vec::new()),
            #[cfg(test)]
            task_gate: Mutex::new(None),
        }))
    }

    pub fn start(self: &Arc<Self>) {
        if self.shutdown.load(Ordering::Acquire) || self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.start_task_pool();
        self.client.start();
        let receiver = self.client_events.lock().unwrap().take();
        let Some(receiver) = receiver else {
            return;
        };
        let gateway = Arc::clone(self);
        let worker = thread::spawn(move || gateway.run_event_loop(receiver));
        *self.event_worker.lock().unwrap() = Some(worker);
        self.refresh_subscription_snapshot();
    }

    fn start_task_pool(self: &Arc<Self>) {
        let mut sender_slot = self.task_sender.lock().unwrap();
        if sender_slot.is_some() {
            return;
        }
        let (sender, receiver) = mpsc::sync_channel(TASK_QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = self.task_workers.lock().unwrap();
        for _ in 0..TASK_WORKER_COUNT {
            let gateway = Arc::clone(self);
            let receiver = Arc::clone(&receiver);
            workers.push(thread::spawn(move || loop {
                if gateway.shutdown.load(Ordering::Acquire) {
                    return;
                }
                // `recv_timeout` 让接收锁在等待期间释放，阻塞任务不会串行化整个 worker 池。
                let task = receiver
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_millis(50));
                let task = match task {
                    Ok(task) => task,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
                #[cfg(test)]
                if let Some(gate) = gateway.task_gate.lock().unwrap().take() {
                    let _ = gate.loaded.send(());
                    let _ = gate.release.recv();
                }
                if gateway.shutdown.load(Ordering::Acquire) {
                    return;
                }
                match task {
                    GatewayTask::Recover(room_id) => gateway.recover_room(room_id),
                    GatewayTask::Invocation(event) => gateway.forward_invocation_now(&event),
                    GatewayTask::Disconnected(body) => gateway.send_disconnected_bridge(body),
                }
                gateway.drain_pending_disconnected();
            }));
        }
        *sender_slot = Some(sender);
    }

    fn dispatch_task(&self, task: GatewayTask) -> Result<(), GatewayTask> {
        let sender = self.task_sender.lock().unwrap().clone();
        match sender {
            Some(sender) => match sender.try_send(task) {
                Ok(()) => Ok(()),
                Err(mpsc::TrySendError::Full(task))
                | Err(mpsc::TrySendError::Disconnected(task)) => Err(task),
            },
            None => Err(task),
        }
    }

    fn run_event_loop(self: Arc<Self>, receiver: mpsc::Receiver<ChatroomClientEvent>) {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                return;
            }
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(event) => self.handle_client_event(event),
                Err(mpsc::RecvTimeoutError::Timeout) => self.tick_leases(self.clock.now()),
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn handle_client_event(&self, event: ChatroomClientEvent) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        match event {
            ChatroomClientEvent::Connected => {
                self.disconnected_notified.store(false, Ordering::Release);
                self.publish_status(None, "realtime_connected", "聊天室实时连接已建立");
                self.refresh_subscription_snapshot();
            }
            ChatroomClientEvent::Disconnected => self.notify_disconnected(),
            ChatroomClientEvent::Status { code, message } => {
                self.publish_status(None, &code, &message)
            }
            ChatroomClientEvent::Event(event) => self.publish_event(event),
        }
    }

    fn notify_disconnected(&self) {
        if self.disconnected_notified.swap(true, Ordering::AcqRel) {
            return;
        }
        let body = serde_json::json!({"reason":"realtime_disconnected"});
        let body = body.to_string().into_bytes();
        if let Err(task) = self.dispatch_task(GatewayTask::Disconnected(body)) {
            if let GatewayTask::Disconnected(body) = task {
                if self.task_sender.lock().unwrap().is_none() {
                    self.send_disconnected_bridge(body);
                } else {
                    self.pending_disconnected.store(true, Ordering::Release);
                    self.drain_pending_disconnected();
                }
            }
        }
        self.publish_status(None, "realtime_disconnected", "聊天室实时连接已断开");
    }

    fn send_disconnected_bridge(&self, body: Vec<u8>) {
        if self.bridge.send_disconnected(body, &self.shutdown).is_err() {
            self.publish_status(None, "bridge_unavailable", "聊天室业务桥不可用");
        }
    }

    fn drain_pending_disconnected(&self) {
        if self.shutdown.load(Ordering::Acquire)
            || !self.pending_disconnected.swap(false, Ordering::AcqRel)
        {
            return;
        }
        let body = serde_json::json!({"reason":"realtime_disconnected"})
            .to_string()
            .into_bytes();
        if self.dispatch_task(GatewayTask::Disconnected(body)).is_err() {
            self.pending_disconnected.store(true, Ordering::Release);
        }
    }

    pub fn handle_http(
        &self,
        method: &str,
        target: &str,
        _headers: &HashMap<String, String>,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                503,
                "gateway_closed",
                "聊天室网关已关闭",
            ));
        }
        if body.len() > MAX_BODY_BYTES {
            return Err(ChatroomGatewayError::new(
                413,
                "body_too_large",
                "请求体过大",
            ));
        }
        let (path, query) = split_target(target)?;
        let route = parse_route(&path)?;
        let method = method.to_ascii_uppercase();
        if matches!(route, Route::LocalSse) {
            if method != "GET" {
                return Err(method_not_allowed());
            }
            let rooms = parse_sse_room_ids(&query)?;
            return self.subscribe_sse(rooms).map(GatewayHttpResponse::Sse);
        }
        if !method_allowed(&method, &route) {
            return Err(method_not_allowed());
        }
        match route {
            Route::InternalUpload => self.handle_cos_grant(CosAction::Upload, body),
            Route::InternalDownload => self.handle_cos_grant(CosAction::Download, body),
            Route::InternalFinalize => self.handle_internal_finalize(body),
            Route::InternalInvocation(invocation_id, state) => {
                self.handle_internal_invocation(state, invocation_id, body)
            }
            Route::Rooms
            | Route::Room(_)
            | Route::Archive(_)
            | Route::Restore(_)
            | Route::Leave(_)
            | Route::MemberRemove(_, _)
            | Route::Read(_)
            | Route::Messages(_)
            | Route::Events(_)
            | Route::Agents(_)
            | Route::Agent(_, _)
            | Route::Lease(_, _)
            | Route::Join => self.handle_public_http(&method, &path, &query, &route, body),
            Route::LocalSse => unreachable!(),
        }
    }

    fn handle_public_http(
        &self,
        method: &str,
        path: &str,
        query: &str,
        route: &Route<'_>,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let body_value = parse_body_value(body, body_required(method, route))?;
        let request_body = normalize_public_body(method, route, &body_value, !body.is_empty())?;
        let canonical_query = canonical_query_for_route(route, query)?;
        let upstream_path = if canonical_query.is_empty() {
            path.to_string()
        } else {
            format!("{path}?{canonical_query}")
        };
        let response = self
            .transport
            .request(method, &upstream_path, request_body)
            .map_err(|message| ChatroomGatewayError::new(502, "upstream_unavailable", message))?;
        let successful = (200..300).contains(&response.status);
        let result = public_response(response)?;
        if successful {
            if let Route::Lease(room_id, agent_id) = route {
                if let Some(device_id) = body_value.get("deviceId").and_then(Value::as_str) {
                    self.register_lease(room_id, agent_id, device_id);
                }
            }
            self.update_local_state_after_route(method, route);
        }
        Ok(result)
    }

    fn handle_cos_grant(
        &self,
        action: CosAction,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_body_value(body, true)?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid_request("请求体必须是对象"))?;
        let room_id = object
            .get("roomId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("缺少 roomId"))?;
        let room_id = normalize_room_id(room_id).map_err(|_| invalid_request("roomId 不合法"))?;
        let expected_upload = ["roomId", "fileName", "mimeType", "sizeBytes", "sha256"];
        if action == CosAction::Upload {
            require_keys(object, &expected_upload)?;
            let file_name = required_file_name(object, "fileName")?;
            let mime_type = object
                .get("mimeType")
                .and_then(Value::as_str)
                .filter(|value| valid_media_type(value))
                .ok_or_else(|| invalid_request("mimeType 不正确"))?;
            let size = object
                .get("sizeBytes")
                .and_then(Value::as_u64)
                .filter(|size| *size <= MAX_ATTACHMENT_BYTES)
                .ok_or_else(|| invalid_request("sizeBytes 不正确"))?;
            let sha256 = object
                .get("sha256")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64
                        && value
                            .chars()
                            .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
                })
                .ok_or_else(|| invalid_request("sha256 不正确"))?;
            let _ = (file_name, mime_type, size, sha256);
        } else {
            require_keys(object, &["roomId", "attachmentId"])?;
        }
        let endpoint = match action {
            CosAction::Upload => {
                format!("/api/chatrooms/v2/rooms/{room_id}/attachments/upload-authorizations")
            }
            CosAction::Download => format!(
                "/api/chatrooms/v2/rooms/{room_id}/attachments/{}/download-authorizations",
                object
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .filter(|value| valid_component(value))
                    .ok_or_else(|| invalid_request("缺少 attachmentId"))?
            ),
        };
        let mut upstream_value = value.clone();
        if let Some(object) = upstream_value.as_object_mut() {
            object.remove("roomId");
            object.remove("attachmentId");
        }
        let response = self
            .transport
            .request("POST", &endpoint, Some(upstream_value.to_string()))
            .map_err(|message| ChatroomGatewayError::new(502, "upstream_unavailable", message))?;
        if !(200..300).contains(&response.status) {
            return public_response(response);
        }
        let raw = parse_json_response(&response.body)?;
        let grant = filter_cos_sts(&raw, action).map_err(|error| {
            ChatroomGatewayError::new(502, error.code, "COS 授权响应格式不正确")
        })?;
        Ok(GatewayHttpResponse::Json {
            status: response.status,
            body: serde_json::to_value(grant).map_err(|_| {
                ChatroomGatewayError::new(502, "invalid_cos_grant", "COS 授权响应格式不正确")
            })?,
        })
    }

    fn handle_internal_finalize(
        &self,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_body_value(body, true)?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid_request("请求体必须是对象"))?;
        let room_id = object
            .get("roomId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("缺少 roomId"))?;
        let attachment_id = object
            .get("attachmentId")
            .and_then(Value::as_str)
            .filter(|value| valid_component(value))
            .ok_or_else(|| invalid_request("缺少 attachmentId"))?;
        let room_id = normalize_room_id(room_id).map_err(|_| invalid_request("roomId 不合法"))?;
        require_keys(
            object,
            &["roomId", "attachmentId", "sizeBytes", "etag", "sha256"],
        )?;
        let size_bytes = object
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .filter(|size| *size <= MAX_ATTACHMENT_BYTES)
            .ok_or_else(|| invalid_request("sizeBytes 不正确"))?;
        let etag = required_text(object, "etag")?;
        let sha256 = object
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 64
                    && value
                        .chars()
                        .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
            })
            .ok_or_else(|| invalid_request("sha256 不正确"))?;
        let endpoint =
            format!("/api/chatrooms/v2/rooms/{room_id}/attachments/{attachment_id}/finalize");
        let upstream_value = serde_json::json!({
            "sizeBytes": size_bytes,
            "etag": etag,
            "sha256": sha256,
        });
        let response = self
            .transport
            .request("POST", &endpoint, Some(upstream_value.to_string()))
            .map_err(|message| ChatroomGatewayError::new(502, "upstream_unavailable", message))?;
        public_response(response)
    }

    fn handle_internal_invocation(
        &self,
        state: &str,
        path_invocation_id: &str,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_body_value(body, true)?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid_request("请求体必须是对象"))?;
        let room_id = required_string(object, "roomId")?;
        let invocation_id = required_string(object, "invocationId")?;
        if invocation_id != path_invocation_id {
            return Err(invalid_request("invocationId 不匹配"));
        }
        normalize_room_id(room_id).map_err(|_| invalid_request("roomId 不合法"))?;
        if state == "running" {
            require_keys(object, &["roomId", "invocationId"])?;
            return Ok(GatewayHttpResponse::Empty { status: 204 });
        }
        let command = match state {
            "accepted" => {
                require_keys(object, &["roomId", "invocationId", "agentId", "deviceId"])?;
                ChatroomCommand::AgentAccepted {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                    agent_id: required_string(object, "agentId")?.to_string(),
                    device_id: required_string(object, "deviceId")?.to_string(),
                }
            }
            "delta" => {
                require_keys(object, &["roomId", "invocationId", "delta"])?;
                ChatroomCommand::AgentEvent {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                    event: AgentEventPayload::Delta {
                        text: required_string(object, "delta")?.to_string(),
                    },
                }
            }
            "completed" => {
                require_keys(
                    object,
                    &[
                        "roomId",
                        "invocationId",
                        "content",
                        "mentionAgentIds",
                        "attachmentIds",
                        "clientMessageId",
                    ],
                )?;
                ChatroomCommand::AgentEvent {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                    event: AgentEventPayload::Completed {
                        content: required_string(object, "content")?.to_string(),
                        mention_agent_ids: string_array(object, "mentionAgentIds")?,
                        attachment_ids: string_array(object, "attachmentIds")?,
                        client_message_id: required_string(object, "clientMessageId")?.to_string(),
                    },
                }
            }
            "failed" => {
                if object.keys().any(|key| {
                    !["roomId", "invocationId", "failureCode", "message"].contains(&key.as_str())
                }) || !object.contains_key("failureCode")
                {
                    return Err(invalid_request("内部请求包含未知或缺失字段"));
                }
                ChatroomCommand::AgentEvent {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                    event: AgentEventPayload::Failed {
                        code: required_string(object, "failureCode")?.to_string(),
                        message: object
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Agent invocation failed")
                            .to_string(),
                    },
                }
            }
            _ => return Err(route_not_found()),
        };
        self.send_client_command(command)?;
        Ok(GatewayHttpResponse::Empty { status: 204 })
    }

    pub fn subscribe_sse(
        &self,
        room_ids: Vec<String>,
    ) -> Result<SseSubscription, ChatroomGatewayError> {
        if room_ids.is_empty() || room_ids.len() > 50 {
            return Err(invalid_request("SSE 至少需要一个聊天室"));
        }
        let mut rooms = HashSet::new();
        for room_id in room_ids {
            rooms.insert(
                normalize_room_id(&room_id).map_err(|_| invalid_request("聊天室 ID 不合法"))?,
            );
        }
        let (sender, receiver) = mpsc::sync_channel(SSE_CAPACITY);
        let occupancy = Arc::new(AtomicUsize::new(0));
        let subscriber_id = self.next_subscriber_id.fetch_add(1, Ordering::Relaxed);
        let mut initial = Vec::new();
        {
            let mut states = self.rooms.lock().unwrap();
            for room_id in &rooms {
                let state = states.entry(room_id.clone()).or_insert_with(RoomState::new);
                state.subscribed = true;
                if let Some(snapshot) = state.snapshot.clone() {
                    initial.push(snapshot);
                }
                if state.gap_recovery {
                    initial.push(ChatroomEvent::LocalStatus {
                        room_id: Some(room_id.clone()),
                        code: "realtime_gap".into(),
                        message: "聊天室实时事件需要重新同步".into(),
                    });
                }
            }
        }
        // 注册先于 snapshot/status，避免注册与首帧之间丢事件。
        self.subscribers.lock().unwrap().insert(
            subscriber_id,
            Subscriber {
                rooms: rooms.clone(),
                sender: sender.clone(),
                occupancy: occupancy.clone(),
            },
        );
        for event in initial {
            let _ = self.send_to_subscriber(subscriber_id, public_event(&event), true);
        }
        self.refresh_subscription_snapshot();
        Ok(SseSubscription {
            receiver: SseReceiver {
                receiver,
                occupancy,
            },
            _guard: SseSubscriptionGuard {
                subscribers: Arc::downgrade(&self.subscribers),
                subscriber_id,
            },
        })
    }

    fn send_to_subscriber(&self, id: u64, value: Value, durable: bool) -> bool {
        let (sender, occupancy) = {
            let subscribers = self.subscribers.lock().unwrap();
            let Some(subscriber) = subscribers.get(&id) else {
                return false;
            };
            (subscriber.sender.clone(), subscriber.occupancy.clone())
        };
        if occupancy.load(Ordering::Acquire) >= SSE_RESERVED_SLOT {
            if !durable {
                return true;
            }
            let marker = public_event(&ChatroomEvent::LocalStatus {
                room_id: None,
                code: "resync_required".into(),
                message: "SSE 客户端过慢，请重新同步聊天室".into(),
            });
            let delivered = try_send_sse(&sender, &occupancy, marker).is_ok();
            self.subscribers.lock().unwrap().remove(&id);
            return delivered;
        }
        match try_send_sse(&sender, &occupancy, value) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) if !durable => true,
            Err(mpsc::TrySendError::Full(_)) => {
                let marker = public_event(&ChatroomEvent::LocalStatus {
                    room_id: None,
                    code: "resync_required".into(),
                    message: "SSE 客户端过慢，请重新同步聊天室".into(),
                });
                let delivered = try_send_sse(&sender, &occupancy, marker).is_ok();
                self.subscribers.lock().unwrap().remove(&id);
                delivered
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.subscribers.lock().unwrap().remove(&id);
                false
            }
        }
    }

    fn publish_event(&self, event: ChatroomEvent) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        if let Some(seq) = event.seq() {
            self.publish_persistent(event, seq);
            return;
        }
        if let ChatroomEvent::RoomSnapshot { room_id, .. } = &event {
            let mut states = self.rooms.lock().unwrap();
            let state = states.entry(room_id.clone()).or_insert_with(RoomState::new);
            state.subscribed = true;
            state.snapshot = Some(event.clone());
        }
        self.broadcast(&event);
        if matches!(event, ChatroomEvent::AgentInvocation { .. }) {
            self.forward_invocation(&event);
        }
    }

    fn publish_persistent(&self, event: ChatroomEvent, seq: u64) {
        let room_id = event.room_id().unwrap_or_default().to_string();
        let mut should_recover = false;
        let mut should_commit = false;
        {
            let mut states = self.rooms.lock().unwrap();
            let state = states.entry(room_id.clone()).or_insert_with(RoomState::new);
            if !state.subscribed || seq <= state.last_contiguous_seq {
                return;
            }
            if state.gap_recovery {
                state.buffered.entry(seq).or_insert(event.clone());
                if !state.recovering {
                    state.recovering = true;
                    should_recover = true;
                }
            } else if seq == state.last_contiguous_seq.saturating_add(1) {
                state.last_contiguous_seq = seq;
                should_commit = true;
            } else {
                state.gap_recovery = true;
                state.recovering = true;
                state.buffered.insert(seq, event.clone());
                should_recover = true;
            }
        }
        if should_recover {
            if let Err(task) = self.dispatch_task(GatewayTask::Recover(room_id.clone())) {
                if self.task_sender.lock().unwrap().is_some() {
                    self.finish_recovery_with_gap(&room_id);
                } else if let GatewayTask::Recover(room_id) = task {
                    self.recover_room(room_id);
                }
            }
        }
        if should_commit {
            self.commit_event(event);
        }
    }

    fn recover_room(&self, room_id: String) {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                return;
            }
            let buffered = {
                let mut states = self.rooms.lock().unwrap();
                let Some(state) = states.get_mut(&room_id) else {
                    return;
                };
                let expected = state.last_contiguous_seq.saturating_add(1);
                state.buffered.remove(&expected)
            };
            if let Some(event) = buffered {
                let seq = event.seq().unwrap_or(0);
                {
                    let mut states = self.rooms.lock().unwrap();
                    let Some(state) = states.get_mut(&room_id) else {
                        return;
                    };
                    if seq != state.last_contiguous_seq.saturating_add(1) {
                        drop(states);
                        self.finish_recovery_with_gap(&room_id);
                        return;
                    }
                    state.last_contiguous_seq = seq;
                    state.buffered.retain(|buffered_seq, _| *buffered_seq > seq);
                }
                self.commit_event(event);
                continue;
            }
            let has_buffered_future = {
                let states = self.rooms.lock().unwrap();
                states
                    .get(&room_id)
                    .map(|state| !state.buffered.is_empty())
                    .unwrap_or(false)
            };
            if !has_buffered_future {
                let mut states = self.rooms.lock().unwrap();
                if let Some(state) = states.get_mut(&room_id) {
                    state.gap_recovery = false;
                    state.recovering = false;
                }
                return;
            }
            let cursor = {
                let states = self.rooms.lock().unwrap();
                let Some(state) = states.get(&room_id) else {
                    return;
                };
                state.last_contiguous_seq
            };
            let path = format!(
                "/api/chatrooms/v2/rooms/{room_id}/events?afterSeq={cursor}&limit={MAX_RECOVERY_PAGE}"
            );
            let response = match self.transport.request("GET", &path, None) {
                Ok(response) if (200..300).contains(&response.status) => response,
                Ok(_) | Err(_) => {
                    self.finish_recovery_with_gap(&room_id);
                    return;
                }
            };
            let events = match parse_recovery_events(&response.body, &room_id) {
                Ok(events) if !events.is_empty() => events,
                _ => {
                    self.finish_recovery_with_gap(&room_id);
                    return;
                }
            };
            let page_is_contiguous = events
                .iter()
                .enumerate()
                .all(|(index, event)| event.seq() == Some(cursor + index as u64 + 1));
            if !page_is_contiguous {
                self.finish_recovery_with_gap(&room_id);
                return;
            }
            let mut advanced = false;
            for event in events {
                let seq = event.seq().unwrap_or(0);
                let commit = {
                    let mut states = self.rooms.lock().unwrap();
                    let Some(state) = states.get_mut(&room_id) else {
                        return;
                    };
                    if seq <= state.last_contiguous_seq {
                        Ok(None)
                    } else if seq != state.last_contiguous_seq.saturating_add(1) {
                        Err(())
                    } else {
                        state.last_contiguous_seq = seq;
                        state.buffered.retain(|buffered_seq, _| *buffered_seq > seq);
                        Ok(Some(event.clone()))
                    }
                };
                let Ok(commit) = commit else {
                    self.finish_recovery_with_gap(&room_id);
                    return;
                };
                if let Some(event) = commit {
                    advanced = true;
                    self.commit_event(event);
                }
            }
            if !advanced {
                self.finish_recovery_with_gap(&room_id);
                return;
            }
            // 补拉页提交后回到循环顶部，先消费已缓冲的连续事件，再决定是否继续补拉。
        }
    }

    fn finish_recovery_with_gap(&self, room_id: &str) {
        {
            let mut states = self.rooms.lock().unwrap();
            if let Some(state) = states.get_mut(room_id) {
                state.gap_recovery = true;
                state.recovering = false;
            }
        }
        self.publish_status(Some(room_id), "realtime_gap", "聊天室实时事件需要重新同步");
    }

    fn commit_event(&self, event: ChatroomEvent) {
        self.cleanup_lease_for_event(&event);
        self.broadcast(&event);
        if let (Some(room_id), Some(seq)) = (event.room_id(), event.seq()) {
            self.send_client_command_if_started(ChatroomCommand::CursorAck {
                room_id: room_id.to_string(),
                seq,
            });
        }
    }

    fn cleanup_lease_for_event(&self, event: &ChatroomEvent) {
        let should_remove = matches!(
            event,
            ChatroomEvent::AgentOffline { .. } | ChatroomEvent::AgentDisabled { .. }
        );
        if !should_remove {
            return;
        }
        let (room_id, payload) = match event {
            ChatroomEvent::AgentOffline {
                room_id, payload, ..
            }
            | ChatroomEvent::AgentDisabled {
                room_id, payload, ..
            } => (room_id, payload),
            _ => return,
        };
        let Some(agent_id) = payload
            .as_object()
            .and_then(|object| object.get("roomAgentId").or_else(|| object.get("agentId")))
            .and_then(Value::as_str)
        else {
            return;
        };
        self.remove_lease(room_id, agent_id);
    }

    fn forward_invocation(&self, event: &ChatroomEvent) {
        if let Err(task) = self.dispatch_task(GatewayTask::Invocation(event.clone())) {
            if let GatewayTask::Invocation(event) = task {
                if self.task_sender.lock().unwrap().is_none() {
                    self.forward_invocation_now(&event);
                } else {
                    self.send_bridge_busy_failure(&event);
                }
            }
        }
    }

    fn send_bridge_busy_failure(&self, event: &ChatroomEvent) {
        let ChatroomEvent::AgentInvocation { room_id, payload } = event else {
            return;
        };
        let Some(invocation_id) = payload
            .get("invocationId")
            .and_then(Value::as_str)
            .filter(|value| valid_component(value))
        else {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        };
        if self
            .send_client_command(ChatroomCommand::AgentEvent {
                room_id: room_id.clone(),
                invocation_id: invocation_id.to_string(),
                event: AgentEventPayload::Failed {
                    code: "bridge_busy".into(),
                    message: "聊天室 Agent 桥当前繁忙".into(),
                },
            })
            .is_err()
        {
            self.publish_status(Some(room_id), "bridge_busy", "聊天室 Agent 桥当前繁忙");
        }
    }

    fn forward_invocation_now(&self, event: &ChatroomEvent) {
        let ChatroomEvent::AgentInvocation { room_id, payload } = event else {
            return;
        };
        let Some(object) = payload.as_object() else {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        };
        let required = [
            ("invocationId", "invocationId"),
            ("traceId", "traceId"),
            ("targetAgentId", "targetAgentId"),
            ("triggerMessageId", "triggerMessageId"),
        ];
        let mut output = Map::new();
        output.insert("roomId".into(), Value::String(room_id.clone()));
        for (source, target) in required {
            let Some(value) = object.get(source).and_then(Value::as_str) else {
                self.publish_status(
                    Some(room_id),
                    "invocation_invalid",
                    "Agent invocation 格式不正确",
                );
                return;
            };
            if !valid_component(value) || sensitive_scalar(value) {
                self.publish_status(
                    Some(room_id),
                    "invocation_invalid",
                    "Agent invocation 格式不正确",
                );
                return;
            }
            output.insert(target.into(), Value::String(value.into()));
        }
        let Some(depth) = object.get("depth").and_then(Value::as_u64) else {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        };
        if depth > u8::MAX as u64 || validate_invocation_depth(depth as u8).is_err() {
            self.publish_status(
                Some(room_id),
                "invocation_limit_reached",
                "Agent invocation 深度已达上限",
            );
            return;
        }
        output.insert("depth".into(), Value::from(depth));
        if let Some(status) = object.get("status").and_then(Value::as_str) {
            if valid_component(status) {
                output.insert("status".into(), Value::String(status.into()));
            }
        }
        if let Some(status_code) = object.get("statusCode").and_then(Value::as_str) {
            if valid_component(status_code) {
                output.insert("statusCode".into(), Value::String(status_code.into()));
            }
        }
        let body = Value::Object(output).to_string().into_bytes();
        if self.bridge.send_invocation(body, &self.shutdown).is_err() {
            self.publish_status(Some(room_id), "bridge_unavailable", "聊天室业务桥不可用");
        }
    }

    fn broadcast(&self, event: &ChatroomEvent) {
        let value = public_event(event);
        let durable = is_durable_event(event);
        let room_id = event.room_id().map(str::to_string);
        let recipients = {
            let subscribers = self.subscribers.lock().unwrap();
            subscribers
                .iter()
                .filter(|(_, subscriber)| {
                    room_id
                        .as_deref()
                        .map(|room| subscriber.rooms.contains(room))
                        .unwrap_or(true)
                })
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        };
        for id in recipients {
            let _ = self.send_to_subscriber(id, value.clone(), durable);
        }
    }

    fn publish_status(&self, room_id: Option<&str>, code: &str, message: &str) {
        self.broadcast(&ChatroomEvent::LocalStatus {
            room_id: room_id.map(str::to_string),
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    fn refresh_subscription_snapshot(&self) {
        if self.shutdown.load(Ordering::Acquire) || !self.started.load(Ordering::Acquire) {
            return;
        }
        let rooms = {
            let states = self.rooms.lock().unwrap();
            states
                .iter()
                .filter(|(_, state)| state.subscribed)
                .map(|(room_id, state)| RoomCursor {
                    room_id: room_id.clone(),
                    after_seq: state.last_contiguous_seq,
                })
                .collect::<Vec<_>>()
        };
        if rooms.is_empty() {
            return;
        }
        self.send_client_command_if_started(ChatroomCommand::Subscribe {
            rooms,
            device_id: self.device_id.clone(),
        });
    }

    fn send_client_command_if_started(&self, command: ChatroomCommand) {
        if self.shutdown.load(Ordering::Acquire) || !self.started.load(Ordering::Acquire) {
            return;
        }
        if self.client.command(command).is_err() {
            self.publish_status(None, "realtime_unavailable", "聊天室实时连接不可用");
        }
    }

    fn send_client_command(&self, command: ChatroomCommand) -> Result<(), ChatroomGatewayError> {
        if self.shutdown.load(Ordering::Acquire) || !self.started.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                503,
                "realtime_unavailable",
                "聊天室实时连接不可用",
            ));
        }
        self.client
            .command(command)
            .map_err(|error| ChatroomGatewayError::new(503, error.code, "聊天室实时连接不可用"))
    }

    fn tick_leases(&self, now: Instant) {
        {
            let mut last = self.last_lease_tick.lock().unwrap();
            if now.duration_since(*last) < Duration::from_secs(1) {
                return;
            }
            *last = now;
        }
        let mut renew = Vec::new();
        let mut expired = Vec::new();
        {
            let mut leases = self.leases.lock().unwrap();
            for key in leases.keys().cloned().collect::<Vec<_>>() {
                let Some(lease) = leases.get_mut(&key) else {
                    continue;
                };
                if now >= lease.expires_at {
                    expired.push(key.clone());
                } else if now >= lease.next_renew_at {
                    lease.next_renew_at = now + LEASE_RENEW_INTERVAL;
                    lease.expires_at = now + LEASE_DURATION;
                    renew.push((
                        lease.room_id.clone(),
                        lease.room_agent_id.clone(),
                        lease.device_id.clone(),
                    ));
                }
            }
            for key in &expired {
                leases.remove(key);
            }
        }
        for (room_id, agent_id, device_id) in renew {
            self.send_client_command_if_started(ChatroomCommand::RenewLease {
                room_id,
                agent_id,
                device_id,
            });
        }
        for (room_id, _) in expired {
            self.publish_status(Some(&room_id), "agent_offline", "Agent lease 已过期");
        }
    }

    fn update_local_state_after_route(&self, method: &str, route: &Route<'_>) {
        match route {
            Route::Room(room_id)
            | Route::Archive(room_id)
            | Route::Restore(room_id)
            | Route::Leave(room_id)
            | Route::Read(room_id)
            | Route::Messages(room_id)
            | Route::Events(room_id)
            | Route::Agents(room_id) => {
                self.mark_room_subscribed(room_id);
                if method == "DELETE" && matches!(route, Route::Room(_)) {
                    self.remove_room_leases(room_id);
                }
            }
            Route::Agent(room_id, agent_id) | Route::Lease(room_id, agent_id) => {
                self.mark_room_subscribed(room_id);
                if method == "DELETE" && matches!(route, Route::Agent(_, _)) {
                    self.remove_lease(room_id, agent_id);
                }
            }
            Route::MemberRemove(room_id, _) => {
                self.mark_room_subscribed(room_id);
            }
            Route::Rooms
            | Route::Join
            | Route::LocalSse
            | Route::InternalUpload
            | Route::InternalDownload
            | Route::InternalFinalize
            | Route::InternalInvocation(_, _) => {}
        }
        self.refresh_subscription_snapshot();
    }

    fn mark_room_subscribed(&self, room_id: &str) {
        if let Ok(room_id) = normalize_room_id(room_id) {
            self.rooms
                .lock()
                .unwrap()
                .entry(room_id)
                .or_insert_with(RoomState::new)
                .subscribed = true;
        }
    }

    fn register_lease(&self, room_id: &str, agent_id: &str, device_id: &str) {
        let now = self.clock.now();
        self.leases.lock().unwrap().insert(
            (room_id.to_string(), agent_id.to_string()),
            LeaseState {
                room_id: room_id.to_string(),
                room_agent_id: agent_id.to_string(),
                device_id: device_id.to_string(),
                expires_at: now + LEASE_DURATION,
                next_renew_at: now + LEASE_RENEW_INTERVAL,
            },
        );
    }

    fn remove_lease(&self, room_id: &str, agent_id: &str) {
        self.leases
            .lock()
            .unwrap()
            .remove(&(room_id.to_string(), agent_id.to_string()));
        self.refresh_subscription_snapshot();
    }

    fn remove_room_leases(&self, room_id: &str) {
        self.leases
            .lock()
            .unwrap()
            .retain(|(lease_room, _), _| lease_room != room_id);
        self.refresh_subscription_snapshot();
    }

    pub fn shutdown_connection(&self) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        self.client.pause();
        self.notify_disconnected();
    }

    pub fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        self.leases.lock().unwrap().clear();
        self.subscribers.lock().unwrap().clear();
        self.client.shutdown();
        if let Some(worker) = self.event_worker.lock().unwrap().take() {
            if worker.thread().id() != thread::current().id() {
                let _ = worker.join();
            }
        }
        self.task_sender.lock().unwrap().take();
        let mut task_workers = self.task_workers.lock().unwrap();
        for worker in task_workers.drain(..) {
            if worker.thread().id() != thread::current().id() {
                let _ = worker.join();
            }
        }
        self.client_events.lock().unwrap().take();
    }

    #[cfg(test)]
    pub(crate) fn publish_event_for_test(&self, event: ChatroomEvent) {
        self.publish_event(event);
    }

    #[cfg(test)]
    pub(crate) fn handle_client_event_for_test(&self, event: ChatroomClientEvent) {
        self.handle_client_event(event);
    }

    #[cfg(test)]
    pub(crate) fn set_room_cursor_for_test(&self, room_id: &str, seq: u64) {
        let mut rooms = self.rooms.lock().unwrap();
        let state = rooms
            .entry(room_id.to_string())
            .or_insert_with(RoomState::new);
        state.subscribed = true;
        state.last_contiguous_seq = seq;
    }

    #[cfg(test)]
    pub(crate) fn room_cursor_for_test(&self, room_id: &str) -> Option<u64> {
        self.rooms
            .lock()
            .unwrap()
            .get(room_id)
            .map(|state| state.last_contiguous_seq)
    }

    #[cfg(test)]
    pub(crate) fn subscriber_count_for_test(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }

    #[cfg(test)]
    pub(crate) fn buffered_count_for_test(&self, room_id: &str) -> usize {
        self.rooms
            .lock()
            .unwrap()
            .get(room_id)
            .map(|state| state.buffered.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn lease_count_for_test(&self) -> usize {
        self.leases.lock().unwrap().len()
    }

    #[cfg(test)]
    pub(crate) fn register_lease_for_test(&self, room_id: &str, agent_id: &str, device_id: &str) {
        self.register_lease(room_id, agent_id, device_id);
    }

    #[cfg(test)]
    pub(crate) fn command_after_shutdown_for_test(&self) -> Result<(), ChatroomGatewayError> {
        self.send_client_command(ChatroomCommand::CursorAck {
            room_id: "room-1".into(),
            seq: 1,
        })
    }

    #[cfg(test)]
    pub(crate) fn tick_leases_for_test(&self, now: Instant) {
        self.tick_leases(now);
    }

    #[cfg(test)]
    pub(crate) fn gate_next_task_for_test(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.task_gate.lock().unwrap() = Some(TaskGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }

    #[cfg(test)]
    pub(crate) fn shutdown_requested_for_test(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }
}

impl Drop for ChatroomGateway {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn split_target(target: &str) -> Result<(String, String), ChatroomGatewayError> {
    if target.len() > MAX_QUERY_BYTES + MAX_BODY_BYTES || !target.starts_with('/') {
        return Err(invalid_request("聊天室请求路径不正确"));
    }
    if target.to_ascii_lowercase().contains("%2f")
        || target.to_ascii_lowercase().contains("%5c")
        || target.to_ascii_lowercase().contains("%3f")
        || target.to_ascii_lowercase().contains("%23")
    {
        return Err(invalid_request("聊天室路径不允许编码分隔符"));
    }
    let mut parts = target.splitn(2, '?');
    let path = parts.next().unwrap_or_default();
    let query = parts.next().unwrap_or_default();
    if query.len() > MAX_QUERY_BYTES || query.contains('#') || query.contains('?') {
        return Err(invalid_request("聊天室查询参数不正确"));
    }
    Ok((path.to_string(), query.to_string()))
}

fn parse_route(path: &str) -> Result<Route<'_>, ChatroomGatewayError> {
    if path == CHATROOM_SSE_PATH {
        return Ok(Route::LocalSse);
    }
    let internal_prefix = format!("{CHATROOM_INTERNAL_PREFIX}/");
    if path == format!("{CHATROOM_INTERNAL_PREFIX}/cos/upload-grant") {
        return Ok(Route::InternalUpload);
    }
    if path == format!("{CHATROOM_INTERNAL_PREFIX}/cos/download-grant") {
        return Ok(Route::InternalDownload);
    }
    if path == format!("{CHATROOM_INTERNAL_PREFIX}/cos/finalize") {
        return Ok(Route::InternalFinalize);
    }
    if path.starts_with(&internal_prefix) {
        let parts: Vec<&str> = path[internal_prefix.len()..].split('/').collect();
        if parts.len() == 3 && parts[0] == "invocations" && valid_component(parts[1]) {
            return Ok(Route::InternalInvocation(parts[1], parts[2]));
        }
        return Err(route_not_found());
    }
    let prefix = format!("{CHATROOM_HTTP_PREFIX}/");
    if path == format!("{CHATROOM_HTTP_PREFIX}/join") {
        return Ok(Route::Join);
    }
    if !path.starts_with(&prefix) {
        return Err(route_not_found());
    }
    let parts: Vec<&str> = path[prefix.len()..].split('/').collect();
    if parts.len() == 1 && parts[0] == "rooms" {
        return Ok(Route::Rooms);
    }
    if parts.len() < 2 || parts[0] != "rooms" || !valid_component(parts[1]) {
        return Err(route_not_found());
    }
    normalize_room_id(parts[1]).map_err(|_| route_not_found())?;
    let room_id = parts[1];
    if parts.len() == 2 {
        return Ok(Route::Room(room_id));
    }
    let route = match parts.as_slice() {
        [_, _, "archive"] => Route::Archive(room_id),
        [_, _, "restore"] => Route::Restore(room_id),
        [_, _, "leave"] => Route::Leave(room_id),
        [_, _, "read"] => Route::Read(room_id),
        [_, _, "messages"] => Route::Messages(room_id),
        [_, _, "events"] => Route::Events(room_id),
        [_, _, "agents"] => Route::Agents(room_id),
        [_, _, "members", member_id] if valid_member_id(member_id) => {
            Route::MemberRemove(room_id, member_id)
        }
        [_, _, "agents", agent_id] if valid_component(agent_id) => Route::Agent(room_id, agent_id),
        [_, _, "agents", agent_id, "lease"] if valid_component(agent_id) => {
            Route::Lease(room_id, agent_id)
        }
        _ => return Err(route_not_found()),
    };
    Ok(route)
}

fn method_allowed(method: &str, route: &Route<'_>) -> bool {
    matches!(
        (method, route),
        ("GET", Route::Rooms)
            | ("POST", Route::Rooms)
            | ("GET", Route::Room(_))
            | ("PATCH", Route::Room(_))
            | ("DELETE", Route::Room(_))
            | ("POST", Route::Archive(_))
            | ("POST", Route::Restore(_))
            | ("POST", Route::Leave(_))
            | ("DELETE", Route::MemberRemove(_, _))
            | ("PATCH", Route::Read(_))
            | ("GET", Route::Messages(_))
            | ("GET", Route::Events(_))
            | ("POST", Route::Messages(_))
            | ("POST", Route::Agents(_))
            | ("PATCH", Route::Agent(_, _))
            | ("DELETE", Route::Agent(_, _))
            | ("POST", Route::Lease(_, _))
            | ("POST", Route::Join)
            | ("POST", Route::InternalUpload)
            | ("POST", Route::InternalDownload)
            | ("POST", Route::InternalFinalize)
            | ("POST", Route::InternalInvocation(_, _))
    )
}

fn parse_sse_room_ids(query: &str) -> Result<Vec<String>, ChatroomGatewayError> {
    let mut rooms = Vec::new();
    let mut selected_key = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            return Err(invalid_request("SSE 查询参数不正确"));
        }
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| invalid_request("SSE 查询参数不正确"))?;
        if (key != "roomId" && key != "roomIds") || value.is_empty() {
            return Err(invalid_request("SSE 查询参数不正确"));
        }
        if selected_key.is_some() {
            return Err(invalid_request("SSE 查询参数不正确"));
        }
        selected_key = Some(key);
        if value.split(',').any(|value| value.is_empty()) {
            return Err(invalid_request("SSE 查询参数不正确"));
        }
        rooms.extend(value.split(',').map(str::to_string));
    }
    Ok(rooms)
}

fn canonical_query_for_route(
    route: &Route<'_>,
    query: &str,
) -> Result<String, ChatroomGatewayError> {
    if query.is_empty() {
        return Ok(String::new());
    }
    let allowed: &[&str] = match route {
        Route::Messages(_) => &["beforeSeq", "limit"],
        Route::Events(_) => &["afterSeq", "limit"],
        _ => &[],
    };
    let mut values = HashMap::new();
    for pair in query.split('&') {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| invalid_request("查询参数不正确"))?;
        if !allowed.contains(&key) || value.is_empty() || values.contains_key(key) {
            return Err(invalid_request("查询参数不正确"));
        }
        let parsed = value
            .parse::<u64>()
            .map_err(|_| invalid_request("查询参数不正确"))?;
        if key == "limit" && !(1..=500).contains(&parsed) {
            return Err(invalid_request("查询参数不正确"));
        }
        if key != "limit" && parsed > i64::MAX as u64 {
            return Err(invalid_request("查询参数不正确"));
        }
        values.insert(key, parsed);
    }
    let order = match route {
        Route::Messages(_) => ["beforeSeq", "limit"],
        Route::Events(_) => ["afterSeq", "limit"],
        _ => return Ok(String::new()),
    };
    Ok(order
        .iter()
        .filter_map(|key| values.get(key).map(|value| format!("{key}={value}")))
        .collect::<Vec<_>>()
        .join("&"))
}

fn body_required(method: &str, route: &Route<'_>) -> bool {
    matches!(
        (method, route),
        ("POST", Route::Rooms)
            | ("POST", Route::Join)
            | ("POST", Route::Messages(_))
            | ("POST", Route::Agents(_))
            | ("POST", Route::Lease(_, _))
            | ("PATCH", Route::Room(_))
            | ("PATCH", Route::Read(_))
            | ("PATCH", Route::Agent(_, _))
    )
}

fn parse_strict_json(body: &[u8]) -> Result<Value, ()> {
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let value = deserializer
        .deserialize_any(StrictValueVisitor)
        .map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    Ok(value)
}

fn parse_body_value(body: &[u8], required: bool) -> Result<Value, ChatroomGatewayError> {
    if body.is_empty() {
        if required {
            return Err(invalid_request("请求体不能为空"));
        }
        return Ok(Value::Null);
    }
    parse_strict_json(body).map_err(|_| invalid_request("请求体不是有效 JSON"))
}

struct StrictValueSeed;

impl<'de> DeserializeSeed<'de> for StrictValueSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JSON value without duplicate object keys")
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(StrictValueSeed)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            values.insert(key, map.next_value_seed(StrictValueSeed)?);
        }
        Ok(Value::Object(values))
    }
}

fn normalize_public_body(
    method: &str,
    route: &Route<'_>,
    value: &Value,
    has_body: bool,
) -> Result<Option<String>, ChatroomGatewayError> {
    let is_body_route = body_required(method, route);
    if !is_body_route {
        if has_body {
            return Err(invalid_request("该路由不接受请求体"));
        }
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| invalid_request("请求体必须是对象"))?;
    let normalized = match (method, route) {
        ("POST", Route::Rooms) => {
            require_keys(object, &["name", "shareCode"])?;
            let name = required_text(object, "name")?;
            let share_code = required_share_code(object, "shareCode")?;
            serde_json::json!({"name":name,"shareCode":share_code})
        }
        ("PATCH", Route::Room(_)) => {
            if object.is_empty() {
                return Err(invalid_request("更新聊天室至少需要一个字段"));
            }
            require_optional_keys(object, &["name", "shareCode", "shareCodeEnabled"])?;
            let mut result = Map::new();
            if object.contains_key("name") {
                result.insert(
                    "name".into(),
                    Value::String(required_text(object, "name")?.into()),
                );
            }
            if object.contains_key("shareCode") {
                result.insert(
                    "shareCode".into(),
                    Value::String(required_share_code(object, "shareCode")?.into()),
                );
            }
            if object.contains_key("shareCodeEnabled") {
                result.insert(
                    "shareCodeEnabled".into(),
                    Value::Bool(
                        object["shareCodeEnabled"]
                            .as_bool()
                            .ok_or_else(|| invalid_request("shareCodeEnabled 类型不正确"))?,
                    ),
                );
            }
            Value::Object(result)
        }
        ("POST", Route::Join) => {
            require_keys(object, &["shareCode"])?;
            serde_json::json!({"shareCode":required_share_code(object,"shareCode")?})
        }
        ("PATCH", Route::Read(_)) => {
            require_keys(object, &["seq"])?;
            if object["seq"]
                .as_u64()
                .is_none_or(|seq| seq > i64::MAX as u64)
            {
                return Err(invalid_request("seq 必须是非负整数"));
            }
            Value::Object(object.clone())
        }
        ("POST", Route::Agents(_)) => {
            require_optional_keys(object, &["displayName", "avatar", "deviceId"])?;
            if !object.contains_key("displayName") || !object.contains_key("deviceId") {
                return Err(invalid_request("新增 Agent 缺少必要字段"));
            }
            let display_name = required_text(object, "displayName")?;
            let device_id = required_text(object, "deviceId")?;
            let mut result = serde_json::json!({"displayName":display_name,"deviceId":device_id});
            if object.contains_key("avatar") {
                result["avatar"] = Value::String(required_text(object, "avatar")?.into());
            }
            result
        }
        ("PATCH", Route::Agent(_, _)) => {
            if object.is_empty() {
                return Err(invalid_request("更新 Agent 至少需要一个字段"));
            }
            require_optional_keys(object, &["displayName", "avatar"])?;
            let mut result = Map::new();
            for key in ["displayName", "avatar"] {
                if object.contains_key(key) {
                    result.insert(
                        key.into(),
                        Value::String(required_text(object, key)?.into()),
                    );
                }
            }
            Value::Object(result)
        }
        ("POST", Route::Lease(_, _)) => {
            require_keys(object, &["deviceId"])?;
            serde_json::json!({"deviceId":required_text(object,"deviceId")?})
        }
        ("POST", Route::Messages(_)) => normalize_message_body(value)?,
        _ => return Err(invalid_request("请求体 schema 不正确")),
    };
    Ok(Some(normalized.to_string()))
}

fn require_optional_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), ChatroomGatewayError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_request("请求体包含未知字段"));
    }
    Ok(())
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ChatroomGatewayError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 128 && value.trim() == *value)
        .ok_or_else(|| invalid_request("文本字段不正确"))
}

fn required_file_name<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ChatroomGatewayError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 255 && value.trim() == *value)
        .ok_or_else(|| invalid_request("文件名不正确"))
}

fn valid_media_type(value: &str) -> bool {
    if value.len() > 128 || value.contains(['\r', '\n']) {
        return false;
    }
    let value = value.trim();
    let Some((media_type, parameters)) = split_media_type(value) else {
        return false;
    };
    if media_type.is_empty()
        || !media_type
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'/' || is_media_token(byte))
    {
        return false;
    }
    if media_type.bytes().filter(|byte| *byte == b'/').count() > 1 {
        return false;
    }
    parameters
        .into_iter()
        .all(|parameter| valid_media_parameter(parameter.trim()))
}

fn split_media_type(value: &str) -> Option<(&str, Vec<&str>)> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in value.bytes().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match byte {
            b'\\' if quoted => escaped = true,
            b'"' => quoted = !quoted,
            b';' if !quoted => {
                parts.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    if quoted || escaped {
        return None;
    }
    parts.push(&value[start..]);
    let media_type = parts.first()?.trim();
    Some((media_type, parts.into_iter().skip(1).collect()))
}

fn valid_media_parameter(parameter: &str) -> bool {
    let Some((name, raw_value)) = parameter.split_once('=') else {
        return false;
    };
    let name = name.trim();
    let value = raw_value.trim();
    if name.is_empty() || value.is_empty() || !name.bytes().all(is_media_token) {
        return false;
    }
    if value.starts_with('"') {
        if !value.ends_with('"') || value.len() < 2 {
            return false;
        }
        let mut escaped = false;
        for byte in value[1..value.len() - 1].bytes() {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' || byte.is_ascii_control() {
                return false;
            }
        }
        !escaped
    } else {
        value.bytes().all(is_media_token)
    }
}

fn is_media_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn required_share_code<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ChatroomGatewayError> {
    let value = required_text(object, key)?;
    if value.len() != 4 || !value.chars().all(|char| char.is_ascii_alphanumeric()) {
        return Err(invalid_request("分享码必须是 4 位字母或数字"));
    }
    Ok(value)
}

fn normalize_message_body(value: &Value) -> Result<Value, ChatroomGatewayError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_request("消息请求体必须是对象"))?;
    let allowed = [
        "content",
        "mentionAgentIds",
        "attachmentIds",
        "clientMessageId",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_request("消息请求包含不允许的字段"));
    }
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 64 * 1024)
        .ok_or_else(|| invalid_request("消息正文不能为空"))?;
    let mentions = optional_string_array(object, "mentionAgentIds")?;
    if mentions.len() > 3 {
        return Err(invalid_request("消息 @Agent 数量超限"));
    }
    let attachments = optional_string_array(object, "attachmentIds")?;
    let client_message_id = match object.get("clientMessageId") {
        Some(Value::String(value)) if valid_uuid(value) => value.clone(),
        Some(_) => return Err(invalid_request("clientMessageId 不合法")),
        None => generate_message_id(),
    };
    Ok(serde_json::json!({
        "content": content,
        "mentionAgentIds": mentions,
        "attachmentIds": attachments,
        "clientMessageId": client_message_id,
    }))
}

fn generate_message_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        return format!("00000000-0000-4000-8000-{:012x}", 0_u64);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().iter().enumerate().all(|(index, value)| {
            matches!(index, 8 | 13 | 18 | 23) && *value == b'-'
                || !matches!(index, 8 | 13 | 18 | 23) && (*value as char).is_ascii_hexdigit()
        })
}

fn optional_string_array(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, ChatroomGatewayError> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid_request("数组字段格式不正确"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| valid_component(value))
                    .map(str::to_string)
                    .ok_or_else(|| invalid_request("数组字段包含不合法 ID"))
            })
            .collect(),
    }
}

fn string_array(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, ChatroomGatewayError> {
    optional_string_array(object, key)
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 128
        && !value.chars().any(|value| {
            value.is_control() || value.is_whitespace() || matches!(value, '/' | '?' | '#' | '\\')
        })
}

fn valid_member_id(value: &str) -> bool {
    value.parse::<u64>().ok().is_some_and(|value| value > 0)
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ChatroomGatewayError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_component(value))
        .ok_or_else(|| invalid_request("内部请求字段不正确"))
}

fn require_keys(object: &Map<String, Value>, keys: &[&str]) -> Result<(), ChatroomGatewayError> {
    if object.keys().any(|key| !keys.contains(&key.as_str()))
        || keys.iter().any(|key| !object.contains_key(*key))
    {
        return Err(invalid_request("内部请求包含未知或缺失字段"));
    }
    Ok(())
}

fn public_response(
    response: GatewayTransportResponse,
) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
    if response.status == 204 || response.body.is_empty() {
        return Ok(GatewayHttpResponse::Empty {
            status: response.status,
        });
    }
    let body = parse_strict_json(&response.body)
        .map(|value| sanitize_public(&value))
        .unwrap_or_else(|_| serde_json::json!({"error":"上游响应格式不正确","code":"invalid_upstream_response"}));
    Ok(GatewayHttpResponse::Json {
        status: response.status,
        body,
    })
}

fn parse_json_response(body: &[u8]) -> Result<Value, ChatroomGatewayError> {
    parse_strict_json(body).map_err(|_| {
        ChatroomGatewayError::new(502, "invalid_upstream_response", "上游响应格式不正确")
    })
}

fn sensitive_scalar(value: &str) -> bool {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    lower.starts_with("bearer ")
        || (lower.starts_with("eyj") && value.matches('.').count() >= 2)
        || lower.starts_with("qcs::")
        || [
            "/users/",
            "/volumes/",
            "/private/",
            "/home/",
            "/tmp/",
            "/var/",
            "/mnt/",
            "/srv/",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || lower.get(1..3).is_some_and(|prefix| prefix == ":/")
}

fn parse_recovery_events(
    body: &[u8],
    expected_room: &str,
) -> Result<Vec<ChatroomEvent>, ChatroomGatewayError> {
    let root = parse_json_response(body)?;
    let object = root
        .as_object()
        .ok_or_else(|| invalid_request("补拉响应格式不正确"))?;
    if object.keys().any(|key| key != "data") {
        return Err(invalid_request("补拉响应包含未知字段"));
    }
    let data = object
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_request("补拉响应缺少 data"))?;
    let mut result = Vec::with_capacity(data.len());
    for item in data {
        let item = item
            .as_object()
            .ok_or_else(|| invalid_request("补拉事件格式不正确"))?;
        let allowed = [
            "eventId",
            "roomId",
            "seq",
            "eventType",
            "payload",
            "createdAt",
        ];
        require_keys(item, &allowed)?;
        let event_room = item
            .get("roomId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("补拉事件缺少 roomId"))?;
        if event_room != expected_room {
            return Err(invalid_request("补拉事件聊天室不匹配"));
        }
        let seq = item
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid_request("补拉事件 seq 不正确"))?;
        if seq == 0 || seq > i64::MAX as u64 {
            return Err(invalid_request("补拉事件 seq 不正确"));
        }
        if item
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|value| valid_component(value))
            .is_none()
            || item
                .get("createdAt")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .is_none()
        {
            return Err(invalid_request("补拉事件元数据不正确"));
        }
        let event_type = item
            .get("eventType")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("补拉事件缺少 eventType"))?;
        let payload = item
            .get("payload")
            .cloned()
            .ok_or_else(|| invalid_request("补拉事件缺少 payload"))?;
        let envelope = serde_json::json!({
            "type": event_type,
            "roomId": event_room,
            "seq": seq,
            "payload": payload,
        });
        let event = crate::chatroom_protocol::parse_event(&envelope.to_string().into_bytes())
            .map_err(|_| invalid_request("补拉事件协议不正确"))?;
        if event.seq().is_none() {
            return Err(invalid_request("补拉事件必须是持久事件"));
        }
        result.push(event);
    }
    result.sort_by_key(|event| event.seq().unwrap_or(0));
    Ok(result)
}

fn is_durable_event(event: &ChatroomEvent) -> bool {
    matches!(
        event,
        ChatroomEvent::RoomSnapshot { .. }
            | ChatroomEvent::MessageCreated { .. }
            | ChatroomEvent::RoomUpdated { .. }
            | ChatroomEvent::MemberRemoved { .. }
            | ChatroomEvent::AgentUpdated { .. }
            | ChatroomEvent::AttachmentUpdated { .. }
            | ChatroomEvent::AgentOffline { .. }
            | ChatroomEvent::AgentBusy { .. }
            | ChatroomEvent::AgentDisabled { .. }
            | ChatroomEvent::InvocationLimitReached { .. }
            | ChatroomEvent::AgentCompleted { .. }
            | ChatroomEvent::AgentFailed { .. }
            | ChatroomEvent::LocalStatus { .. }
    )
}

fn invalid_request(message: impl Into<String>) -> ChatroomGatewayError {
    ChatroomGatewayError::new(400, "invalid_chatroom_request", message)
}
fn method_not_allowed() -> ChatroomGatewayError {
    ChatroomGatewayError::new(405, "method_not_allowed", "聊天室请求方法不支持")
}
fn route_not_found() -> ChatroomGatewayError {
    ChatroomGatewayError::new(404, "chatroom_route_not_found", "聊天室路由不存在")
}

pub fn is_chatroom_path(path: &str) -> bool {
    path == CHATROOM_HTTP_PREFIX || path.starts_with(&format!("{CHATROOM_HTTP_PREFIX}/"))
}

pub fn is_chatroom_internal_path(path: &str) -> bool {
    path == CHATROOM_INTERNAL_PREFIX || path.starts_with(&format!("{CHATROOM_INTERNAL_PREFIX}/"))
}
