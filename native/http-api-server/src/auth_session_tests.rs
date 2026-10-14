use super::auth_session::{
    AuthError, AuthSession, AuthStorage, LoginInput, PersistedAuth, RegisterInput, SendCodeInput,
    VerifyResetCodeInput,
};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

#[derive(Default)]
struct MemoryStorage {
    value: Mutex<Option<PersistedAuth>>,
    saves: AtomicUsize,
    clears: AtomicUsize,
    clear_error: AtomicBool,
}

#[derive(Default)]
struct ReentrantStorage {
    value: Mutex<Option<PersistedAuth>>,
    on_save: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    on_clear: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl AuthStorage for ReentrantStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError> {
        *self.value.lock().unwrap() = Some(auth.clone());
        if let Some(callback) = self.on_save.lock().unwrap().clone() {
            callback();
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
        if let Some(callback) = self.on_clear.lock().unwrap().clone() {
            callback();
        }
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

fn assert_auth_request_can_reenter(auth: &AuthSession) -> Result<EduApiResponse, AuthError> {
    auth.authenticated_request("GET", "/api/users/me", None)
}

fn finish_with_timeout<T: Send + 'static>(handle: thread::JoinHandle<T>) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || sender.send(handle.join()).ok());
    receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("可重入认证存储调用超时")
        .expect("认证操作线程 panic")
}

fn refresh_profile_gate_fixture(
    status: u16,
    body: Value,
) -> (
    Arc<AuthSession>,
    Arc<ReentrantStorage>,
    Arc<Barrier>,
    Arc<Barrier>,
) {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test",
            Arc::new(QueueTransport::new(Vec::new())),
            8,
        )
        .unwrap(),
    );
    let oidc_transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([response(status, body)])),
        requests: Mutex::new(Vec::new()),
        block_path: "/oauth/token".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let oidc_client =
        Arc::new(EduApiClient::new("https://auth.example.test", oidc_transport, 8).unwrap());
    let storage = Arc::new(ReentrantStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    (auth, storage, entered, release)
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
        if self.clear_error.load(Ordering::SeqCst) {
            return Err(AuthError::Storage("测试认证清理失败".to_string()));
        }
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
        let call_idx = self.calls.fetch_add(1, Ordering::SeqCst);
        let should_block = request.path == self.block_path && call_idx == 0;
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
fn given_uppercase_user_id_when_refreshing_after_vip_payment_then_account_identity_is_preserved() {
    use super::working_payment::VipPaymentRefresher;

    for key in ["ID", "id", "userId", "user_id"] {
        for id in [json!(7), json!("7")] {
            let transport = Arc::new(QueueTransport::new(vec![response(
                200,
                json!({"data": {key: id}}),
            )]));
            let storage = Arc::new(MemoryStorage::default());
            *storage.value.lock().unwrap() = Some(persisted_auth());
            let refresher = super::AuthVipPaymentRefresher {
                auth: Arc::new(session(transport, storage)),
            };

            let refreshed = refresher.refresh_after_vip_payment().unwrap();

            assert_eq!(refreshed.user_id, "7");
        }
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
fn auth_state_observer_runs_after_login_publishes_in_memory_auth() {
    let transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({"token":"access-token","user_id":7}),
    )]));
    let storage = Arc::new(MemoryStorage::default());
    let auth = Arc::new(session(transport, storage));
    let observed = Arc::new(AtomicBool::new(false));
    let observed_clone = Arc::clone(&observed);
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        assert!(authenticated);
        let state = auth_weak.upgrade().unwrap().auth_state();
        assert!(state.authenticated);
        assert_eq!(
            state
                .user
                .as_ref()
                .and_then(|user| user.get("id"))
                .and_then(Value::as_i64),
            Some(7)
        );
        observed_clone.store(true, Ordering::Release);
    }));

    auth.login(login_input()).unwrap();

    assert!(observed.load(Ordering::Acquire));
}

#[test]
fn login_profile_enrichment_notifies_after_each_committed_user_state() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token"})),
        response(200, json!({"data":{"id":7,"email":"user@example.com"}})),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    let auth = Arc::new(session(transport, storage));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_clone = Arc::clone(&notifications);
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        assert!(authenticated);
        let state = auth_weak.upgrade().unwrap().auth_state();
        assert!(state.authenticated);
        notifications_clone
            .lock()
            .unwrap()
            .push(state.user.as_ref().and_then(|user| user.get("id")).cloned());
    }));

    auth.login(login_input()).unwrap();

    assert_eq!(*notifications.lock().unwrap(), vec![None, Some(json!(7))]);
}

