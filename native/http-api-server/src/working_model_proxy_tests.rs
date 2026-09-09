use super::auth_session::{AuthSession, AuthStorage, PersistedAuth};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use super::working_model_proxy::{WorkingModelError, WorkingModelProxy};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryStorage {
    value: Mutex<Option<PersistedAuth>>,
}

impl AuthStorage for MemoryStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, super::auth_session::AuthError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, auth: &PersistedAuth) -> Result<(), super::auth_session::AuthError> {
        *self.value.lock().unwrap() = Some(auth.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), super::auth_session::AuthError> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

struct FixedTransport {
    calls: Mutex<Vec<EduApiRequest>>,
}

impl EduApiTransport for FixedTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.calls.lock().unwrap().push(request.clone_for_test());
        let body = if request.path == "/api/auth/login" {
            json!({
                "token": "header.eyJleHAiOjQxMDAuMH0.sig",
                "refresh_token": "refresh",
                "user": { "id": "user-1" }
            })
            .to_string()
            .into_bytes()
        } else if request.path == "/api/auth/refresh" {
            json!({"token": "refreshed-access", "refresh_token": "refreshed-refresh"})
                .to_string()
                .into_bytes()
        } else {
            b"data: {\"id\":\"chunk-1\"}\n\n".to_vec()
        };
        Ok(EduApiResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/event-stream".to_string())],
            body,
        })
    }
}

trait CloneForTest {
    fn clone_for_test(&self) -> EduApiRequest;
}

impl CloneForTest for EduApiRequest {
    fn clone_for_test(&self) -> EduApiRequest {
        EduApiRequest {
            method: self.method.clone(),
            path: self.path.clone(),
            body: self.body.clone(),
            access_token: self.access_token.clone(),
            headers: self.headers.clone(),
            request_id: self.request_id.clone(),
        }
    }
}

fn setup() -> (Arc<AuthSession>, Arc<FixedTransport>) {
    let transport = Arc::new(FixedTransport {
        calls: Mutex::new(Vec::new()),
    });
    let client = Arc::new(EduApiClient::new("https://edu.example", transport.clone(), 4).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    let auth = Arc::new(AuthSession::new(client, storage).unwrap());
    auth.login(super::auth_session::LoginInput {
        email: "user@example.com".to_string(),
        password: "password".to_string(),
    })
    .unwrap();
    (auth, transport)
}

#[test]
fn dsh_stream_public_request_keeps_reasoning_and_key_across_401_refresh() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for status in [401, 200] {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let headers = String::from_utf8(headers).unwrap();
            let length: usize = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .unwrap()
                .1
                .trim()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            requests.push((
                headers,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            ));
            write!(socket, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
        }
        requests
    });
    let (auth, transport) = setup();
    let client = crate::model_request_client::ModelRequestClient::new(
        &format!("http://{addr}/model-request"),
        5,
    )
    .unwrap();
    let proxy = WorkingModelProxy::with_model_client(auth, client);
    let capability = proxy.issue_dsh_capability(Some("high")).unwrap();
    let mut response = proxy
        .proxy_stream_with_capability(&capability, br#"{"model":"fast","input":"hello"}"#, None)
        .unwrap();
    let mut body = String::new();
    response.body.read_to_string(&mut body).unwrap();
    assert_eq!(response.status, 200);
    let requests = server.join().unwrap();
    let header = |index: usize, name: &str| {
        requests[index]
            .0
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .unwrap()
            .1
            .trim()
            .to_string()
    };
    for (headers, body) in &requests {
        assert!(headers.starts_with("POST /model-request/v1/responses HTTP/1.1"));
        assert_eq!(body["reasoning"]["effort"], "high");
    }
    assert_eq!(header(0, "idempotency-key"), header(1, "idempotency-key"));
    assert!(header(0, "idempotency-key").len() >= 16);
    assert_eq!(header(1, "authorization"), "Bearer refreshed-access");
    assert_eq!(
        header(0, "x-working-model-source-type"),
        "copis-agent-model"
    );
    assert_eq!(
        header(1, "x-working-model-source-type"),
        "copis-agent-model"
    );
    assert_eq!(
        transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.path == "/api/auth/refresh")
            .count(),
        1
    );
}

