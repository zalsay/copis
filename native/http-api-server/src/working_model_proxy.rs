use crate::agent_files::tokens_equal;
use crate::auth_session::{AuthError, AuthSession};
use crate::model_request_client::{ModelRequestClient, ModelRequestError, ModelRequestResponse};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPABILITY_TTL_SECS: u64 = 2 * 60 * 60;
const MAX_MODEL_REQUEST_BYTES: usize = 8 * 1024 * 1024;

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

pub struct WorkingModelStreamResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: crate::model_request_transport::ModelBody,
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

struct StoredDshCapability {
    capability: String,
    reasoning_effort: Option<String>,
}

pub struct WorkingModelProxy {
    auth: Arc<AuthSession>,
    model_client: ModelRequestClient,
    capabilities: Mutex<HashMap<String, StoredCapability>>,
    dsh_capabilities: Mutex<Vec<StoredDshCapability>>,
}

impl WorkingModelProxy {
    pub fn new(auth: Arc<AuthSession>) -> Result<Self, WorkingModelError> {
        Ok(Self::with_model_client(
            auth,
            ModelRequestClient::from_environment().map_err(map_model_error)?,
        ))
    }

    pub fn with_model_client(auth: Arc<AuthSession>, model_client: ModelRequestClient) -> Self {
        Self {
            auth,
            model_client,
            capabilities: Mutex::new(HashMap::new()),
            dsh_capabilities: Mutex::new(Vec::new()),
        }
    }

    /// DSH 使用独立的长期 capability；它仅能访问 Working 模型代理，不持有用户登录凭据。
    /// DSH capability 在签发时固化 Copis 的思考深度，避免运行中的 DSH 被配置变更影响。
    pub fn issue_dsh_capability(
        &self,
        reasoning_effort: Option<&str>,
    ) -> Result<String, WorkingModelError> {
        let capability = generate_capability()?;
        let reasoning_effort = reasoning_effort
            .map(normalize_reasoning_effort)
            .transpose()?;
        self.dsh_capabilities
            .lock()
            .unwrap()
            .push(StoredDshCapability {
                capability: capability.clone(),
                reasoning_effort,
            });
        Ok(capability)
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
        let dsh_reasoning_effort = self
            .dsh_capabilities
            .lock()
            .unwrap()
            .iter()
            .find(|stored| tokens_equal(&stored.capability, capability))
            .map(|stored| stored.reasoning_effort.clone());
        if let Some(reasoning_effort) = dsh_reasoning_effort {
            validate_model_request(request_body)?;
            let request_body = inject_reasoning_effort(request_body, reasoning_effort.as_deref())?;
            return self.forward(&request_body, None);
        }
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
        self.forward(request_body, None)
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

        self.forward(request_body, None)
    }

    pub fn proxy_stream_with_capability(
        &self,
        capability: &str,
        request_body: &[u8],
        idempotency_key: Option<&str>,
    ) -> Result<WorkingModelStreamResponse, WorkingModelError> {
        let dsh_reasoning_effort = self
            .dsh_capabilities
            .lock()
            .unwrap()
            .iter()
            .find(|stored| tokens_equal(&stored.capability, capability))
            .map(|stored| stored.reasoning_effort.clone());
        if let Some(reasoning_effort) = dsh_reasoning_effort {
            validate_model_request(request_body)?;
            let request_body = inject_reasoning_effort(request_body, reasoning_effort.as_deref())?;
            return self.open_stream(&request_body, idempotency_key);
        }
        let session_id = {
            let capabilities = self.capabilities.lock().unwrap();
            capabilities
                .values()
                .find(|stored| tokens_equal(&stored.capability.capability, capability))
                .map(|stored| stored.capability.session_id.clone())
                .ok_or(WorkingModelError::Unauthorized)?
        };
        self.validate_capability_request(&session_id, capability, request_body)?;
        self.open_stream(request_body, idempotency_key)
    }

