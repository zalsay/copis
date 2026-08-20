use serde_json::Value;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub const DEFAULT_BACKEND_URL: &str = "https://pie.meetlife.com.cn/pi-api";
pub const MAX_EDU_REQUEST_BODY_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_EDU_RESPONSE_BODY_BYTES: u64 = 10 * 1024 * 1024;
pub const DEFAULT_MAX_CONCURRENT_REQUESTS: usize = 32;

pub struct EduApiRequest {
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub access_token: Option<String>,
    pub request_id: String,
}

impl fmt::Debug for EduApiRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EduApiRequest")
            .field("method", &self.method)
            .field("path", &self.path)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("request_id", &self.request_id)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EduApiResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub trait EduApiTransport: Send + Sync {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError>;
}

pub struct EduApiClient {
    base_url: String,
    transport: Arc<dyn EduApiTransport>,
    active_requests: Arc<AtomicUsize>,
    max_concurrent_requests: usize,
}

impl EduApiClient {
    pub fn new(
        base_url: &str,
        transport: Arc<dyn EduApiTransport>,
        max_concurrent_requests: usize,
    ) -> Result<Self, EduApiError> {
        let base_url = normalize_base_url(base_url)?;
        if max_concurrent_requests == 0 {
            return Err(EduApiError::InvalidConfiguration(
                "edu-api 并发上限必须大于 0".to_string(),
            ));
        }
        Ok(Self {
            base_url,
            transport,
            active_requests: Arc::new(AtomicUsize::new(0)),
            max_concurrent_requests,
        })
    }

    pub fn from_environment(max_concurrent_requests: usize) -> Result<Self, EduApiError> {
        let base_url = std::env::var("COPIS_BACKEND_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string());
        let transport = Arc::new(UreqEduApiTransport::new(&base_url)?);
        Self::new(&base_url, transport, max_concurrent_requests)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    pub fn from_auth_environment(max_concurrent_requests: usize) -> Result<Self, EduApiError> {
        let configured = std::env::var("COPIS_AUTH_ISSUER")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                let backend = std::env::var("COPIS_BACKEND_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string());
                let backend = backend.trim_end_matches('/');
                let issuer = backend
                    .strip_suffix("/module/edu-api")
                    .map(|root| format!("{root}/module/auth"))
                    .unwrap_or_else(|| format!("{backend}/module/auth"));
                Some(issuer)
            })
            .expect("OIDC issuer fallback must exist");
        let transport = Arc::new(UreqEduApiTransport::new(&configured)?);
        Self::new(&configured, transport, max_concurrent_requests)
    }

    pub fn url_for(&self, path: &str) -> Result<String, EduApiError> {
        validate_path(path)?;
        Ok(format!("{}{}", self.base_url, path))
    }

    pub fn request(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        validate_request(&request)?;
        let _permit =
            RequestPermit::try_acquire(self.active_requests.clone(), self.max_concurrent_requests)?;
        let response = self.transport.send(request)?;
        if (200..300).contains(&response.status) {
            return Ok(response);
        }

        let code = public_error_code(response.status, &response.body);
        let message = public_error_message(response.status, &response.body);
        Err(EduApiError::Upstream {
            status: response.status,
            code,
            message,
            body: response.body,
        })
    }
}

#[derive(Debug)]
pub enum EduApiError {
    InvalidConfiguration(String),
    InvalidPath(String),
    InvalidHeader,
    RequestBodyTooLarge,
    ResponseBodyTooLarge,
    Overloaded,
    Transport(String),
    Upstream {
        status: u16,
        code: String,
        message: String,
        body: Vec<u8>,
    },
}

impl fmt::Display for EduApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(message)
            | Self::InvalidPath(message)
            | Self::Transport(message) => formatter.write_str(message),
            Self::InvalidHeader => formatter.write_str("edu-api 请求头不正确"),
            Self::RequestBodyTooLarge => formatter.write_str("edu-api 请求体过大"),
            Self::ResponseBodyTooLarge => formatter.write_str("edu-api 响应体过大"),
            Self::Overloaded => formatter.write_str("edu-api 请求过多，请稍后重试"),
            Self::Upstream {
                status, message, ..
            } => write!(
                formatter,
                "edu-api 请求失败（HTTP {}）：{}",
                status, message
            ),
        }
    }
}

impl std::error::Error for EduApiError {}

struct RequestPermit {
    active_requests: Arc<AtomicUsize>,
}

impl RequestPermit {
    fn try_acquire(
        active_requests: Arc<AtomicUsize>,
        max_concurrent_requests: usize,
    ) -> Result<Self, EduApiError> {
        let mut current = active_requests.load(Ordering::Acquire);
        loop {
            if current >= max_concurrent_requests {
                return Err(EduApiError::Overloaded);
            }
            match active_requests.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Self { active_requests }),
                Err(next) => current = next,
            }
        }
    }
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.active_requests.fetch_sub(1, Ordering::Release);
    }
}

struct UreqEduApiTransport {
    base_url: String,
    agent: ureq::Agent,
}

impl UreqEduApiTransport {
    fn new(base_url: &str) -> Result<Self, EduApiError> {
        let base_url = normalize_base_url(base_url)?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .new_agent();
        if let Some(proxy) = agent.config().proxy() {
            eprintln!(
                "[HTTP API][edu-api] transport 初始化 base_url={} proxy={}://{}:{} from_env={}",
                base_url,
                proxy.protocol(),
                proxy.host(),
                proxy.port(),
                proxy.is_from_env()
            );
        } else {
            eprintln!(
                "[HTTP API][edu-api] transport 初始化 base_url={} proxy=none",
                base_url
            );
        }
        Ok(Self { base_url, agent })
    }
}