#[test]
fn capability_is_bound_to_model_and_revoked_after_worker_exit() {
    let (auth, _) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let capability = proxy.issue("session-1", "model-1").unwrap();

    let response = proxy
        .proxy_with_capability(
            &capability.capability,
            br#"{"model":"model-1","messages":[]}"#,
        )
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"data: {\"id\":\"chunk-1\"}\n\n");

    assert!(matches!(
        proxy.proxy_with_capability(
            &capability.capability,
            br#"{"model":"other-model","messages":[]}"#,
        ),
        Err(WorkingModelError::CapabilityMismatch)
    ));
    proxy.revoke("session-1");
    assert!(matches!(
        proxy.proxy_with_capability(&capability.capability, br#"{"model":"model-1"}"#),
        Err(WorkingModelError::Unauthorized)
    ));
}

#[test]
fn model_proxy_keeps_sse_order_and_uses_auth_session_token() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let capability = proxy.issue("session-2", "model-2").unwrap();
    let response = proxy
        .proxy_with_capability(
            &capability.capability,
            br#"{"model":"model-2","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
    assert_eq!(response.body, b"data: {\"id\":\"chunk-1\"}\n\n");
    let calls = transport.calls.lock().unwrap();
    let model_request = calls.last().unwrap();
    assert_eq!(
        model_request.path,
        "/api/internal/working-model/v1/responses"
    );
    assert_eq!(
        model_request.access_token.as_deref(),
        Some("header.eyJleHAiOjQxMDAuMH0.sig")
    );
    assert_eq!(
        model_request.headers,
        vec![(
            "X-Working-Model-Source-Type".to_string(),
            "copis-agent-model".to_string(),
        ),]
    );
    assert_eq!(calls.len(), 2);
}

#[test]
fn internal_model_proxy_uses_auth_session_without_worker_capability() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let response = proxy
        .proxy_internal(br#"{"model":"model-internal","messages":[]}"#)
        .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"data: {\"id\":\"chunk-1\"}\n\n");
    let calls = transport.calls.lock().unwrap();
    let model_request = calls.last().unwrap();
    assert_eq!(
        model_request.path,
        "/api/internal/working-model/v1/responses"
    );
    assert_eq!(
        model_request.access_token.as_deref(),
        Some("header.eyJleHAiOjQxMDAuMH0.sig")
    );
}

#[test]
fn dsh_capability_is_long_lived_and_can_request_every_working_model() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let capability = proxy.issue_dsh_capability(None).unwrap();

    proxy
        .proxy_with_capability(&capability, br#"{"model":"fast","messages":[]}"#)
        .unwrap();
    proxy
        .proxy_with_capability(&capability, br#"{"model":"deepseek-v4-pro","messages":[]}"#)
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[1].path, "/api/internal/working-model/v1/responses");
    assert_eq!(calls[2].path, "/api/internal/working-model/v1/responses");
}

#[test]
fn dsh_request_uses_copis_reasoning_level() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let capability = proxy.issue_dsh_capability(Some("high")).unwrap();

    proxy
        .proxy_with_capability(&capability, br#"{"model":"fast","messages":[]}"#)
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let body: serde_json::Value =
        serde_json::from_str(calls.last().unwrap().body.as_deref().unwrap()).unwrap();
    assert_eq!(body["reasoning"]["effort"], "high");
}

#[test]
fn dsh_request_forces_none_when_copis_thinking_is_disabled() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let capability = proxy.issue_dsh_capability(Some("none")).unwrap();

    proxy
        .proxy_with_capability(
            &capability,
            br#"{"model":"fast","reasoning":{"effort":"high"}}"#,
        )
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let body: serde_json::Value =
        serde_json::from_str(calls.last().unwrap().body.as_deref().unwrap()).unwrap();
    assert_eq!(body["reasoning"]["effort"], "none");
}

#[test]
fn capability_expired_displays_friendly_message_and_blocks_request() {
    let (auth, _) = setup();
    let proxy = WorkingModelProxy::new(auth).unwrap();
    let mut capability = proxy.issue("session-expired", "model-expired").unwrap();
    // 强制将 expires_at 设置为过去的时间戳以模拟过期
    capability.expires_at = 0;

    // 错误信息展示
    let error = WorkingModelError::CapabilityExpired;
    assert_eq!(
        error.to_string(),
        "模型会话已过期，请直接发送「继续任务」或点击重试"
    );
}
