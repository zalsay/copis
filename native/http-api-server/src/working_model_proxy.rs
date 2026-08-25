use crate::agent_files::tokens_equal;
use crate::auth_session::{AuthError, AuthSession};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPABILITY_TTL_SECS: u64 = 2 * 60 * 60;
const MAX_MODEL_REQUEST_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkingModelCapability {
    pub capability: String,
    pub session_id: String,
    pub model_id: String,
    pub expires_at: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WorkingModelResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkingModelError {
    InvalidRequest(String),
    Unauthorized,
    CapabilityExpired,
    CapabilityMismatch,
    Upstream {
        status: u16,
        code: String,
        message: String,
    },
    InvalidResponse,
}

struct StoredCapability {
    capability: WorkingModelCapability,
}

pub struct WorkingModelProxy {
    auth: Arc<AuthSession>,
    capabilities: Mutex<HashMap<String, StoredCapability>>,
}

impl WorkingModelProxy {
    pub fn new(auth: Arc<AuthSession>) -> Self {
        Self {
            auth,
            capabilities: Mutex::new(HashMap::new()),
        }
    }

    pub fn issue(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> Result<WorkingModelCapability, WorkingModelError> {
        validate_identifier(session_id, "session_id", 512)?;
        validate_identifier(model_id, "model_id", 256)?;
        let capability = generate_capability()?;
        let value = WorkingModelCapability {
            capability,
            session_id: session_id.to_string(),
            model_id: model_id.to_string(),
            expires_at: now_secs().saturating_add(CAPABILITY_TTL_SECS),
        };
        self.capabilities.lock().unwrap().insert(
            session_id.to_string(),
            StoredCapability {
                capability: value.clone(),
            },
        );
        Ok(value)
    }

    pub fn revoke(&self, session_id: &str) {
        self.capabilities.lock().unwrap().remove(session_id);
    }

    pub fn proxy_with_capability(
        &self,
        capability: &str,
        request_body: &[u8],
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        let session_id = {
            let capabilities = self.capabilities.lock().unwrap();
            capabilities
                .values()
                .find(|stored| tokens_equal(&stored.capability.capability, capability))
                .map(|stored| stored.capability.session_id.clone())
                .ok_or(WorkingModelError::Unauthorized)?
        };
        self.proxy(&session_id, capability, request_body)
    }

    /// Electron 主进程的隐藏回合使用内部令牌进入这里；不创建或暴露 Pi Worker capability。
    pub fn proxy_internal(
        &self,
        request_body: &[u8],
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        validate_model_request(request_body)?;
        self.forward(request_body)
    }

    pub fn proxy(
        &self,
        session_id: &str,
        capability: &str,
        request_body: &[u8],
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        let model_id = validate_model_request(request_body)?;
        let stored = self
            .capabilities
            .lock()
            .unwrap()
            .get(session_id)
            .map(|value| value.capability.clone())
            .ok_or(WorkingModelError::Unauthorized)?;
        if !tokens_equal(&stored.capability, capability) {
            return Err(WorkingModelError::CapabilityMismatch);
        }
        if stored.expires_at <= now_secs() {
            return Err(WorkingModelError::CapabilityExpired);
        }
        if stored.model_id != model_id {
            return Err(WorkingModelError::CapabilityMismatch);
        }

        self.forward(request_body)
    }

    fn forward(&self, request_body: &[u8]) -> Result<WorkingModelResponse, WorkingModelError> {
        let response = self
            .auth
            .authenticated_request(
                "POST",
                "/api/internal/working-model/v1/responses",
                Some(String::from_utf8_lossy(request_body).into_owned()),
            )
            .map_err(map_auth_error)?;
        let content_type = response
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.clone());
        Ok(WorkingModelResponse {
            status: response.status,
            body: response.body,
            content_type,
        })
    }
}

fn validate_model_request(request_body: &[u8]) -> Result<String, WorkingModelError> {
    if request_body.len() > MAX_MODEL_REQUEST_BYTES {
        return Err(WorkingModelError::InvalidRequest(
            "模型请求体过大".to_string(),
        ));
    }
    let request = serde_json::from_slice::<Value>(request_body).map_err(|_| {
        WorkingModelError::InvalidRequest("模型请求体不是有效 JSON".to_string())
    })?;
    request
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| WorkingModelError::InvalidRequest("模型请求缺少 model".to_string()))
}

fn map_auth_error(error: AuthError) -> WorkingModelError {
    match error {
        AuthError::NotAuthenticated | AuthError::RefreshFailed => WorkingModelError::Unauthorized,
        AuthError::Upstream {
            status,
            code,
            message,
        } => WorkingModelError::Upstream {
            status,
            code,
            message,
        },
        AuthError::Busy => WorkingModelError::Upstream {
            status: 429,
            code: "auth_operation_busy".to_string(),
            message: "认证操作正在进行，请稍后重试".to_string(),
        },
        AuthError::Network(message) => WorkingModelError::Upstream {
            status: 504,
            code: "upstream_network_error".to_string(),
            message: format!("连接 Copis Working 服务器网络异常或超时：{}", message),
        },
        AuthError::InvalidInput(message) => WorkingModelError::InvalidRequest(message),
        _ => WorkingModelError::InvalidResponse,
    }
}

fn validate_identifier(
    value: &str,
    name: &str,
    max_length: usize,
) -> Result<(), WorkingModelError> {
    if value.trim().is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(WorkingModelError::InvalidRequest(format!(
            "{} 不正确",
            name
        )));
    }
    Ok(())
}

fn generate_capability() -> Result<String, WorkingModelError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| WorkingModelError::InvalidResponse)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl std::fmt::Display for WorkingModelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::Unauthorized => formatter.write_str("Working 模型代理未授权"),
            Self::CapabilityExpired => formatter.write_str("模型会话已过期，请直接发送「继续任务」或点击重试"),
            Self::CapabilityMismatch => formatter.write_str("Working 模型代理 capability 不匹配"),
            Self::Upstream {
                status, message, ..
            } => {
                write!(
                    formatter,
                    "Working 模型请求失败（HTTP {}）：{}",
                    status, message
                )
            }
            Self::InvalidResponse => formatter.write_str("模型服务响应异常，请直接发送「继续任务」或点击重试"),
        }
    }
}

impl std::error::Error for WorkingModelError {}
