use crate::model_request_transport::{DisconnectConnector, DisconnectPeer, ModelBody};
use std::fmt;
use std::io::Read;
use std::time::Duration;
use ureq::unversioned::transport::{Connector, DefaultConnector};

pub const DEFAULT_MODEL_REQUEST_URL: &str = "https://pie.meetlife.com.cn/model-request";
const MAX_MODEL_RESPONSE_BYTES: u64 = 10 * 1024 * 1024;
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
        Self::new(&base_url, resolve_model_stream_timeout_secs())
    }

    pub fn new(base_url: &str, timeout_secs: u64) -> Result<Self, ModelRequestError> {
        let base_url = normalize_base_url(base_url)?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(timeout_secs.max(1))))
            .http_status_as_error(false)
            .build()
            .new_agent();
        Ok(Self { base_url, agent })
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
