//! DSH 共享群的受限消息通道：只翻译指定命令，不代理任意 URL、原始请求体或身份。
use super::{
    remote_response, GatewayError, GatewayResponse, UserBoundRequestError, WorkingGateway,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    InternalMarkDshShared { room_id: String, room_agent_id: String, device_id: String },
    InternalAgentOperationStatus { room_id: String, operation_id: String, device_id: String },
    InternalRegisterAgent { room_id: String, operation_id: String, device_id: String, display_name: String },
    InternalRemoveAgent { room_id: String, operation_id: String, device_id: String, room_agent_id: String },
    InternalAttachmentUpload { room_id: String, file_name: String, mime_type: String, size_bytes: u64, sha256: String },
    InternalAttachmentFinalize { room_id: String, attachment_id: String, size_bytes: u64, etag: String, sha256: String },
    InternalAttachmentDownload { room_id: String, attachment_id: String },
    List {},
    Create {
        name: String,
        share_code: String,
    },
    Join {
        share_code: String,
    },
    Leave { room_id: String },
    Dissolve { room_id: String },
    Detail {
        room_id: String,
    },
    Events {
        room_id: String,
        after_seq: u64,
    },
    Messages {
        room_id: String,
        before_seq: Option<u64>,
    },
    Send {
        room_id: String,
        client_message_id: String,
        content: String,
        mention_agent_id: Option<String>,
        #[serde(default)]
        attachment_ids: Vec<String>,
    },
}
fn invalid() -> GatewayError {
    GatewayError::new(400, "invalid_request", "共享群命令参数无效")
}
fn identifier(value: &str) -> Result<&str, GatewayError> {
    if !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(value)
    } else {
        Err(invalid())
    }
}
fn share_code(raw: &str) -> Result<String, GatewayError> {
    let code = raw.trim();
    if code.len() == 4 && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(code.to_ascii_uppercase())
    } else {
        Err(invalid())
    }
}

pub(super) fn handle(
    gateway: &WorkingGateway,
    mut payload: Value,
) -> Result<GatewayResponse, GatewayError> {
    let expected = payload
        .as_object_mut()
        .and_then(|v| v.remove("expectedUserId"))
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(invalid)?;
    if expected.is_empty() || expected.len() > 128 || expected.chars().any(char::is_control) {
        return Err(invalid());
    }
    let cmd: Command = serde_json::from_value(payload).map_err(|_| invalid())?;
    let (method, path, body) = cmd.request()?;
    let response = gateway
        .auth
        .authenticated_request_for_user(&expected, method, &path, body.map(|v| v.to_string()))
        .map_err(|err| match err {
            UserBoundRequestError::Authentication(error) => GatewayError::from(error),
            UserBoundRequestError::UserMismatch => GatewayError::new(
                409,
                "shared_room_user_mismatch",
                "当前账号已切换，请重新打开共享群",
            ),
        })?;
    let mut result = remote_response(response.status, &response.body)?;
    if (200..300).contains(&result.status) {
        if let Some(raw) = result.body.take() {
            result.body = Some(cmd.for_display(&raw, &expected)?);
        }
    }
    Ok(result)
}

fn validate_attachment(size: u64, sha256: &str) -> Result<(), GatewayError> {
    if size > 256 * 1024 * 1024 || sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(invalid());
    }
    Ok(())
}

