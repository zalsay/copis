use serde::de::Error as _;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;

pub const CHATROOM_WS_PATH: &str = "/api/chatrooms/v2/ws";
pub const CHATROOM_HTTP_PREFIX: &str = "/api/chatrooms/v2";
pub const CHATROOM_INTERNAL_PREFIX: &str = "/api/internal/chatrooms";
pub const CHATROOM_SSE_PATH: &str = "/api/chatrooms/v2/events";
const MAX_FRAME_BYTES: usize = 128 * 1024;
// 帧预算覆盖完整 JSON envelope；业务正文仍由字段级预算单独限制。
const MAX_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_ROOMS: usize = 50;
const MAX_ID_BYTES: usize = 64;
const MAX_DEVICE_BYTES: usize = 128;
const MAX_CLIENT_MESSAGE_ID_BYTES: usize = 128;
const MAX_ATTACHMENT_IDS: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomCursor {
    pub room_id: String,
    pub after_seq: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatroomCommand {
    Subscribe {
        rooms: Vec<RoomCursor>,
        device_id: String,
    },
    Unsubscribe {
        room_id: String,
    },
    SendMessage {
        room_id: String,
        client_message_id: String,
        content: String,
        mention_agent_ids: Vec<String>,
        attachment_ids: Vec<String>,
    },
    AgentAccepted {
        room_id: String,
        invocation_id: String,
        agent_id: String,
        device_id: String,
    },
    AgentEvent {
        room_id: String,
        invocation_id: String,
        event: AgentEventPayload,
    },
    RenewLease {
        room_id: String,
        agent_id: String,
        device_id: String,
    },
    CursorAck {
        room_id: String,
        seq: u64,
    },
    Close,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentEventPayload {
    Delta {
        text: String,
    },
    Completed {
        content: String,
        mention_agent_ids: Vec<String>,
        attachment_ids: Vec<String>,
        client_message_id: String,
    },
    Failed {
        code: String,
        message: String,
    },
}

impl Serialize for ChatroomCommand {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::Error;
        self.validate_wire_fields().map_err(S::Error::custom)?;
        let value = match self {
            Self::Subscribe { rooms, device_id } => {
                let mut after = Map::new();
                let mut ids = Vec::with_capacity(rooms.len());
                for room in rooms {
                    ids.push(Value::String(room.room_id.clone()));
                    after.insert(room.room_id.clone(), Value::from(room.after_seq));
                }
                serde_json::json!({"type":"subscribe","payload":{"roomIds":ids,"afterSeq":after,"deviceId":device_id}})
            }
            Self::SendMessage {
                room_id,
                client_message_id,
                content,
                mention_agent_ids,
                attachment_ids,
            } => serde_json::json!({
                "type":"message.create", "roomId":room_id, "payload": {"content":content,"mentionAgentIds":mention_agent_ids,"attachmentIds":attachment_ids,"clientMessageId":client_message_id}
            }),
            Self::AgentAccepted {
                room_id,
                invocation_id,
                ..
            } => serde_json::json!({
                "type":"agent.accepted", "roomId":room_id, "payload":{"invocationId":invocation_id}
            }),
            Self::AgentEvent {
                room_id,
                invocation_id,
                event,
            } => {
                let (typ, payload) = match event {
                    AgentEventPayload::Delta { text } => (
                        "agent.delta",
                        serde_json::json!({"invocationId":invocation_id,"delta":text}),
                    ),
                    AgentEventPayload::Completed {
                        content,
                        mention_agent_ids,
                        attachment_ids,
                        client_message_id,
                    } => (
                        "agent.completed",
                        serde_json::json!({"invocationId":invocation_id,"content":content,"mentionAgentIds":mention_agent_ids,"attachmentIds":attachment_ids,"clientMessageId":client_message_id}),
                    ),
                    AgentEventPayload::Failed { code, .. } => (
                        "agent.failed",
                        serde_json::json!({"invocationId":invocation_id,"failureCode":code}),
                    ),
                };
                serde_json::json!({"type":typ,"roomId":room_id,"payload":payload})
            }
            Self::RenewLease {
                room_id, agent_id, ..
            } => serde_json::json!({
                "type":"agent.heartbeat", "roomId":room_id, "payload":{"roomAgentId":agent_id}
            }),
            Self::CursorAck { room_id, seq } => serde_json::json!({
                "type":"cursor.ack", "roomId":room_id, "payload":{"seq":seq}
            }),
            Self::Unsubscribe { .. } | Self::Close => {
                return Err(S::Error::custom(
                    "local chatroom control is not an upstream frame",
                ))
            }
        };
        value.serialize(serializer)
    }
}

impl ChatroomCommand {
    pub(crate) fn validate_wire_fields(&self) -> Result<(), &'static str> {
        let valid_room = |value: &str| normalize_room_id(value).is_ok();
        match self {
            Self::Subscribe { rooms, device_id } => {
                if rooms.is_empty() || rooms.len() > MAX_ROOMS || !valid_device(device_id) {
                    return Err("subscribe requires rooms and device_id");
                }
                if rooms
                    .iter()
                    .any(|room| !valid_room(&room.room_id) || room.after_seq > i64::MAX as u64)
                {
                    return Err("subscribe contains invalid room id");
                }
            }
            Self::Unsubscribe { room_id } => {
                if !valid_room(room_id) {
                    return Err("command contains invalid room id");
                }
            }
            Self::SendMessage {
                room_id,
                client_message_id,
                content,
                mention_agent_ids,
                attachment_ids,
            } => {
                if !valid_room(room_id) {
                    return Err("command contains invalid room id");
                }
                if !valid_id(client_message_id, MAX_CLIENT_MESSAGE_ID_BYTES)
                    || !valid_content(content, MAX_TEXT_BYTES)
                    || !valid_mentions(mention_agent_ids)
                    || attachment_ids.len() > MAX_ATTACHMENT_IDS
                    || attachment_ids
                        .iter()
                        .any(|attachment_id| !valid_id(attachment_id, MAX_ID_BYTES))
                {
                    return Err("message requires client_message_id");
                }
            }
            Self::AgentAccepted {
                room_id,
                invocation_id,
                agent_id,
                device_id,
            } => {
                if !valid_room(room_id) {
                    return Err("command contains invalid room id");
                }
                if !valid_id(invocation_id, MAX_ID_BYTES)
                    || !valid_id(agent_id, MAX_ID_BYTES)
                    || !valid_device(device_id)
                {
                    return Err("accepted event requires invocation_id");
                }
            }
            Self::AgentEvent {
                room_id,
                invocation_id,
                event,
            } => {
                if !valid_room(room_id) {
                    return Err("command contains invalid room id");
                }
                if !valid_id(invocation_id, MAX_ID_BYTES) {
                    return Err("agent event requires invocation_id");
                }
                match event {
                    AgentEventPayload::Delta { text } => {
                        if !valid_content(text, MAX_TEXT_BYTES) {
                            return Err("delta exceeds payload limit");
                        }
                    }
                    AgentEventPayload::Completed {
                        content,
                        mention_agent_ids,
                        attachment_ids,
                        client_message_id,
                    } => {
                        if !valid_content(content, MAX_TEXT_BYTES)
                            || !valid_id(client_message_id, MAX_CLIENT_MESSAGE_ID_BYTES)
                            || !valid_mentions(mention_agent_ids)
                            || attachment_ids.len() > MAX_ATTACHMENT_IDS
                            || attachment_ids
                                .iter()
                                .any(|attachment_id| !valid_id(attachment_id, MAX_ID_BYTES))
                        {
                            return Err("completed event contains invalid fields");
                        }
                    }
                    AgentEventPayload::Failed { code, message } => {
                        if !valid_id(code, MAX_ID_BYTES) || !valid_content(message, MAX_TEXT_BYTES)
                        {
                            return Err("failed event contains invalid failure code");
                        }
                    }
                }
            }
            Self::RenewLease {
                room_id,
                agent_id,
                device_id,
            } => {
                if !valid_room(room_id)
                    || !valid_id(agent_id, MAX_ID_BYTES)
                    || !valid_device(device_id)
                {
                    return Err("command contains invalid room id");
                }
            }
            Self::CursorAck { room_id, seq } => {
                if !valid_room(room_id) || *seq == 0 || *seq > i64::MAX as u64 {
                    return Err("command contains invalid room id");
                }
            }
            Self::Close => {}
        }
        Ok(())
    }
}

