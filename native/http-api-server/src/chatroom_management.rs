use serde_json::{Map, Value};

const RECEIPT_FIELDS: &[&str] = &[
    "version",
    "operationId",
    "roomId",
    "roomAgentId",
    "ownerUserId",
    "action",
    "status",
    "displayName",
    "memoryShared",
    "skillsShared",
];

pub(crate) struct ManagementCommand {
    pub(crate) action: &'static str,
    pub(crate) operation_id: String,
    pub(crate) target_agent_id: Option<String>,
    pub(crate) body: Value,
}

pub(crate) struct ManagementStatusQuery {
    pub(crate) operation_id: String,
    pub(crate) body: Value,
}

pub(crate) fn parse_command(value: Value, device_id: &str) -> Result<ManagementCommand, ()> {
    let object = value.as_object().ok_or(())?;
    let action = match required_string(object, "action")? {
        "register" => "register",
        "remove" => "remove",
        "update-sharing" => "update-sharing",
        _ => return Err(()),
    };
    let operation_id = required_uuid_v4(object, "operationId")?;
    let supplied_device_id = required_uuid_v4(object, "deviceId")?;
    if supplied_device_id != device_id || !valid_uuid_v4(device_id) {
        return Err(());
    }

    let (allowed_fields, target_agent_id) = match action {
        "register" => {
            let display_name = required_string(object, "displayName")?;
            if display_name.trim().is_empty() {
                return Err(());
            }
            if let Some(avatar) = optional_string(object, "avatar")? {
                if avatar.chars().count() > 512 {
                    return Err(());
                }
            }
            (
                &[
                    "action",
                    "operationId",
                    "deviceId",
                    "displayName",
                    "avatar",
                    "memoryShared",
                    "skillsShared",
                ][..],
                None,
            )
        }
        "remove" => {
            let target = required_component(object, "roomAgentId")?;
            (
                &["action", "operationId", "deviceId", "roomAgentId"][..],
                Some(target),
            )
        }
        "update-sharing" => {
            let target = required_component(object, "roomAgentId")?;
            if !object.contains_key("memoryShared") && !object.contains_key("skillsShared") {
                return Err(());
            }
            (
                &[
                    "action",
                    "operationId",
                    "deviceId",
                    "roomAgentId",
                    "memoryShared",
                    "skillsShared",
                ][..],
                Some(target),
            )
        }
        _ => return Err(()),
    };

    if !has_only_fields(object, allowed_fields)
        || !valid_optional_boolean(object, "memoryShared")
        || !valid_optional_boolean(object, "skillsShared")
    {
        return Err(());
    }

    Ok(ManagementCommand {
        action,
        operation_id,
        target_agent_id,
        body: value,
    })
}

pub(crate) fn parse_status_query(
    value: Value,
    device_id: &str,
) -> Result<ManagementStatusQuery, ()> {
    let object = value.as_object().ok_or(())?;
    if !has_only_fields(object, &["operationId", "deviceId"]) {
        return Err(());
    }
    let operation_id = required_uuid_v4(object, "operationId")?;
    let supplied_device_id = required_uuid_v4(object, "deviceId")?;
    if supplied_device_id != device_id || !valid_uuid_v4(device_id) {
        return Err(());
    }
    Ok(ManagementStatusQuery {
        operation_id,
        body: value,
    })
}

pub(crate) fn validate_capabilities_envelope(value: Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    if !has_only_fields(object, &["data"]) {
        return Err(());
    }
    let data = object.get("data").and_then(Value::as_object).ok_or(())?;
    if !has_only_fields(data, &["version"])
        || data.get("version").and_then(Value::as_u64) != Some(1)
    {
        return Err(());
    }
    Ok(serde_json::json!({"data":{"version":1}}))
}