#[test]
fn password_login_switches_accounts_without_reusing_previous_user() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "token": "account-b-access",
                "refresh_token": "account-b-refresh",
                "user": {"id": 42, "email": "b@example.test"}
            }),
        ),
        response(200, json!({"data":{"ok":true}})),
        response(500, json!({"message":"refresh 暂不可用"})),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        access_token: "account-a-access".to_string(),
        refresh_token: Some("account-a-refresh".to_string()),
        provider: "oidc".to_string(),
        user: Some(json!({"id": 7, "email": "a@example.test"})),
        expires_at: None,
    });
    let auth = Arc::new(session(transport.clone(), storage.clone()));
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_callback = observed.clone();
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        let state = auth_weak.upgrade().unwrap().auth_state();
        let user_id = state
            .user
            .as_ref()
            .and_then(|user| user.get("id"))
            .and_then(Value::as_i64);
        observed_for_callback
            .lock()
            .unwrap()
            .push((authenticated, user_id));
    }));

    let state = auth.login(login_input()).unwrap();

    assert!(state.authenticated);
    assert_eq!(
        state.user.as_ref().and_then(|user| user.get("id")),
        Some(&json!(42))
    );
    assert_eq!(*observed.lock().unwrap(), vec![(true, Some(42))]);
    let persisted = storage.value.lock().unwrap().clone().unwrap();
    assert_eq!(persisted.access_token, "account-b-access");
    assert_eq!(
        persisted.refresh_token.as_deref(),
        Some("account-b-refresh")
    );
    assert_eq!(persisted.provider, "legacy");
    assert_eq!(
        persisted.user.as_ref().and_then(|user| user.get("id")),
        Some(&json!(42))
    );

    auth.authenticated_request("GET", "/api/test", None)
        .unwrap();
    assert_eq!(auth.current_access_token().unwrap(), "account-b-access");
    assert!(auth.refresh_single_flight().is_err());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests[1].access_token.as_deref(),
        Some("account-b-access")
    );
    assert_eq!(requests[2].path, "/api/auth/refresh");
    assert!(requests[2]
        .body
        .as_deref()
        .unwrap()
        .contains("account-b-refresh"));
}

#[test]
fn oidc_login_switches_accounts_without_reusing_previous_user() {
    let legacy_transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"data":{"id":42,"email":"b@example.test"}})),
        response(200, json!({"data":{"ok":true}})),
    ]));
    let oidc_transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "issuer": "https://auth.example.test",
                "authorization_endpoint": "/oauth/authorize",
                "token_endpoint": "/oauth/token"
            }),
        ),
        response(
            200,
            json!({
                "access_token": "account-b-oidc-access",
                "refresh_token": "account-b-oidc-refresh",
                "expires_in": 900
            }),
        ),
        response(500, json!({"error":"temporarily_unavailable"})),
    ]));
    let legacy_client = Arc::new(
        EduApiClient::new("https://edu.example.test", legacy_transport.clone(), 8).unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new("https://auth.example.test", oidc_transport.clone(), 8).unwrap(),
    );
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_callback = observed.clone();
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        let state = auth_weak.upgrade().unwrap().auth_state();
        let user_id = state
            .user
            .as_ref()
            .and_then(|user| user.get("id"))
            .and_then(Value::as_i64);
        observed_for_callback
            .lock()
            .unwrap()
            .push((authenticated, user_id));
    }));

    let authorization_url = auth
        .start_oidc("http://127.0.0.1:51730/api/working/oauth/callback")
        .unwrap();
    let query = authorization_url.split_once('?').unwrap().1;
    let query_value = |name: &str| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    };
    let state = query_value("state").unwrap();
    let auth_state = auth
        .complete_oidc(&format!(
            "/api/working/oauth/callback?code=code-b&state={state}"
        ))
        .unwrap();

    assert!(auth_state.authenticated);
    assert_eq!(
        auth_state.user.as_ref().and_then(|user| user.get("id")),
        Some(&json!(42))
    );
    assert_eq!(*observed.lock().unwrap(), vec![(true, None), (true, Some(42))]);
    let persisted = storage.value.lock().unwrap().clone().unwrap();
    assert_eq!(persisted.access_token, "account-b-oidc-access");
    assert_eq!(
        persisted.refresh_token.as_deref(),
        Some("account-b-oidc-refresh")
    );
    assert_eq!(persisted.provider, "oidc");
    assert_eq!(
        persisted.user.as_ref().and_then(|user| user.get("id")),
        Some(&json!(42))
    );

    auth.authenticated_request("GET", "/api/test", None)
        .unwrap();
    assert_eq!(
        auth.current_access_token().unwrap(),
        "account-b-oidc-access"
    );
    assert!(auth.refresh_single_flight().is_err());
    assert_eq!(
        legacy_transport.requests.lock().unwrap()[1]
            .access_token
            .as_deref(),
        Some("account-b-oidc-access")
    );
    let requests = oidc_transport.requests.lock().unwrap();
    assert_eq!(requests[2].path, "/oauth/token");
    assert!(requests[2]
        .body
        .as_deref()
        .unwrap()
        .contains("account-b-oidc-refresh"));
}