fn valid_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= max_bytes
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        && !value
            .chars()
            .any(|character| matches!(character, '/' | '?' | '#' | '\\'))
}

fn valid_device(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= MAX_DEVICE_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

fn valid_content(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max_bytes
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_mentions(values: &[String]) -> bool {
    values.len() <= 3 && values.iter().all(|value| valid_id(value, MAX_ID_BYTES))
}

fn validate_event_payload_fields(payload: &Value) -> Result<(), ProtocolError> {
    let Some(object) = payload.as_object() else {
        return Ok(());
    };

    for field in ["content", "delta", "message"] {
        if let Some(value) = object.get(field) {
            let text = value
                .as_str()
                .ok_or_else(|| invalid("event text field must be a string"))?;
            if !valid_content(text, MAX_TEXT_BYTES) {
                return Err(ProtocolError::new(
                    "payload_too_large",
                    "chatroom event text field exceeds 64 KiB",
                ));
            }
        }
    }

    for (field, max_bytes) in [
        ("invocationId", MAX_ID_BYTES),
        ("failureCode", MAX_ID_BYTES),
        ("code", MAX_ID_BYTES),
        ("clientMessageId", MAX_CLIENT_MESSAGE_ID_BYTES),
    ] {
        if let Some(value) = object.get(field) {
            let id = value
                .as_str()
                .ok_or_else(|| invalid("event id field must be a string"))?;
            if !valid_id(id, max_bytes) {
                return Err(invalid("event id field is invalid"));
            }
        }
    }

    for (field, max_count) in [
        ("mentionAgentIds", 3usize),
        ("attachmentIds", MAX_ATTACHMENT_IDS),
    ] {
        if let Some(value) = object.get(field) {
            let ids = value
                .as_array()
                .ok_or_else(|| invalid("event id list must be an array"))?;
            if ids.len() > max_count
                || ids.iter().any(|value| {
                    value
                        .as_str()
                        .map(|id| !valid_id(id, MAX_ID_BYTES))
                        .unwrap_or(true)
                })
            {
                return Err(invalid("event id list is invalid"));
            }
        }
    }

    Ok(())
}

fn validate_transient_agent_payload(typ: &str, payload: &Value) -> Result<(), ProtocolError> {
    let object = payload
        .as_object()
        .ok_or_else(|| invalid("agent transient payload must be an object"))?;
    let (required, allowed): (&[&str], &[&str]) = match typ {
        "agent.accepted" => (&["invocationId"], &["invocationId"]),
        "agent.delta" => (&["invocationId", "delta"], &["invocationId", "delta"]),
        "agent.completed" => (
            &[
                "invocationId",
                "content",
                "mentionAgentIds",
                "attachmentIds",
                "clientMessageId",
            ],
            &[
                "invocationId",
                "content",
                "mentionAgentIds",
                "attachmentIds",
                "clientMessageId",
            ],
        ),
        "agent.failed" => (
            &["invocationId", "failureCode"],
            &["invocationId", "failureCode"],
        ),
        _ => return Ok(()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(invalid("agent transient payload schema is invalid"));
    }
    let invocation_id = object
        .get("invocationId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value, MAX_ID_BYTES))
        .ok_or_else(|| invalid("agent transient invocationId is invalid"))?;
    let _ = invocation_id;
    match typ {
        "agent.accepted" => {}
        "agent.delta" => {
            let delta = object
                .get("delta")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("agent delta must be a string"))?;
            if !valid_content(delta, MAX_TEXT_BYTES) {
                return Err(ProtocolError::new(
                    "payload_too_large",
                    "agent delta exceeds 64 KiB",
                ));
            }
        }
        "agent.completed" => {
            let content = object
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("agent completed content must be a string"))?;
            if !valid_content(content, MAX_TEXT_BYTES) {
                return Err(ProtocolError::new(
                    "payload_too_large",
                    "agent completed content exceeds 64 KiB",
                ));
            }
            let mentions = object
                .get("mentionAgentIds")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("agent completed mentions must be an array"))?;
            if mentions.len() > 3
                || mentions.iter().any(|value| {
                    value
                        .as_str()
                        .map(|id| !valid_id(id, MAX_ID_BYTES))
                        .unwrap_or(true)
                })
            {
                return Err(invalid("agent completed mentions are invalid"));
            }
            let attachments = object
                .get("attachmentIds")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("agent completed attachments must be an array"))?;
            if attachments.len() > MAX_ATTACHMENT_IDS
                || attachments.iter().any(|value| {
                    value
                        .as_str()
                        .map(|id| !valid_id(id, MAX_ID_BYTES))
                        .unwrap_or(true)
                })
            {
                return Err(invalid("agent completed attachments are invalid"));
            }
            let client_message_id = object
                .get("clientMessageId")
                .and_then(Value::as_str)
                .filter(|value| valid_id(value, MAX_CLIENT_MESSAGE_ID_BYTES))
                .ok_or_else(|| invalid("agent completed clientMessageId is invalid"))?;
            let _ = client_message_id;
        }
        "agent.failed" => {
            let code = object
                .get("failureCode")
                .and_then(Value::as_str)
                .filter(|value| valid_id(value, MAX_ID_BYTES))
                .ok_or_else(|| invalid("agent failureCode is invalid"))?;
            let _ = code;
        }
        _ => unreachable!(),
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

impl ProtocolError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatroomEvent {
    RoomSnapshot {
        room_id: String,
        latest_seq: u64,
        payload: Value,
    },
    MessageCreated {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    RoomUpdated {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    MemberRemoved {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    AgentUpdated {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    AttachmentUpdated {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    AgentOffline {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    AgentBusy {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    AgentDisabled {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    InvocationLimitReached {
        room_id: String,
        seq: u64,
        payload: Value,
    },
    MemberPresenceChanged {
        room_id: String,
        payload: Value,
    },
    AgentPresenceChanged {
        room_id: String,
        payload: Value,
    },
    AgentInvocation {
        room_id: String,
        payload: Value,
    },
    AgentAccepted {
        room_id: String,
        payload: Value,
    },
    AgentDelta {
        room_id: String,
        payload: Value,
    },
    AgentCompleted {
        room_id: String,
        payload: Value,
    },
    AgentFailed {
        room_id: String,
        payload: Value,
    },
    RoomRecoveryReady {
        room_id: String,
    },
    LocalStatus {
        room_id: Option<String>,
        code: String,
        message: String,
    },
}

impl Serialize for ChatroomEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        public_event(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChatroomEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let bytes = serde_json::to_vec(&value).map_err(D::Error::custom)?;
        parse_event(&bytes).map_err(|error| D::Error::custom(error.message))
    }
}

impl ChatroomEvent {
    pub fn room_id(&self) -> Option<&str> {
        match self {
            Self::LocalStatus { room_id, .. } => room_id.as_deref(),
            Self::RoomSnapshot { room_id, .. }
            | Self::MessageCreated { room_id, .. }
            | Self::RoomUpdated { room_id, .. }
            | Self::MemberRemoved { room_id, .. }
            | Self::AgentUpdated { room_id, .. }
            | Self::AttachmentUpdated { room_id, .. }
            | Self::AgentOffline { room_id, .. }
            | Self::AgentBusy { room_id, .. }
            | Self::AgentDisabled { room_id, .. }
            | Self::InvocationLimitReached { room_id, .. }
            | Self::MemberPresenceChanged { room_id, .. }
            | Self::AgentPresenceChanged { room_id, .. }
            | Self::AgentInvocation { room_id, .. }
            | Self::AgentAccepted { room_id, .. }
            | Self::AgentDelta { room_id, .. }
            | Self::AgentCompleted { room_id, .. }
            | Self::AgentFailed { room_id, .. }
            | Self::RoomRecoveryReady { room_id } => Some(room_id),
        }
    }
    pub fn seq(&self) -> Option<u64> {
        match self {
            Self::MessageCreated { seq, .. }
            | Self::RoomUpdated { seq, .. }
            | Self::MemberRemoved { seq, .. }
            | Self::AgentUpdated { seq, .. }
            | Self::AttachmentUpdated { seq, .. }
            | Self::AgentOffline { seq, .. }
            | Self::AgentBusy { seq, .. }
            | Self::AgentDisabled { seq, .. }
            | Self::InvocationLimitReached { seq, .. } => Some(*seq),
            _ => None,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::RoomSnapshot { .. } => "room.snapshot",
            Self::MessageCreated { .. } => "message.created",
            Self::RoomUpdated { .. } => "room.updated",
            Self::MemberRemoved { .. } => "member.removed",
            Self::AgentUpdated { .. } => "agent.updated",
            Self::AttachmentUpdated { .. } => "attachment.updated",
            Self::AgentOffline { .. } => "agent.offline",
            Self::AgentBusy { .. } => "agent.busy",
            Self::AgentDisabled { .. } => "agent.disabled",
            Self::InvocationLimitReached { .. } => "invocation.limit_reached",
            Self::MemberPresenceChanged { .. } => "member.presence_changed",
            Self::AgentPresenceChanged { .. } => "agent.presence_changed",
            Self::AgentInvocation { .. } => "agent.invocation",
            Self::AgentAccepted { .. } => "agent.accepted",
            Self::AgentDelta { .. } => "agent.delta",
            Self::AgentCompleted { .. } => "agent.completed",
            Self::AgentFailed { .. } => "agent.failed",
            Self::RoomRecoveryReady { .. } => "room.recovery_ready",
            Self::LocalStatus { .. } => "local.status",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CosStsGrant {
    pub attachment_id: String,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CosAction {
    Upload,
    Download,
}

impl Serialize for CosStsGrant {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut grant = serializer.serialize_struct("CosStsGrant", 10)?;
        grant.serialize_field("attachmentId", &self.attachment_id)?;
        grant.serialize_field("bucket", &self.bucket)?;
        grant.serialize_field("region", &self.region)?;
        grant.serialize_field("objectKey", &self.object_key)?;
        grant.serialize_field("tmpSecretId", &self.tmp_secret_id)?;
        grant.serialize_field("tmpSecretKey", &self.tmp_secret_key)?;
        grant.serialize_field("sessionToken", &self.session_token)?;
        grant.serialize_field("startTime", &self.start_time)?;
        grant.serialize_field("expiredTime", &self.expired_time)?;
        grant.serialize_field("action", &self.action)?;
        grant.end()
    }
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("protocol_invalid", message)
}

pub fn chatroom_ws_url(base_url: &str) -> Result<String, ProtocolError> {
    if base_url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
        || base_url.contains('?')
        || base_url.contains('#')
    {
        return Err(invalid("invalid backend URL"));
    }
    let (scheme, rest) = if let Some(rest) = base_url.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = base_url.strip_prefix("http://") {
        ("ws", rest)
    } else {
        return Err(invalid("backend URL must use http or https"));
    };
    let trimmed = rest.trim_end_matches('/');
    let authority = trimmed.split('/').next().unwrap_or_default();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('@')
        || authority.is_empty()
        || authority.contains('@')
    {
        return Err(invalid("backend URL host is missing"));
    }
    Ok(format!("{scheme}://{trimmed}{CHATROOM_WS_PATH}"))
}

pub fn normalize_room_id(value: &str) -> Result<String, ProtocolError> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '/' | '?' | '#' | '\\'))
    {
        return Err(invalid("invalid room id"));
    }
    Ok(value.to_string())
}

pub fn validate_invocation_depth(depth: u8) -> Result<(), ProtocolError> {
    if depth >= 3 {
        Err(ProtocolError::new(
            "invocation_limit_reached",
            "invocation depth limit reached",
        ))
    } else {
        Ok(())
    }
}

pub fn parse_event(bytes: &[u8]) -> Result<ChatroomEvent, ProtocolError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "payload_too_large",
            "chatroom event frame exceeds 128 KiB",
        ));
    }
    let root = parse_strict_value(bytes)?;
    let object = root
        .as_object()
        .ok_or_else(|| invalid("event must be an object"))?;
    let typ = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("event type is required"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type" | "roomId" | "seq" | "latestSeq" | "payload"
        )
    }) {
        return Err(invalid("unknown event field"));
    }
    let room = object
        .get("roomId")
        .and_then(Value::as_str)
        .map(normalize_room_id)
        .transpose()?;
    let payload = object.get("payload").cloned().unwrap_or(Value::Null);
    if payload != Value::Null && !payload.is_object() && !payload.is_array() {
        return Err(invalid("event payload must be structured"));
    }
    if payload.to_string().len() > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::new(
            "payload_too_large",
            "chatroom event payload exceeds 128 KiB",
        ));
    }
    validate_event_payload_fields(&payload)?;
    validate_transient_agent_payload(typ, &payload)?;
    let seq = object
        .get("seq")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| invalid("event seq must be an unsigned integer"))
        })
        .transpose()?;
    let latest = object
        .get("latestSeq")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| invalid("event latestSeq must be an unsigned integer"))
        })
        .transpose()?;
    let room_required = typ != "error";
    let room_id = if room_required {
        Some(room.ok_or_else(|| invalid("event roomId is required"))?)
    } else {
        room
    };
    if typ == "room.snapshot" && seq.is_some() {
        return Err(invalid("snapshot cannot carry seq"));
    }
    if typ != "room.snapshot" && latest.is_some() {
        return Err(invalid("only snapshot may carry latestSeq"));
    }
    if contains_sensitive(&payload) {
        return Err(ProtocolError::new(
            "sensitive_field",
            "event payload contains an internal field",
        ));
    }
    let event = match typ {
        "room.snapshot" => ChatroomEvent::RoomSnapshot {
            room_id: room_id.ok_or_else(|| invalid("event roomId is required"))?,
            latest_seq: latest.ok_or_else(|| invalid("snapshot latestSeq is required"))?,
            payload,
        },
        "message.created" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::MessageCreated {
                room_id,
                seq,
                payload,
            },
        )?,
        "room.updated" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::RoomUpdated {
                room_id,
                seq,
                payload,
            },
        )?,
        "member.removed" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::MemberRemoved {
                room_id,
                seq,
                payload,
            },
        )?,
        "agent.updated" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::AgentUpdated {
                room_id,
                seq,
                payload,
            },
        )?,
        "attachment.updated" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::AttachmentUpdated {
                room_id,
                seq,
                payload,
            },
        )?,
        "agent.offline" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::AgentOffline {
                room_id,
                seq,
                payload,
            },
        )?,
        "agent.busy" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::AgentBusy {
                room_id,
                seq,
                payload,
            },
        )?,
        "agent.disabled" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::AgentDisabled {
                room_id,
                seq,
                payload,
            },
        )?,
        "invocation.limit_reached" => persisted(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, seq, payload| ChatroomEvent::InvocationLimitReached {
                room_id,
                seq,
                payload,
            },
        )?,
        "member.presence_changed" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::MemberPresenceChanged { room_id, payload },
        )?,
        "agent.presence_changed" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentPresenceChanged { room_id, payload },
        )?,
        "agent.invocation" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentInvocation { room_id, payload },
        )?,
        "agent.accepted" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentAccepted { room_id, payload },
        )?,
        "agent.delta" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentDelta { room_id, payload },
        )?,
        "agent.completed" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentCompleted { room_id, payload },
        )?,
        "agent.failed" => transient(
            room_id.unwrap(),
            seq,
            payload.clone(),
            |room_id, payload| ChatroomEvent::AgentFailed { room_id, payload },
        )?,
        "room.recovery_ready" => {
            if seq.is_some() || payload != Value::Object(Map::new()) {
                return Err(invalid(
                    "recovery marker must be empty and cannot carry seq",
                ));
            }
            ChatroomEvent::RoomRecoveryReady {
                room_id: room_id.unwrap(),
            }
        }
        "error" => {
            let code = payload
                .get("code")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("error code is required"))?;
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("error message is required"))?;
            if seq.is_some() || latest.is_some() {
                return Err(invalid("error cannot carry sequence"));
            }
            ChatroomEvent::LocalStatus {
                room_id: None,
                code: code.into(),
                message: message.into(),
            }
        }
        _ => {
            return Err(ProtocolError::new(
                "unknown_event",
                "unknown chatroom event type",
            ))
        }
    };
    Ok(event)
}

