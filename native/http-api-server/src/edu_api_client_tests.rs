use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport, DEFAULT_BACKEND_URL,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

struct RecordingTransport {
    requests: Mutex<Vec<EduApiRequest>>,
    response: Mutex<EduApiResponse>,
}

impl RecordingTransport {
    fn new(response: EduApiResponse) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            response: Mutex::new(response),
        }
    }
}

impl EduApiTransport for RecordingTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.requests.lock().unwrap().push(request);
        Ok(self.response.lock().unwrap().clone())
    }
}

struct BlockingTransport {
    calls: AtomicUsize,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}

impl EduApiTransport for BlockingTransport {
    fn send(&self, _request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.wait();
        self.release.wait();
        Ok(EduApiResponse {
            status: 200,
            headers: Vec::new(),
            body: b"{}".to_vec(),
        })
    }
}

fn ok_response() -> EduApiResponse {
    EduApiResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: b"{}".to_vec(),
    }
}

#[test]
fn default_backend_points_to_the_new_public_entrypoint() {
    assert_eq!(DEFAULT_BACKEND_URL, "https://pie.meetlife.com.cn/pi-api");
}

fn client(transport: Arc<dyn EduApiTransport>, max_concurrent: usize) -> EduApiClient {
    EduApiClient::new(
        "https://edu-api.example.test:9001/module/edu-api",
        transport,
        max_concurrent,
    )
    .unwrap()
}

fn request(method: &str, path: &str) -> EduApiRequest {
    EduApiRequest {
        method: method.to_string(),
        path: path.to_string(),
        body: None,
        access_token: None,
        request_id: "req-test-1".to_string(),
    }
}

#[test]
fn composes_only_configured_base_url_and_relative_path() {
    let transport = Arc::new(RecordingTransport::new(ok_response()));
    let client = client(transport.clone(), 2);

    client.request(request("GET", "/api/users/me")).unwrap();

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].path, "/api/users/me");
    assert_eq!(
        client.base_url(),
        "https://edu-api.example.test:9001/module/edu-api"
    );
    assert_eq!(
        client.url_for("/api/users/me").unwrap(),
        "https://edu-api.example.test:9001/module/edu-api/api/users/me"
    );
}

#[test]
fn forwards_one_bearer_token_without_logging_or_mutating_it() {
    let transport = Arc::new(RecordingTransport::new(ok_response()));
    let client = client(transport.clone(), 2);
    let mut input = request("GET", "/api/users/me");
    input.access_token = Some("access-secret".to_string());

    client.request(input).unwrap();

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].access_token.as_deref(), Some("access-secret"));
    let debug = format!("{:?}", requests[0]);
    assert!(!debug.contains("access-secret"));
}

#[test]
fn does_not_retry_a_post_when_upstream_returns_503() {
    let response = EduApiResponse {
        status: 503,
        headers: Vec::new(),
        body: br#"{"code":"upstream_busy","message":"busy"}"#.to_vec(),
    };
    let transport = Arc::new(RecordingTransport::new(response));
    let client = client(transport.clone(), 2);
    let mut input = request("POST", "/api/auth/login");
    input.body = Some("{}".to_string());

    let error = client.request(input).unwrap_err();

    assert!(
        matches!(error, EduApiError::Upstream { status: 503, ref code, .. } if code == "upstream_busy")
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn rejects_requests_when_global_concurrency_limit_is_reached() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let transport = Arc::new(BlockingTransport {
        calls: AtomicUsize::new(0),
        entered: entered.clone(),
        release: release.clone(),
    });
    let client = Arc::new(client(transport.clone(), 1));
    let first_client = client.clone();
    let first = thread::spawn(move || first_client.request(request("GET", "/api/users/me")));
    entered.wait();

    let second = client.request(request("GET", "/api/users/me"));
    assert!(matches!(second, Err(EduApiError::Overloaded)));
    release.wait();
    first.join().unwrap().unwrap();
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn preserves_upstream_status_code_and_response_body() {
    let response = EduApiResponse {
        status: 429,
        headers: vec![("retry-after".to_string(), "3".to_string())],
        body: r#"{"code":"rate_limited","message":"稍后重试"}"#.as_bytes().to_vec(),
    };
    let transport = Arc::new(RecordingTransport::new(response));
    let client = client(transport, 2);
    let error = client.request(request("GET", "/api/users/me")).unwrap_err();

    match error {
        EduApiError::Upstream {
            status, code, body, ..
        } => {
            assert_eq!(status, 429);
            assert_eq!(code, "rate_limited");
            assert_eq!(
                body,
                r#"{"code":"rate_limited","message":"稍后重试"}"#.as_bytes()
            );
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn rejects_absolute_paths_header_injection_and_invalid_path_characters() {
    let transport = Arc::new(RecordingTransport::new(ok_response()));
    let client = client(transport, 2);

    for path in [
        "https://other.example/api/users/me",
        "//other.example/api/users/me",
        "/api/users/../me",
        "/api/users/me\nX-Injected: yes",
        "/api/users/me with-space",
    ] {
        let result = client.request(request("GET", path));
        assert!(
            matches!(result, Err(EduApiError::InvalidPath(_))),
            "path: {path}"
        );
    }

    let mut header_injection = request("GET", "/api/users/me");
    header_injection.access_token = Some("token\r\nX-Leak: yes".to_string());
    assert!(matches!(
        client.request(header_injection),
        Err(EduApiError::InvalidHeader)
    ));
}

#[test]
fn client_constructor_rejects_invalid_base_url() {
    let transport = Arc::new(RecordingTransport::new(ok_response()));
    assert!(EduApiClient::new("not a url", transport, 1).is_err());
}

#[test]
fn stream_timeout_resolution_respects_max_300s_limit() {
    use super::edu_api_client::{
        resolve_api_timeout_secs, resolve_stream_timeout_secs, DEFAULT_API_TIMEOUT_SECS,
        DEFAULT_STREAM_TIMEOUT_SECS, MAX_STREAM_TIMEOUT_SECS,
    };

    // 默认值断言
    assert_eq!(DEFAULT_STREAM_TIMEOUT_SECS, 300);
    assert_eq!(DEFAULT_API_TIMEOUT_SECS, 30);
    assert_eq!(MAX_STREAM_TIMEOUT_SECS, 300);

    // 测试未设置环境变量时的默认值
    std::env::remove_var("COPIS_STREAM_TIMEOUT_SECS");
    std::env::remove_var("COPIS_MODEL_STREAM_TIMEOUT_SECS");
    std::env::remove_var("COPIS_EDU_API_TIMEOUT_SECS");
    assert_eq!(resolve_stream_timeout_secs(), 300);
    assert_eq!(resolve_api_timeout_secs(), 30);

    // 测试设置小于 300 的值
    std::env::set_var("COPIS_STREAM_TIMEOUT_SECS", "120");
    assert_eq!(resolve_stream_timeout_secs(), 120);

    std::env::set_var("COPIS_EDU_API_TIMEOUT_SECS", "45");
    assert_eq!(resolve_api_timeout_secs(), 45);

    // 测试设置大于 300 的值被限制在 300
    std::env::set_var("COPIS_STREAM_TIMEOUT_SECS", "600");
    assert_eq!(resolve_stream_timeout_secs(), 300);

    std::env::set_var("COPIS_EDU_API_TIMEOUT_SECS", "600");
    assert_eq!(resolve_api_timeout_secs(), 300);

    // 清理测试环境变量
    std::env::remove_var("COPIS_STREAM_TIMEOUT_SECS");
    std::env::remove_var("COPIS_EDU_API_TIMEOUT_SECS");
}

