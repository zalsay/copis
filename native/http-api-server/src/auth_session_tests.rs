use super::auth_session::{
    AuthError, AuthSession, AuthStorage, LoginInput, PersistedAuth, RegisterInput, SendCodeInput,
    VerifyResetCodeInput,
};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

#[derive(Default)]
struct MemoryStorage {
    value: Mutex<Option<PersistedAuth>>,
    saves: AtomicUsize,
    clears: AtomicUsize,
}

impl AuthStorage for MemoryStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        *self.value.lock().unwrap() = Some(auth.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
        self.clears.fetch_add(1, Ordering::SeqCst);
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

struct QueueTransport {
    responses: Mutex<VecDeque<EduApiResponse>>,
    requests: Mutex<Vec<EduApiRequest>>,
}

impl QueueTransport {
    fn new(responses: Vec<EduApiResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl EduApiTransport for QueueTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.requests.lock().unwrap().push(request);
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| EduApiError::Transport("测试响应队列为空".to_string()))
    }
}

struct BlockingTransport {
    responses: Mutex<VecDeque<EduApiResponse>>,
    requests: Mutex<Vec<EduApiRequest>>,
    block_path: String,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
    calls: AtomicUsize,
}

impl EduApiTransport for BlockingTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let should_block = request.path == self.block_path;
        self.requests.lock().unwrap().push(request);
        if should_block {
            self.entered.wait();
            self.release.wait();
        }
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| EduApiError::Transport("测试响应队列为空".to_string()))
    }
}

fn response(status: u16, body: Value) -> EduApiResponse {
    EduApiResponse {
        status,
        headers: Vec::new(),
        body: serde_json::to_vec(&body).unwrap(),
    }
}

fn session(transport: Arc<dyn EduApiTransport>, storage: Arc<MemoryStorage>) -> AuthSession {
    let client = Arc::new(
        EduApiClient::new("https://edu-api.example.test/module/edu-api", transport, 64).unwrap(),
    );
    AuthSession::new(client, storage).unwrap()
}

fn login_input() -> LoginInput {
    LoginInput {
        email: "user@example.com".to_string(),
        password: "password-secret".to_string(),
    }
}

fn persisted_auth() -> PersistedAuth {
    PersistedAuth {
        access_token: "old-access-token".to_string(),
        refresh_token: Some("old-refresh-token".to_string()),
        provider: "legacy".to_string(),
        user: Some(json!({"id": 7, "email": "user@example.com"})),
        expires_at: Some(4_000_000_000),
    }
}

#[test]
fn login_persists_credentials_but_auth_state_exposes_no_token() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({"token":"header.eyJleHAiOjQwMDAwMDAwMDB9.sig", "refresh_token":"new-refresh-token", "user_id":7}),
        ),
        response(200, json!({"data":{"id":7,"email":"user@example.com"}})),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    let auth = session(transport, storage.clone());

    let state = auth.login(login_input()).unwrap();

    assert!(state.authenticated);
    assert_eq!(
        state
            .user
            .as_ref()
            .and_then(|user| user.get("id"))
            .and_then(Value::as_i64),
        Some(7)
    );
    assert!(state.expires_at.is_some());
    let encoded = serde_json::to_string(&state).unwrap();
    assert!(!encoded.contains("new-access-token"));
    assert!(!encoded.contains("new-refresh-token"));
    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().access_token,
        "header.eyJleHAiOjQwMDAwMDAwMDB9.sig"
    );
}

#[test]
fn same_kind_login_is_rejected_while_the_first_operation_is_running() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([
            response(200, json!({"token":"access-token","user_id":7})),
            response(200, json!({"data":{"ID":7}})),
        ])),
        requests: Mutex::new(Vec::new()),
        block_path: "/api/auth/login".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let storage = Arc::new(MemoryStorage::default());
    let auth = Arc::new(session(transport.clone(), storage));
    let first_auth = auth.clone();
    let first = thread::spawn(move || first_auth.login(login_input()));
    entered.wait();

    let second = auth.login(login_input());
    assert!(matches!(second, Err(AuthError::Busy)));
    release.wait();
    first.join().unwrap().unwrap();
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn twenty_concurrent_refreshes_share_one_upstream_request() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([response(
            200,
            json!({"token":"rotated-access-token","refresh_token":"rotated-refresh-token"}),
        )])),
        requests: Mutex::new(Vec::new()),
        block_path: "/api/auth/refresh".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let auth = Arc::new(session(transport.clone(), storage));
    let first_auth = auth.clone();
    let first = thread::spawn(move || first_auth.refresh_single_flight());
    entered.wait();

    let mut waiters = Vec::new();
    for _ in 0..19 {
        let auth = auth.clone();
        waiters.push(thread::spawn(move || auth.refresh_single_flight()));
    }
    release.wait();
    assert_eq!(first.join().unwrap().unwrap(), "rotated-access-token");
    for waiter in waiters {
        assert_eq!(waiter.join().unwrap().unwrap(), "rotated-access-token");
    }
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn unauthorized_request_refreshes_once_and_replays_once() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(401, json!({"code":"unauthorized"})),
        response(
            200,
            json!({"token":"rotated-access-token","refresh_token":"rotated-refresh-token"}),
        ),
        response(200, json!({"data":{"ok":true}})),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let auth = session(transport.clone(), storage);

    let result = auth
        .authenticated_request("GET", "/api/users/me", None)
        .unwrap();

    assert_eq!(result.status, 200);
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/users/me", "/api/auth/refresh", "/api/users/me",]
    );
}