fn persisted<F>(
    room: String,
    seq: Option<u64>,
    payload: Value,
    make: F,
) -> Result<ChatroomEvent, ProtocolError>
where
    F: FnOnce(String, u64, Value) -> ChatroomEvent,
{
    Ok(make(
        room,
        seq.filter(|v| *v > 0)
            .ok_or_else(|| invalid("persisted event seq must be positive"))?,
        payload,
    ))
}
fn transient<F>(
    room: String,
    seq: Option<u64>,
    payload: Value,
    make: F,
) -> Result<ChatroomEvent, ProtocolError>
where
    F: FnOnce(String, Value) -> ChatroomEvent,
{
    if seq.is_some() {
        return Err(invalid("transient event cannot carry seq"));
    }
    Ok(make(room, payload))
}

pub fn filter_cos_sts(
    value: &Value,
    expected_action: CosAction,
) -> Result<CosStsGrant, ProtocolError> {
    let object = value.get("data").filter(|v| v.is_object()).unwrap_or(value);
    let get_string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_string)
    };
    let credentials = object
        .get("credentials")
        .filter(|v| v.is_object())
        .unwrap_or(object);
    let credential_string = |key: &str| {
        credentials
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_string)
    };
    let number = |obj: &Value, key: &str| obj.get(key).and_then(Value::as_u64);
    let action = match expected_action {
        CosAction::Upload => "upload",
        CosAction::Download => "download",
    };
    let grant = CosStsGrant {
        attachment_id: get_string("attachmentId")
            .filter(|value| valid_id(value, MAX_ID_BYTES))
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        bucket: get_string("bucket")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        region: get_string("region")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        object_key: get_string("objectKey")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        tmp_secret_id: credential_string("tmpSecretId")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        tmp_secret_key: credential_string("tmpSecretKey")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        session_token: credential_string("sessionToken")
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        start_time: number(credentials, "startTime")
            .or_else(|| number(object, "startTime"))
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        expired_time: number(credentials, "expiredTime")
            .or_else(|| number(object, "expiredTime"))
            .ok_or_else(|| ProtocolError::new("cos_sts_invalid", "invalid COS STS grant"))?,
        action: expected_action,
    };
    if object
        .get("action")
        .is_some_and(|v| v.as_str() != Some(action))
        || grant.start_time == 0
        || grant.expired_time == 0
        || grant.expired_time <= grant.start_time
    {
        return Err(ProtocolError::new(
            "cos_sts_invalid",
            "invalid COS STS grant",
        ));
    }
    Ok(grant)
}