#[test]
fn explicit_logout_returns_storage_clear_error_after_local_auth_is_cleared() {
    let transport = Arc::new(QueueTransport::new(vec![]));
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    storage.clear_error.store(true, Ordering::SeqCst);
    let auth = Arc::new(session(transport, storage.clone()));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_clone = Arc::clone(&notifications);
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        notifications_clone.lock().unwrap().push((
            authenticated,
            auth_weak.upgrade().unwrap().auth_state().authenticated,
        ));
    }));

    let result = auth.logout();

    assert!(matches!(
        result,
        Err(AuthError::Storage(message)) if message == "测试认证清理失败"
    ));
    assert!(!auth.auth_state().authenticated);
    assert_eq!(*notifications.lock().unwrap(), vec![(false, false)]);
    assert_eq!(storage.clears.load(Ordering::SeqCst), 1);
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
    while auth.refresh_waiters() < 19 {
        thread::yield_now();
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
    let auth = Arc::new(
        AuthSession::new_with_oidc(Arc::clone(&client), storage.clone(), Some(client)).unwrap(),
    );
    let observed_emails = Arc::new(Mutex::new(Vec::new()));
    let observed_emails_clone = Arc::clone(&observed_emails);
    let auth_weak = Arc::downgrade(&auth);
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        let state = auth_weak.upgrade().unwrap().auth_state();
        assert_eq!(state.authenticated, authenticated);
        observed_emails_clone.lock().unwrap().push(
            state
                .user
                .as_ref()
                .and_then(|user| user.get("email"))
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }));

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
    assert_eq!(
        *observed_emails.lock().unwrap(),
        vec![None, Some("oidc@example.com".to_string())]
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
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        notifications_for_observer
            .lock()
            .unwrap()
            .push(authenticated);
    }));

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
    assert_eq!(*notifications.lock().unwrap(), vec![true]);
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

#[test]
fn oidc_invalid_grant_clears_auth_and_notifies_once() {
    let legacy_transport = Arc::new(QueueTransport::new(Vec::new()));
    let oidc_transport = Arc::new(QueueTransport::new(vec![response(
        400,
        json!({
            "error": "invalid_grant",
            "error_description": "Refresh token is no longer valid"
        }),
    )]));
    let legacy_client =
        Arc::new(EduApiClient::new("https://edu.example.test", legacy_transport, 8).unwrap());
    let oidc_client =
        Arc::new(EduApiClient::new("https://auth.example.test", oidc_transport, 8).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth =
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        notifications_for_observer
            .lock()
            .unwrap()
            .push(authenticated);
    }));

    assert!(auth.refresh_single_flight().is_err());

    assert!(!auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_none());
    assert_eq!(storage.clears.load(Ordering::SeqCst), 1);
    assert_eq!(*notifications.lock().unwrap(), vec![false]);
}

#[test]
fn oidc_transient_refresh_failure_preserves_auth_and_does_not_notify_logout() {
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test",
            Arc::new(QueueTransport::new(Vec::new())),
            8,
        )
        .unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new(
            "https://auth.example.test",
            Arc::new(QueueTransport::new(vec![response(
                503,
                json!({"error":"temporarily_unavailable","error_description":"try later"}),
            )])),
            8,
        )
        .unwrap(),
    );
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth =
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |_| {
        notifications_for_observer.fetch_add(1, Ordering::SeqCst);
    }));

    assert!(auth.refresh_single_flight().is_err());

    assert!(auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_some());
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[test]
fn oidc_invalid_request_refresh_error_preserves_auth_and_does_not_notify_logout() {
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test",
            Arc::new(QueueTransport::new(Vec::new())),
            8,
        )
        .unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new(
            "https://auth.example.test",
            Arc::new(QueueTransport::new(vec![response(
                400,
                json!({"error":"invalid_request","error_description":"malformed request"}),
            )])),
            8,
        )
        .unwrap(),
    );
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth =
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |_| {
        notifications_for_observer.fetch_add(1, Ordering::SeqCst);
    }));

    assert!(auth.refresh_single_flight().is_err());

    assert!(auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_some());
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[test]
fn late_oidc_invalid_grant_does_not_clear_a_new_login() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let legacy_transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "token": "new-login-access",
            "refresh_token": "new-login-refresh",
            "user": {"id": 99}
        }),
    )]));
    let oidc_transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([response(
            400,
            json!({"error":"invalid_grant","error_description":"expired"}),
        )])),
        requests: Mutex::new(Vec::new()),
        block_path: "/oauth/token".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let legacy_client =
        Arc::new(EduApiClient::new("https://edu.example.test", legacy_transport, 8).unwrap());
    let oidc_client =
        Arc::new(EduApiClient::new("https://auth.example.test", oidc_transport, 8).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let refresh_auth = auth.clone();
    let refresh = thread::spawn(move || refresh_auth.refresh_single_flight());
    entered.wait();

    auth.login(login_input()).unwrap();
    release.wait();
    assert!(refresh.join().unwrap().is_err());

    assert!(auth.auth_state().authenticated);
    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().access_token,
        "new-login-access"
    );
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
}