#[test]
fn auth_write_operations_use_their_own_paths_and_bound_input_size() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"data":{"ID":7}})),
        response(204, json!({})),
        response(200, json!({"reset_token":"reset-token"})),
        response(204, json!({})),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    let auth = session(transport.clone(), storage);

    auth.register(RegisterInput {
        email: "user@example.com".to_string(),
        password: "password".to_string(),
        nickname: Some("User".to_string()),
        invitation_code: None,
        verification_code: None,
    })
    .unwrap();
    auth.send_code(SendCodeInput {
        email: "user@example.com".to_string(),
        purpose: Some("register".to_string()),
    })
    .unwrap();
    auth.verify_reset_code(VerifyResetCodeInput {
        email: "user@example.com".to_string(),
        code: "123456".to_string(),
    })
    .unwrap();
    auth.reset_password("user@example.com", "reset-token", "new-password")
        .unwrap();

    let paths = transport.requests.lock().unwrap();
    assert_eq!(
        paths
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/auth/register",
            "/api/auth/send-code",
            "/api/auth/verify-code",
            "/api/auth/password/reset",
        ]
    );
    drop(paths);
    assert!(auth
        .send_code(SendCodeInput {
            email: "x".repeat(400),
            purpose: None,
        })
        .is_err());
}

#[test]
fn oidc_authorization_uses_rust_state_pkce_and_never_exposes_tokens() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "issuer": "https://auth.example/module/auth",
                "authorization_endpoint": "/oauth/authorize",
                "token_endpoint": "/oauth/token"
            }),
        ),
        response(
            200,
            json!({
                "access_token": "oidc-access",
                "refresh_token": "oidc-refresh",
                "expires_in": 900
            }),
        ),
        response(200, json!({"data": {"id": 7, "email": "oidc@example.com"}})),
    ]));
    let client =
        Arc::new(EduApiClient::new("https://auth.example/module/auth", transport, 8).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    let auth =
        AuthSession::new_with_oidc(Arc::clone(&client), storage.clone(), Some(client)).unwrap();

    let authorization_url = auth
        .start_oidc("http://127.0.0.1:51730/api/working/oauth/callback")
        .unwrap();
    assert!(authorization_url.starts_with("https://auth.example/module/auth/oauth/authorize?"));
    let query = authorization_url.split_once('?').unwrap().1;
    let query_value = |name: &str| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    };
    let state = query_value("state").unwrap();
    let verifier = query_value("code_challenge").unwrap();
    assert!(!state.is_empty());
    assert!(!verifier.is_empty());
    assert_eq!(query_value("client_id").as_deref(), Some("copis-desktop"));
    assert!(!authorization_url.contains("oidc-access"));

    let auth_state = auth
        .complete_oidc(&format!(
            "/api/working/oauth/callback?code=code-1&state={state}"
        ))
        .unwrap();
    assert!(auth_state.authenticated);
    assert_eq!(
        auth_state
            .user
            .as_ref()
            .and_then(|user| user.get("email"))
            .and_then(Value::as_str),
        Some("oidc@example.com")
    );
    assert!(!serde_json::to_string(&auth_state)
        .unwrap()
        .contains("oidc-access"));
    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().provider,
        "oidc"
    );
    assert!(auth
        .complete_oidc(&format!(
            "/api/working/oauth/callback?code=code-2&state={state}"
        ))
        .is_err());
}

#[test]
fn oidc_refresh_uses_oauth_token_endpoint_and_rotates_refresh_token() {
    let legacy_transport = Arc::new(QueueTransport::new(Vec::new()));
    let oidc_transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "access_token": "oidc-rotated-access",
            "refresh_token": "oidc-rotated-refresh",
            "expires_in": 900
        }),
    )]));
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test/module/edu-api",
            legacy_transport.clone(),
            8,
        )
        .unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new(
            "https://auth.example.test/module/auth",
            oidc_transport.clone(),
            8,
        )
        .unwrap(),
    );
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        access_token: "oidc-old-access".to_string(),
        refresh_token: Some("oidc-old-refresh".to_string()),
        provider: "oidc".to_string(),
        user: Some(json!({"id": 7})),
        expires_at: Some(4_000_000_000),
    });
    let auth =
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap();

    assert_eq!(auth.refresh_single_flight().unwrap(), "oidc-rotated-access");
    assert!(legacy_transport.requests.lock().unwrap().is_empty());
    let requests = oidc_transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/oauth/token");
    let body = requests[0].body.as_deref().unwrap_or_default();
    assert!(body.contains("grant_type=refresh_token"));
    assert!(body.contains("client_id=copis-desktop"));
    assert!(body.contains("refresh_token=oidc-old-refresh"));
    let persisted = storage.value.lock().unwrap().clone().unwrap();
    assert_eq!(persisted.provider, "oidc");
    assert_eq!(
        persisted.refresh_token.as_deref(),
        Some("oidc-rotated-refresh")
    );
}

#[test]
fn refresh_unauthorized_clears_memory_and_storage() {
    let transport = Arc::new(QueueTransport::new(vec![response(
        401,
        json!({"code":"invalid_grant","message":"refresh failed"}),
    )]));
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let auth = session(transport, storage.clone());

    assert!(auth.refresh_single_flight().is_err());
    assert!(!auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_none());
    assert_eq!(storage.clears.load(Ordering::SeqCst), 1);
}