pub fn public_event(event: &ChatroomEvent) -> Value {
    let clean = |value: &Value| sanitize_public(value);
    let mut result = serde_json::Map::new();
    result.insert("type".into(), Value::String(event.kind().into()));
    if let Some(room) = event.room_id() {
        result.insert("roomId".into(), Value::String(room.into()));
    }
    if let Some(seq) = event.seq() {
        result.insert("seq".into(), Value::from(seq));
    }
    match event {
        ChatroomEvent::RoomSnapshot {
            latest_seq,
            payload,
            ..
        } => {
            result.insert("latestSeq".into(), Value::from(*latest_seq));
            result.insert("payload".into(), clean(payload));
        }
        ChatroomEvent::LocalStatus { code, message, .. } => {
            result.insert("code".into(), Value::String(code.clone()));
            result.insert(
                "message".into(),
                sanitize_public(&Value::String(message.clone())),
            );
        }
        ChatroomEvent::RoomRecoveryReady { .. } => {
            result.insert("payload".into(), Value::Object(serde_json::Map::new()));
        }
        _ => {
            let payload = match event {
                ChatroomEvent::MessageCreated { payload, .. }
                | ChatroomEvent::RoomUpdated { payload, .. }
                | ChatroomEvent::MemberRemoved { payload, .. }
                | ChatroomEvent::AgentUpdated { payload, .. }
                | ChatroomEvent::AttachmentUpdated { payload, .. }
                | ChatroomEvent::AgentOffline { payload, .. }
                | ChatroomEvent::AgentBusy { payload, .. }
                | ChatroomEvent::AgentDisabled { payload, .. }
                | ChatroomEvent::InvocationLimitReached { payload, .. }
                | ChatroomEvent::MemberPresenceChanged { payload, .. }
                | ChatroomEvent::AgentPresenceChanged { payload, .. }
                | ChatroomEvent::AgentInvocation { payload, .. }
                | ChatroomEvent::AgentAccepted { payload, .. }
                | ChatroomEvent::AgentDelta { payload, .. }
                | ChatroomEvent::AgentCompleted { payload, .. }
                | ChatroomEvent::AgentFailed { payload, .. } => payload,
                _ => unreachable!(),
            };
            result.insert("payload".into(), clean(payload));
        }
    }
    Value::Object(result)
}