#[test]
fn late_oidc_refresh_unauthorized_does_not_clear_a_new_login() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let legacy_transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "token": "new-login-access",
            "refresh_token": "new-login-refresh",
            "user": {"id": 99}
        }),
    )]));
    let oidc_transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([response(
            401,
            json!({"code":"unauthorized","message":"expired refresh"}),
        )])),
        requests: Mutex::new(Vec::new()),
        block_path: "/oauth/token".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let legacy_client =
        Arc::new(EduApiClient::new("https://edu.example.test", legacy_transport, 8).unwrap());
    let oidc_client =
        Arc::new(EduApiClient::new("https://auth.example.test", oidc_transport, 8).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |state| {
        notifications_for_observer.lock().unwrap().push(state);
    }));
    let refresh_auth = auth.clone();
    let refresh = thread::spawn(move || refresh_auth.refresh_single_flight());
    entered.wait();

    auth.login(login_input()).unwrap();
    release.wait();
    assert!(finish_with_timeout(refresh).is_err());

    assert_eq!(auth.current_access_token().unwrap(), "new-login-access");
    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().access_token,
        "new-login-access"
    );
    assert_eq!(*notifications.lock().unwrap(), vec![true]);
}

#[test]
fn late_successful_refresh_does_not_overwrite_a_new_login() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let legacy_transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "token": "new-login-access",
            "refresh_token": "new-login-refresh",
            "user": {"id": 99}
        }),
    )]));
    let oidc_transport = Arc::new(BlockingTransport {
        responses: Mutex::new(VecDeque::from([response(
            200,
            json!({
                "access_token": "late-rotated-access",
                "refresh_token": "late-rotated-refresh"
            }),
        )])),
        requests: Mutex::new(Vec::new()),
        block_path: "/oauth/token".to_string(),
        entered: entered.clone(),
        release: release.clone(),
        calls: AtomicUsize::new(0),
    });
    let legacy_client =
        Arc::new(EduApiClient::new("https://edu.example.test", legacy_transport, 8).unwrap());
    let oidc_client =
        Arc::new(EduApiClient::new("https://auth.example.test", oidc_transport, 8).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let refresh_auth = auth.clone();
    let refresh = thread::spawn(move || refresh_auth.refresh_single_flight());
    entered.wait();

    auth.login(login_input()).unwrap();
    release.wait();
    assert!(matches!(
        finish_with_timeout(refresh),
        Err(AuthError::NotAuthenticated)
    ));

    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().access_token,
        "new-login-access"
    );
    assert_eq!(auth.current_access_token().unwrap(), "new-login-access");
}

#[test]
fn password_login_storage_callback_can_reenter_authenticated_request() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "token": "new-access",
                "refresh_token": "new-refresh",
                "user": {"id": 7}
            }),
        ),
        response(200, json!({"data":{"id":7}})),
    ]));
    let client = Arc::new(EduApiClient::new("https://edu.example.test", transport, 8).unwrap());
    let storage = Arc::new(ReentrantStorage::default());
    let auth = Arc::new(AuthSession::new(client, storage.clone()).unwrap());
    let auth_weak = Arc::downgrade(&auth);
    *storage.on_save.lock().unwrap() = Some(Arc::new(move || {
        assert_auth_request_can_reenter(&auth_weak.upgrade().unwrap())
            .expect("登录 save 回调应可使用已发布的认证状态");
    }));
    let auth_for_login = auth.clone();
    let login = thread::spawn(move || auth_for_login.login(login_input()));

    assert!(finish_with_timeout(login).unwrap().authenticated);
}

#[test]
fn reentrant_unauthorized_refresh_fails_fast_without_overwriting_outer_save() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "token": "login-access",
                "refresh_token": "login-refresh",
                "user": {"id": 7}
            }),
        ),
        response(401, json!({"code":"unauthorized"})),
        response(
            200,
            json!({
                "token": "rotated-access",
                "refresh_token": "rotated-refresh"
            }),
        ),
    ]));
    let client =
        Arc::new(EduApiClient::new("https://edu.example.test", transport.clone(), 8).unwrap());
    let storage = Arc::new(ReentrantStorage::default());
    let auth = Arc::new(AuthSession::new(client, storage.clone()).unwrap());
    let auth_weak = Arc::downgrade(&auth);
    *storage.on_save.lock().unwrap() = Some(Arc::new(move || {
        assert!(matches!(
            assert_auth_request_can_reenter(&auth_weak.upgrade().unwrap()),
            Err(AuthError::Busy)
        ));
    }));
    let auth_for_login = auth.clone();
    let login = thread::spawn(move || auth_for_login.login(login_input()));

    assert!(finish_with_timeout(login).unwrap().authenticated);
    assert_eq!(auth.current_access_token().unwrap(), "login-access");
    let persisted = storage.value.lock().unwrap().clone().unwrap();
    assert_eq!(persisted.access_token, "login-access");
    assert_eq!(persisted.refresh_token.as_deref(), Some("login-refresh"));
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/auth/login", "/api/users/me"]
    );
}

