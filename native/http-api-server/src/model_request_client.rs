use crate::model_request_transport::{DisconnectConnector, DisconnectPeer, ModelBody};
use std::fmt;
use std::io::Read;
use std::time::{Duration, Instant};
use ureq::unversioned::transport::{Connector, DefaultConnector};

pub const DEFAULT_MODEL_REQUEST_URL: &str = "https://pie.meetlife.com.cn/model-request";
const MAX_MODEL_RESPONSE_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_MODEL_PROBE_TIMEOUT_MS: u64 = 6_000;
pub const DEFAULT_MODEL_STREAM_TIMEOUT_SECS: u64 = 960;
pub const MAX_MODEL_STREAM_TIMEOUT_SECS: u64 = 960;

pub struct ModelRequestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ModelBody,
}

#[derive(Debug)]
pub enum ModelRequestError {
    InvalidConfiguration(String),
    InvalidRequest,
    Transport(String),
}

impl fmt::Display for ModelRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(message) | Self::Transport(message) => {
                formatter.write_str(message)
            }
            Self::InvalidRequest => formatter.write_str("模型请求不正确"),
        }
    }
}

#[derive(Clone)]
pub struct ModelRequestClient {
    base_url: String,
    agent: ureq::Agent,
}

impl ModelRequestClient {
    pub fn from_environment() -> Result<Self, ModelRequestError> {
        let base_url = std::env::var("COPIS_MODEL_REQUEST_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL_REQUEST_URL.to_string());
        let candidates = std::env::var("COPIS_MODEL_REQUEST_BASE_URLS")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                serde_json::from_str::<Vec<String>>(&value).map_err(|_| {
                    ModelRequestError::InvalidConfiguration(
                        "COPIS_MODEL_REQUEST_BASE_URLS 不是有效的 JSON 地址数组".to_string(),
                    )
                })
            })
            .transpose()?;
        let stream_timeout = resolve_model_stream_timeout_secs();
        let Some(mut candidates) = candidates else {
            return Self::new(&base_url, stream_timeout);
        };
        if !candidates
            .iter()
            .any(|candidate| candidate.trim() == base_url)
        {
            candidates.insert(0, base_url);
        }
        let selected = select_direct_model_base_url(&candidates, resolve_model_probe_timeout_ms())?;
        Self::new(&selected, stream_timeout)
    }

    pub fn new(base_url: &str, timeout_secs: u64) -> Result<Self, ModelRequestError> {
        let base_url = normalize_base_url(base_url)?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(timeout_secs.max(1))))
            .http_status_as_error(false)
            .proxy(None)
            .build()
            .new_agent();
        Ok(Self { base_url, agent })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    #[cfg(test)]
    pub fn proxy(&self) -> Option<&ureq::Proxy> {
        self.agent.config().proxy()
    }

    pub fn open(
        &self,
        method: &str,
        path: &str,
        body: &str,
        access_token: &str,
        headers: Vec<(String, String)>,
    ) -> Result<ModelRequestResponse, ModelRequestError> {
        if method != "GET" && method != "POST"
            || !valid_path(path)
            || access_token.contains(['\r', '\n'])
        {
            return Err(ModelRequestError::InvalidRequest);
        }
        let mut builder = ureq::http::Request::builder()
            .method(method)
            .uri(format!("{}{}", self.base_url, path))
            .header("Accept", "application/json, text/event-stream")
            .header("Authorization", format!("Bearer {access_token}"));
        if method == "POST" {
            builder = builder.header("Content-Type", "application/json");
        }
        for (name, value) in headers {
            if name.is_empty()
                || name
                    .bytes()
                    .any(|byte| !byte.is_ascii() || byte.is_ascii_control() || byte == b' ')
                || value.contains(['\r', '\n'])
            {
                return Err(ModelRequestError::InvalidRequest);
            }
            builder = builder.header(name, value);
        }
        let request = builder
            .body(body.to_string())
            .map_err(|_| ModelRequestError::InvalidRequest)?;
        let peer = DisconnectPeer::default();
        let agent = ureq::Agent::with_parts(
            self.agent.config().clone(),
            DefaultConnector::default().chain(DisconnectConnector(peer.clone())),
            ureq::unversioned::resolver::DefaultResolver::default(),
        );
        let response = agent
            .run(request)
            .map_err(|error| ModelRequestError::Transport(sanitize_error(&error.to_string())))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let body = LimitedReader::new(response.into_body().into_reader(), MAX_MODEL_RESPONSE_BYTES);
        Ok(ModelRequestResponse {
            status,
            headers,
            body: ModelBody::new(Box::new(body), peer),
        })
    }
}