pub fn sanitize_public(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_public).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !forbidden(key))
                .map(|(key, value)| (key.clone(), sanitize_public(value)))
                .collect(),
        ),
        Value::String(value) if sensitive_scalar(value) => Value::String("[已过滤]".into()),
        _ => value.clone(),
    }
}
fn forbidden(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    [
        "authorization",
        "authheader",
        "bearer",
        "jwt",
        "sts",
        "tmpsecret",
        "secret",
        "accesstoken",
        "refreshtoken",
        "sessiontoken",
        "objectkey",
        "cosobject",
        "storageobject",
        "qcs",
        "localpath",
        "absolutepath",
        "internalpath",
        "filepath",
        "rawdevice",
        "deviceid",
        "devicehash",
        "memory",
        "skill",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
        || key == "device"
        || key == "coskey"
        || key == "storagekey"
}
fn sensitive_scalar(value: &str) -> bool {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    lower.starts_with("bearer ")
        || (lower.starts_with("eyj") && value.matches('.').count() >= 2)
        || lower.starts_with("qcs::")
        || lower.starts_with("sts ")
        || [
            "/Users/",
            "/Volumes/",
            "/private/",
            "/home/",
            "/tmp/",
            "/var/",
            "/mnt/",
            "/srv/",
        ]
        .iter()
        .any(|prefix| lower.starts_with(&prefix.to_ascii_lowercase()))
        || lower.get(1..3).is_some_and(|prefix| prefix == ":/")
}
fn contains_sensitive(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_sensitive),
        Value::Object(map) => map
            .iter()
            .any(|(key, value)| forbidden(key) || contains_sensitive(value)),
        Value::String(value) => sensitive_scalar(value),
        _ => false,
    }
}

struct ValueSeed;
impl<'de> DeserializeSeed<'de> for ValueSeed {
    type Value = Value;
    fn deserialize<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ValueVisitor)
    }
}
struct ValueVisitor;
impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::from(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::from(v))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::from(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A>(self, mut seq: A) -> Result<Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut out = Vec::new();
        while let Some(v) = seq.next_element_seed(ValueSeed)? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A>(self, mut map: A) -> Result<Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut out = Map::new();
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom("duplicate JSON key"));
            }
            let value = map.next_value_seed(ValueSeed)?;
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}

fn parse_strict_value(bytes: &[u8]) -> Result<Value, ProtocolError> {
    if std::str::from_utf8(bytes).is_err() {
        return Err(invalid("event is not UTF-8"));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = ValueSeed
        .deserialize(&mut deserializer)
        .map_err(|e| invalid(e.to_string()))?;
    deserializer.end().map_err(|e| invalid(e.to_string()))?;
    Ok(value)
}