#[test]
fn refresh_rotation_waits_for_same_identity_profile_save_and_persists_latest_credentials() {
    let (auth, storage, refresh_entered, refresh_release) = refresh_profile_gate_fixture(
        200,
        json!({
            "access_token": "rotated-access",
            "refresh_token": "rotated-refresh"
        }),
    );
    let profile_entered = Arc::new(Barrier::new(2));
    let profile_release = Arc::new(Barrier::new(2));
    let save_callbacks = Arc::new(AtomicUsize::new(0));
    let profile_entered_callback = profile_entered.clone();
    let profile_release_callback = profile_release.clone();
    let save_callbacks_callback = save_callbacks.clone();
    *storage.on_save.lock().unwrap() = Some(Arc::new(move || {
        if save_callbacks_callback.fetch_add(1, Ordering::SeqCst) == 0 {
            profile_entered_callback.wait();
            profile_release_callback.wait();
        }
    }));
    let previous = storage.value.lock().unwrap().clone().unwrap();
    let mut profile = previous.clone();
    profile.user = Some(json!({"id":7,"email":"updated@example.test"}));

    let (refresh_tx, refresh_rx) = std::sync::mpsc::channel();
    let refresh_auth = auth.clone();
    let refresh = thread::spawn(move || {
        refresh_tx
            .send(refresh_auth.refresh_single_flight())
            .unwrap();
    });
    refresh_entered.wait();
    let profile_auth = auth.clone();
    let profile_save =
        thread::spawn(move || profile_auth.save_auth_snapshot_for_test(&profile, &Some(previous)));
    profile_entered.wait();

    refresh_release.wait();
    let early_result = refresh_rx.recv_timeout(std::time::Duration::from_millis(100));
    let completed_while_profile_save_holds_gate = early_result.is_ok();
    profile_release.wait();
    let refresh_result = match early_result {
        Ok(result) => result,
        Err(_) => refresh_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rotation 写入等待 profile save 后应完成"),
    };

    assert!(profile_save.join().unwrap().is_ok());
    refresh.join().unwrap();
    assert!(matches!(completed_while_profile_save_holds_gate, false));
    assert_eq!(refresh_result.unwrap(), "rotated-access");
    assert_eq!(auth.current_access_token().unwrap(), "rotated-access");
    let persisted = storage.value.lock().unwrap().clone().unwrap();
    assert_eq!(persisted.access_token, "rotated-access");
    assert_eq!(persisted.refresh_token.as_deref(), Some("rotated-refresh"));
    assert_eq!(
        persisted
            .user
            .as_ref()
            .and_then(|user| user.get("email"))
            .and_then(Value::as_str),
        Some("updated@example.test")
    );
}

#[test]
fn invalid_grant_waits_for_same_identity_profile_save_then_clears_auth() {
    assert_profile_save_does_not_drop_terminal_refresh_error(response(
        400,
        json!({"error":"invalid_grant","error_description":"expired"}),
    ));
}

#[test]
fn refresh_unauthorized_waits_for_same_identity_profile_save_then_clears_auth() {
    assert_profile_save_does_not_drop_terminal_refresh_error(response(
        401,
        json!({"code":"unauthorized","message":"expired"}),
    ));
}

fn assert_profile_save_does_not_drop_terminal_refresh_error(error_response: EduApiResponse) {
    let (auth, storage, refresh_entered, refresh_release) = refresh_profile_gate_fixture(
        error_response.status,
        serde_json::from_slice(&error_response.body).unwrap(),
    );
    let profile_entered = Arc::new(Barrier::new(2));
    let profile_release = Arc::new(Barrier::new(2));
    let save_callbacks = Arc::new(AtomicUsize::new(0));
    let profile_entered_callback = profile_entered.clone();
    let profile_release_callback = profile_release.clone();
    let save_callbacks_callback = save_callbacks.clone();
    *storage.on_save.lock().unwrap() = Some(Arc::new(move || {
        if save_callbacks_callback.fetch_add(1, Ordering::SeqCst) == 0 {
            profile_entered_callback.wait();
            profile_release_callback.wait();
        }
    }));
    let previous = storage.value.lock().unwrap().clone().unwrap();
    let mut profile = previous.clone();
    profile.user = Some(json!({"id":7,"email":"updated@example.test"}));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notifications_for_observer = notifications.clone();
    auth.set_auth_state_observer(Arc::new(move |state| {
        notifications_for_observer.lock().unwrap().push(state);
    }));

    let (refresh_tx, refresh_rx) = std::sync::mpsc::channel();
    let refresh_auth = auth.clone();
    let refresh = thread::spawn(move || {
        refresh_tx
            .send(refresh_auth.refresh_single_flight())
            .unwrap();
    });
    refresh_entered.wait();
    let profile_auth = auth.clone();
    let profile_save =
        thread::spawn(move || profile_auth.save_auth_snapshot_for_test(&profile, &Some(previous)));
    profile_entered.wait();

    refresh_release.wait();
    let early_result = refresh_rx.recv_timeout(std::time::Duration::from_millis(100));
    let completed_while_profile_save_holds_gate = early_result.is_ok();
    profile_release.wait();
    let refresh_result = match early_result {
        Ok(result) => result,
        Err(_) => refresh_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("失效 refresh 清理等待 profile save 后应完成"),
    };

    assert!(profile_save.join().unwrap().is_ok());
    refresh.join().unwrap();
    assert!(matches!(completed_while_profile_save_holds_gate, false));
    assert!(refresh_result.is_err());
    assert!(!auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_none());
    assert_eq!(*notifications.lock().unwrap(), vec![false]);
}

