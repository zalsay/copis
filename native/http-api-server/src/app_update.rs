use serde_json::{json, Value};
use std::cmp::Ordering;
use std::time::Duration;

pub const DEFAULT_APP_UPDATE_MANIFEST_URL: &str =
    "https://download.meetlife.com.cn/copis/client/stable/manifest.json";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

pub fn resolve_manifest_url() -> String {
    std::env::var("COPIS_APP_UPDATE_MANIFEST_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("COPIS_FUNCTIONAL_MODULE_MANIFEST_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_APP_UPDATE_MANIFEST_URL.to_string())
}

pub fn check_app_update(current_version: &str, manifest_url: &str) -> Result<Value, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent
        .get(manifest_url)
        .header("Accept", "application/json")
        .call()
        .map_err(|error| format!("更新 manifest 获取失败: {}", error))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("更新 manifest 获取失败（HTTP {}）", status));
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_vec()
        .map_err(|error| format!("读取更新 manifest 失败: {}", error))?;
    parse_app_update(&body, current_version)
}

pub fn parse_app_update(body: &[u8], current_version: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "更新 manifest 不是有效的 JSON".to_string())?;
    let client = value.get("client").and_then(Value::as_object);
    let Some(update) = client
        .and_then(|client| client.get("update"))
        .and_then(Value::as_object)
    else {
        return Ok(json!({ "available": false, "currentVersion": current_version }));
    };

    let version = update
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let url = update
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if version.is_empty() || url.is_empty() {
        return Ok(json!({ "available": false, "currentVersion": current_version }));
    }
    if !is_newer_version(version, current_version) {
        return Ok(json!({ "available": false, "currentVersion": current_version }));
    }
    if !url.starts_with("https://") {
        return Err("更新下载地址必须使用 HTTPS".to_string());
    }

    let mut result = serde_json::Map::new();
    result.insert("available".to_string(), json!(true));
    result.insert("version".to_string(), json!(version));
    result.insert("url".to_string(), json!(url));
    result.insert("currentVersion".to_string(), json!(current_version));
    if let Some(sha256) = update.get("sha256").and_then(Value::as_str) {
        let sha256 = sha256.trim().to_ascii_lowercase();
        if !sha256.is_empty() {
            if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("更新 SHA-256 格式无效".to_string());
            }
            result.insert("sha256".to_string(), json!(sha256));
        }
    }
    if let Some(size) = update.get("size").and_then(Value::as_u64) {
        result.insert("size".to_string(), json!(size));
    }
    if let Some(notes) = update.get("releaseNotes").and_then(Value::as_str) {
        if !notes.trim().is_empty() {
            result.insert("releaseNotes".to_string(), json!(notes.trim()));
        }
    }
    Ok(Value::Object(result))
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    compare_versions(version_parts(candidate), version_parts(current)) == Ordering::Greater
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim_start_matches('v')
        .split(|character: char| character == '.' || character == '-' || character == '_')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn compare_versions(left: Vec<u64>, right: Vec<u64>) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let left_value = left.get(index).copied().unwrap_or(0);
        let right_value = right.get(index).copied().unwrap_or(0);
        let order = left_value.cmp(&right_value);
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}