fn resolve_model_probe_timeout_ms() -> u64 {
    std::env::var("COPIS_MODEL_REQUEST_PROBE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(DEFAULT_MODEL_PROBE_TIMEOUT_MS))
        .unwrap_or(DEFAULT_MODEL_PROBE_TIMEOUT_MS)
}

fn select_direct_model_base_url(
    candidates: &[String],
    timeout_ms: u64,
) -> Result<String, ModelRequestError> {
    let mut normalized = Vec::new();
    for candidate in candidates {
        let candidate = normalize_base_url(candidate)?;
        if !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }
    let fallback = normalized.last().cloned().ok_or_else(|| {
        ModelRequestError::InvalidConfiguration(
            "COPIS_MODEL_REQUEST_BASE_URLS 不能为空".to_string(),
        )
    })?;
    let started = Instant::now();
    let total_timeout = Duration::from_millis(timeout_ms.max(1));
    for candidate in normalized {
        let Some(remaining) = total_timeout.checked_sub(started.elapsed()) else {
            break;
        };
        if direct_health_probe(&candidate, remaining) {
            return Ok(candidate);
        }
    }
    Ok(fallback)
}

fn direct_health_probe(base_url: &str, timeout: Duration) -> bool {
    let Some(url) = health_probe_url(base_url) else {
        return false;
    };
    let request = match ureq::http::Request::builder()
        .method("GET")
        .uri(url)
        .header("Accept", "application/json")
        .body(())
    {
        Ok(request) => request,
        Err(_) => return false,
    };
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout.max(Duration::from_millis(1))))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent();
    agent
        .run(request)
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn health_probe_url(base_url: &str) -> Option<String> {
    if base_url.ends_with("/model-request") {
        return Some(format!("{base_url}/health"));
    }
    let (scheme, rest) = base_url.split_once("://")?;
    let authority = rest.split('/').next()?;
    Some(format!("{scheme}://{authority}/health"))
}

fn normalize_base_url(value: &str) -> Result<String, ModelRequestError> {
    let value = value.trim().trim_end_matches('/');
    if !(value.starts_with("https://") || value.starts_with("http://"))
        || value.contains(['?', '#', '@'])
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(ModelRequestError::InvalidConfiguration(
            "COPIS_MODEL_REQUEST_BASE_URL 不是有效的 HTTP URL".to_string(),
        ));
    }
    let authority = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split('/').next())
        .unwrap_or_default();
    if authority.is_empty() {
        return Err(ModelRequestError::InvalidConfiguration(
            "COPIS_MODEL_REQUEST_BASE_URL 主机不正确".to_string(),
        ));
    }
    Ok(value.to_string())
}

struct LimitedReader<R> {
    inner: R,
    remaining: u64,
}

impl<R> LimitedReader<R> {
    fn new(inner: R, remaining: u64) -> Self {
        Self { inner, remaining }
    }
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            let mut probe = [0_u8; 1];
            return match self.inner.read(&mut probe) {
                Ok(0) => Ok(0),
                Ok(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "模型响应过大",
                )),
                Err(error) => Err(error),
            };
        }
        let limit = buffer.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buffer[..limit])?;
        self.remaining = self.remaining.saturating_sub(read as u64);
        Ok(read)
    }
}

pub fn resolve_model_stream_timeout_secs() -> u64 {
    std::env::var("COPIS_MODEL_STREAM_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_MODEL_STREAM_TIMEOUT_SECS))
        .unwrap_or(DEFAULT_MODEL_STREAM_TIMEOUT_SECS)
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("..")
        && !path
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

fn sanitize_error(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect()
}