impl Command {
    fn request(&self) -> Result<(&'static str, String, Option<Value>), GatewayError> {
        let rooms = "/api/chatrooms/v2/rooms";
        let request = match self {
            Command::InternalMarkDshShared { room_id, room_agent_id, device_id } => (
                "PATCH", format!("{}/{}", rooms, identifier(room_id)?),
                Some(json!({"roomKind":"dsh_shared","roomAgentId":identifier(room_agent_id)?,"deviceId":identifier(device_id)?})),
            ),
            Command::InternalAgentOperationStatus { room_id, operation_id, device_id } => (
                "POST", format!("{}/{}/agent-management/operations/status", rooms, identifier(room_id)?),
                Some(json!({"operationId":identifier(operation_id)?,"deviceId":identifier(device_id)?})),
            ),
            Command::InternalRegisterAgent { room_id, operation_id, device_id, display_name } => {
                if display_name.trim().is_empty() || display_name.trim().len() > 128 || display_name.chars().any(char::is_control) { return Err(invalid()); }
                ("POST", format!("{}/{}/agent-management/operations", rooms, identifier(room_id)?),
                 Some(json!({"action":"register","roomKind":"dsh_shared","operationId":identifier(operation_id)?,"deviceId":identifier(device_id)?,"displayName":display_name.trim(),"memoryShared":false,"skillsShared":false})))
            }
            Command::InternalRemoveAgent { room_id, operation_id, device_id, room_agent_id } => (
                "POST", format!("{}/{}/agent-management/operations", rooms, identifier(room_id)?),
                Some(json!({"action":"remove","operationId":identifier(operation_id)?,"deviceId":identifier(device_id)?,"roomAgentId":identifier(room_agent_id)?})),
            ),
            Command::InternalAttachmentUpload { room_id, file_name, mime_type, size_bytes, sha256 } => {
                validate_attachment(*size_bytes, sha256)?;
                if file_name.trim().is_empty() || file_name.len() > 255 || file_name.chars().any(char::is_control)
                    || mime_type.trim().is_empty() || mime_type.len() > 128 || mime_type.chars().any(char::is_control) {
                    return Err(invalid());
                }
                ("POST", format!("{}/{}/attachments/upload-authorizations", rooms, identifier(room_id)?),
                 Some(json!({"fileName":file_name,"mimeType":mime_type,"sizeBytes":size_bytes,"sha256":sha256})))
            }
            Command::InternalAttachmentFinalize { room_id, attachment_id, size_bytes, etag, sha256 } => {
                validate_attachment(*size_bytes, sha256)?;
                if etag.trim().is_empty() || etag.len() > 1024 || etag.chars().any(char::is_control) { return Err(invalid()); }
                ("POST", format!("{}/{}/attachments/{}/finalize", rooms, identifier(room_id)?, identifier(attachment_id)?),
                 Some(json!({"sizeBytes":size_bytes,"etag":etag,"sha256":sha256})))
            }
            Command::InternalAttachmentDownload { room_id, attachment_id } => (
                "POST", format!("{}/{}/attachments/{}/download-authorizations", rooms, identifier(room_id)?, identifier(attachment_id)?), Some(json!({})),
            ),
            Command::List {} => ("GET", rooms.into(), None),
            Command::Create {
                name,
                share_code: code,
            } => {
                if name.trim().is_empty() || name.chars().count() > 128 {
                    return Err(invalid());
                }
                (
                    "POST",
                    rooms.into(),
                    Some(json!({"roomKind":"dsh_shared","name":name.trim(),"shareCode":share_code(&code)?})),
                )
            }
            Command::Join { share_code: code } => (
                "POST",
                "/api/chatrooms/v2/join".into(),
                Some(json!({"shareCode":share_code(&code)?})),
            ),
            Command::Leave { room_id } => ("POST", format!("{}/{}/leave", rooms, identifier(room_id)?), None),
            Command::Dissolve { room_id } => ("DELETE", format!("{}/{}", rooms, identifier(room_id)?), None),
            Command::Detail { room_id } => {
                ("GET", format!("{}/{}", rooms, identifier(&room_id)?), None)
            }
            Command::Events { room_id, after_seq } => (
                "GET",
                format!(
                    "{}/{}/events?limit=100&afterSeq={}",
                    rooms,
                    identifier(&room_id)?,
                    after_seq
                ),
                None,
            ),
            Command::Messages {
                room_id,
                before_seq,
            } => (
                "GET",
                format!(
                    "{}/{}/messages?limit=50&beforeSeq={}",
                    rooms,
                    identifier(&room_id)?,
                    before_seq.unwrap_or(0)
                ),
                None,
            ),
            Command::Send {
                room_id,
                client_message_id,
                content,
                mention_agent_id,
                attachment_ids,
            } => {
                if (content.trim().is_empty() && attachment_ids.is_empty()) || content.len() > 32 * 1024 || attachment_ids.len() > 20 {
                    return Err(invalid());
                }
                for id in attachment_ids { identifier(id)?; }
                let target = mention_agent_id.as_deref().map(identifier).transpose()?;
                (
                    "POST",
                    format!("{}/{}/messages", rooms, identifier(&room_id)?),
                    Some(
                        json!({"clientMessageId":identifier(&client_message_id)?,"content":content,"mentionAgentIds":target.into_iter().collect::<Vec<_>>(),"attachmentIds":attachment_ids}),
                    ),
                )
            }
        };
        Ok(request)
    }
}