impl EduApiTransport for UreqEduApiTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        let url = format!("{}{}", self.base_url, request.path);
        let diagnostic = request.request_id.starts_with("auth-");
        if diagnostic {
            eprintln!(
                "[HTTP API][edu-api] 请求开始 request_id={} method={} path={}",
                request.request_id, request.method, request.path
            );
        }
        let mut builder = ureq::http::Request::builder()
            .method(request.method.as_str())
            .uri(&url);
        builder = builder.header("Accept", "application/json");
        if request.body.is_some() {
            let content_type = if request.path == "/oauth/token" {
                "application/x-www-form-urlencoded"
            } else {
                "application/json"
            };
            builder = builder.header("Content-Type", content_type);
        }
        if let Some(access_token) = request.access_token {
            builder = builder.header("Authorization", format!("Bearer {}", access_token));
        }
        let http_request = builder
            .body(request.body.unwrap_or_default())
            .map_err(|_| EduApiError::InvalidConfiguration("edu-api 请求构造失败".to_string()))?;
        let mut response = self.agent.run(http_request).map_err(|error| {
            let message = sanitize_transport_error(&error.to_string());
            if diagnostic {
                eprintln!(
                    "[HTTP API][edu-api] 请求传输失败 request_id={} error={}",
                    request.request_id, message
                );
            }
            EduApiError::Transport(message)
        })?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_EDU_RESPONSE_BODY_BYTES)
            .read_to_vec()
            .map_err(|error| {
                if error.to_string().to_ascii_lowercase().contains("limit") {
                    EduApiError::ResponseBodyTooLarge
                } else {
                    EduApiError::Transport("读取 edu-api 响应失败".to_string())
                }
            })?;
        if diagnostic {
            eprintln!(
                "[HTTP API][edu-api] 请求完成 request_id={} status={} body_bytes={}",
                request.request_id,
                status,
                body.len()
            );
        }
        Ok(EduApiResponse {
            status,
            headers,
            body,
        })
    }
}

fn normalize_base_url(value: &str) -> Result<String, EduApiError> {
    let value = value.trim().trim_end_matches('/');
    let valid_scheme = value.starts_with("http://") || value.starts_with("https://");
    if !valid_scheme || value.len() <= "https://".len() {
        return Err(EduApiError::InvalidConfiguration(
            "COPIS_BACKEND_URL 不是有效的 HTTP URL".to_string(),
        ));
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || value.contains('?')
        || value.contains('#')
    {
        return Err(EduApiError::InvalidConfiguration(
            "COPIS_BACKEND_URL 包含不允许的字符".to_string(),
        ));
    }
    let authority = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split('/').next())
        .unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || authority.contains(':') && authority.ends_with(':')
    {
        return Err(EduApiError::InvalidConfiguration(
            "COPIS_BACKEND_URL 主机不正确".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn validate_request(request: &EduApiRequest) -> Result<(), EduApiError> {
    let method = request.method.as_str();
    if method.is_empty() || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(EduApiError::InvalidConfiguration(
            "edu-api 请求方法不正确".to_string(),
        ));
    }
    validate_path(&request.path)?;
    if request.body.as_ref().map(|body| body.len()).unwrap_or(0) > MAX_EDU_REQUEST_BODY_BYTES {
        return Err(EduApiError::RequestBodyTooLarge);
    }
    if request
        .access_token
        .as_deref()
        .map(|token| token.contains('\r') || token.contains('\n'))
        .unwrap_or(false)
    {
        return Err(EduApiError::InvalidHeader);
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(EduApiError::InvalidConfiguration(
            "edu-api request id 不正确".to_string(),
        ));
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), EduApiError> {
    if path.is_empty() || !path.starts_with('/') || path.starts_with("//") {
        return Err(EduApiError::InvalidPath(
            "edu-api 路径必须是相对路径".to_string(),
        ));
    }
    if path
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || path.contains('#')
    {
        return Err(EduApiError::InvalidPath(
            "edu-api 路径包含不允许的字符".to_string(),
        ));
    }
    let (pathname, _) = path.split_once('?').unwrap_or((path, ""));
    if pathname
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(EduApiError::InvalidPath(
            "edu-api 路径包含不安全片段".to_string(),
        ));
    }
    if !path.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'/' | b'_' | b'-' | b'.' | b'?' | b'=' | b'&' | b'%' | b'+' | b':' | b',' | b'~'
            )
    }) {
        return Err(EduApiError::InvalidPath(
            "edu-api 路径包含不允许的字符".to_string(),
        ));
    }
    Ok(())
}

fn public_error_code(status: u16, body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|code| !code.trim().is_empty() && code.len() <= 96)
        .unwrap_or_else(|| match status {
            401 => "unauthorized".to_string(),
            403 => "forbidden".to_string(),
            404 => "not_found".to_string(),
            429 => "rate_limited".to_string(),
            500..=599 => "upstream_error".to_string(),
            _ => "upstream_request_failed".to_string(),
        })
}

fn public_error_message(status: u16, body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .map(|message| message.chars().take(512).collect())
        .unwrap_or_else(|| format!("edu-api 请求失败（HTTP {}）", status))
}

fn sanitize_transport_error(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect()
}