#[test]
fn refresh_save_callback_can_reenter_authenticated_request() {
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test",
            Arc::new(QueueTransport::new(vec![response(
                200,
                json!({"data":{"id":7}}),
            )])),
            8,
        )
        .unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new(
            "https://auth.example.test",
            Arc::new(QueueTransport::new(vec![response(
                200,
                json!({"access_token":"rotated-access","refresh_token":"rotated-refresh"}),
            )])),
            8,
        )
        .unwrap(),
    );
    let storage = Arc::new(ReentrantStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let auth_weak = Arc::downgrade(&auth);
    *storage.on_save.lock().unwrap() = Some(Arc::new(move || {
        assert_auth_request_can_reenter(&auth_weak.upgrade().unwrap())
            .expect("refresh save 回调应可使用已发布的认证状态");
    }));
    let auth_for_refresh = auth.clone();
    let refresh = thread::spawn(move || auth_for_refresh.refresh_single_flight());

    assert_eq!(finish_with_timeout(refresh).unwrap(), "rotated-access");
}

#[test]
fn invalid_grant_clear_callback_can_reenter_authenticated_request() {
    let legacy_client = Arc::new(
        EduApiClient::new(
            "https://edu.example.test",
            Arc::new(QueueTransport::new(vec![response(
                200,
                json!({"data":{"id":7}}),
            )])),
            8,
        )
        .unwrap(),
    );
    let oidc_client = Arc::new(
        EduApiClient::new(
            "https://auth.example.test",
            Arc::new(QueueTransport::new(vec![response(
                400,
                json!({"error":"invalid_grant","error_description":"expired"}),
            )])),
            8,
        )
        .unwrap(),
    );
    let storage = Arc::new(ReentrantStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        provider: "oidc".to_string(),
        ..persisted_auth()
    });
    let auth = Arc::new(
        AuthSession::new_with_oidc(legacy_client, storage.clone(), Some(oidc_client)).unwrap(),
    );
    let auth_weak = Arc::downgrade(&auth);
    *storage.on_clear.lock().unwrap() = Some(Arc::new(move || {
        assert!(matches!(
            assert_auth_request_can_reenter(&auth_weak.upgrade().unwrap()),
            Err(AuthError::NotAuthenticated)
        ));
    }));
    let auth_for_refresh = auth.clone();
    let refresh = thread::spawn(move || auth_for_refresh.refresh_single_flight());

    assert!(finish_with_timeout(refresh).is_err());
    assert!(!auth.auth_state().authenticated);
    assert!(storage.value.lock().unwrap().is_none());
}

struct RedemptionAccountSwitchTransport {
    requests: Mutex<Vec<EduApiRequest>>,
    redemption_calls: AtomicUsize,
    block_call: usize,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
    reject_replay: bool,
}

impl EduApiTransport for RedemptionAccountSwitchTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        let path = request.path.clone();
        let token = request.access_token.clone();
        let body = request.body.clone();
        self.requests.lock().unwrap().push(request);
        match path.as_str() {
            "/api/diamond-redemptions/redeem" => {
                let call = self.redemption_calls.fetch_add(1, Ordering::SeqCst);
                if call == self.block_call {
                    self.entered.wait();
                    self.release.wait();
                }
                if call == 0 || self.reject_replay {
                    Ok(response(401, json!({"error":"Invalid or expired token"})))
                } else {
                    Ok(response(
                        200,
                        json!({"data":{"diamonds":100,"balance_after":100}}),
                    ))
                }
            }
            "/api/auth/login" => {
                let input: Value = serde_json::from_str(body.as_deref().unwrap()).unwrap();
                if input["email"] == "account-b@example.com" {
                    Ok(response(
                        200,
                        json!({"token":"b-access","refresh_token":"b-refresh","user":{"id":99}}),
                    ))
                } else {
                    let original = persisted_auth();
                    Ok(response(
                        200,
                        json!({"token":original.access_token,"refresh_token":original.refresh_token,"user":original.user}),
                    ))
                }
            }
            "/api/auth/refresh" => {
                let input: Value = serde_json::from_str(body.as_deref().unwrap()).unwrap();
                let access = if input["refresh_token"] == "b-refresh" {
                    "rotated-b-access"
                } else {
                    "rotated-a-access"
                };
                Ok(response(
                    200,
                    json!({"token":access,"refresh_token":"rotated-refresh"}),
                ))
            }
            _ => Err(EduApiError::Transport(format!(
                "未知测试路由 {path}, has_token={}",
                token.is_some()
            ))),
        }
    }
}