// 普通群聊 UI 只消费显示字段，不把设备调用载荷、租约和其他人的分享码透传给页面。
fn fields(raw: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| raw.get(key).map(|v| ((*key).to_string(), v.clone())))
            .collect(),
    )
}
fn rows(raw: &Value) -> Result<&Vec<Value>, GatewayError> {
    raw.as_array()
        .ok_or_else(|| GatewayError::new(502, "invalid_upstream_response", "无效的共享群列表"))
}
fn message(raw: &Value) -> Value {
    fields(
        raw,
        &[
            "messageId",
            "roomId",
            "seq",
            "senderType",
            "senderUserId",
            "senderAgentId",
            "content",
            "attachmentIds",
            "createdAt",
        ],
    )
}
impl Command {
    fn for_display(&self, raw: &Value, user_id: &str) -> Result<Value, GatewayError> {
        let room = |v: &Value| {
            let mut public = fields(v, &["roomId", "name", "hostUserId", "status", "roomKind"]);
            if v["hostUserId"].as_u64().map(|n| n.to_string()).as_deref() == Some(user_id)
                && v["shareCodeEnabled"] == true
            {
                public["shareCodeEnabled"] = true.into();
                public["shareCode"] = v["shareCode"].clone();
            }
            public
        };
        Ok(match self {
            Command::InternalAttachmentUpload { .. } | Command::InternalAttachmentFinalize { .. } | Command::InternalAttachmentDownload { .. } => raw.clone(),
            Command::InternalMarkDshShared { room_id, .. } => {
                let r = &raw["room"];
                if r["roomId"] != *room_id || r["roomKind"] != "dsh_shared" || r["hostUserId"].as_u64().map(|id| id.to_string()).as_deref() != Some(user_id) {
                    return Err(GatewayError::new(502, "invalid_upstream_response", "共享群升级回执不匹配"));
                }
                json!({"roomId":room_id})
            }
            Command::InternalRegisterAgent { room_id, operation_id, .. } | Command::InternalRemoveAgent { room_id, operation_id, .. } | Command::InternalAgentOperationStatus { room_id, operation_id, .. } => {
                let (action, status) = match self { Command::InternalRegisterAgent { .. } | Command::InternalAgentOperationStatus { .. } => ("register", "registered"), _ => ("remove", "removed") };
                let agent = raw["roomAgentId"].as_str().and_then(|v| identifier(v).ok());
                let valid = raw["version"] == 1 && raw["operationId"] == *operation_id && raw["roomId"] == *room_id
                    && raw["ownerUserId"].as_u64().map(|n| n.to_string()).as_deref() == Some(user_id)
                    && raw["action"] == action && raw["status"] == status && agent.is_some()
                    && match self { Command::InternalRegisterAgent { .. } | Command::InternalAgentOperationStatus { .. } => raw["memoryShared"] == false && raw["skillsShared"] == false,
                        Command::InternalRemoveAgent { room_agent_id, .. } => agent == Some(room_agent_id.as_str()), _ => false };
                if !valid { return Err(GatewayError::new(502, "invalid_upstream_response", "无效的共享群管理回执")); }
                json!({"roomAgentId": agent.unwrap()})
            }
            Command::List {} => Value::Array(rows(raw)?.iter().map(room).collect()),
            Command::Create { .. } | Command::Join { .. } => room(raw),
            Command::Leave { .. } => fields(raw, &["roomId"]),
            Command::Dissolve { .. } => fields(&raw["room"], &["roomId"]),
            Command::Messages { .. } => Value::Array(rows(raw)?.iter().map(message).collect()),
            Command::Send { mention_agent_id, .. } => {
                let mut ack = json!({"message":message(&raw["message"])});
                if let Some(target) = mention_agent_id {
                    // HTTP 200 只证明真人消息已保存，不意味着智能体调用获准。
                    let dispatched = raw["invocations"].as_array().into_iter().flatten().any(|i|
                        i["targetAgentId"] == *target && matches!(i["status"].as_str(), Some("created" | "queued" | "accepted" | "running" | "completed")));
                    ack["notExecuted"] = (!dispatched).into();
                    if !dispatched {
                        if let Some(reason) = raw["events"].as_array().into_iter().flatten()
                            .map(|event| &event["payload"]).filter(|p| p["agentId"] == *target)
                            .filter_map(|p| p["reason"].as_str())
                            .find(|r| matches!(*r, "room_queue_full" | "member_pending_limit" | "agent_offline" | "agent_disabled")) {
                            ack["reason"] = reason.into();
                        }
                    }
                }
                ack
            }
            Command::Detail { .. } => {
                json!({"room":room(&raw["room"]),"agents":raw["agents"].as_array().into_iter().flatten().map(|a| fields(a,&["roomId","roomAgentId","ownerUserId","displayName","availability","queuedCount"])).collect::<Vec<_>>() })
            }
            Command::Events { .. } => Value::Array(
                rows(raw)?
                    .iter()
                    .map(|e| {
                        let mut item = fields(e, &["roomId", "seq", "eventType", "createdAt"]);
                        if e["eventType"] == "message.created" {
                            item["payload"] = message(&e["payload"]);
                        }
                        item
                    })
                    .collect(),
            ),
        })
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;

    fn command(value: Value) -> Command { serde_json::from_value(value).unwrap() }

    #[test]
    fn shared_room_attachment_commands_forward_typed_contract() {
        let sha = "a".repeat(64);
        let upload = command(json!({"action":"internalAttachmentUpload","roomId":"r","fileName":"图.png","mimeType":"image/png","sizeBytes":3,"sha256":sha}));
        let (method, path, body) = upload.request().unwrap();
        assert_eq!((method, path.as_str()), ("POST", "/api/chatrooms/v2/rooms/r/attachments/upload-authorizations"));
        assert_eq!(body.unwrap(), json!({"fileName":"图.png","mimeType":"image/png","sizeBytes":3,"sha256":sha}));
        let grant = json!({"attachmentId":"a","objectKey":"private/r/a","credentials":{"tmpSecretKey":"secret"}});
        assert_eq!(upload.for_display(&grant, "7").unwrap(), grant);
        let finalize = command(json!({"action":"internalAttachmentFinalize","roomId":"r","attachmentId":"a","sizeBytes":3,"etag":"\"abc\"","sha256":sha}));
        let (_, path, body) = finalize.request().unwrap();
        assert_eq!(path, "/api/chatrooms/v2/rooms/r/attachments/a/finalize");
        assert_eq!(body.unwrap(), json!({"sizeBytes":3,"etag":"\"abc\"","sha256":sha}));
        let metadata = json!({"roomId":"r","attachmentId":"a","status":"ready"});
        assert_eq!(finalize.for_display(&metadata, "7").unwrap(), metadata);
        let download = command(json!({"action":"internalAttachmentDownload","roomId":"r","attachmentId":"a"}));
        let (_, path, body) = download.request().unwrap();
        assert_eq!(path, "/api/chatrooms/v2/rooms/r/attachments/a/download-authorizations");
        assert_eq!(body.unwrap(), json!({}));
        assert_eq!(download.for_display(&grant, "7").unwrap(), grant);
    }

    #[test]
    fn shared_room_attachment_rejects_invalid_inputs() {
        let sha = "a".repeat(64);
        for payload in [
            json!({"action":"internalAttachmentUpload","roomId":"../r","fileName":"a","mimeType":"text/plain","sizeBytes":1,"sha256":sha}),
            json!({"action":"internalAttachmentUpload","roomId":"r","fileName":"a","mimeType":"text/plain","sizeBytes":268435457,"sha256":sha}),
            json!({"action":"internalAttachmentUpload","roomId":"r","fileName":"a","mimeType":"text/plain","sizeBytes":1,"sha256":"bad"}),
            json!({"action":"internalAttachmentFinalize","roomId":"r","attachmentId":"../a","sizeBytes":1,"etag":"x","sha256":sha}),
            json!({"action":"internalAttachmentFinalize","roomId":"r","attachmentId":"a","sizeBytes":1,"etag":"","sha256":sha}),
            json!({"action":"internalAttachmentDownload","roomId":"r","attachmentId":"../a"}),
        ] { assert!(command(payload).request().is_err()); }
        assert!(serde_json::from_value::<Command>(json!({"action":"internalAttachmentDownload","roomId":"r","attachmentId":"a","url":"https://evil"})).is_err());
        let send = command(json!({"action":"send","roomId":"r","clientMessageId":"m","content":" text ","mentionAgentId":"agent"}));
        assert_eq!(send.request().unwrap().2.unwrap(), json!({"clientMessageId":"m","content":" text ","mentionAgentIds":["agent"],"attachmentIds":[]}));
    }

    #[test]
    fn shared_room_attachment_send_and_response_contract() {
        let send = command(json!({"action":"send","roomId":"r","clientMessageId":"m","content":"","attachmentIds":["a"]}));
        assert_eq!(send.request().unwrap().2.unwrap(), json!({"clientMessageId":"m","content":"","mentionAgentIds":[],"attachmentIds":["a"]}));
        let msg = json!({"messageId":"m","attachmentIds":["a"],"private":"hidden"});
        assert_eq!(send.for_display(&json!({"message":msg}), "7").unwrap(), json!({"message":{"messageId":"m","attachmentIds":["a"]}}));
        let events = command(json!({"action":"events","roomId":"r","afterSeq":0}));
        assert_eq!(events.for_display(&json!([{"eventType":"message.created","payload":msg}]), "7").unwrap()[0]["payload"]["attachmentIds"], json!(["a"]));
        for ids in [json!([]), json!(["../bad"]), json!(vec!["a"; 21])] {
            let bad = command(json!({"action":"send","roomId":"r","clientMessageId":"m","content":"","attachmentIds":ids}));
            assert!(bad.request().is_err());
        }
    }
}