    pub fn proxy_stream_internal(
        &self,
        request_body: &[u8],
        idempotency_key: Option<&str>,
    ) -> Result<WorkingModelStreamResponse, WorkingModelError> {
        validate_model_request(request_body)?;
        self.open_stream(request_body, idempotency_key)
    }

    pub fn model_json_get(&self, path: &str) -> Result<Value, WorkingModelError> {
        if path != "/first-token-latencies" && !path.starts_with("/config?alias=") {
            return Err(WorkingModelError::InvalidRequest(
                "模型请求路径不正确".to_string(),
            ));
        }
        let token = self.auth.current_access_token().map_err(map_auth_error)?;
        let response = self
            .model_client
            .open("GET", path, "", &token, Vec::new())
            .map_err(map_model_error)?;
        let mut response = if response.status == 401 {
            let token = self.auth.refresh_single_flight().map_err(map_auth_error)?;
            self.model_client
                .open("GET", path, "", &token, Vec::new())
                .map_err(map_model_error)?
        } else {
            response
        };
        let mut body = Vec::new();
        response
            .body
            .read_to_end(&mut body)
            .map_err(|_| WorkingModelError::InvalidResponse)?;
        if !(200..300).contains(&response.status) {
            return Err(WorkingModelError::Upstream {
                status: response.status,
                code: "model_request_failed".to_string(),
                message: String::from_utf8_lossy(&body).chars().take(512).collect(),
            });
        }
        serde_json::from_slice(&body).map_err(|_| WorkingModelError::InvalidResponse)
    }

    fn validate_capability_request(
        &self,
        session_id: &str,
        capability: &str,
        request_body: &[u8],
    ) -> Result<(), WorkingModelError> {
        let model_id = validate_model_request(request_body)?;
        let stored = self
            .capabilities
            .lock()
            .unwrap()
            .get(session_id)
            .map(|value| value.capability.clone())
            .ok_or(WorkingModelError::Unauthorized)?;
        if !tokens_equal(&stored.capability, capability) || stored.model_id != model_id {
            return Err(WorkingModelError::CapabilityMismatch);
        }
        if stored.expires_at <= now_secs() {
            return Err(WorkingModelError::CapabilityExpired);
        }
        Ok(())
    }

    fn forward(
        &self,
        request_body: &[u8],
        idempotency_key: Option<&str>,
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        let mut headers = vec![(
            "X-Working-Model-Source-Type".to_string(),
            "copis-agent-model".to_string(),
        )];
        if let Some(key) = idempotency_key {
            headers.push(("Idempotency-Key".to_string(), key.to_string()));
        }
        let response = self
            .auth
            .authenticated_request_with_headers(
                "POST",
                "/api/internal/working-model/v1/responses",
                Some(String::from_utf8_lossy(request_body).into_owned()),
                headers,
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

    fn open_stream(
        &self,
        request_body: &[u8],
        supplied_key: Option<&str>,
    ) -> Result<WorkingModelStreamResponse, WorkingModelError> {
        let idempotency_key = supplied_key
            .map(str::to_string)
            .unwrap_or_else(generate_idempotency_key);
        validate_idempotency_key(&idempotency_key)?;
        let body = String::from_utf8_lossy(request_body).into_owned();
        let response = self.open_with_current_token(&body, &idempotency_key)?;
        let response = if response.status == 401 {
            let token = self.auth.refresh_single_flight().map_err(map_auth_error)?;
            self.open_with_token(&body, &token, &idempotency_key)?
        } else {
            response
        };
        let content_type = response
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.clone());
        Ok(WorkingModelStreamResponse {
            status: response.status,
            body: response.body,
            content_type,
        })
    }

    fn open_with_current_token(
        &self,
        body: &str,
        key: &str,
    ) -> Result<ModelRequestResponse, WorkingModelError> {
        let token = self.auth.current_access_token().map_err(map_auth_error)?;
        self.open_with_token(body, &token, key)
    }

    fn open_with_token(
        &self,
        body: &str,
        token: &str,
        key: &str,
    ) -> Result<ModelRequestResponse, WorkingModelError> {
        self.model_client
            .open(
                "POST",
                "/v1/responses",
                body,
                token,
                vec![
                    (
                        "X-Working-Model-Source-Type".to_string(),
                        "copis-agent-model".to_string(),
                    ),
                    ("Idempotency-Key".to_string(), key.to_string()),
                ],
            )
            .map_err(map_model_error)
    }
}

fn generate_idempotency_key() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).expect("系统随机数不可用");
    format!(
        "copis-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn validate_idempotency_key(value: &str) -> Result<(), WorkingModelError> {
    if (16..=128).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        Ok(())
    } else {
        Err(WorkingModelError::InvalidRequest(
            "Idempotency-Key 不正确".to_string(),
        ))
    }
}

