use crate::working_model_proxy::WorkingModelError;
use serde_json::Value;

const WORKING_MODEL_ALIASES: [&str; 5] = [
    "fast",
    "export",
    "global",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
];

pub fn working_model_latencies(
    mut request: impl FnMut(&str) -> Result<Value, WorkingModelError>,
) -> Result<Value, String> {
    let mut payload = request("/first-token-latencies").map_err(|error| error.to_string())?;

    let mut configs = Vec::new();
    for alias in WORKING_MODEL_ALIASES {
        let path = format!("/config?alias={}", alias);
        if let Ok(config) = request(&path) {
            configs.push(config.get("data").cloned().unwrap_or(config));
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
