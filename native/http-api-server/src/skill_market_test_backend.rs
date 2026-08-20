use super::{SkillMarketError, WorkingBackend};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const TEST_REMOTE_BODY_BYTES: u64 = 10 * 1024 * 1024;

pub(crate) fn backend_env_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) struct TestBackend {
    access_token: Mutex<Option<String>>,
}

impl TestBackend {
    pub(crate) fn new(token: Option<String>) -> Self {
        Self {
            access_token: Mutex::new(token.filter(|value| !value.trim().is_empty())),
        }
    }

    pub(crate) fn set_token(&self, token: Option<String>) {
        *self.access_token.lock().unwrap() = token.filter(|value| !value.trim().is_empty());
    }

    fn token(&self) -> Option<String> {
        self.access_token.lock().unwrap().clone()
    }
}

impl WorkingBackend for TestBackend {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value, SkillMarketError> {
        let token = self
            .token()
            .ok_or_else(|| SkillMarketError::new(401, "unauthorized", "请先登录 Copis Working"))?;
        legacy_request(method, path, Some(&token), body)
    }

    fn request_with_capability(
        &self,
        method: &str,
        path: &str,
        capability: &str,
        body: Option<&str>,
    ) -> Result<Value, SkillMarketError> {
        legacy_request(method, path, Some(capability), body)
    }
}

fn legacy_request(
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Result<Value, SkillMarketError> {
    let base = std::env::var("COPIS_BACKEND_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:51730".to_string())
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}{}", base, path);
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = match method {
        "GET" => {
            let mut request = agent.get(&url).header("Accept", "application/json");
            if let Some(bearer) = bearer {
                request = request.header("Authorization", format!("Bearer {}", bearer));
            }
            request.call()
        }
        "POST" => {
            let mut request = agent
                .post(&url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json");
            if let Some(bearer) = bearer {
                request = request.header("Authorization", format!("Bearer {}", bearer));
            }
            request.send(body.unwrap_or("{}"))
        }
        "DELETE" => {
            let mut request = agent.delete(&url).header("Accept", "application/json");
            if let Some(bearer) = bearer {
                request = request.header("Authorization", format!("Bearer {}", bearer));
            }
            request.call()
        }
        _ => {
            return Err(SkillMarketError::new(
                405,
                "method_not_allowed",
                "技能市场请求方法不支持",
            ))
        }
    }
    .map_err(|error| {
        SkillMarketError::new(
            502,
            "working_backend_unavailable",
            format!("Working 后端请求失败: {}", error),
        )
    })?;

    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(TEST_REMOTE_BODY_BYTES)
        .read_to_string()
        .map_err(|_| {
            SkillMarketError::new(502, "working_backend_unavailable", "读取 Working 响应失败")
        })?;
    let payload = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()))
    };
    if !(200..300).contains(&status) {
        let message = payload
            .get("error")
            .or_else(|| payload.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Working 后端请求失败")
            .to_string();
        let code = payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("working_backend_error")
            .to_string();
        return Err(SkillMarketError::new(status, code, message));
    }
    Ok(payload)
}