pub(crate) fn validate_receipt_envelope(
    value: Value,
    command: &ManagementCommand,
    room_id: &str,
    actor_id: u64,
) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    if !has_only_fields(object, &["data"]) {
        return Err(());
    }
    let receipt = object.get("data").and_then(Value::as_object).ok_or(())?;
    if !has_only_fields(receipt, RECEIPT_FIELDS)
        || receipt.len() != RECEIPT_FIELDS.len()
        || receipt.get("version").and_then(Value::as_u64) != Some(1)
        || receipt.get("operationId").and_then(Value::as_str) != Some(&command.operation_id)
        || receipt.get("roomId").and_then(Value::as_str) != Some(room_id)
        || receipt.get("ownerUserId").and_then(Value::as_u64) != Some(actor_id)
        || receipt.get("action").and_then(Value::as_str) != Some(command.action)
        || receipt.get("status").and_then(Value::as_str) != Some(expected_status(command.action))
        || !receipt
            .get("roomAgentId")
            .and_then(Value::as_str)
            .is_some_and(valid_component)
        || !receipt
            .get("displayName")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        || !receipt.get("memoryShared").is_some_and(Value::is_boolean)
        || !receipt.get("skillsShared").is_some_and(Value::is_boolean)
    {
        return Err(());
    }
    if command
        .target_agent_id
        .as_deref()
        .is_some_and(|target| receipt.get("roomAgentId").and_then(Value::as_str) != Some(target))
    {
        return Err(());
    }
    Ok(serde_json::json!({"data":receipt}))
}

pub(crate) fn validate_status_receipt_envelope(
    value: Value,
    operation_id: &str,
    room_id: &str,
    actor_id: u64,
) -> Result<Value, ()> {
    let action = value
        .get("data")
        .and_then(Value::as_object)
        .and_then(|receipt| receipt.get("action"))
        .and_then(Value::as_str)
        .ok_or(())?;
    let action = match action {
        "register" => "register",
        "remove" => "remove",
        "update-sharing" => "update-sharing",
        _ => return Err(()),
    };
    let command = ManagementCommand {
        action,
        operation_id: operation_id.to_string(),
        target_agent_id: None,
        body: Value::Null,
    };
    validate_receipt_envelope(value, &command, room_id, actor_id)
}

pub(crate) fn management_error_envelope(value: Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.len() == 1 {
        let error = object.get("error")?.as_object()?;
        if !has_only_fields(error, &["code", "message", "context"])
            || !error.get("code").is_some_and(Value::is_string)
            || !error.get("message").is_some_and(Value::is_string)
        {
            return None;
        }
        return Some(value);
    }
    if !has_only_fields(object, &["error", "code", "message", "context"])
        || !object.get("code").is_some_and(Value::is_string)
        || !object.get("error").is_some_and(Value::is_string)
        || object
            .get("message")
            .is_some_and(|message| !message.is_string())
    {
        return None;
    }
    Some(value)
}

fn expected_status(action: &str) -> &'static str {
    match action {
        "register" => "registered",
        "remove" => "removed",
        "update-sharing" => "updated",
        _ => "",
    }
}

fn has_only_fields(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn required_string<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str, ()> {
    object
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

fn optional_string<'a>(object: &'a Map<String, Value>, name: &str) -> Result<Option<&'a str>, ()> {
    match object.get(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(()),
    }
}

fn required_uuid_v4(object: &Map<String, Value>, name: &str) -> Result<String, ()> {
    let value = required_string(object, name)?;
    if valid_uuid_v4(value) {
        Ok(value.to_string())
    } else {
        Err(())
    }
}

fn valid_uuid_v4(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        && value.as_bytes()[14] == b'4'
        && matches!(
            value.as_bytes()[19].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

fn required_component(object: &Map<String, Value>, name: &str) -> Result<String, ()> {
    let value = required_string(object, name)?;
    if valid_component(value) {
        Ok(value.to_string())
    } else {
        Err(())
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.trim() == value
        && !value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '/' | '?' | '#' | '\\')
        })
}

fn valid_optional_boolean(object: &Map<String, Value>, name: &str) -> bool {
    object.get(name).is_none_or(Value::is_boolean)
}
