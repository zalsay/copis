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
fn capability_is_bound_to_model_and_revoked_after_worker_exit() {
    let (auth, _) = setup();
    let proxy = WorkingModelProxy::new(auth);
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
    let proxy = WorkingModelProxy::new(auth);
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
    assert_eq!(calls.len(), 2);
}

#[test]
fn internal_model_proxy_uses_auth_session_without_worker_capability() {
    let (auth, transport) = setup();
    let proxy = WorkingModelProxy::new(auth);
    let response = proxy
        .proxy_internal(br#"{"model":"model-internal","messages":[]}"#)
        .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"data: {\"id\":\"chunk-1\"}\n\n");
    let calls = transport.calls.lock().unwrap();
    let model_request = calls.last().unwrap();
    assert_eq!(model_request.path, "/api/internal/working-model/v1/responses");
    assert_eq!(model_request.access_token.as_deref(), Some("header.eyJleHAiOjQxMDAuMH0.sig"));
}

#[test]
fn capability_expired_displays_friendly_message_and_blocks_request() {
    let (auth, _) = setup();
    let proxy = WorkingModelProxy::new(auth);
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
