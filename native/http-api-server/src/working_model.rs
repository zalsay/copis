use crate::skill_market::{remote_json, remote_json_raw, SkillMarketState};
use serde_json::Value;

const WORKING_MODEL_ALIASES: [&str; 3] = ["fast", "export", "deepseek-v4-flash"];

pub fn working_model_latencies(state: &SkillMarketState) -> Result<Value, String> {
    let token = state
        .access_token()
        .ok_or_else(|| "请先登录 Copis Working".to_string())?;
    let mut payload = remote_json_raw(
        "GET",
        "/api/internal/working-model/first-token-latencies",
        &token,
        None,
    )
    .map_err(|error| error.message)?;

    let mut configs = Vec::new();
    for alias in WORKING_MODEL_ALIASES {
        let path = format!("/api/internal/working-model/config?alias={}", alias);
        if let Ok(config) = remote_json("GET", &path, &token, None) {
            configs.push(config);
        }
    }
    merge_alias_latencies(&mut payload, &configs);
    Ok(payload)
}

pub fn merge_alias_latencies(payload: &mut Value, configs: &[Value]) {
    let Some(data) = payload.get_mut("data").and_then(Value::as_object_mut) else {
        return;
    };
    for config in configs {
        let alias = config.get("alias").and_then(Value::as_str).unwrap_or("");
        let model_id = config.get("model_id").and_then(Value::as_str).unwrap_or("");
        if alias.is_empty() || model_id.is_empty() {
            continue;
        }
        if let Some(latency) = data.get(model_id).cloned() {
            data.insert(alias.to_string(), latency);
        }
    }
}