fn map_model_error(error: ModelRequestError) -> WorkingModelError {
    match error {
        ModelRequestError::InvalidRequest => {
            WorkingModelError::InvalidRequest("模型请求不正确".to_string())
        }
        ModelRequestError::InvalidConfiguration(message)
        | ModelRequestError::Transport(message) => WorkingModelError::Upstream {
            status: 504,
            code: "model_request_network_error".to_string(),
            message,
        },
    }
}

fn normalize_reasoning_effort(value: &str) -> Result<String, WorkingModelError> {
    match value.trim() {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => {
            Ok(value.trim().to_string())
        }
        _ => Err(WorkingModelError::InvalidRequest(
            "DSH 思考深度不正确".to_string(),
        )),
    }
}

fn inject_reasoning_effort(
    request_body: &[u8],
    reasoning_effort: Option<&str>,
) -> Result<Vec<u8>, WorkingModelError> {
    let Some(reasoning_effort) = reasoning_effort else {
        return Ok(request_body.to_vec());
    };
    let mut request = serde_json::from_slice::<Value>(request_body)
        .map_err(|_| WorkingModelError::InvalidRequest("模型请求体不是有效 JSON".to_string()))?;
    let object = request
        .as_object_mut()
        .ok_or_else(|| WorkingModelError::InvalidRequest("模型请求体不是 JSON 对象".to_string()))?;
    let mut reasoning = object
        .get("reasoning")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let has_explicit_effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if reasoning_effort == "none" || !has_explicit_effort {
        reasoning.insert(
            "effort".to_string(),
            Value::String(reasoning_effort.to_string()),
        );
    }
    object.insert("reasoning".to_string(), Value::Object(reasoning));
    serde_json::to_vec(&request).map_err(|_| WorkingModelError::InvalidResponse)
}

fn validate_model_request(request_body: &[u8]) -> Result<String, WorkingModelError> {
    if request_body.len() > MAX_MODEL_REQUEST_BYTES {
        return Err(WorkingModelError::InvalidRequest(
            "模型请求体过大".to_string(),
        ));
    }
    let request = serde_json::from_slice::<Value>(request_body)
        .map_err(|_| WorkingModelError::InvalidRequest("模型请求体不是有效 JSON".to_string()))?;
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
            Self::CapabilityExpired => {
                formatter.write_str("模型会话已过期，请直接发送「继续任务」或点击重试")
            }
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
            Self::InvalidResponse => {
                formatter.write_str("模型服务响应异常，请直接发送「继续任务」或点击重试")
            }
        }
    }
}

impl std::error::Error for WorkingModelError {}

#[cfg(test)]
mod request_size_tests {
    use super::{validate_model_request, WorkingModelError};

    #[test]
    fn accepts_eight_mib_and_rejects_one_byte_over() {
        let mut body = br#"{"model":"fast"}"#.to_vec();
        body.resize(8 * 1024 * 1024, b' ');
        assert_eq!(validate_model_request(&body).unwrap(), "fast");
        body.push(b' ');
        assert!(matches!(
            validate_model_request(&body),
            Err(WorkingModelError::InvalidRequest(message)) if message == "模型请求体过大"
        ));
    }
}