fn redemption_account_switch_fixture(
    block_call: usize,
    reject_replay: bool,
) -> (
    Arc<AuthSession>,
    Arc<RedemptionAccountSwitchTransport>,
    Arc<MemoryStorage>,
) {
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let transport = Arc::new(RedemptionAccountSwitchTransport {
        requests: Mutex::new(Vec::new()),
        redemption_calls: AtomicUsize::new(0),
        block_call,
        entered: Arc::new(Barrier::new(2)),
        release: Arc::new(Barrier::new(2)),
        reject_replay,
    });
    let auth = Arc::new(session(transport.clone(), storage.clone()));
    (auth, transport, storage)
}

fn login_account_b(auth: &AuthSession) {
    auth.login(LoginInput {
        email: "account-b@example.com".to_string(),
        password: "password".to_string(),
    })
    .unwrap();
}

#[test]
fn given_account_a_redemption_unauthorized_after_login_b_then_never_refresh_or_replay_with_b() {
    let (auth, transport, storage) = redemption_account_switch_fixture(0, false);
    let worker_auth = auth.clone();
    let redemption = thread::spawn(move || {
        worker_auth.authenticated_request(
            "POST",
            "/api/diamond-redemptions/redeem",
            Some(json!({"code":"A-CODE"}).to_string()),
        )
    });
    transport.entered.wait();
    login_account_b(&auth);
    transport.release.wait();

    assert!(matches!(
        finish_with_timeout(redemption),
        Err(AuthError::NotAuthenticated)
    ));
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.path == "/api/diamond-redemptions/redeem")
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/auth/refresh"));
    assert_eq!(auth.current_access_token().unwrap(), "b-access");
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
}

#[test]
fn given_account_a_redemption_then_login_b_and_a_again_then_old_request_cannot_replay_even_with_identical_tokens(
) {
    let (auth, transport, storage) = redemption_account_switch_fixture(0, false);
    let worker_auth = auth.clone();
    let redemption = thread::spawn(move || {
        worker_auth.authenticated_request(
            "POST",
            "/api/diamond-redemptions/redeem",
            Some(json!({"code":"A-CODE"}).to_string()),
        )
    });
    transport.entered.wait();
    login_account_b(&auth);
    auth.login(login_input()).unwrap();
    transport.release.wait();

    assert!(matches!(
        finish_with_timeout(redemption),
        Err(AuthError::NotAuthenticated)
    ));
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.path == "/api/diamond-redemptions/redeem")
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/auth/refresh"));
    assert_eq!(
        auth.current_access_token().unwrap(),
        persisted_auth().access_token
    );
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
}

#[test]
fn given_account_a_redemption_replay_in_flight_then_login_b_and_replay_401_then_b_auth_is_preserved(
) {
    let (auth, transport, storage) = redemption_account_switch_fixture(1, true);
    let worker_auth = auth.clone();
    let redemption = thread::spawn(move || {
        worker_auth.authenticated_request(
            "POST",
            "/api/diamond-redemptions/redeem",
            Some(json!({"code":"A-CODE"}).to_string()),
        )
    });
    transport.entered.wait();
    login_account_b(&auth);
    transport.release.wait();

    assert!(finish_with_timeout(redemption).is_err());
    assert_eq!(auth.current_access_token().unwrap(), "b-access");
    assert_eq!(
        storage.value.lock().unwrap().as_ref().unwrap().access_token,
        "b-access"
    );
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
}

#[test]
fn given_account_profile_changes_during_redemption_then_same_login_can_refresh_and_replay() {
    let (auth, transport, storage) = redemption_account_switch_fixture(0, false);
    let worker_auth = auth.clone();
    let redemption = thread::spawn(move || {
        worker_auth.authenticated_request(
            "POST",
            "/api/diamond-redemptions/redeem",
            Some(json!({"code":"A-CODE"}).to_string()),
        )
    });
    transport.entered.wait();
    let previous = storage.value.lock().unwrap().clone().unwrap();
    let mut updated = previous.clone();
    updated.user = Some(json!({"id":7,"nickname":"最新资料"}));
    auth.save_auth_snapshot_for_test(&updated, &Some(previous))
        .unwrap();
    transport.release.wait();

    assert_eq!(finish_with_timeout(redemption).unwrap().status, 200);
    assert_eq!(auth.auth_state().user.unwrap()["nickname"], "最新资料");
    let requests = transport.requests.lock().unwrap();
    let redemptions: Vec<_> = requests
        .iter()
        .filter(|request| request.path == "/api/diamond-redemptions/redeem")
        .collect();
    assert_eq!(redemptions.len(), 2);
    assert_eq!(
        redemptions[0].access_token.as_deref(),
        Some("old-access-token")
    );
    assert_eq!(
        redemptions[1].access_token.as_deref(),
        Some("rotated-a-access")
    );
    assert_eq!(redemptions[0].body, redemptions[1].body);
}

