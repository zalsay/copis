use crate::auth_session::{AuthError, AuthSession};
use crate::chatroom_ack::{AckError, ConfirmedCommand};
use crate::chatroom_client::{ChatroomClient, ChatroomClientEvent, ChatroomSocketConnector};
use crate::chatroom_execution::{
    ChatroomExecutionBinding, ChatroomExecutionRegistry, ChatroomOrigin,
};
use crate::chatroom_protocol::{
    chatroom_ws_url, filter_cos_sts, normalize_room_id, public_event, reply_digest,
    sanitize_public, validate_invocation_depth, AgentEventPayload, ChatroomCapability,
    ChatroomCommand, ChatroomEvent, ChatroomProtocolOptions, ChatroomReplyDigestInput, CosAction,
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
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_INVOCATION_BRIDGE_BYTES: usize = 128 * 1024;
const MAX_INVOCATION_STATUS_BYTES: usize = 128 * 1024;
const MAX_MANAGEMENT_BODY_BYTES: usize = 64 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 4096;
const SSE_CAPACITY: usize = 64;
const SSE_RESERVED_SLOT: usize = SSE_CAPACITY - 1;
const LEASE_DURATION: Duration = Duration::from_secs(60);
const LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(20);
const MAX_RECOVERY_PAGE: usize = 500;
const TASK_WORKER_COUNT: usize = 4;
const TASK_QUEUE_CAPACITY: usize = 64;
const NO_CLIENT_GENERATION: u64 = u64::MAX;
const CHATROOM_CAPABILITIES_PATH: &str = "/api/chatrooms/v2/capabilities";
const MAX_LEGACY_LIFECYCLE_WAITERS: usize = 256;
pub(super) const CHATROOM_NATIVE_RUNTIME_UNSUPPORTED: &str = "chatroom_native_runtime_unsupported";
const CHATROOM_NATIVE_RUNTIME_UNSUPPORTED_MESSAGE: &str =
    "当前本机 Rust 运行时不支持可信聊天室来源校验，请更新并重启 Copis";

fn is_chatroom_failure_code(value: &str) -> bool {
    matches!(
        value,
        "room_not_found"
            | "room_archived"
            | "not_room_member"
            | "share_code_invalid"
            | "share_code_rate_limited"
            | "agent_limit_reached"
            | "agent_offline"
            | "agent_busy"
            | "invocation_duplicate"
            | "invocation_depth_exceeded"
            | "host_approval_timeout"
            | "host_approval_denied"
            | "attachment_not_ready"
            | "attachment_forbidden"
            | "realtime_reconnecting"
            | "gateway_disconnected"
            | "app_quit"
            | "invalid_invocation"
            | "invalid_output"
            | "room_agent_not_found"
            | "internal_error"
    )
}

struct LegacyLifecycleWaiter {
    generation: u64,
    expected: LegacyLifecycleExpectation,
    sender: mpsc::SyncSender<Result<Option<LegacyTerminalProof>, AckError>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LegacyTerminalProof {
    Completed {
        reply_client_message_id: String,
        reply_digest: String,
    },
    Failed {
        failure_code: String,
    },
}

impl LegacyTerminalProof {
    fn to_value(&self) -> Value {
        match self {
            Self::Completed {
                reply_client_message_id,
                reply_digest,
            } => serde_json::json!({
                "kind": "matched-server-event-v1",
                "replyClientMessageId": reply_client_message_id,
                "replyDigest": reply_digest,
            }),
            Self::Failed { failure_code } => serde_json::json!({
                "kind": "matched-server-event-v1",
                "failureCode": failure_code,
            }),
        }
    }
}

enum LegacyLifecycleExpectation {
    Command(ChatroomCommand),
    Status {
        room_id: String,
        invocation_id: String,
        status: String,
        client_message_id: String,
        reply_digest: String,
        failure_code: String,
    },
}

#[derive(Default)]
struct LegacyLifecycleWaiters {
    entries: Mutex<HashMap<String, LegacyLifecycleWaiter>>,
}

impl LegacyLifecycleWaiters {
    fn register(
        &self,
        generation: u64,
        request_id: &str,
        command: ChatroomCommand,
    ) -> Result<mpsc::Receiver<Result<Option<LegacyTerminalProof>, AckError>>, AckError> {
        self.register_expected(
            generation,
            request_id,
            LegacyLifecycleExpectation::Command(command),
        )
    }

    fn register_status(
        &self,
        generation: u64,
        request_id: &str,
        room_id: &str,
        invocation_id: &str,
        status: &str,
        client_message_id: &str,
        reply_digest: &str,
        failure_code: &str,
    ) -> Result<mpsc::Receiver<Result<Option<LegacyTerminalProof>, AckError>>, AckError> {
        self.register_expected(
            generation,
            request_id,
            LegacyLifecycleExpectation::Status {
                room_id: room_id.to_string(),
                invocation_id: invocation_id.to_string(),
                status: status.to_string(),
                client_message_id: client_message_id.to_string(),
                reply_digest: reply_digest.to_string(),
                failure_code: failure_code.to_string(),
            },
        )
    }

    fn register_expected(
        &self,
        generation: u64,
        request_id: &str,
        expected: LegacyLifecycleExpectation,
    ) -> Result<mpsc::Receiver<Result<Option<LegacyTerminalProof>, AckError>>, AckError> {
        let mut entries = self.entries.lock().expect("legacy lifecycle map poisoned");
        if entries.contains_key(request_id)
            || entries.values().any(|pending| {
                pending.generation == generation
                    && same_lifecycle_identity(&pending.expected, &expected)
            })
        {
            return Err(AckError::DuplicateRequest);
        }
        if entries.len() >= MAX_LEGACY_LIFECYCLE_WAITERS {
            return Err(AckError::Full);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        entries.insert(
            request_id.to_string(),
            LegacyLifecycleWaiter {
                generation,
                expected,
                sender,
            },
        );
        Ok(receiver)
    }

    fn observe(
        &self,
        generation: u64,
        event: &ChatroomEvent,
        allow_accepted: bool,
    ) -> Option<ChatroomCommand> {
        let mut entries = self.entries.lock().expect("legacy lifecycle map poisoned");
        let matched = entries.iter().find_map(|(id, pending)| {
            (pending.generation == generation)
                .then(|| {
                    lifecycle_event_match(&pending.expected, event)
                        .map(|matched| (id.clone(), matched))
                })
                .flatten()
        });
        let (id, outcome) = matched?;
        let pending = entries.remove(&id).expect("matched waiter exists");
        let outcome = if !allow_accepted
            && matches!(
                &pending.expected,
                LegacyLifecycleExpectation::Command(ChatroomCommand::AgentAccepted { .. })
            ) {
            Err(AckError::Full)
        } else {
            outcome
        };
        match outcome {
            Ok(terminal_proof) => {
                let _ = pending.sender.try_send(Ok(terminal_proof));
                match pending.expected {
                    LegacyLifecycleExpectation::Command(command) => Some(command),
                    LegacyLifecycleExpectation::Status { .. } => None,
                }
            }
            Err(error) => {
                let _ = pending.sender.try_send(Err(error));
                None
            }
        }
    }

    fn cancel(&self, generation: u64, request_id: &str) {
        let mut entries = self.entries.lock().expect("legacy lifecycle map poisoned");
        if entries
            .get(request_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            entries.remove(request_id);
        }
    }

    fn invalidate_all(&self) {
        let mut entries = self.entries.lock().expect("legacy lifecycle map poisoned");
        for (_, pending) in entries.drain() {
            let _ = pending.sender.try_send(Err(AckError::Disconnected));
        }
    }

    fn wait(
        &self,
        request_id: &str,
        generation: u64,
        receiver: mpsc::Receiver<Result<Option<LegacyTerminalProof>, AckError>>,
        timeout: Duration,
    ) -> Result<Option<LegacyTerminalProof>, AckError> {
        let result = match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(AckError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(AckError::Disconnected),
        };
        if matches!(result, Err(AckError::Timeout)) {
            self.cancel(generation, request_id);
        }
        result
    }
}

fn remember_legacy_accepted(
    accepted: &mut HashSet<(u64, String, String)>,
    generation: u64,
    room_id: &str,
    invocation_id: &str,
) -> bool {
    let key = (generation, room_id.to_string(), invocation_id.to_string());
    if accepted.contains(&key) {
        return true;
    }
    if accepted.len() >= MAX_LEGACY_LIFECYCLE_WAITERS {
        return false;
    }
    accepted.insert(key);
    true
}

fn observe_legacy_lifecycle(
    waiters: &LegacyLifecycleWaiters,
    accepted: &Mutex<HashSet<(u64, String, String)>>,
    generation: u64,
    event: &ChatroomEvent,
) -> Option<ChatroomCommand> {
    if let ChatroomEvent::AgentAccepted { room_id, payload } = event {
        let invocation_id = payload.get("invocationId")?.as_str()?;
        let mut accepted = accepted.lock().expect("legacy accepted map poisoned");
        let key = (generation, room_id.clone(), invocation_id.to_string());
        let has_capacity = accepted.contains(&key) || accepted.len() < MAX_LEGACY_LIFECYCLE_WAITERS;
        let confirmed = waiters.observe(generation, event, has_capacity);
        if confirmed.is_some() {
            remember_legacy_accepted(&mut accepted, generation, room_id, invocation_id);
        }
        confirmed
    } else {
        waiters.observe(generation, event, true)
    }
}

fn same_lifecycle_identity(
    left: &LegacyLifecycleExpectation,
    right: &LegacyLifecycleExpectation,
) -> bool {
    if let (
        LegacyLifecycleExpectation::Status {
            room_id: left_room,
            invocation_id: left_id,
            status: left_status,
            ..
        },
        LegacyLifecycleExpectation::Status {
            room_id: right_room,
            invocation_id: right_id,
            status: right_status,
            ..
        },
    ) = (left, right)
    {
        return left_room == right_room && left_id == right_id && left_status == right_status;
    }
    let (LegacyLifecycleExpectation::Command(left), LegacyLifecycleExpectation::Command(right)) =
        (left, right)
    else {
        return false;
    };
    match (left, right) {
        (
            ChatroomCommand::AgentAccepted {
                room_id: left_room,
                invocation_id: left_id,
                ..
            },
            ChatroomCommand::AgentAccepted {
                room_id: right_room,
                invocation_id: right_id,
                ..
            },
        )
        | (
            ChatroomCommand::AgentRunning {
                room_id: left_room,
                invocation_id: left_id,
            },
            ChatroomCommand::AgentRunning {
                room_id: right_room,
                invocation_id: right_id,
            },
        ) => left_room == right_room && left_id == right_id,
        (
            ChatroomCommand::AgentEvent {
                room_id: left_room,
                invocation_id: left_id,
                event: left_event,
            },
            ChatroomCommand::AgentEvent {
                room_id: right_room,
                invocation_id: right_id,
                event: right_event,
            },
        ) => {
            left_room == right_room
                && left_id == right_id
                && std::mem::discriminant(left_event) == std::mem::discriminant(right_event)
        }
        _ => false,
    }
}

fn lifecycle_event_match(
    expected: &LegacyLifecycleExpectation,
    event: &ChatroomEvent,
) -> Option<Result<Option<LegacyTerminalProof>, AckError>> {
    let command = match expected {
        LegacyLifecycleExpectation::Command(command) => Some(command),
        LegacyLifecycleExpectation::Status { .. } => None,
    };
    let (expected_room, expected_id, expected_kind) = match command {
        Some(ChatroomCommand::AgentAccepted {
            room_id,
            invocation_id,
            ..
        }) => (room_id, invocation_id, "accepted"),
        Some(ChatroomCommand::AgentRunning {
            room_id,
            invocation_id,
        }) => (room_id, invocation_id, "running"),
        Some(ChatroomCommand::AgentEvent {
            room_id,
            invocation_id,
            event: AgentEventPayload::Completed { .. },
        }) => (room_id, invocation_id, "completed"),
        Some(ChatroomCommand::AgentEvent {
            room_id,
            invocation_id,
            event: AgentEventPayload::Failed { .. },
        }) => (room_id, invocation_id, "failed"),
        Some(_) => return None,
        None => match expected {
            LegacyLifecycleExpectation::Status {
                room_id,
                invocation_id,
                status,
                ..
            } => (room_id, invocation_id, status.as_str()),
            _ => unreachable!(),
        },
    };
    if event.room_id() != Some(expected_room) {
        return None;
    }
    let (actual_id, actual_kind, payload) = match event {
        ChatroomEvent::AgentAccepted { payload, .. } => {
            (payload.get("invocationId")?.as_str()?, "accepted", payload)
        }
        ChatroomEvent::AgentCompleted { payload, .. } => {
            (payload.get("invocationId")?.as_str()?, "completed", payload)
        }
        ChatroomEvent::AgentFailed { payload, .. } => {
            (payload.get("invocationId")?.as_str()?, "failed", payload)
        }
        _ => return None,
    };
    if actual_id != expected_id {
        return None;
    }
    if actual_kind != expected_kind {
        if matches!(
            (actual_kind, expected_kind),
            ("completed", "failed") | ("failed", "completed")
        ) {
            return Some(Err(AckError::Rejected("terminal_conflict".into())));
        }
        return None;
    }
    let terminal_proof = match (command, expected) {
        (Some(ChatroomCommand::AgentAccepted { .. }), _) => None,
        (
            Some(ChatroomCommand::AgentEvent {
                event:
                    AgentEventPayload::Completed {
                        content,
                        mention_agent_ids,
                        attachment_ids,
                        client_message_id,
                    },
                ..
            }),
            _,
        ) => {
            let actual_client_id = payload.get("clientMessageId").and_then(Value::as_str);
            let Some(actual_content) = payload.get("content").and_then(Value::as_str) else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let Some(mentions) = payload.get("mentionAgentIds").and_then(Value::as_array) else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let Some(mentions) = mentions
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
            else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let Some(attachments) = payload.get("attachmentIds").and_then(Value::as_array) else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let Some(attachments) = attachments
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
            else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let actual_digest = reply_digest(&ChatroomReplyDigestInput {
                client_message_id: actual_client_id.unwrap_or_default(),
                content: actual_content,
                mention_agent_ids: &mentions,
                attachment_ids: &attachments,
            });
            let expected_digest = reply_digest(&ChatroomReplyDigestInput {
                client_message_id,
                content,
                mention_agent_ids: &mention_agent_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                attachment_ids: &attachment_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            });
            if actual_client_id != Some(client_message_id) || actual_digest != expected_digest {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            }
            Some(LegacyTerminalProof::Completed {
                reply_client_message_id: actual_client_id.unwrap_or_default().to_string(),
                reply_digest: actual_digest,
            })
        }
        (
            Some(ChatroomCommand::AgentEvent {
                event: AgentEventPayload::Failed { code, .. },
                ..
            }),
            _,
        ) => {
            let Some(actual_failure_code) = payload.get("failureCode").and_then(Value::as_str)
            else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            if !is_chatroom_failure_code(actual_failure_code) || actual_failure_code != code {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            }
            Some(LegacyTerminalProof::Failed {
                failure_code: actual_failure_code.to_string(),
            })
        }
        (
            None,
            LegacyLifecycleExpectation::Status {
                status,
                client_message_id,
                reply_digest: expected_digest,
                failure_code,
                ..
            },
        ) if status == "completed" => {
            let Some(content) = payload.get("content").and_then(Value::as_str) else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let Some(actual_client_id) = payload.get("clientMessageId").and_then(Value::as_str)
            else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            let mentions = payload
                .get("mentionAgentIds")
                .and_then(Value::as_array)?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            let attachments = payload
                .get("attachmentIds")
                .and_then(Value::as_array)?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            let actual_digest = reply_digest(&ChatroomReplyDigestInput {
                client_message_id: actual_client_id,
                content,
                mention_agent_ids: &mentions,
                attachment_ids: &attachments,
            });
            if actual_client_id != client_message_id
                || !failure_code.is_empty()
                || actual_digest != *expected_digest
            {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            }
            Some(LegacyTerminalProof::Completed {
                reply_client_message_id: actual_client_id.to_string(),
                reply_digest: actual_digest,
            })
        }
        (
            None,
            LegacyLifecycleExpectation::Status {
                status,
                failure_code,
                client_message_id,
                reply_digest,
                ..
            },
        ) if status == "failed" => {
            let Some(actual_failure_code) = payload.get("failureCode").and_then(Value::as_str)
            else {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            };
            if !is_chatroom_failure_code(actual_failure_code)
                || actual_failure_code != failure_code
                || !client_message_id.is_empty()
                || !reply_digest.is_empty()
            {
                return Some(Err(AckError::Rejected("result_mismatch".into())));
            }
            Some(LegacyTerminalProof::Failed {
                failure_code: actual_failure_code.to_string(),
            })
        }
        _ => return Some(Err(AckError::Rejected("result_mismatch".into()))),
    };
    Some(Ok(terminal_proof))
}

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
    fn send_server_failure(&self, body: Vec<u8>, shutdown: &AtomicBool) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatroomGatewayError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

/// 只暴露当前 WebSocket 代际在全量初始 snapshot 中确认的能力。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayCapabilityState {
    pub socket_generation: u64,
    pub selected: Vec<ChatroomCapability>,
}

type GatewayOrigin = ChatroomOrigin;

impl ChatroomGatewayError {
    fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}

fn lifecycle_unknown(message: impl Into<String>) -> ChatroomGatewayError {
    ChatroomGatewayError::new(503, "lifecycle_unknown", message)
}

fn lifecycle_boot_id() -> Result<String, ChatroomGatewayError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        ChatroomGatewayError::new(
            500,
            "gateway_entropy_unavailable",
            "无法生成聊天室生命周期请求标识",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn lifecycle_request_id(boot_id: &str, counter: u64) -> String {
    format!("gw-{boot_id}-{counter}")
}

fn lifecycle_ack_error(error: AckError) -> ChatroomGatewayError {
    match error {
        AckError::Rejected(code) if matches!(code.as_str(), "forbidden" | "not_member") => {
            ChatroomGatewayError::new(403, "lifecycle_rejected", code)
        }
        AckError::Rejected(code) => ChatroomGatewayError::new(409, "lifecycle_rejected", code),
        AckError::Full | AckError::DuplicateRequest => {
            ChatroomGatewayError::new(503, "lifecycle_unavailable", "生命周期确认队列不可用")
        }
        AckError::Timeout | AckError::Disconnected | AckError::MismatchedAck => {
            lifecycle_unknown("未收到可验证的聊天室生命周期确认")
        }
    }
}

pub(super) fn valid_lifecycle_confirmation(
    confirmed: &ConfirmedCommand,
    room_id: &str,
    invocation_id: &str,
    command: &str,
    request_id: &str,
    status: &str,
    generation: u64,
) -> bool {
    let status_matches_command = match (command, status, confirmed.status.as_deref()) {
        ("agent.accepted", "accepted", Some("accepted" | "running")) => true,
        ("agent.running", "running", Some("running")) => true,
        ("agent.completed", "completed", Some("completed")) => true,
        ("agent.failed", "failed", Some("failed")) => true,
        _ => false,
    };
    confirmed.room_id == room_id
        && confirmed.invocation_id.as_deref() == Some(invocation_id)
        && confirmed.command == command
        && confirmed.request_id == request_id
        && status_matches_command
        && confirmed.generation == generation
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
    snapshot_ready: bool,
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
            snapshot_ready: false,
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
    Invocation {
        event: ChatroomEvent,
        origin: GatewayOrigin,
    },
    #[cfg(test)]
    TestInvocation(ChatroomEvent),
    Disconnected(Vec<u8>),
    ServerFailure {
        body: Vec<u8>,
        room_id: String,
        client_generation: u64,
        socket_generation: u64,
        auth_epoch: u64,
    },
    PruneInaccessible(u64),
}

#[cfg(test)]
struct TaskGate {
    loaded: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

#[cfg(test)]
struct SseRegistrationGate {
    loaded: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

#[cfg(test)]
struct ClientEventAcceptanceGate {
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
    TerminalInvocations(&'a str),
    InvocationMetadata(&'a str, &'a str),
    Agents(&'a str),
    Agent(&'a str, &'a str),
    Lease(&'a str, &'a str),
    Join,
    LocalSse,
    InternalUpload,
    InternalDownload,
    InternalFinalize,
    InternalLeaseRelease,
    InternalRoomStatus(&'a str),
    InternalAgentReadiness(&'a str, &'a str, bool),
    InternalInvocation(&'a str, &'a str),
    InternalInvocationStatus(&'a str, &'a str),
    InternalExecutionBinding(bool),
    InternalManagementCapabilities,
    InternalManagementOperation(&'a str),
    InternalManagementStatus(&'a str),
}

pub struct ChatroomGateway {
    auth: Arc<AuthSession>,
    client: Arc<ChatroomClient>,
    transport: Arc<dyn GatewayTransport>,
    bridge: Arc<dyn ChatroomBridge>,
    execution_registry: Mutex<Arc<ChatroomExecutionRegistry>>,
    native_workers: Mutex<Option<Arc<super::pi_rpc::PiWorkerManager>>>,
    device_id: String,
    protocol_options: ChatroomProtocolOptions,
    rooms: Mutex<HashMap<String, RoomState>>,
    subscribers: Arc<Mutex<HashMap<u64, Subscriber>>>,
    leases: Mutex<HashMap<(String, String), LeaseState>>,
    last_subscription: Mutex<Option<(Vec<RoomCursor>, String)>>,
    next_subscriber_id: AtomicU64,
    client_events: Mutex<Option<mpsc::Receiver<ChatroomClientEvent>>>,
    event_worker: Mutex<Option<JoinHandle<()>>>,
    started: AtomicBool,
    shutdown: AtomicBool,
    auth_epoch: AtomicU64,
    realtime_epoch: AtomicU64,
    auth_boundary: Mutex<()>,
    connection_paused: AtomicBool,
    accepted_client_generation: AtomicU64,
    websocket_connected: AtomicBool,
    advertised_capabilities: Mutex<(u64, Vec<ChatroomCapability>)>,
    capability_probe_sequence: AtomicU64,
    next_lifecycle_request_id: AtomicU64,
    lifecycle_boot_id: String,
    legacy_lifecycle_waiters: LegacyLifecycleWaiters,
    legacy_accepted: Mutex<HashSet<(u64, String, String)>>,
    legacy_status_wait_timeout: Mutex<Duration>,
    disconnected_notified: AtomicBool,
    pending_disconnected: AtomicBool,
    clock: Arc<dyn GatewayClock>,
    last_lease_tick: Mutex<Instant>,
    task_sender: Mutex<Option<mpsc::SyncSender<GatewayTask>>>,
    prune_queued: AtomicBool,
    prune_pending: AtomicBool,
    task_workers: Mutex<Vec<JoinHandle<()>>>,
    #[cfg(test)]
    task_gate: Mutex<Option<TaskGate>>,
    #[cfg(test)]
    invocation_dispatch_observer: Mutex<Option<mpsc::Sender<(u64, u64, u64)>>>,
    #[cfg(test)]
    saturated_task_receiver: Mutex<Option<mpsc::Receiver<GatewayTask>>>,
    #[cfg(test)]
    sse_registration_gate: Mutex<Option<SseRegistrationGate>>,
    #[cfg(test)]
    sse_status_gate: Mutex<Option<SseRegistrationGate>>,
    #[cfg(test)]
    client_event_acceptance_gate: Mutex<Option<ClientEventAcceptanceGate>>,
}

impl ChatroomGateway {
    pub fn new(
        auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        protocol_options: ChatroomProtocolOptions,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        let transport = Arc::new(AuthGatewayTransport { auth });
        Self::new_with_transport_and_options(
            transport.auth.clone(),
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
            protocol_options,
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
        Self::new_with_transport_and_options(
            _auth,
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
            ChatroomProtocolOptions::default(),
        )
    }

    pub(crate) fn new_with_transport_and_options(
        auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        transport: Arc<dyn GatewayTransport>,
        protocol_options: ChatroomProtocolOptions,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        Self::new_with_transport_and_clock_and_options(
            auth,
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
            Arc::new(SystemGatewayClock),
            protocol_options,
        )
    }

    pub(crate) fn new_with_transport_and_clock(
        auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        transport: Arc<dyn GatewayTransport>,
        clock: Arc<dyn GatewayClock>,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        Self::new_with_transport_and_clock_and_options(
            auth,
            edu_base_url,
            connector,
            bridge,
            device_id,
            transport,
            clock,
            ChatroomProtocolOptions::default(),
        )
    }

    pub(crate) fn new_with_transport_and_clock_and_options(
        auth: Arc<AuthSession>,
        edu_base_url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        bridge: Arc<dyn ChatroomBridge>,
        device_id: String,
        transport: Arc<dyn GatewayTransport>,
        clock: Arc<dyn GatewayClock>,
        protocol_options: ChatroomProtocolOptions,
    ) -> Result<Arc<Self>, ChatroomGatewayError> {
        let url = chatroom_ws_url(&edu_base_url)
            .map_err(|_| invalid_request("聊天室实时服务地址不合法"))?;
        let lifecycle_boot_id = lifecycle_boot_id()?;
        let (events, receiver) = mpsc::channel();
        Ok(Arc::new(Self {
            auth: auth.clone(),
            client: Arc::new(ChatroomClient::new(auth, url, connector, events)),
            transport,
            bridge,
            execution_registry: Mutex::new(Arc::new(ChatroomExecutionRegistry::default())),
            native_workers: Mutex::new(None),
            device_id,
            protocol_options,
            rooms: Mutex::new(HashMap::new()),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            leases: Mutex::new(HashMap::new()),
            last_subscription: Mutex::new(None),
            next_subscriber_id: AtomicU64::new(1),
            client_events: Mutex::new(Some(receiver)),
            event_worker: Mutex::new(None),
            started: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            auth_epoch: AtomicU64::new(0),
            realtime_epoch: AtomicU64::new(0),
            auth_boundary: Mutex::new(()),
            connection_paused: AtomicBool::new(false),
            accepted_client_generation: AtomicU64::new(NO_CLIENT_GENERATION),
            websocket_connected: AtomicBool::new(false),
            advertised_capabilities: Mutex::new((0, Vec::new())),
            capability_probe_sequence: AtomicU64::new(0),
            next_lifecycle_request_id: AtomicU64::new(1),
            lifecycle_boot_id,
            legacy_lifecycle_waiters: LegacyLifecycleWaiters::default(),
            legacy_accepted: Mutex::new(HashSet::new()),
            legacy_status_wait_timeout: Mutex::new(Duration::from_secs(5)),
            disconnected_notified: AtomicBool::new(false),
            pending_disconnected: AtomicBool::new(false),
            last_lease_tick: Mutex::new(clock.now()),
            clock,
            task_sender: Mutex::new(None),
            prune_queued: AtomicBool::new(false),
            prune_pending: AtomicBool::new(false),
            task_workers: Mutex::new(Vec::new()),
            #[cfg(test)]
            task_gate: Mutex::new(None),
            #[cfg(test)]
            invocation_dispatch_observer: Mutex::new(None),
            #[cfg(test)]
            saturated_task_receiver: Mutex::new(None),
            #[cfg(test)]
            sse_registration_gate: Mutex::new(None),
            #[cfg(test)]
            sse_status_gate: Mutex::new(None),
            #[cfg(test)]
            client_event_acceptance_gate: Mutex::new(None),
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

    pub fn attach_execution_runtime(
        &self,
        registry: Arc<ChatroomExecutionRegistry>,
        workers: Arc<super::pi_rpc::PiWorkerManager>,
    ) {
        *self.execution_registry.lock().unwrap() = registry;
        *self.native_workers.lock().unwrap() = Some(workers);
    }

    /// 能力广告只用于发起可选请求；有效选择必须来自同代 WS 初始 snapshot。
    pub fn capability_state(&self) -> GatewayCapabilityState {
        let active_generation = self.client.active_socket_generation();
        let (socket_generation, selected) = self.client.selected_capabilities();
        let (advertised_generation, advertised) =
            self.advertised_capabilities.lock().unwrap().clone();
        if active_generation != 0
            && active_generation == socket_generation
            && active_generation == advertised_generation
        {
            GatewayCapabilityState {
                socket_generation,
                selected: selected
                    .into_iter()
                    .filter(|capability| advertised.contains(capability))
                    .collect(),
            }
        } else {
            GatewayCapabilityState {
                socket_generation: 0,
                selected: Vec::new(),
            }
        }
    }

    fn capability_probe_enabled(&self) -> bool {
        !self.protocol_options.requested_capabilities().is_empty()
    }

    fn modern_protocol_selected(&self) -> bool {
        if !self.protocol_options.modern_execution_enabled() {
            return false;
        }
        let active_generation = self.client.active_socket_generation();
        let capability = self.capability_state();
        active_generation != 0
            && capability.socket_generation == active_generation
            && capability
                .selected
                .contains(&ChatroomCapability::AgentReadyV1)
            && capability
                .selected
                .contains(&ChatroomCapability::InvocationAckV1)
    }

    #[cfg(test)]
    pub(super) fn lifecycle_request_id_for_test(&self, counter: u64) -> String {
        lifecycle_request_id(&self.lifecycle_boot_id, counter)
    }

    #[cfg(test)]
    pub(super) fn active_socket_generation_for_test(&self) -> u64 {
        self.client.active_socket_generation()
    }

    #[cfg(test)]
    pub(super) fn set_current_socket_generations_for_test(
        &self,
        client_generation: u64,
        socket_generation: u64,
    ) {
        self.accepted_client_generation
            .store(client_generation, Ordering::Release);
        self.client
            .set_active_socket_generation_for_test(socket_generation);
        self.connection_paused.store(false, Ordering::Release);
    }

    #[cfg(test)]
    pub(super) fn set_capabilities_for_test(
        &self,
        socket_generation: u64,
        capabilities: Vec<ChatroomCapability>,
    ) {
        self.client
            .set_selected_capabilities_for_test(socket_generation, capabilities.clone());
        *self.advertised_capabilities.lock().unwrap() = (socket_generation, capabilities);
    }

    #[cfg(test)]
    pub(super) fn set_room_snapshot_ready_for_test(&self, room_id: &str) {
        self.websocket_connected.store(true, Ordering::Release);
        let mut room = RoomState::new();
        room.subscribed = true;
        room.snapshot_ready = true;
        self.rooms.lock().unwrap().insert(room_id.to_string(), room);
    }

    #[cfg(test)]
    pub(super) fn start_task_pool_for_test(self: &Arc<Self>) {
        self.start_task_pool();
    }

    #[cfg(test)]
    pub(super) fn fill_task_queue_for_test(&self) {
        let (sender, receiver) = mpsc::sync_channel::<GatewayTask>(TASK_QUEUE_CAPACITY);
        for _ in 0..TASK_QUEUE_CAPACITY {
            sender
                .try_send(GatewayTask::Recover("queue-full-test".into()))
                .unwrap();
        }
        *self.task_sender.lock().unwrap() = Some(sender);
        *self.saturated_task_receiver.lock().unwrap() = Some(receiver);
    }

    #[cfg(test)]
    pub(super) fn handle_socket_event_for_test(
        &self,
        client_generation: u64,
        socket_generation: u64,
        event: ChatroomEvent,
    ) {
        self.handle_socket_event(client_generation, Some(socket_generation), event);
    }

    #[cfg(test)]
    pub(super) fn pause_generation_for_test(&self) -> u64 {
        self.client.pause_generation()
    }

    #[cfg(test)]
    pub(super) fn websocket_connected_for_test(&self) -> bool {
        self.websocket_connected.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn room_snapshot_for_test(&self, room_id: &str) -> Option<ChatroomEvent> {
        self.rooms
            .lock()
            .unwrap()
            .get(room_id)
            .and_then(|state| state.snapshot.clone())
    }

    fn start_task_pool(self: &Arc<Self>) {
        let mut sender_slot = self.task_sender.lock().unwrap();
        if sender_slot.is_some() {
            return;
        }
        let (sender, receiver) = mpsc::sync_channel::<GatewayTask>(TASK_QUEUE_CAPACITY);
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
                    GatewayTask::Invocation { event, origin } => {
                        gateway.forward_invocation_now(&event, origin)
                    }
                    #[cfg(test)]
                    GatewayTask::TestInvocation(event) => {
                        gateway.forward_invocation_for_test(&event)
                    }
                    GatewayTask::Disconnected(body) => gateway.send_disconnected_bridge(body),
                    GatewayTask::ServerFailure {
                        body,
                        room_id,
                        client_generation,
                        socket_generation,
                        auth_epoch,
                    } => gateway.send_server_failure_if_current(
                        body,
                        &room_id,
                        client_generation,
                        socket_generation,
                        auth_epoch,
                    ),
                    GatewayTask::PruneInaccessible(epoch) => {
                        gateway.prune_inaccessible_subscriptions(epoch);
                        gateway.prune_queued.store(false, Ordering::Release);
                        gateway.try_dispatch_pending_prune();
                    }
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
            self.try_dispatch_pending_prune();
        }
    }

    fn handle_client_event(&self, event: ChatroomClientEvent) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        self.tick_leases(self.clock.now());
        match event {
            ChatroomClientEvent::Connected => {
                let _auth_boundary = self.auth_boundary.lock().unwrap();
                if self.connection_paused.load(Ordering::Acquire) {
                    return;
                }
                self.websocket_connected.store(true, Ordering::Release);
                self.realtime_epoch.fetch_add(1, Ordering::AcqRel);
                self.disconnected_notified.store(false, Ordering::Release);
                self.publish_status(None, "realtime_connected", "聊天室实时连接已建立");
            }
            ChatroomClientEvent::ConnectedAt { generation } => {
                let candidate = generation == self.client.pause_generation()
                    && self.auth.auth_state().authenticated;
                #[cfg(test)]
                if candidate {
                    if let Some(gate) = self.client_event_acceptance_gate.lock().unwrap().take() {
                        let _ = gate.loaded.send(());
                        gate.release
                            .recv_timeout(Duration::from_secs(1))
                            .expect("测试 client event acceptance 未收到放行信号");
                    }
                }
                let accepted = {
                    let _auth_boundary = self.auth_boundary.lock().unwrap();
                    if candidate
                        && generation == self.client.pause_generation()
                        && self.auth.auth_state().authenticated
                    {
                        self.accepted_client_generation
                            .store(generation, Ordering::Release);
                        self.connection_paused.store(false, Ordering::Release);
                        self.websocket_connected.store(true, Ordering::Release);
                        self.realtime_epoch.fetch_add(1, Ordering::AcqRel);
                        if self.capability_probe_enabled() {
                            *self.last_subscription.lock().unwrap() = None;
                            *self.advertised_capabilities.lock().unwrap() = (0, Vec::new());
                        }
                        self.disconnected_notified.store(false, Ordering::Release);
                        self.publish_status(None, "realtime_connected", "聊天室实时连接已建立");
                        true
                    } else {
                        false
                    }
                };
                if accepted {
                    let socket_generation = self.client.active_socket_generation();
                    let revoked = self
                        .execution_registry
                        .lock()
                        .unwrap()
                        .revoke_stale_sources(generation, socket_generation);
                    self.revoke_native_bindings(revoked);
                    self.refresh_subscription_snapshot();
                }
            }
            ChatroomClientEvent::Disconnected => {
                self.legacy_lifecycle_waiters.invalidate_all();
                self.legacy_accepted.lock().unwrap().clear();
                let revoked = self.execution_registry.lock().unwrap().revoke_all();
                self.revoke_native_bindings(revoked);
                let _auth_boundary = self.auth_boundary.lock().unwrap();
                self.notify_disconnected();
            }
            ChatroomClientEvent::Status { code, message } => {
                self.publish_status(None, &code, &message);
                if matches!(code.as_str(), "not_found" | "not_member" | "forbidden") {
                    self.schedule_inaccessible_prune();
                }
            }
            ChatroomClientEvent::Event(event)
                if !self.connection_paused.load(Ordering::Acquire)
                    && self.accepted_client_generation.load(Ordering::Acquire)
                        == NO_CLIENT_GENERATION
                    && self.auth_epoch.load(Ordering::Acquire) == 0 =>
            {
                self.publish_event(event)
            }
            ChatroomClientEvent::Event(_) => {}
            ChatroomClientEvent::EventAt { generation, event } => {
                self.handle_socket_event(generation, None, event)
            }
            ChatroomClientEvent::SocketEventAt {
                generation,
                socket_generation,
                event,
            } => self.handle_socket_event(generation, Some(socket_generation), event),
        }
    }

    fn handle_socket_event(
        &self,
        generation: u64,
        socket_generation: Option<u64>,
        event: ChatroomEvent,
    ) {
        // EventAt 是旧内部事件兼容形状（没有 socket generation），只保留公开事件兼容，
        // 不能作为生命周期、accepted cache 或当前连接事件的证明。
        let socket_generation_matches = || {
            socket_generation.is_none_or(|socket_generation| {
                socket_generation != 0
                    && self.client.active_socket_generation() == socket_generation
            })
        };
        let delta_frame_valid = match &event {
            ChatroomEvent::AgentDelta { payload, .. } => {
                let id_selected = socket_generation.is_some_and(|generation| {
                    let capability = self.capability_state();
                    capability.socket_generation == generation
                        && capability
                            .selected
                            .contains(&ChatroomCapability::AgentDeltaFrameIdV1)
                });
                crate::chatroom_protocol::validate_delta_frame_selection(payload, id_selected)
                    .is_ok()
            }
            _ => true,
        };
        let candidate = delta_frame_valid
            && !self.connection_paused.load(Ordering::Acquire)
            && self.accepted_client_generation.load(Ordering::Acquire) == generation
            && socket_generation_matches();
        #[cfg(test)]
        if candidate {
            if let Some(gate) = self.client_event_acceptance_gate.lock().unwrap().take() {
                let _ = gate.loaded.send(());
                gate.release
                    .recv_timeout(Duration::from_secs(1))
                    .expect("测试 client event acceptance 未收到放行信号");
            }
        }
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        let accepted = candidate
            && !self.connection_paused.load(Ordering::Acquire)
            && self.accepted_client_generation.load(Ordering::Acquire) == generation
            && socket_generation_matches()
            && self.auth.auth_state().authenticated;
        let should_prune = accepted
            && matches!(&event,
            ChatroomEvent::LocalStatus { code, .. } if matches!(code.as_str(), "not_found" | "not_member" | "forbidden"));
        let mut terminal_task = None;
        let mut revoked_binding = None;
        let mut deferred_failure_event = None;
        let origin = socket_generation.map(|socket_generation| GatewayOrigin {
            client_generation: generation,
            socket_generation,
            auth_epoch: self.auth_epoch.load(Ordering::Acquire),
        });
        let mut invocation_task = None;
        if accepted {
            if let Some(socket_generation) = socket_generation {
                observe_legacy_lifecycle(
                    &self.legacy_lifecycle_waiters,
                    &self.legacy_accepted,
                    socket_generation,
                    &event,
                );
                if let ChatroomEvent::AgentCompleted { room_id, payload }
                | ChatroomEvent::AgentFailed { room_id, payload } = &event
                {
                    if let Some(invocation_id) = payload.get("invocationId").and_then(Value::as_str)
                    {
                        self.legacy_accepted.lock().unwrap().remove(&(
                            socket_generation,
                            room_id.clone(),
                            invocation_id.to_string(),
                        ));
                    }
                }
            }
            terminal_task = socket_generation.and_then(|socket_generation| {
                let ChatroomEvent::AgentFailed { room_id, payload } = &event else {
                    return None;
                };
                let invocation_id = payload
                    .get("invocationId")
                    .and_then(Value::as_str)
                    .filter(|value| valid_component(value))?;
                let failure_code = payload
                    .get("failureCode")
                    .and_then(Value::as_str)
                    .filter(|value| valid_component(value))
                    .unwrap_or("internal_error");
                let body = serde_json::json!({
                    "event": "agent.failed",
                    "roomId": room_id,
                    "invocationId": invocation_id,
                    "failureCode": failure_code,
                    "clientGeneration": generation,
                    "socketGeneration": socket_generation,
                    "authEpoch": self.auth_epoch.load(Ordering::Acquire),
                })
                .to_string()
                .into_bytes();
                Some((
                    body,
                    room_id.clone(),
                    socket_generation,
                    self.auth_epoch.load(Ordering::Acquire),
                ))
            });
            if let (Some(origin), ChatroomEvent::AgentInvocation { room_id, payload }) =
                (origin, &event)
            {
                let invocation_id = payload
                    .get("invocationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let target_agent_id = payload
                    .get("targetAgentId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let subscribed = self
                    .rooms
                    .lock()
                    .unwrap()
                    .get(room_id)
                    .is_some_and(|room| room.subscribed);
                let recorded = subscribed
                    && !invocation_id.is_empty()
                    && !target_agent_id.is_empty()
                    && self.execution_registry.lock().unwrap().record_source(
                        room_id,
                        invocation_id,
                        target_agent_id,
                        origin,
                    );
                if recorded {
                    invocation_task = Some((event.clone(), origin));
                }
            }
            if let (Some(socket_generation), ChatroomEvent::AgentFailed { room_id, payload }) =
                (socket_generation, &event)
            {
                if let Some(invocation_id) = payload.get("invocationId").and_then(Value::as_str) {
                    revoked_binding = self
                        .execution_registry
                        .lock()
                        .unwrap()
                        .revoke_invocation(room_id, invocation_id);
                }
                let _ = socket_generation;
                deferred_failure_event = Some(event.clone());
            }
            if deferred_failure_event.is_none() {
                self.publish_event(event);
            }
        }
        drop(_auth_boundary);
        if let Some(binding) = revoked_binding {
            self.revoke_native_bindings(vec![binding]);
        }
        if let Some(event) = deferred_failure_event {
            self.publish_event(event);
        }
        if let Some((event, origin)) = invocation_task {
            self.forward_invocation(&event, origin);
        }
        if let Some((body, room_id, socket_generation, auth_epoch)) = terminal_task {
            let task = GatewayTask::ServerFailure {
                body: body.clone(),
                room_id: room_id.clone(),
                client_generation: generation,
                socket_generation,
                auth_epoch,
            };
            if self.dispatch_task(task).is_err() {
                self.send_server_failure_if_current(
                    body,
                    &room_id,
                    generation,
                    socket_generation,
                    auth_epoch,
                );
            }
        }
        if should_prune {
            self.schedule_inaccessible_prune();
        }
    }

    fn notify_disconnected(&self) {
        self.legacy_lifecycle_waiters.invalidate_all();
        self.legacy_accepted.lock().unwrap().clear();
        self.websocket_connected.store(false, Ordering::Release);
        self.realtime_epoch.fetch_add(1, Ordering::AcqRel);
        *self.last_subscription.lock().unwrap() = None;
        *self.advertised_capabilities.lock().unwrap() = (0, Vec::new());
        for state in self.rooms.lock().unwrap().values_mut() {
            state.snapshot_ready = false;
        }
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

    fn revoke_native_bindings(&self, bindings: Vec<ChatroomExecutionBinding>) {
        let workers = self.native_workers.lock().unwrap().clone();
        let Some(workers) = workers else { return };
        for binding in bindings {
            let mut stopped = false;
            for attempt in 0..3 {
                match workers.revoke_chatroom_binding(&binding) {
                    Ok(_) => {
                        stopped = true;
                        break;
                    }
                    Err(_) if attempt < 2 => {
                        thread::sleep(Duration::from_millis(if attempt == 0 { 25 } else { 75 }))
                    }
                    Err(_) => {}
                }
            }
            if stopped {
                self.execution_registry
                    .lock()
                    .unwrap()
                    .confirm_native_stop(&binding);
            } else {
                self.publish_status(
                    Some(&binding.room_id),
                    "execution_revoke_failed",
                    "聊天室 Agent 执行撤权失败",
                );
            }
        }
    }

    fn send_disconnected_bridge(&self, body: Vec<u8>) {
        if self.bridge.send_disconnected(body, &self.shutdown).is_err() {
            self.publish_status(None, "bridge_unavailable", "聊天室业务桥不可用");
        }
    }

    fn send_server_failure_if_current(
        &self,
        body: Vec<u8>,
        room_id: &str,
        client_generation: u64,
        socket_generation: u64,
        auth_epoch: u64,
    ) {
        let origin = ChatroomOrigin {
            client_generation,
            socket_generation,
            auth_epoch,
        };
        let current = self.server_failure_origin_is_current(room_id, origin);
        if current {
            self.send_server_failure_with_bounded_retry(body, room_id, origin);
        }
    }

    fn send_server_failure_with_bounded_retry(
        &self,
        body: Vec<u8>,
        room_id: &str,
        origin: ChatroomOrigin,
    ) {
        for attempt in 0..3 {
            if !self.server_failure_origin_is_current(room_id, origin) {
                return;
            }
            if self
                .bridge
                .send_server_failure(body.clone(), &self.shutdown)
                .is_ok()
            {
                return;
            }
            if attempt < 2 {
                thread::sleep(Duration::from_millis(if attempt == 0 { 40 } else { 120 }));
            }
        }
        self.publish_status(None, "bridge_unavailable", "聊天室服务端终态通知暂不可用");
    }

    fn server_failure_origin_is_current(&self, room_id: &str, origin: ChatroomOrigin) -> bool {
        self.origin_is_current(origin)
            && self
                .rooms
                .lock()
                .unwrap()
                .get(room_id)
                .is_some_and(|room| room.subscribed)
    }

    fn origin_is_current(&self, origin: GatewayOrigin) -> bool {
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        !self.shutdown.load(Ordering::Acquire)
            && !self.connection_paused.load(Ordering::Acquire)
            && self.accepted_client_generation.load(Ordering::Acquire) == origin.client_generation
            && self.client.active_socket_generation() == origin.socket_generation
            && self.auth_epoch.load(Ordering::Acquire) == origin.auth_epoch
            && self.auth.auth_state().authenticated
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
        let (path, query) = split_target(target)?;
        let route = parse_route(&path)?;
        let method = method.to_ascii_uppercase();
        let is_management_route = matches!(
            route,
            Route::InternalManagementCapabilities
                | Route::InternalManagementOperation(_)
                | Route::InternalManagementStatus(_)
        );
        if is_management_route && !query.is_empty() {
            return Err(management_invalid_request("管理接口不接受查询参数"));
        }
        if is_management_route && body.len() > MAX_MANAGEMENT_BODY_BYTES {
            return Err(ChatroomGatewayError::new(
                400,
                "invalid_request",
                "管理请求体超过 64 KiB 限制",
            ));
        }
        if body.len() > MAX_BODY_BYTES {
            return Err(ChatroomGatewayError::new(
                413,
                "body_too_large",
                "请求体过大",
            ));
        }
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
            Route::InternalLeaseRelease => self.handle_internal_lease_release(body),
            Route::InternalRoomStatus(room_id) => self.handle_internal_room_status(room_id),
            Route::InternalAgentReadiness(room_id, agent_id, ready) => {
                match self.handle_internal_agent_readiness(room_id, agent_id, ready, body) {
                    Ok(response) => Ok(response),
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "lifecycle_unknown"
                                | "lifecycle_rejected"
                                | "lifecycle_unavailable"
                                | "legacy_mode"
                                | "not_authenticated"
                        ) =>
                    {
                        let legacy = error.code == "legacy_mode";
                        let outcome = if matches!(error.status, 401 | 403)
                            || error.code == "lifecycle_rejected"
                        {
                            "Rejected"
                        } else {
                            "Unknown"
                        };
                        Ok(GatewayHttpResponse::Json {
                            status: error.status,
                            body: serde_json::json!({
                                "outcome": outcome,
                                "mode": if legacy { "legacy" } else { "agent-ready-v1" },
                                "source": if error.code == "lifecycle_rejected" { "private-ack" } else { "gateway" },
                                "code": error.code,
                                "error": error.message,
                            }),
                        })
                    }
                    Err(error) => Err(error),
                }
            }
            Route::InternalInvocation(invocation_id, state) => {
                self.handle_internal_invocation(state, invocation_id, body)
            }
            Route::InternalInvocationStatus(room_id, invocation_id) => {
                self.handle_internal_invocation_status(room_id, invocation_id, body)
            }
            Route::InternalExecutionBinding(bind) => {
                self.handle_internal_execution_binding(bind, body)
            }
            Route::InternalManagementCapabilities => self.handle_management_capabilities(body),
            Route::InternalManagementOperation(room_id) => {
                self.handle_management_operation(room_id, body)
            }
            Route::InternalManagementStatus(room_id) => {
                self.handle_management_status(room_id, body)
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
            | Route::TerminalInvocations(_)
            | Route::InvocationMetadata(_, _)
            | Route::Agents(_)
            | Route::Agent(_, _)
            | Route::Lease(_, _)
            | Route::Join => self.handle_public_http(&method, &path, &query, &route, body),
            Route::LocalSse => unreachable!(),
        }
    }

    fn management_identity(&self) -> Result<(u64, u64), ChatroomGatewayError> {
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if self.shutdown.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                503,
                "gateway_closed",
                "聊天室网关已关闭",
            ));
        }
        let epoch = self.auth_epoch.load(Ordering::Acquire);
        let (actor_id, _, _) = self.auth.image_task_identity().map_err(|error| {
            let (status, code) = match error {
                AuthError::NotAuthenticated => (401, "not_authenticated"),
                _ => (503, "auth_unavailable"),
            };
            ChatroomGatewayError::new(status, code, error.to_string())
        })?;
        if actor_id == 0 || self.auth_epoch.load(Ordering::Acquire) != epoch {
            return Err(ChatroomGatewayError::new(
                401,
                "auth_changed",
                "Working 身份在管理请求开始前已变化",
            ));
        }
        Ok((epoch, actor_id))
    }

    fn verify_management_identity(
        &self,
        epoch: u64,
        actor_id: u64,
    ) -> Result<std::sync::MutexGuard<'_, ()>, ChatroomGatewayError> {
        let auth_boundary = self.auth_boundary.lock().unwrap();
        if self.shutdown.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                503,
                "gateway_closed",
                "聊天室网关已关闭",
            ));
        }
        let current_actor = self
            .auth
            .image_task_identity()
            .ok()
            .map(|identity| identity.0);
        if self.auth_epoch.load(Ordering::Acquire) != epoch || current_actor != Some(actor_id) {
            return Err(ChatroomGatewayError::new(
                409,
                "auth_changed",
                "Working 身份在管理请求期间已变化，已丢弃旧响应",
            ));
        }
        Ok(auth_boundary)
    }

    fn handle_management_capabilities(
        &self,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        if !body.is_empty() {
            return Err(management_invalid_request("能力探测不接受请求体"));
        }
        let (epoch, actor_id) = self.management_identity()?;
        let response = self
            .transport
            .request(
                "GET",
                "/api/chatrooms/v2/agent-management/capabilities",
                None,
            )
            .map_err(management_transport_error)?;
        let _auth_boundary = self.verify_management_identity(epoch, actor_id)?;
        if !(200..300).contains(&response.status) {
            return Ok(management_error_response(response));
        }
        if response.status == 204 || response.body.is_empty() {
            return Err(invalid_management_response("上游能力响应缺少版本信息"));
        }
        let value = parse_management_response(&response.body)?;
        let body = crate::chatroom_management::validate_capabilities_envelope(value)
            .map_err(|_| invalid_management_response("上游能力响应不符合管理协议 v1"))?;
        Ok(GatewayHttpResponse::Json {
            status: response.status,
            body,
        })
    }

    fn handle_management_operation(
        &self,
        room_id: &str,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_management_body(body)?;
        let command = crate::chatroom_management::parse_command(value, &self.device_id)
            .map_err(|_| management_invalid_request("管理命令字段、类型或设备身份不正确"))?;
        let (epoch, actor_id) = self.management_identity()?;
        let path = format!("/api/chatrooms/v2/rooms/{room_id}/agent-management/operations");
        let response = self
            .transport
            .request("POST", &path, Some(command.body.to_string()))
            .map_err(management_transport_error)?;
        let _auth_boundary = self.verify_management_identity(epoch, actor_id)?;
        if !(200..300).contains(&response.status) {
            return Ok(management_error_response(response));
        }
        if response.status == 204 || response.body.is_empty() {
            return Err(invalid_management_response("上游管理写入未返回回执"));
        }
        let value = parse_management_response(&response.body)?;
        let body = crate::chatroom_management::validate_receipt_envelope(
            value, &command, room_id, actor_id,
        )
        .map_err(|_| invalid_management_response("上游管理回执与请求身份不匹配"))?;
        let room_agent_id = body["data"]["roomAgentId"]
            .as_str()
            .expect("已校验的管理回执含 roomAgentId");
        if command.action == "remove" {
            self.remove_management_lease(room_id, room_agent_id);
        }
        Ok(GatewayHttpResponse::Json {
            status: response.status,
            body,
        })
    }

    fn handle_management_status(
        &self,
        room_id: &str,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_management_body(body)?;
        let query = crate::chatroom_management::parse_status_query(value, &self.device_id)
            .map_err(|_| management_invalid_request("管理状态查询字段、类型或设备身份不正确"))?;
        let (epoch, actor_id) = self.management_identity()?;
        let path = format!("/api/chatrooms/v2/rooms/{room_id}/agent-management/operations/status");
        let response = self
            .transport
            .request("POST", &path, Some(query.body.to_string()))
            .map_err(management_transport_error)?;
        let _auth_boundary = self.verify_management_identity(epoch, actor_id)?;
        if !(200..300).contains(&response.status) {
            return Ok(management_error_response(response));
        }
        if response.status == 204 || response.body.is_empty() {
            return Err(invalid_management_response("上游管理状态查询未返回回执"));
        }
        let value = parse_management_response(&response.body)?;
        let body = crate::chatroom_management::validate_status_receipt_envelope(
            value,
            &query.operation_id,
            room_id,
            actor_id,
        )
        .map_err(|_| invalid_management_response("上游管理状态回执与请求身份不匹配"))?;
        Ok(GatewayHttpResponse::Json {
            status: response.status,
            body,
        })
    }

    fn remove_management_lease(&self, room_id: &str, agent_id: &str) {
        self.leases
            .lock()
            .unwrap()
            .remove(&(room_id.to_string(), agent_id.to_string()));
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
        if let Route::InvocationMetadata(room_id, invocation_id) = route {
            if (200..300).contains(&response.status) {
                let body =
                    validate_invocation_metadata_response(&response.body, room_id, invocation_id)?;
                return Ok(GatewayHttpResponse::Json {
                    status: response.status,
                    body,
                });
            }
            // 上游旧版本或未知调用的 404 必须原样保留，不能伪造关联结果。
            return public_response(response);
        }
        let successful = (200..300).contains(&response.status);
        let result = public_response(response)?;
        if successful {
            if let Route::Lease(room_id, agent_id) = route {
                if let Some(device_id) = body_value.get("deviceId").and_then(Value::as_str) {
                    if self.modern_protocol_selected() {
                        self.leases
                            .lock()
                            .unwrap()
                            .remove(&(room_id.to_string(), agent_id.to_string()));
                    } else {
                        self.register_lease(room_id, agent_id, device_id);
                    }
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
        let etag = required_component_text(object, "etag")?;
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

    fn handle_internal_room_status(
        &self,
        room_id: &str,
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if !self.auth.auth_state().authenticated || self.connection_paused.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                401,
                "not_authenticated",
                "请先登录 Copis Working",
            ));
        }
        let generation = self.client.active_socket_generation();
        let connected = self.websocket_connected.load(Ordering::Acquire)
            && self.accepted_client_generation.load(Ordering::Acquire) != NO_CLIENT_GENERATION;
        let snapshot_ready = connected
            && self
                .rooms
                .lock()
                .unwrap()
                .get(room_id)
                .is_some_and(|room| room.subscribed && room.snapshot_ready);
        let capability = self.capability_state();
        let selected = if capability.socket_generation == generation {
            capability.selected
        } else {
            Vec::new()
        };
        let modern = self.modern_protocol_selected();
        let capability_state = if generation == 0 || !snapshot_ready {
            "preparing"
        } else if modern {
            "ready"
        } else {
            "legacy"
        };
        Ok(GatewayHttpResponse::Json {
            status: 200,
            body: serde_json::json!({
                "ready": snapshot_ready,
                "epoch": self.realtime_epoch.load(Ordering::Acquire),
                "capabilityState": capability_state,
                "mode": if modern { "modern" } else { "legacy" },
                "socketGeneration": generation,
                "snapshotReady": snapshot_ready,
                "selectedCapabilities": selected.iter().map(|cap| match cap {
                    ChatroomCapability::AgentReadyV1 => "agent-ready-v1",
                    ChatroomCapability::InvocationAckV1 => "invocation-ack-v1",
                    ChatroomCapability::AgentDeltaFrameIdV1 => "agent-delta-frame-id-v1",
                }).collect::<Vec<_>>(),
            }),
        })
    }

    fn handle_internal_agent_readiness(
        &self,
        room_id: &str,
        agent_id: &str,
        ready: bool,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        normalize_room_id(room_id).map_err(|_| invalid_request("roomId 不合法"))?;
        if !valid_component(agent_id) {
            return Err(invalid_request("roomAgentId 不合法"));
        }
        let request = parse_body_value(body, true)?;
        if !request.as_object().is_some_and(serde_json::Map::is_empty) {
            return Err(invalid_request("ready 请求不得指定宿主或所有者身份"));
        }
        let auth_boundary = self.auth_boundary.lock().unwrap();
        if !self.auth.auth_state().authenticated || self.connection_paused.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                401,
                "not_authenticated",
                "请先登录 Copis Working",
            ));
        }
        let generation = self.client.active_socket_generation();
        let auth_epoch = self.auth_epoch.load(Ordering::Acquire);
        let auth_generation = self.accepted_client_generation.load(Ordering::Acquire);
        if generation == 0
            || !self.websocket_connected.load(Ordering::Acquire)
            || auth_generation == NO_CLIENT_GENERATION
        {
            return Err(lifecycle_unknown("当前没有活动的聊天室连接"));
        }
        let snapshot_ready = self
            .rooms
            .lock()
            .unwrap()
            .get(room_id)
            .is_some_and(|room| room.subscribed && room.snapshot_ready);
        if !snapshot_ready {
            return Err(lifecycle_unknown("当前房间订阅快照尚未就绪"));
        }
        if !self.modern_protocol_selected() {
            return Err(ChatroomGatewayError::new(
                409,
                "legacy_mode",
                "当前 WebSocket 未协商 agent-ready-v1，请使用 legacy lease 路径",
            ));
        }
        let counter = self
            .next_lifecycle_request_id
            .fetch_add(1, Ordering::AcqRel);
        let request_id = lifecycle_request_id(&self.lifecycle_boot_id, counter);
        let command_name = if ready {
            "agent.ready"
        } else {
            "agent.unready"
        };
        let command = if ready {
            ChatroomCommand::Ready {
                room_id: room_id.to_string(),
                request_id: request_id.clone(),
                room_agent_id: agent_id.to_string(),
            }
        } else {
            ChatroomCommand::Unready {
                room_id: room_id.to_string(),
                request_id: request_id.clone(),
                room_agent_id: agent_id.to_string(),
            }
        };
        drop(auth_boundary);

        let confirmed = self
            .client
            .request_and_confirm_on_generation(
                command,
                room_id,
                &request_id,
                command_name,
                None,
                generation,
            )
            .map_err(lifecycle_ack_error)?;

        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if !self.auth.auth_state().authenticated
            || self.connection_paused.load(Ordering::Acquire)
            || self.auth_epoch.load(Ordering::Acquire) != auth_epoch
            || self.accepted_client_generation.load(Ordering::Acquire) != auth_generation
            || self.client.active_socket_generation() != generation
            || self.capability_state().socket_generation != generation
            || !self
                .rooms
                .lock()
                .unwrap()
                .get(room_id)
                .is_some_and(|room| room.subscribed && room.snapshot_ready)
            || confirmed.room_id != room_id
            || confirmed.command != command_name
            || confirmed.request_id != request_id
            || confirmed.generation != generation
        {
            return Err(lifecycle_unknown("ready 确认到达时连接代际已变化"));
        }
        self.leases
            .lock()
            .unwrap()
            .remove(&(room_id.to_string(), agent_id.to_string()));
        Ok(GatewayHttpResponse::Json {
            status: 200,
            body: serde_json::json!({
                "outcome": "confirmed",
                "mode": "agent-ready-v1",
                "source": "private-ack",
                "roomId": room_id,
                "roomAgentId": agent_id,
                "command": command_name,
                "requestId": confirmed.request_id,
                "generation": confirmed.generation,
            }),
        })
    }

    fn handle_internal_lease_release(
        &self,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_body_value(body, true)?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid_request("请求体必须是对象"))?;
        require_keys(object, &["deviceId", "leases"])?;
        let _device_id = object
            .get("deviceId")
            .and_then(Value::as_str)
            .filter(|v| valid_component(v))
            .ok_or_else(|| invalid_request("deviceId 不正确"))?;
        let leases = object
            .get("leases")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_request("leases 不正确"))?;
        if leases.is_empty() || leases.len() > 3 {
            return Err(invalid_request("leases 数量不正确"));
        }
        let mut seen = HashSet::new();
        for lease in leases {
            let item = lease
                .as_object()
                .ok_or_else(|| invalid_request("lease 必须是对象"))?;
            require_keys(item, &["roomId", "roomAgentId"])?;
            let room_id = item
                .get("roomId")
                .and_then(Value::as_str)
                .filter(|v| valid_component(v))
                .ok_or_else(|| invalid_request("roomId 不正确"))?;
            let agent_id = item
                .get("roomAgentId")
                .and_then(Value::as_str)
                .filter(|v| valid_component(v))
                .ok_or_else(|| invalid_request("roomAgentId 不正确"))?;
            if !seen.insert(format!("{room_id}\0{agent_id}")) {
                return Err(invalid_request("leases 不得重复"));
            }
        }
        let response = self
            .transport
            .request(
                "POST",
                "/api/chatrooms/v2/agents/leases/release",
                Some(value.to_string()),
            )
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
        let auth_epoch = {
            let _auth_boundary = self.auth_boundary.lock().unwrap();
            if !self.auth.auth_state().authenticated
                || self.connection_paused.load(Ordering::Acquire)
            {
                return Err(ChatroomGatewayError::new(
                    401,
                    "not_authenticated",
                    "聊天室连接因认证状态不可用",
                ));
            }
            self.auth_epoch.load(Ordering::Acquire)
        };
        let command = match state {
            "running" => {
                require_keys(object, &["roomId", "invocationId"])?;
                ChatroomCommand::AgentRunning {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                }
            }
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
                        text: required_text(object, "delta")?.to_string(),
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
                        content: required_text(object, "content")?.to_string(),
                        mention_agent_ids: string_array(object, "mentionAgentIds")?,
                        attachment_ids: {
                            let ids = string_array(object, "attachmentIds")?;
                            if ids.len() > 20 {
                                return Err(invalid_request("附件数量超限"));
                            }
                            ids
                        },
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
                let failure_code = required_string(object, "failureCode")?;
                if !is_chatroom_failure_code(failure_code) {
                    return Err(invalid_request("聊天室 failureCode 不合法"));
                }
                ChatroomCommand::AgentEvent {
                    room_id: room_id.to_string(),
                    invocation_id: invocation_id.to_string(),
                    event: AgentEventPayload::Failed {
                        code: failure_code.to_string(),
                        message: match object.get("message") {
                            None => "Agent invocation failed".to_string(),
                            Some(_) => required_text(object, "message")?.to_string(),
                        },
                    },
                }
            }
            _ => return Err(route_not_found()),
        };
        if state == "delta" {
            let generation = self.client.active_socket_generation();
            if generation == 0 {
                return Err(ChatroomGatewayError::new(
                    503,
                    "realtime_unavailable",
                    "没有可发送增量的活动聊天室连接",
                ));
            }
            self.client
                .command_on_generation(command, generation)
                .map_err(|_| {
                    ChatroomGatewayError::new(
                        503,
                        "realtime_unavailable",
                        "聊天室连接代际已变化，增量未发送",
                    )
                })?;
            let _auth_boundary = self.auth_boundary.lock().unwrap();
            if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                || !self.auth.auth_state().authenticated
                || self.connection_paused.load(Ordering::Acquire)
                || self.client.active_socket_generation() != generation
            {
                return Err(lifecycle_unknown("认证状态或连接代际已变化，增量未确认"));
            }
            return Ok(GatewayHttpResponse::Empty { status: 204 });
        }

        let request_id = lifecycle_request_id(
            &self.lifecycle_boot_id,
            self.next_lifecycle_request_id
                .fetch_add(1, Ordering::AcqRel),
        );
        let expected_status = state;
        let command_name = match state {
            "accepted" => "agent.accepted",
            "running" => "agent.running",
            "completed" => "agent.completed",
            "failed" => "agent.failed",
            _ => return Err(route_not_found()),
        };
        let generation = self.client.active_socket_generation();
        if generation == 0 {
            return Err(lifecycle_unknown("当前没有活动的聊天室连接"));
        }
        let ack_selected = self.modern_protocol_selected();
        if !ack_selected {
            if state == "running" {
                let already_accepted = self.legacy_accepted.lock().unwrap().contains(&(
                    generation,
                    room_id.to_string(),
                    invocation_id.to_string(),
                ));
                if !already_accepted {
                    return Err(lifecycle_unknown(
                        "旧协议 running 仅在本连接已确认 accepted 后提供 advisory",
                    ));
                }
                let _auth_boundary = self.auth_boundary.lock().unwrap();
                if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                    || !self.auth.auth_state().authenticated
                    || self.connection_paused.load(Ordering::Acquire)
                    || self.client.active_socket_generation() != generation
                {
                    return Err(lifecycle_unknown("旧协议 running advisory 的连接已变化"));
                }
                return Ok(GatewayHttpResponse::Json {
                    status: 200,
                    body: serde_json::json!({
                        "outcome": "advisory",
                        "mode": "legacy",
                        "source": "accepted-event+local-advisory",
                        "roomId": room_id,
                        "invocationId": invocation_id,
                        "command": command_name,
                        "status": expected_status,
                        "generation": generation,
                    }),
                });
            }
            let receiver = self
                .legacy_lifecycle_waiters
                .register(generation, &request_id, command.clone())
                .map_err(lifecycle_ack_error)?;
            if self
                .client
                .command_on_generation(command, generation)
                .is_err()
            {
                self.legacy_lifecycle_waiters
                    .cancel(generation, &request_id);
                return Err(lifecycle_unknown("旧协议生命周期命令未能进入当前 socket"));
            }
            let terminal_proof = self
                .legacy_lifecycle_waiters
                .wait(&request_id, generation, receiver, Duration::from_secs(5))
                .map_err(lifecycle_ack_error)?;
            if matches!(state, "completed" | "failed") && terminal_proof.is_none() {
                return Err(lifecycle_unknown(
                    "legacy terminal event 缺少匹配结果 proof",
                ));
            }
            let _auth_boundary = self.auth_boundary.lock().unwrap();
            if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                || !self.auth.auth_state().authenticated
                || self.connection_paused.load(Ordering::Acquire)
                || self.client.active_socket_generation() != generation
            {
                return Err(lifecycle_unknown("legacy 服务端事件到达时连接代际已变化"));
            }
            let mut body = serde_json::json!({
                "outcome": "confirmed",
                "mode": "legacy",
                "source": "server-event",
                "roomId": room_id,
                "invocationId": invocation_id,
                "command": command_name,
                "status": expected_status,
                "generation": generation,
            });
            if let Some(terminal_proof) = terminal_proof {
                body.as_object_mut()
                    .expect("legacy lifecycle result is an object")
                    .insert("terminalProof".into(), terminal_proof.to_value());
            }
            return Ok(GatewayHttpResponse::Json { status: 200, body });
        }
        // 不持有 auth_boundary 或 Gateway 状态锁等待 ACK；reader 在线程内独立处理回包。
        let confirmed = self
            .client
            .request_and_confirm_on_generation(
                command,
                room_id,
                &request_id,
                command_name,
                Some(invocation_id),
                generation,
            )
            .map_err(lifecycle_ack_error)?;
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
            || !self.auth.auth_state().authenticated
            || self.connection_paused.load(Ordering::Acquire)
            || !valid_lifecycle_confirmation(
                &confirmed,
                room_id,
                invocation_id,
                command_name,
                &request_id,
                expected_status,
                generation,
            )
            || self.client.active_socket_generation() != generation
            || self.capability_state().socket_generation != generation
        {
            return Err(lifecycle_unknown("聊天室确认状态缺失或连接代际已变化"));
        }
        Ok(GatewayHttpResponse::Json {
            status: 200,
            body: serde_json::json!({
                "outcome": "confirmed",
                "mode": "invocation-ack-v1",
                "source": "private-ack",
                "confirmed": true,
                "roomId": confirmed.room_id,
                "invocationId": confirmed.invocation_id,
                "requestId": confirmed.request_id,
                "command": confirmed.command,
                "status": confirmed.status,
                "generation": confirmed.generation,
            }),
        })
    }

    fn handle_internal_invocation_status(
        &self,
        path_room_id: &str,
        path_invocation_id: &str,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let request = parse_body_value(body, true)?;
        let expected = request
            .as_object()
            .ok_or_else(|| invalid_request("状态查询请求必须是对象"))?;
        require_keys(
            expected,
            &[
                "roomId",
                "invocationId",
                "deviceId",
                "traceId",
                "targetAgentId",
                "triggerMessageId",
                "depth",
                "expectedStatus",
                "failureCode",
                "clientMessageId",
                "replyDigest",
            ],
        )?;
        let room_id = required_string(expected, "roomId")?;
        let invocation_id = required_string(expected, "invocationId")?;
        let device_id = required_string(expected, "deviceId")?;
        if room_id != path_room_id
            || invocation_id != path_invocation_id
            || room_id.len() > 64
            || !valid_invocation_id(invocation_id, 128)
            || device_id != self.device_id
        {
            return Err(ChatroomGatewayError::new(
                403,
                "invocation_status_rejected",
                "聊天室调用状态查询上下文不匹配",
            ));
        }
        normalize_room_id(room_id).map_err(|_| invalid_request("roomId 不合法"))?;
        for key in ["traceId", "targetAgentId", "triggerMessageId"] {
            let value = required_string(expected, key)?;
            if !valid_invocation_id(value, 128) {
                return Err(invalid_request("状态查询关联字段不合法"));
            }
        }
        if expected
            .get("depth")
            .and_then(Value::as_u64)
            .filter(|depth| *depth <= u8::MAX as u64)
            .is_none()
        {
            return Err(invalid_request("状态查询 depth 不合法"));
        }
        let expected_status = required_string(expected, "expectedStatus")?;
        let expected_client_id = expected
            .get("clientMessageId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("状态查询 clientMessageId 不合法"))?;
        let expected_digest = expected
            .get("replyDigest")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("状态查询 replyDigest 不合法"))?;
        let expected_failure_code = expected
            .get("failureCode")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request("状态查询 failureCode 不合法"))?;
        match expected_status {
            "completed"
                if valid_invocation_id(expected_client_id, 128)
                    && valid_sha256(expected_digest)
                    && expected_failure_code.is_empty() => {}
            "failed"
                if expected_client_id.is_empty()
                    && expected_digest.is_empty()
                    && is_chatroom_failure_code(expected_failure_code) => {}
            _ => return Err(invalid_request("状态查询终态期望不合法")),
        }
        let auth_epoch = {
            let _auth_boundary = self.auth_boundary.lock().unwrap();
            if !self.auth.auth_state().authenticated
                || self.connection_paused.load(Ordering::Acquire)
            {
                return Err(ChatroomGatewayError::new(
                    401,
                    "not_authenticated",
                    "请先登录 Copis Working",
                ));
            }
            self.auth_epoch.load(Ordering::Acquire)
        };
        let generation = self.client.active_socket_generation();
        let outcome = |name, proof| {
            invocation_status_outcome(name, room_id, invocation_id, expected, generation, proof)
        };
        let mut legacy_status_waiter = None;
        if generation != 0 && !self.modern_protocol_selected() {
            let request_id = format!(
                "{}-status",
                lifecycle_request_id(
                    &self.lifecycle_boot_id,
                    self.next_lifecycle_request_id
                        .fetch_add(1, Ordering::AcqRel),
                )
            );
            match self.legacy_lifecycle_waiters.register_status(
                generation,
                &request_id,
                room_id,
                invocation_id,
                expected_status,
                expected_client_id,
                expected_digest,
                expected_failure_code,
            ) {
                Ok(receiver) => legacy_status_waiter = Some((request_id, receiver)),
                Err(_) => return Ok(outcome("Unknown", None)),
            }
        }
        let path = format!(
            "{CHATROOM_HTTP_PREFIX}/rooms/{}/invocations/{}/status?deviceId={}",
            percent_encode_query_component(room_id),
            percent_encode_query_component(invocation_id),
            percent_encode_query_component(device_id),
        );
        let response = match self.transport.request("GET", &path, None) {
            Ok(response) => response,
            Err(_) => {
                if let Some((request_id, _)) = &legacy_status_waiter {
                    self.legacy_lifecycle_waiters.cancel(generation, request_id);
                }
                return Ok(outcome("Unknown", None));
            }
        };
        if response.status == 404 {
            if let Some((request_id, receiver)) = legacy_status_waiter {
                if let Ok(Some(terminal_proof)) = self.legacy_lifecycle_waiters.wait(
                    &request_id,
                    generation,
                    receiver,
                    self.legacy_status_wait_timeout(),
                ) {
                    let _auth_boundary = self.auth_boundary.lock().unwrap();
                    if self.auth_epoch.load(Ordering::Acquire) == auth_epoch
                        && self.auth.auth_state().authenticated
                        && !self.connection_paused.load(Ordering::Acquire)
                        && self.client.active_socket_generation() == generation
                    {
                        return Ok(GatewayHttpResponse::Json {
                            status: 200,
                            body: serde_json::json!({
                                "outcome": "Confirmed",
                                "mode": "legacy",
                                "source": "server-event",
                                "roomId": room_id,
                                "invocationId": invocation_id,
                                "traceId": expected.get("traceId"),
                                "status": expected_status,
                                "generation": generation,
                                "terminalProof": terminal_proof.to_value(),
                            }),
                        });
                    }
                }
            }
            return Ok(outcome("Unknown", None));
        }
        if let Some((request_id, _)) = &legacy_status_waiter {
            self.legacy_lifecycle_waiters.cancel(generation, request_id);
        }
        if response.status >= 500 {
            return Ok(outcome("Unknown", None));
        }
        if response.status == 401 || response.status == 403 {
            return Ok(outcome("Rejected", None));
        }
        if !(200..300).contains(&response.status)
            || response.body.len() > MAX_INVOCATION_STATUS_BYTES
        {
            return Ok(outcome("Rejected", None));
        }
        let data = match parse_invocation_status_data(&response.body) {
            Ok(data) => data,
            Err(()) => return Ok(outcome("Rejected", None)),
        };
        if !invocation_status_matches(&data, expected) {
            return Ok(outcome("Rejected", None));
        }
        let status = data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            status,
            "created" | "accepted" | "running" | "completed" | "failed"
        ) {
            return Ok(outcome("Rejected", None));
        }
        if !matches!(status, "completed" | "failed") {
            return Ok(outcome("Unknown", None));
        }
        if status != expected_status {
            return Ok(outcome("Rejected", None));
        }
        if !data
            .get("finishedAt")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
            })
        {
            return Ok(outcome("Rejected", None));
        }
        if status == "completed"
            && (data.get("replyClientMessageId").and_then(Value::as_str)
                != expected.get("clientMessageId").and_then(Value::as_str)
                || data.get("replyDigest").and_then(Value::as_str)
                    != expected.get("replyDigest").and_then(Value::as_str)
                || !data
                    .get("replyMessageId")
                    .and_then(Value::as_str)
                    .is_some_and(|value| valid_invocation_id(value, 128))
                || data
                    .get("replyDigest")
                    .and_then(Value::as_str)
                    .is_none_or(|value| !valid_sha256(value)))
        {
            return Ok(outcome("Rejected", None));
        }
        if status == "failed"
            && data.get("failureCode").and_then(Value::as_str) != Some(expected_failure_code)
        {
            return Ok(outcome("Rejected", None));
        }
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
            || !self.auth.auth_state().authenticated
            || self.connection_paused.load(Ordering::Acquire)
        {
            return Ok(outcome("Unknown", None));
        }
        Ok(outcome("Confirmed", Some(data)))
    }

    fn handle_internal_execution_binding(
        &self,
        bind: bool,
        body: &[u8],
    ) -> Result<GatewayHttpResponse, ChatroomGatewayError> {
        let value = parse_body_value(body, true)?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid_request("执行绑定请求必须是对象"))?;
        require_keys(
            object,
            &[
                "roomId",
                "invocationId",
                "targetAgentId",
                "sessionId",
                "workerRunId",
                "origin",
            ],
        )?;
        let room_id = required_string(object, "roomId")?;
        let invocation_id = required_string(object, "invocationId")?;
        let target_agent_id = required_string(object, "targetAgentId")?;
        let session_id = required_string(object, "sessionId")?;
        let worker_run_id = required_string(object, "workerRunId")?;
        if !valid_component(&room_id)
            || !valid_component(&invocation_id)
            || !valid_component(&target_agent_id)
            || !valid_component(&session_id)
            || !valid_component(&worker_run_id)
        {
            return Err(invalid_request("执行绑定标识不合法"));
        }
        let origin_value = object
            .get("origin")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_request("执行绑定来源不正确"))?;
        require_keys(
            origin_value,
            &["clientGeneration", "socketGeneration", "authEpoch"],
        )?;
        let origin = ChatroomOrigin {
            client_generation: origin_value
                .get("clientGeneration")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid_request("clientGeneration 不正确"))?,
            socket_generation: origin_value
                .get("socketGeneration")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid_request("socketGeneration 不正确"))?,
            auth_epoch: origin_value
                .get("authEpoch")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid_request("authEpoch 不正确"))?,
        };
        let binding = ChatroomExecutionBinding {
            room_id: room_id.to_string(),
            invocation_id: invocation_id.to_string(),
            target_agent_id: target_agent_id.to_string(),
            session_id: session_id.to_string(),
            worker_run_id: worker_run_id.to_string(),
            origin,
        };
        let registry = self.execution_registry.lock().unwrap().clone();
        if bind {
            let subscribed = self
                .rooms
                .lock()
                .unwrap()
                .get(room_id)
                .is_some_and(|room| room.subscribed && room.snapshot_ready);
            if !subscribed || !self.origin_is_current(origin) || !registry.bind(binding) {
                return Ok(GatewayHttpResponse::Json {
                    status: 409,
                    body: serde_json::json!({"code":"execution_binding_rejected"}),
                });
            }
        } else if !registry.release(&binding) {
            return Ok(GatewayHttpResponse::Json {
                status: 409,
                body: serde_json::json!({"code":"execution_binding_stale"}),
            });
        }
        Ok(GatewayHttpResponse::Json {
            status: 200,
            body: serde_json::json!({"status": if bind {"bound"} else {"released"}}),
        })
    }

    pub fn subscribe_sse(
        &self,
        room_ids: Vec<String>,
    ) -> Result<SseSubscription, ChatroomGatewayError> {
        if !self.auth.auth_state().authenticated || self.connection_paused.load(Ordering::Acquire) {
            return Err(ChatroomGatewayError::new(
                401,
                "not_authenticated",
                "请先登录 Copis Working",
            ));
        }
        let auth_epoch = self.auth_epoch.load(Ordering::Acquire);
        if room_ids.is_empty() || room_ids.len() > 50 {
            return Err(invalid_request("SSE 至少需要一个聊天室"));
        }
        let mut requested_rooms = HashSet::new();
        for room_id in room_ids {
            requested_rooms.insert(
                normalize_room_id(&room_id).map_err(|_| invalid_request("聊天室 ID 不合法"))?,
            );
        }
        let mut rooms = HashSet::new();
        let mut rejected_rooms = Vec::new();
        for room_id in requested_rooms {
            match self.verify_sse_room(&room_id) {
                Ok(()) => {
                    rooms.insert(room_id);
                }
                Err(error) if error.status == 403 || error.status == 404 => {
                    rejected_rooms.push(ChatroomEvent::LocalStatus {
                        room_id: Some(room_id),
                        code: if error.status == 404 {
                            "room_not_found"
                        } else {
                            "not_member"
                        }
                        .into(),
                        message: "聊天室已不可访问".into(),
                    });
                }
                Err(error) => return Err(error),
            }
        }
        #[cfg(test)]
        let registration_gate = self.sse_registration_gate.lock().unwrap().take();
        #[cfg(test)]
        if let Some(gate) = registration_gate {
            let _ = gate.loaded.send(());
            let _ = gate.release.recv();
        }
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
            || !self.auth.auth_state().authenticated
            || self.connection_paused.load(Ordering::Acquire)
        {
            return Err(ChatroomGatewayError::new(
                401,
                "not_authenticated",
                "请先登录 Copis Working",
            ));
        }
        for event in &rejected_rooms {
            if let ChatroomEvent::LocalStatus {
                room_id: Some(room_id),
                code,
                message,
            } = event
            {
                self.publish_status(Some(room_id), code, message);
                self.remove_room_subscription_state(room_id);
            }
        }
        let (sender, receiver) = mpsc::sync_channel(SSE_CAPACITY);
        let occupancy = Arc::new(AtomicUsize::new(0));
        let subscriber_id = self.next_subscriber_id.fetch_add(1, Ordering::Relaxed);
        let mut initial = rejected_rooms;
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
        if self.websocket_connected.load(Ordering::Acquire) {
            initial.push(ChatroomEvent::LocalStatus {
                room_id: None,
                code: "realtime_connected".into(),
                message: "聊天室实时连接已建立".into(),
            });
        }
        #[cfg(test)]
        if let Some(gate) = self.sse_status_gate.lock().unwrap().take() {
            let _ = gate.loaded.send(());
            let _ = gate.release.recv();
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
        drop(_auth_boundary);
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

    fn verify_sse_room(&self, room_id: &str) -> Result<(), ChatroomGatewayError> {
        let path = format!("{CHATROOM_HTTP_PREFIX}/rooms/{room_id}");
        let response = self.transport.request("GET", &path, None).map_err(|_| {
            ChatroomGatewayError::new(502, "upstream_unavailable", "聊天室服务暂不可用")
        })?;
        if !(200..300).contains(&response.status) {
            let status = response.status;
            return Err(ChatroomGatewayError::new(
                status,
                if status == 404 {
                    "room_not_found"
                } else {
                    "room_unavailable"
                },
                "聊天室不可用或当前账号无访问权限",
            ));
        }
        let value = parse_json_response(&response.body)?;
        let room = value.get("data").and_then(|data| data.get("room"));
        if room
            .and_then(|room| room.get("roomId"))
            .and_then(Value::as_str)
            != Some(room_id)
        {
            return Err(ChatroomGatewayError::new(
                502,
                "invalid_upstream_response",
                "聊天室详情响应不正确",
            ));
        }
        if matches!(
            room.and_then(|room| room.get("status"))
                .and_then(Value::as_str),
            Some("deleted" | "deleting")
        ) {
            return Err(ChatroomGatewayError::new(
                404,
                "room_not_found",
                "聊天室已关闭",
            ));
        }
        Ok(())
    }

    fn schedule_inaccessible_prune(&self) {
        self.prune_pending.store(true, Ordering::Release);
        self.try_dispatch_pending_prune();
    }

    fn try_dispatch_pending_prune(&self) {
        if !self.prune_pending.load(Ordering::Acquire)
            || self
                .prune_queued
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        if !self.prune_pending.swap(false, Ordering::AcqRel) {
            self.prune_queued.store(false, Ordering::Release);
            return;
        }
        let epoch = self.auth_epoch.load(Ordering::Acquire);
        if self
            .dispatch_task(GatewayTask::PruneInaccessible(epoch))
            .is_err()
        {
            if self.task_sender.lock().unwrap().is_none() {
                self.prune_inaccessible_subscriptions(epoch);
            } else {
                self.prune_pending.store(true, Ordering::Release);
            }
            self.prune_queued.store(false, Ordering::Release);
            if self.task_sender.lock().unwrap().is_none() {
                self.try_dispatch_pending_prune();
            }
        }
    }

    fn prune_inaccessible_subscriptions(&self, auth_epoch: u64) {
        if self.auth_epoch.load(Ordering::Acquire) != auth_epoch {
            return;
        }
        let room_ids = self
            .rooms
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, state)| state.subscribed)
            .map(|(room_id, _)| room_id.clone())
            .collect::<Vec<_>>();
        for room_id in room_ids {
            if self.auth_epoch.load(Ordering::Acquire) != auth_epoch {
                return;
            }
            let rejection = match self.verify_sse_room(&room_id) {
                Err(error) if error.status == 403 => Some("not_member"),
                Err(error) if error.status == 404 => Some("room_not_found"),
                _ => None,
            };
            let Some(code) = rejection else { continue };
            let removed = {
                let _auth_boundary = self.auth_boundary.lock().unwrap();
                if self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                    || !self.auth.auth_state().authenticated
                    || self.connection_paused.load(Ordering::Acquire)
                {
                    return;
                }
                self.publish_status(Some(&room_id), code, "聊天室已不可访问");
                self.remove_room_subscription_state(&room_id);
                true
            };
            if removed {
                self.refresh_subscription_snapshot();
            }
        }
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
        if self.shutdown.load(Ordering::Acquire) || self.connection_paused.load(Ordering::Acquire) {
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
            state.snapshot_ready = true;
            state.snapshot = Some(event.clone());
        }
        self.broadcast(&event);
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

    fn forward_invocation(&self, event: &ChatroomEvent, origin: GatewayOrigin) {
        let result = self.dispatch_task(GatewayTask::Invocation {
            event: event.clone(),
            origin,
        });
        #[cfg(test)]
        if result.is_ok() {
            if let Some(observer) = self.invocation_dispatch_observer.lock().unwrap().take() {
                let _ = observer.send((
                    origin.client_generation,
                    origin.socket_generation,
                    origin.auth_epoch,
                ));
            }
        }
        if let Err(task) = result {
            if let GatewayTask::Invocation { event, origin } = task {
                if self.task_sender.lock().unwrap().is_none() {
                    self.forward_invocation_now(&event, origin);
                } else if self.origin_is_current(origin) {
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

    pub(super) fn forward_invocation_now(&self, event: &ChatroomEvent, origin: GatewayOrigin) {
        if !self.origin_is_current(origin) {
            return;
        }
        let ChatroomEvent::AgentInvocation { room_id, payload } = event else {
            return;
        };
        let Some(mut object) = payload.as_object().cloned() else {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        };
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

        if validate_forward_invocation_payload(&object).is_err() {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        }
        if canonicalize_forward_invocation_payload(&mut object).is_err() {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        }
        let mut invocation = Map::new();
        invocation.insert("roomId".into(), Value::String(room_id.clone()));
        for key in [
            "invocationId",
            "traceId",
            "targetAgentId",
            "triggerMessageId",
            "depth",
            "sender",
            "messages",
            "receivedAt",
        ] {
            invocation.insert(key.into(), object.get(key).cloned().unwrap_or(Value::Null));
        }
        let output = serde_json::json!({
            "invocation": Value::Object(invocation),
            "gatewayOrigin": {
                "clientGeneration": origin.client_generation,
                "socketGeneration": origin.socket_generation,
                "authEpoch": origin.auth_epoch,
            },
        });
        let body = output.to_string().into_bytes();
        if body.len() > MAX_INVOCATION_BRIDGE_BYTES {
            self.publish_status(
                Some(room_id),
                "invocation_invalid",
                "Agent invocation 格式不正确",
            );
            return;
        }
        if let Err(error) = self.bridge.send_invocation(body, &self.shutdown) {
            if error == CHATROOM_NATIVE_RUNTIME_UNSUPPORTED {
                self.publish_status(
                    Some(room_id),
                    "invocation_invalid",
                    CHATROOM_NATIVE_RUNTIME_UNSUPPORTED_MESSAGE,
                );
                return;
            }
            self.publish_status(Some(room_id), "bridge_unavailable", "聊天室业务桥不可用");
        }
    }

    #[cfg(test)]
    fn forward_invocation_for_test(&self, event: &ChatroomEvent) {
        let ChatroomEvent::AgentInvocation { room_id, payload } = event else {
            return;
        };
        let Some(mut object) = payload.as_object().cloned() else {
            return;
        };
        if validate_forward_invocation_payload(&object).is_err()
            || canonicalize_forward_invocation_payload(&mut object).is_err()
        {
            return;
        }
        let mut output = Map::new();
        output.insert("roomId".into(), Value::String(room_id.clone()));
        for key in [
            "invocationId",
            "traceId",
            "targetAgentId",
            "triggerMessageId",
            "depth",
            "sender",
            "messages",
            "receivedAt",
        ] {
            output.insert(key.into(), object.get(key).cloned().unwrap_or(Value::Null));
        }
        let body = Value::Object(output).to_string().into_bytes();
        if body.len() <= MAX_INVOCATION_BRIDGE_BYTES {
            let _ = self.bridge.send_invocation(body, &self.shutdown);
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
        if self.shutdown.load(Ordering::Acquire)
            || !self.started.load(Ordering::Acquire)
            || self.connection_paused.load(Ordering::Acquire)
            || !self.auth.auth_state().authenticated
        {
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
            *self.last_subscription.lock().unwrap() = None;
            return;
        }
        let desired = (rooms, self.device_id.clone());
        if self.last_subscription.lock().unwrap().as_ref() == Some(&desired) {
            return;
        }
        let auth_epoch = self.auth_epoch.load(Ordering::Acquire);
        let realtime_epoch = self.realtime_epoch.load(Ordering::Acquire);
        let socket_generation = self.client.active_socket_generation();
        let mut probe_sequence = None;
        let requested_capabilities = self.protocol_options.requested_capabilities();
        let capabilities = if !requested_capabilities.is_empty() {
            let sequence = self
                .capability_probe_sequence
                .fetch_add(1, Ordering::AcqRel)
                + 1;
            probe_sequence = Some(sequence);
            if self.connection_paused.load(Ordering::Acquire)
                || self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                || !self.auth.auth_state().authenticated
            {
                return;
            }
            let response = match self
                .transport
                .request("GET", CHATROOM_CAPABILITIES_PATH, None)
            {
                Ok(response) => response,
                Err(_) => {
                    if self.auth_epoch.load(Ordering::Acquire) == auth_epoch
                        && !self.connection_paused.load(Ordering::Acquire)
                    {
                        self.publish_status(
                            None,
                            "capabilities_unavailable",
                            "聊天室能力探测暂不可用",
                        );
                    }
                    return;
                }
            };
            if self.connection_paused.load(Ordering::Acquire)
                || self.auth_epoch.load(Ordering::Acquire) != auth_epoch
                || self.realtime_epoch.load(Ordering::Acquire) != realtime_epoch
                || self.client.active_socket_generation() != socket_generation
                || self.capability_probe_sequence.load(Ordering::Acquire) != sequence
                || !self.auth.auth_state().authenticated
            {
                return;
            }
            let advertised = match crate::chatroom_protocol::parse_chatroom_capabilities_response(
                response.status,
                &response.body,
            ) {
                Ok(capabilities) => capabilities,
                Err(_) => {
                    if !self.connection_paused.load(Ordering::Acquire)
                        && self.auth_epoch.load(Ordering::Acquire) == auth_epoch
                    {
                        self.publish_status(None, "capabilities_invalid", "聊天室能力响应无效");
                    }
                    return;
                }
            };
            let current_rooms = self
                .rooms
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, state)| state.subscribed)
                .map(|(room_id, state)| RoomCursor {
                    room_id: room_id.clone(),
                    after_seq: state.last_contiguous_seq,
                })
                .collect::<Vec<_>>();
            if current_rooms != desired.0 {
                return;
            }
            advertised.map(|capabilities| {
                capabilities
                    .into_iter()
                    .filter(|capability| requested_capabilities.contains(capability))
                    .collect()
            })
        } else {
            None
        };
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        if self.shutdown.load(Ordering::Acquire)
            || self.connection_paused.load(Ordering::Acquire)
            || self.auth_epoch.load(Ordering::Acquire) != auth_epoch
            || self.realtime_epoch.load(Ordering::Acquire) != realtime_epoch
            || self.client.active_socket_generation() != socket_generation
            || !self.auth.auth_state().authenticated
        {
            return;
        }
        let current_rooms = self
            .rooms
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, state)| state.subscribed)
            .map(|(room_id, state)| RoomCursor {
                room_id: room_id.clone(),
                after_seq: state.last_contiguous_seq,
            })
            .collect::<Vec<_>>();
        if current_rooms != desired.0 {
            return;
        }
        if self.last_subscription.lock().unwrap().as_ref() == Some(&desired) {
            return;
        }
        if !requested_capabilities.is_empty() {
            if probe_sequence.is_none_or(|sequence| {
                self.capability_probe_sequence.load(Ordering::Acquire) != sequence
            }) {
                return;
            }
            *self.advertised_capabilities.lock().unwrap() =
                (socket_generation, capabilities.clone().unwrap_or_default());
        }
        *self.last_subscription.lock().unwrap() = Some(desired.clone());
        self.send_client_command_if_started(ChatroomCommand::Subscribe {
            rooms: desired.0,
            device_id: desired.1,
            capabilities,
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
        if self.modern_protocol_selected() {
            self.leases.lock().unwrap().clear();
            return;
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
            Route::Room(room_id) => {
                if method == "DELETE" {
                    self.remove_room_subscription(room_id);
                } else {
                    self.mark_room_subscribed(room_id);
                }
            }
            Route::Archive(room_id)
            | Route::Restore(room_id)
            | Route::Read(room_id)
            | Route::Messages(room_id)
            | Route::Events(room_id)
            | Route::TerminalInvocations(room_id)
            | Route::Agents(room_id) => {
                self.mark_room_subscribed(room_id);
            }
            Route::Leave(room_id) => {
                self.remove_room_subscription(room_id);
            }
            Route::Agent(room_id, agent_id) => {
                if method == "DELETE" {
                    self.remove_lease(room_id, agent_id);
                } else {
                    self.mark_room_subscribed(room_id);
                }
            }
            Route::Lease(room_id, _) => self.mark_room_subscribed(room_id),
            Route::MemberRemove(room_id, member_id) => {
                if self.current_user_matches_member(member_id) {
                    self.remove_room_subscription(room_id);
                } else {
                    self.mark_room_subscribed(room_id);
                }
            }
            Route::Rooms
            | Route::Join
            | Route::LocalSse
            | Route::InternalUpload
            | Route::InternalDownload
            | Route::InternalFinalize
            | Route::InternalLeaseRelease
            | Route::InternalRoomStatus(_)
            | Route::InternalAgentReadiness(_, _, _)
            | Route::InternalInvocation(_, _)
            | Route::InternalInvocationStatus(_, _)
            | Route::InternalExecutionBinding(_)
            | Route::InvocationMetadata(_, _)
            | Route::InternalManagementCapabilities
            | Route::InternalManagementOperation(_)
            | Route::InternalManagementStatus(_) => {}
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

    fn current_user_matches_member(&self, member_id: &str) -> bool {
        let Some(user) = self.auth.auth_state().user else {
            return false;
        };
        let Some(user) = user.as_object() else {
            return false;
        };
        ["id", "ID", "userId", "user_id"].iter().any(|key| {
            let Some(value) = user.get(*key) else {
                return false;
            };
            value.as_str() == Some(member_id)
                || value
                    .as_u64()
                    .is_some_and(|number| number.to_string() == member_id)
        })
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

    fn remove_room_subscription(&self, room_id: &str) {
        self.remove_room_subscription_state(room_id);
        self.refresh_subscription_snapshot();
    }

    fn remove_room_subscription_state(&self, room_id: &str) {
        self.rooms.lock().unwrap().remove(room_id);
        self.leases
            .lock()
            .unwrap()
            .retain(|(lease_room, _), _| lease_room != room_id);
    }

    pub fn shutdown_connection(&self) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        {
            let _auth_boundary = self.auth_boundary.lock().unwrap();
            self.auth_epoch.fetch_add(1, Ordering::AcqRel);
            self.client.pause();
            self.accepted_client_generation
                .store(NO_CLIENT_GENERATION, Ordering::Release);
            self.connection_paused.store(true, Ordering::Release);
            self.websocket_connected.store(false, Ordering::Release);
            self.leases.lock().unwrap().clear();
            self.rooms.lock().unwrap().clear();
            *self.last_subscription.lock().unwrap() = None;
            *self.advertised_capabilities.lock().unwrap() = (0, Vec::new());
            self.subscribers.lock().unwrap().clear();
        }
        let revoked = self.execution_registry.lock().unwrap().revoke_all();
        self.revoke_native_bindings(revoked);
        self.notify_disconnected();
    }

    pub fn resume_connection(&self) {
        self.websocket_connected.store(false, Ordering::Release);
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        let _auth_boundary = self.auth_boundary.lock().unwrap();
        self.client.resume();
        self.connection_paused.store(false, Ordering::Release);
    }

    pub fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        let revoked = self.execution_registry.lock().unwrap().revoke_all();
        self.revoke_native_bindings(revoked);
        self.leases.lock().unwrap().clear();
        *self.last_subscription.lock().unwrap() = None;
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
        if matches!(event, ChatroomEvent::AgentInvocation { .. }) {
            self.publish_event(event.clone());
            if let Err(task) = self.dispatch_task(GatewayTask::TestInvocation(event.clone())) {
                if matches!(task, GatewayTask::TestInvocation(_)) {
                    if self.task_sender.lock().unwrap().is_some() {
                        self.send_bridge_busy_failure(&event);
                    } else {
                        self.forward_invocation_for_test(&event);
                    }
                }
            }
        } else {
            self.publish_event(event);
        }
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
    pub(crate) fn has_lease_for_test(&self, room_id: &str, agent_id: &str) -> bool {
        self.leases
            .lock()
            .unwrap()
            .contains_key(&(room_id.to_string(), agent_id.to_string()))
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
    pub(crate) fn advance_auth_epoch_without_disconnect_for_test(&self) {
        self.auth_epoch.fetch_add(1, Ordering::AcqRel);
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
    pub(crate) fn observe_next_invocation_dispatch_for_test(
        &self,
    ) -> mpsc::Receiver<(u64, u64, u64)> {
        let (sender, receiver) = mpsc::channel();
        *self.invocation_dispatch_observer.lock().unwrap() = Some(sender);
        receiver
    }

    #[cfg(test)]
    pub(crate) fn gate_sse_registration_for_test(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.sse_registration_gate.lock().unwrap() = Some(SseRegistrationGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }

    #[cfg(test)]
    pub(crate) fn gate_sse_status_snapshot_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.sse_status_gate.lock().unwrap() = Some(SseRegistrationGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }

    #[cfg(test)]
    pub(crate) fn gate_client_event_acceptance_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.client_event_acceptance_gate.lock().unwrap() = Some(ClientEventAcceptanceGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }

    #[cfg(test)]
    pub(crate) fn set_legacy_status_wait_timeout_for_test(&self, timeout: Duration) {
        *self.legacy_status_wait_timeout.lock().unwrap() = timeout;
    }

    fn legacy_status_wait_timeout(&self) -> Duration {
        *self.legacy_status_wait_timeout.lock().unwrap()
    }

    #[cfg(test)]
    pub(crate) fn shutdown_requested_for_test(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn connection_paused_for_test(&self) -> bool {
        self.connection_paused.load(Ordering::Acquire)
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
    if path == format!("{CHATROOM_INTERNAL_PREFIX}/agents/leases/release") {
        return Ok(Route::InternalLeaseRelease);
    }
    if path.starts_with(&internal_prefix) {
        let parts: Vec<&str> = path[internal_prefix.len()..].split('/').collect();
        if parts.as_slice() == ["agent-management", "capabilities"] {
            return Ok(Route::InternalManagementCapabilities);
        }
        if parts.len() == 4
            && parts[0] == "rooms"
            && parts[2] == "agent-management"
            && parts[3] == "operations"
            && valid_component(parts[1])
        {
            normalize_room_id(parts[1]).map_err(|_| route_not_found())?;
            return Ok(Route::InternalManagementOperation(parts[1]));
        }
        if parts.len() == 5
            && parts[0] == "rooms"
            && parts[2] == "agent-management"
            && parts[3] == "operations"
            && parts[4] == "status"
            && valid_component(parts[1])
        {
            normalize_room_id(parts[1]).map_err(|_| route_not_found())?;
            return Ok(Route::InternalManagementStatus(parts[1]));
        }
        if parts.len() == 2 && parts[0] == "execution-bindings" {
            match parts[1] {
                "bind" => return Ok(Route::InternalExecutionBinding(true)),
                "release" => return Ok(Route::InternalExecutionBinding(false)),
                _ => {}
            }
        }
        if parts.len() == 3
            && parts[0] == "rooms"
            && parts[2] == "status"
            && valid_component(parts[1])
        {
            normalize_room_id(parts[1]).map_err(|_| route_not_found())?;
            return Ok(Route::InternalRoomStatus(parts[1]));
        }
        if parts.len() == 5
            && parts[0] == "rooms"
            && parts[2] == "agents"
            && valid_component(parts[1])
            && valid_component(parts[3])
        {
            match parts[4] {
                "ready" => return Ok(Route::InternalAgentReadiness(parts[1], parts[3], true)),
                "unready" => return Ok(Route::InternalAgentReadiness(parts[1], parts[3], false)),
                _ => {}
            }
        }
        if parts.len() == 5
            && parts[0] == "rooms"
            && parts[2] == "invocations"
            && parts[4] == "status"
            && valid_component(parts[1])
            && valid_component(parts[3])
        {
            normalize_room_id(parts[1]).map_err(|_| route_not_found())?;
            return Ok(Route::InternalInvocationStatus(parts[1], parts[3]));
        }
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
        [_, _, "invocations", "terminal"] => Route::TerminalInvocations(room_id),
        [_, _, "invocations", invocation_id, "metadata"]
            if valid_invocation_id(invocation_id, 64) =>
        {
            Route::InvocationMetadata(room_id, invocation_id)
        }
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

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn percent_encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn parse_invocation_status_data(body: &[u8]) -> Result<Map<String, Value>, ()> {
    let value: Value = serde_json::from_slice(body).map_err(|_| ())?;
    let envelope = value.as_object().ok_or(())?;
    if envelope.len() != 1 {
        return Err(());
    }
    let data = envelope.get("data").and_then(Value::as_object).ok_or(())?;
    let allowed = [
        "invocationId",
        "roomId",
        "traceId",
        "targetAgentId",
        "triggerMessageId",
        "depth",
        "status",
        "failureCode",
        "finishedAt",
        "replyMessageId",
        "replyClientMessageId",
        "replyDigest",
    ];
    if data.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(());
    }
    for key in [
        "invocationId",
        "roomId",
        "traceId",
        "targetAgentId",
        "triggerMessageId",
        "status",
    ] {
        if data
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(());
        }
    }
    if data.get("depth").and_then(Value::as_u64).is_none() {
        return Err(());
    }
    for key in [
        "failureCode",
        "finishedAt",
        "replyMessageId",
        "replyClientMessageId",
        "replyDigest",
    ] {
        if data.get(key).is_some_and(|value| value.as_str().is_none()) {
            return Err(());
        }
    }
    Ok(data.clone())
}

fn invocation_status_matches(data: &Map<String, Value>, expected: &Map<String, Value>) -> bool {
    [
        "roomId",
        "invocationId",
        "traceId",
        "targetAgentId",
        "triggerMessageId",
        "depth",
    ]
    .iter()
    .all(|key| data.get(*key) == expected.get(*key))
}

fn invocation_status_outcome(
    outcome: &str,
    room_id: &str,
    invocation_id: &str,
    expected: &Map<String, Value>,
    generation: u64,
    proof: Option<Map<String, Value>>,
) -> GatewayHttpResponse {
    let mut body = serde_json::json!({
        "outcome": outcome,
        "roomId": room_id,
        "invocationId": invocation_id,
        "traceId": expected.get("traceId"),
        "generation": generation,
    });
    if let Some(proof) = proof {
        body["status"] = proof.get("status").cloned().unwrap_or(Value::Null);
        for key in [
            "failureCode",
            "finishedAt",
            "replyMessageId",
            "replyClientMessageId",
            "replyDigest",
        ] {
            if let Some(value) = proof.get(key) {
                body[key] = value.clone();
            }
        }
    }
    GatewayHttpResponse::Json { status: 200, body }
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
            | ("GET", Route::TerminalInvocations(_))
            | ("GET", Route::InvocationMetadata(_, _))
            | ("POST", Route::Messages(_))
            | ("POST", Route::Agents(_))
            | ("PATCH", Route::Agent(_, _))
            | ("DELETE", Route::Agent(_, _))
            | ("POST", Route::Lease(_, _))
            | ("POST", Route::Join)
            | ("POST", Route::InternalUpload)
            | ("POST", Route::InternalDownload)
            | ("POST", Route::InternalFinalize)
            | ("POST", Route::InternalLeaseRelease)
            | ("GET", Route::InternalRoomStatus(_))
            | ("POST", Route::InternalAgentReadiness(_, _, _))
            | ("POST", Route::InternalInvocation(_, _))
            | ("POST", Route::InternalInvocationStatus(_, _))
            | ("POST", Route::InternalExecutionBinding(_))
            | ("GET", Route::InternalManagementCapabilities)
            | ("POST", Route::InternalManagementOperation(_))
            | ("POST", Route::InternalManagementStatus(_))
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
        Route::TerminalInvocations(_) => &["after", "limit"],
        _ => &[],
    };
    let mut values: HashMap<&str, String> = HashMap::new();
    for pair in query.split('&') {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| invalid_request("查询参数不正确"))?;
        if !allowed.contains(&key) || value.is_empty() || values.contains_key(key) {
            return Err(invalid_request("查询参数不正确"));
        }
        if key == "after" {
            if !valid_component(value) {
                return Err(invalid_request("查询参数不正确"));
            }
            values.insert(key, value.to_string());
        } else {
            let parsed = value
                .parse::<u64>()
                .map_err(|_| invalid_request("查询参数不正确"))?;
            let limit = if matches!(route, Route::TerminalInvocations(_)) {
                100
            } else {
                500
            };
            if key == "limit" && !(1..=limit).contains(&parsed) {
                return Err(invalid_request("查询参数不正确"));
            }
            if key != "limit" && parsed > i64::MAX as u64 {
                return Err(invalid_request("查询参数不正确"));
            }
            values.insert(key, parsed.to_string());
        }
    }
    let order = match route {
        Route::Messages(_) => ["beforeSeq", "limit"],
        Route::Events(_) => ["afterSeq", "limit"],
        Route::TerminalInvocations(_) => ["after", "limit"],
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
            let name = required_component_text(object, "name")?;
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
                    Value::String(required_component_text(object, "name")?.into()),
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
            let display_name = required_chatroom_display_name(object, "displayName")?;
            let device_id = required_component_text(object, "deviceId")?;
            let mut result = serde_json::json!({"displayName":display_name,"deviceId":device_id});
            if object.contains_key("avatar") {
                result["avatar"] = Value::String(required_component_text(object, "avatar")?.into());
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
                    let value = if key == "displayName" {
                        required_chatroom_display_name(object, key)?
                    } else {
                        required_component_text(object, key)?.to_owned()
                    };
                    result.insert(key.into(), Value::String(value.into()));
                }
            }
            Value::Object(result)
        }
        ("POST", Route::Lease(_, _)) => {
            require_keys(object, &["deviceId"])?;
            serde_json::json!({"deviceId":required_component_text(object,"deviceId")?})
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

fn required_component_text<'a>(
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
    let value = required_component_text(object, key)?;
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
    if attachments.len() > 20 {
        return Err(invalid_request("附件数量超限"));
    }
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

fn validate_forward_invocation_payload(object: &Map<String, Value>) -> Result<(), ()> {
    let required = [
        "invocationId",
        "traceId",
        "targetAgentId",
        "triggerMessageId",
        "depth",
        "sender",
        "messages",
        "receivedAt",
    ];
    if object.keys().any(|key| !required.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(());
    }
    for (key, max) in [
        ("invocationId", 64usize),
        ("targetAgentId", 64),
        ("triggerMessageId", 64),
    ] {
        if !object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| valid_invocation_id(value, max))
        {
            return Err(());
        }
    }
    if !object
        .get("traceId")
        .and_then(Value::as_str)
        .is_some_and(|value| valid_invocation_id(value, 128))
    {
        return Err(());
    }
    let Some(depth) = object.get("depth").and_then(Value::as_u64) else {
        return Err(());
    };
    if depth > 3 {
        return Err(());
    }
    let Some(sender) = object.get("sender").and_then(Value::as_object) else {
        return Err(());
    };
    if sender
        .keys()
        .any(|key| !["type", "id", "displayName"].contains(&key.as_str()))
        || ["type", "id", "displayName"]
            .iter()
            .any(|key| !sender.contains_key(*key))
        || !sender
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "user" || value == "agent")
        || !sender
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|value| valid_invocation_id(value, 64))
        || !sender
            .get("displayName")
            .and_then(Value::as_str)
            .is_some_and(valid_invocation_display_name)
    {
        return Err(());
    }
    let Some(messages) = object.get("messages").and_then(Value::as_array) else {
        return Err(());
    };
    if messages.is_empty() || messages.len() > 200 {
        return Err(());
    }
    for message in messages {
        let Some(message) = message.as_object() else {
            return Err(());
        };
        if message.keys().any(|key| {
            ![
                "messageId",
                "sender",
                "text",
                "createdAt",
                "attachmentIds",
                "mentionedAgentIds",
                "invocationChain",
            ]
            .contains(&key.as_str())
        }) || ["messageId", "sender", "text", "createdAt"]
            .iter()
            .any(|key| !message.contains_key(*key))
        {
            return Err(());
        }
        if !message
            .get("messageId")
            .and_then(Value::as_str)
            .is_some_and(|value| valid_invocation_id(value, 64))
            || !message
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(valid_text)
            || !message
                .get("createdAt")
                .and_then(Value::as_u64)
                .is_some_and(|value| value <= MAX_SAFE_INTEGER)
        {
            return Err(());
        }
        let Some(message_sender) = message.get("sender").and_then(Value::as_object) else {
            return Err(());
        };
        if message_sender
            .keys()
            .any(|key| !["type", "id", "displayName"].contains(&key.as_str()))
            || ["type", "id", "displayName"]
                .iter()
                .any(|key| !message_sender.contains_key(*key))
            || !message_sender
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "user" || value == "agent")
            || !message_sender
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_invocation_id(value, 64))
            || !message_sender
                .get("displayName")
                .and_then(Value::as_str)
                .is_some_and(valid_invocation_display_name)
        {
            return Err(());
        }
        for (key, max) in [("attachmentIds", 20usize), ("mentionedAgentIds", 3)] {
            if let Some(value) = message.get(key) {
                let Some(items) = value.as_array() else {
                    return Err(());
                };
                if items.len() > max
                    || items.iter().any(|item| {
                        item.as_str()
                            .is_none_or(|value| !valid_invocation_id(value, 64))
                    })
                {
                    return Err(());
                }
            }
        }
        if let Some(value) = message.get("invocationChain") {
            let Some(entries) = value.as_array() else {
                return Err(());
            };
            if entries.len() > 3 {
                return Err(());
            }
            for entry in entries {
                let Some(entry) = entry.as_object() else {
                    return Err(());
                };
                if entry
                    .keys()
                    .any(|key| !["agentId", "invocationId"].contains(&key.as_str()))
                    || ["agentId", "invocationId"]
                        .iter()
                        .any(|key| !entry.contains_key(*key))
                    || !entry
                        .get("agentId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| valid_invocation_id(value, 64))
                    || !entry
                        .get("invocationId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| valid_invocation_id(value, 64))
                {
                    return Err(());
                }
            }
        }
    }
    let Some(last_message) = messages.last().and_then(Value::as_object) else {
        return Err(());
    };
    if last_message.get("messageId") != object.get("triggerMessageId")
        || last_message.get("sender") != object.get("sender")
    {
        return Err(());
    }
    if !object
        .get("receivedAt")
        .and_then(Value::as_u64)
        .is_some_and(|value| value <= MAX_SAFE_INTEGER)
    {
        return Err(());
    }
    Ok(())
}

fn canonicalize_forward_invocation_payload(object: &mut Map<String, Value>) -> Result<(), ()> {
    let sender = object
        .get_mut("sender")
        .and_then(Value::as_object_mut)
        .ok_or(())?;
    canonicalize_forward_sender_display_name(sender)?;

    let messages = object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or(())?;
    for message in messages {
        let sender = message
            .as_object_mut()
            .and_then(|value| value.get_mut("sender"))
            .and_then(Value::as_object_mut)
            .ok_or(())?;
        canonicalize_forward_sender_display_name(sender)?;
    }
    Ok(())
}

fn canonicalize_forward_sender_display_name(sender: &mut Map<String, Value>) -> Result<(), ()> {
    let display_name = sender
        .get("displayName")
        .and_then(Value::as_str)
        .and_then(canonicalize_invocation_display_name)
        .ok_or(())?;
    sender.insert("displayName".into(), Value::String(display_name));
    Ok(())
}

fn valid_invocation_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= max_bytes
        && !sensitive_scalar(value)
        && !value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '/' | '?' | '#' | '\\')
        })
}

pub(crate) fn canonicalize_invocation_display_name(value: &str) -> Option<String> {
    if value.chars().any(|character| character.is_control()) {
        return None;
    }
    let canonical = value
        .trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
        .to_owned();
    if canonical.is_empty() || canonical.len() > 128 {
        return None;
    }
    Some(canonical)
}

pub(crate) fn valid_invocation_display_name(value: &str) -> bool {
    canonicalize_invocation_display_name(value).is_some()
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

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ChatroomGatewayError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_text(value))
        .ok_or_else(|| invalid_request("内部请求文本字段不正确"))
}

fn required_chatroom_display_name(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, ChatroomGatewayError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .and_then(canonicalize_invocation_display_name)
        .ok_or_else(|| invalid_request("聊天室 Agent 名称不正确"))
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_TEXT_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
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

fn validate_invocation_metadata_response(
    body: &[u8],
    expected_room_id: &str,
    expected_invocation_id: &str,
) -> Result<Value, ChatroomGatewayError> {
    let invalid =
        || ChatroomGatewayError::new(502, "invalid_upstream_response", "上游调用元数据格式不正确");
    let value = parse_strict_json(body).map_err(|_| invalid())?;
    let envelope = value.as_object().ok_or_else(invalid)?;
    if envelope.len() != 1 || !envelope.contains_key("data") {
        return Err(invalid());
    }
    let data = envelope["data"].as_object().ok_or_else(invalid)?;
    if data.len() != 1 || !data.contains_key("invocation") {
        return Err(invalid());
    }
    let invocation = data["invocation"].as_object().ok_or_else(invalid)?;
    let required = [
        "invocationId",
        "roomId",
        "traceId",
        "targetAgentId",
        "triggerMessageId",
        "depth",
        "status",
    ];
    let optional = ["failureCode", "finishedAt"];
    if required.iter().any(|key| !invocation.contains_key(*key))
        || invocation
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    let string_field = |key: &str, max: usize| {
        invocation
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| valid_invocation_id(value, max))
    };
    if string_field("invocationId", 64) != Some(expected_invocation_id)
        || string_field("roomId", 64) != Some(expected_room_id)
        || string_field("traceId", 128).is_none()
        || string_field("targetAgentId", 64).is_none()
        || string_field("triggerMessageId", 64).is_none()
        || invocation
            .get("depth")
            .and_then(Value::as_u64)
            .is_none_or(|depth| depth > MAX_SAFE_INTEGER)
        || !matches!(
            invocation.get("status").and_then(Value::as_str),
            Some("created" | "accepted" | "running" | "completed" | "failed" | "rejected")
        )
    {
        return Err(invalid());
    }
    if let Some(failure_code) = invocation.get("failureCode") {
        if !failure_code
            .as_str()
            .is_some_and(|value| valid_machine_code(value, 64))
        {
            return Err(invalid());
        }
    }
    if let Some(finished_at) = invocation.get("finishedAt") {
        if !finished_at.as_str().is_some_and(|value| {
            value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
        }) {
            return Err(invalid());
        }
    }
    Ok(value)
}

fn valid_machine_code(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
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

fn management_invalid_request(message: impl Into<String>) -> ChatroomGatewayError {
    ChatroomGatewayError::new(400, "invalid_request", message)
}

fn invalid_management_response(message: impl Into<String>) -> ChatroomGatewayError {
    ChatroomGatewayError::new(502, "invalid_management_receipt", message)
}

fn management_transport_error(message: String) -> ChatroomGatewayError {
    ChatroomGatewayError::new(502, "upstream_unavailable", message)
}

fn parse_management_body(body: &[u8]) -> Result<Value, ChatroomGatewayError> {
    if body.is_empty() {
        return Err(management_invalid_request("管理请求体不能为空"));
    }
    if body.len() > MAX_MANAGEMENT_BODY_BYTES {
        return Err(management_invalid_request("管理请求体超过 64 KiB 限制"));
    }
    parse_strict_json(body).map_err(|_| management_invalid_request("管理请求体不是有效 JSON"))
}

fn parse_management_response(body: &[u8]) -> Result<Value, ChatroomGatewayError> {
    parse_strict_json(body).map_err(|_| invalid_management_response("上游管理响应不是有效 JSON"))
}

fn management_error_response(response: GatewayTransportResponse) -> GatewayHttpResponse {
    let body = parse_strict_json(&response.body)
        .ok()
        .and_then(crate::chatroom_management::management_error_envelope)
        .unwrap_or_else(|| {
            serde_json::json!({
                "error": {
                    "code": "invalid_upstream_error",
                    "message": "上游管理接口返回无法解析的错误响应"
                }
            })
        });
    GatewayHttpResponse::Json {
        status: response.status,
        body,
    }
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

#[cfg(test)]
mod legacy_lifecycle_tests {
    use super::*;

    fn accepted_command() -> ChatroomCommand {
        ChatroomCommand::AgentAccepted {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        }
    }

    fn accepted_event() -> ChatroomEvent {
        ChatroomEvent::AgentAccepted {
            room_id: "room-1".into(),
            payload: serde_json::json!({"invocationId":"inv-1"}),
        }
    }

    #[test]
    fn given_reused_request_id_when_old_generation_cancels_then_new_waiter_remains_bound() {
        let waiters = LegacyLifecycleWaiters::default();
        let accepted = Mutex::new(HashSet::new());
        let _old = waiters.register(1, "same", accepted_command()).unwrap();
        waiters.invalidate_all();
        let new = waiters.register(2, "same", accepted_command()).unwrap();
        waiters.cancel(1, "same");
        assert!(observe_legacy_lifecycle(&waiters, &accepted, 1, &accepted_event()).is_none());
        assert!(observe_legacy_lifecycle(&waiters, &accepted, 2, &accepted_event()).is_some());
        assert_eq!(new.recv_timeout(Duration::from_millis(10)), Ok(Ok(None)));
        assert!(accepted
            .lock()
            .unwrap()
            .contains(&(2, "room-1".into(), "inv-1".into())));
    }

    #[test]
    fn given_legacy_accepted_evidence_when_capacity_is_exceeded_then_fail_closed_without_growth() {
        let mut accepted = HashSet::new();
        for index in 0..MAX_LEGACY_LIFECYCLE_WAITERS {
            assert!(remember_legacy_accepted(
                &mut accepted,
                7,
                "room-1",
                &format!("inv-{index}")
            ));
        }
        assert!(!remember_legacy_accepted(
            &mut accepted,
            7,
            "room-1",
            "inv-overflow"
        ));
        assert_eq!(accepted.len(), MAX_LEGACY_LIFECYCLE_WAITERS);
        assert!(accepted.contains(&(7, "room-1".into(), "inv-0".into())));
    }

    #[test]
    fn given_full_legacy_accepted_cache_when_new_event_arrives_then_waiter_is_not_confirmed() {
        let waiters = LegacyLifecycleWaiters::default();
        let accepted = Mutex::new(
            (0..MAX_LEGACY_LIFECYCLE_WAITERS)
                .map(|index| (9, "room-1".into(), format!("existing-{index}")))
                .collect(),
        );
        let receiver = waiters.register(9, "new", accepted_command()).unwrap();

        assert!(observe_legacy_lifecycle(&waiters, &accepted, 9, &accepted_event()).is_none());
        assert_eq!(accepted.lock().unwrap().len(), MAX_LEGACY_LIFECYCLE_WAITERS);
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(10)),
            Ok(Err(AckError::Full))
        );
    }

    #[test]
    fn given_status_waiter_on_socket_b_when_socket_a_delivers_same_invocation_then_do_not_confirm()
    {
        let waiters = LegacyLifecycleWaiters::default();
        let accepted = Mutex::new(HashSet::new());
        let digest = reply_digest(&ChatroomReplyDigestInput {
            client_message_id: "reply-1",
            content: "done",
            mention_agent_ids: &[],
            attachment_ids: &[],
        });
        let receiver = waiters
            .register_status(
                2,
                "status-b",
                "room-1",
                "inv-1",
                "completed",
                "reply-1",
                &digest,
                "",
            )
            .unwrap();
        let event = ChatroomEvent::AgentCompleted {
            room_id: "room-1".into(),
            payload: serde_json::json!({
                "invocationId":"inv-1",
                "content":"done",
                "mentionAgentIds":[],
                "attachmentIds":[],
                "clientMessageId":"reply-1"
            }),
        };

        observe_legacy_lifecycle(&waiters, &accepted, 1, &event);
        assert!(matches!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        observe_legacy_lifecycle(&waiters, &accepted, 2, &event);
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(10)),
            Ok(Ok(Some(LegacyTerminalProof::Completed {
                reply_client_message_id: "reply-1".into(),
                reply_digest: digest,
            })))
        );
    }

    #[test]
    fn given_legacy_terminal_event_when_result_identity_or_failure_code_differs_then_reject() {
        let completed = ChatroomCommand::AgentEvent {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            event: AgentEventPayload::Completed {
                content: "done".into(),
                mention_agent_ids: vec!["agent-1".into()],
                attachment_ids: vec![],
                client_message_id: "reply-1".into(),
            },
        };
        assert!(matches!(
            lifecycle_event_match(
                &LegacyLifecycleExpectation::Command(completed.clone()),
                &ChatroomEvent::AgentCompleted {
                    room_id: "room-1".into(),
                    payload: serde_json::json!({"invocationId":"inv-1","content":"done","mentionAgentIds":["agent-1"],"attachmentIds":[],"clientMessageId":"reply-1"}),
                }
            ),
            Some(Ok(Some(LegacyTerminalProof::Completed {
                reply_client_message_id,
                reply_digest,
            }))) if reply_client_message_id == "reply-1" && reply_digest.len() == 64
        ));
        assert!(matches!(
            lifecycle_event_match(
                &LegacyLifecycleExpectation::Command(completed),
                &ChatroomEvent::AgentCompleted {
                    room_id: "room-1".into(),
                    payload: serde_json::json!({"invocationId":"inv-1","content":"different","mentionAgentIds":["agent-1"],"attachmentIds":[],"clientMessageId":"reply-1"}),
                }
            ),
            Some(Err(AckError::Rejected(code))) if code == "result_mismatch"
        ));

        let failed = ChatroomCommand::AgentEvent {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            event: AgentEventPayload::Failed {
                code: "agent_offline".into(),
                message: "offline".into(),
            },
        };
        assert!(matches!(
            lifecycle_event_match(
                &LegacyLifecycleExpectation::Command(failed.clone()),
                &ChatroomEvent::AgentFailed {
                    room_id: "room-1".into(),
                    payload: serde_json::json!({"invocationId":"inv-1","failureCode":"different"}),
                }
            ),
            Some(Err(AckError::Rejected(code))) if code == "result_mismatch"
        ));
        let invalid_failure = ChatroomCommand::AgentEvent {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            event: AgentEventPayload::Failed {
                code: "unknown_failure".into(),
                message: "offline".into(),
            },
        };
        assert!(matches!(
            lifecycle_event_match(
                &LegacyLifecycleExpectation::Command(invalid_failure),
                &ChatroomEvent::AgentFailed {
                    room_id: "room-1".into(),
                    payload: serde_json::json!({"invocationId":"inv-1","failureCode":"unknown_failure"}),
                }
            ),
            Some(Err(AckError::Rejected(code))) if code == "result_mismatch"
        ));
    }
}