#[test]
fn given_old_account_refresh_notifying_after_save_then_new_account_cannot_share_its_result() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({"token":"rotated-a-access","refresh_token":"rotated-a-refresh"}),
        ),
        response(
            200,
            json!({"token":"b-access","refresh_token":"b-refresh","user":{"id":99}}),
        ),
    ]));
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(persisted_auth());
    let auth = Arc::new(session(transport.clone(), storage));
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let notifications = Arc::new(AtomicUsize::new(0));
    let observer_entered = entered.clone();
    let observer_release = release.clone();
    auth.set_auth_state_observer(Arc::new(move |authenticated| {
        if authenticated && notifications.fetch_add(1, Ordering::SeqCst) == 0 {
            observer_entered.wait();
            observer_release.wait();
        }
    }));
    let old_auth = auth.clone();
    let old_refresh = thread::spawn(move || old_auth.refresh_single_flight());
    entered.wait();
    login_account_b(&auth);
    let (sender, receiver) = std::sync::mpsc::channel();
    let new_auth = auth.clone();
    let new_refresh = thread::spawn(move || sender.send(new_auth.refresh_single_flight()).unwrap());
    let before_release = receiver.recv_timeout(std::time::Duration::from_millis(500));
    release.wait();
    finish_with_timeout(old_refresh).unwrap();
    finish_with_timeout(new_refresh);
    let result = before_release.unwrap_or_else(|_| {
        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
    });

    assert!(matches!(result, Err(AuthError::Busy)));
    assert_eq!(auth.current_access_token().unwrap(), "b-access");
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.path == "/api/auth/refresh")
            .count(),
        1
    );
}

struct FailedAccountSaveStorage {
    value: Mutex<Option<PersistedAuth>>,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}

impl AuthStorage for FailedAccountSaveStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError> {
        if auth.user.as_ref().and_then(|user| user.get("id")) == Some(&json!(99)) {
            self.entered.wait();
            self.release.wait();
            return Err(AuthError::Storage("模拟账号认证保存失败".to_string()));
        }
        *self.value.lock().unwrap() = Some(auth.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[test]
fn given_temporary_b_request_during_failed_login_save_then_rollback_a_cannot_refresh_or_replay_b_redemption(
) {
    let storage = Arc::new(FailedAccountSaveStorage {
        value: Mutex::new(Some(persisted_auth())),
        entered: Arc::new(Barrier::new(2)),
        release: Arc::new(Barrier::new(2)),
    });
    let transport = Arc::new(RedemptionAccountSwitchTransport {
        requests: Mutex::new(Vec::new()),
        redemption_calls: AtomicUsize::new(0),
        block_call: 0,
        entered: Arc::new(Barrier::new(2)),
        release: Arc::new(Barrier::new(2)),
        reject_replay: false,
    });
    let client =
        Arc::new(EduApiClient::new("https://edu-api.example.test", transport.clone(), 8).unwrap());
    let auth = Arc::new(AuthSession::new(client, storage.clone()).unwrap());
    let login_auth = auth.clone();
    let login = thread::spawn(move || {
        login_auth.login(LoginInput {
            email: "account-b@example.com".to_string(),
            password: "password".to_string(),
        })
    });
    storage.entered.wait();
    let request_auth = auth.clone();
    let redemption = thread::spawn(move || {
        request_auth.authenticated_request(
            "POST",
            "/api/diamond-redemptions/redeem",
            Some(json!({"code":"B-CODE"}).to_string()),
        )
    });
    transport.entered.wait();
    storage.release.wait();
    assert!(matches!(
        finish_with_timeout(login),
        Err(AuthError::Storage(_))
    ));
    transport.release.wait();
    let result = finish_with_timeout(redemption);

    assert!(matches!(result, Err(AuthError::NotAuthenticated)));
    assert_eq!(
        auth.current_access_token().unwrap(),
        persisted_auth().access_token
    );
    let requests = transport.requests.lock().unwrap();
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/auth/refresh"));
    let redemptions: Vec<_> = requests
        .iter()
        .filter(|request| request.path == "/api/diamond-redemptions/redeem")
        .collect();
    assert_eq!(redemptions.len(), 1);
    assert_eq!(redemptions[0].access_token.as_deref(), Some("b-access"));
}
