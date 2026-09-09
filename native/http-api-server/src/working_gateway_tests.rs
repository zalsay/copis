use super::auth_session::{AuthError, AuthSession, AuthStorage, PersistedAuth};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use super::model_request_client::ModelRequestClient;
use super::working_gateway::{
    handle_working_gateway_request, is_working_oauth_callback_path, is_working_oauth_failure_path,
    is_working_oauth_success_path, oidc_failure_page, oidc_success_page, GatewayError,
    WorkingGateway,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

static HTTP_API_ENV_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct MemoryStorage {
    value: Mutex<Option<PersistedAuth>>,
}

impl AuthStorage for MemoryStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError> {
        *self.value.lock().unwrap() = Some(auth.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
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

fn response(status: u16, body: Value) -> EduApiResponse {
    EduApiResponse {
        status,
        headers: Vec::new(),
        body: serde_json::to_vec(&body).unwrap(),
    }
}

fn gateway(transport: Arc<QueueTransport>) -> WorkingGateway {
    let client = Arc::new(
        EduApiClient::new("https://edu-api.example.test/module/edu-api", transport, 32).unwrap(),
    );
    let storage = Arc::new(MemoryStorage::default());
    let auth = Arc::new(AuthSession::new(client, storage).unwrap());
    WorkingGateway::new(auth)
}

#[test]
fn image_task_gateway_refreshes_once_and_replays_same_request_without_resubmitting_task() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        for (index, expected_token) in ["old-token", "new-token"].into_iter().enumerate() {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let text = String::from_utf8_lossy(&request);
            assert!(text.starts_with("POST /v1/images/tasks HTTP/1.1"));
            assert!(text.contains(&format!("authorization: Bearer {expected_token}")));
            assert!(text.contains("idempotency-key: image-call-1"));
            let content_length = text
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut body_bytes = vec![0_u8; content_length];
            if content_length > 0 {
                socket.read_exact(&mut body_bytes).unwrap();
            }
            let body = if index == 0 {
                b"".as_slice()
            } else {
                br#"{"data":{"task_id":"task-1","status":"queued"}}"#.as_slice()
            };
            let head = format!(
                "HTTP/1.0 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                if index == 0 { 401 } else { 202 },
                body.len()
            );
            socket.write_all(head.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
        }
    });
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({"token":"old-token", "refresh_token":"refresh-token", "user":{"id":1}}),
        ),
        response(
            200,
            json!({"token":"new-token", "refresh_token":"new-refresh"}),
        ),
    ]));
    let client =
        Arc::new(EduApiClient::new("https://edu-api.example.test", transport, 32).unwrap());
    let auth = Arc::new(AuthSession::new(client, Arc::new(MemoryStorage::default())).unwrap());
    auth.login(super::auth_session::LoginInput {
        email: "u@example.com".into(),
        password: "password".into(),
    })
    .unwrap();
    let model = ModelRequestClient::new(&format!("http://{address}"), 5).unwrap();
    let gateway = WorkingGateway::with_model_client(auth, model);
    let result = handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/image/tasks",
        Some(r#"{"prompt":"test","sessionId":"s-1","request_id":"image-call-1"}"#),
    )
    .unwrap();
    assert_eq!(result.status, 202);
    assert_eq!(result.body.unwrap()["data"]["task_id"], "task-1");
    let listed = handle_working_gateway_request(&gateway, "GET", "/api/working/image/tasks?session_id=s-1", None).unwrap();
    assert_eq!(listed.body.unwrap()["data"]["tasks"][0]["request_id"], "image-call-1");
    server.join().unwrap();
}

#[test]
fn image_task_completed_query_uses_sqlite_cache_after_upstream_stops() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).unwrap(); request.push(byte[0]); }
        assert!(String::from_utf8_lossy(&request).starts_with("GET /v1/images/tasks/cached-task HTTP/1.1"));
        let body = r#"{"data":{"task_id":"cached-task","status":"completed","image_url":"https://cos.example/image?q-sign-time=1%3B4000000000"}}"#;
        write!(socket, "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
    });
    let transport = Arc::new(QueueTransport::new(vec![]));
    let client = Arc::new(EduApiClient::new("https://edu-api.example.test", transport, 32).unwrap());
    let storage = Arc::new(MemoryStorage::default());
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        access_token: "test-access".into(), refresh_token: None, provider: "oidc".into(),
        user: Some(json!({"ID":42})), expires_at: Some(4000000000),
    });
    let auth = Arc::new(AuthSession::new(client, storage).unwrap());
    let gateway = WorkingGateway::with_model_client(auth.clone(), ModelRequestClient::new(&format!("http://{address}"), 1).unwrap());
    let first = handle_working_gateway_request(&gateway, "GET", "/api/working/image/tasks/cached-task", None).unwrap();
    server.join().unwrap();
    let second = handle_working_gateway_request(&gateway, "GET", "/api/working/image/tasks/cached-task", None).unwrap();
    assert_eq!(first.body, second.body);
    assert!(handle_working_gateway_request(&gateway, "GET", "/api/working/image/tasks/cached-task?refresh=1", None).is_err());
    auth.logout().unwrap();
    assert!(handle_working_gateway_request(&gateway, "GET", "/api/working/image/tasks/cached-task", None).is_err());
}

#[test]
fn public_login_route_is_owned_by_working_gateway() {
    assert!(super::working_gateway::is_working_gateway_path(
        "/api/working/login"
    ));
}

#[test]
fn given_oidc_callback_success_when_browser_receives_response_then_sensitive_url_is_replaced() {
    let page = oidc_success_page();

    assert!(is_working_oauth_callback_path(
        "/api/working/oauth/callback"
    ));
    assert!(is_working_oauth_success_path("/api/working/oauth/success"));
    assert!(is_working_oauth_failure_path("/api/working/oauth/failure"));
    assert!(!is_working_oauth_callback_path(
        "/api/working/oauth/callback/extra"
    ));
    assert!(!is_working_oauth_success_path(
        "/api/working/oauth/success/extra"
    ));
    assert!(!is_working_oauth_failure_path(
        "/api/working/oauth/failure/extra"
    ));
    assert!(page.contains("授权成功"));
    assert!(page.contains("history.replaceState"));
    assert!(page.contains("/api/working/oauth/success"));
    assert!(!page.contains("code="));
    assert!(!page.contains("state="));
    assert!(!page.contains("access_token"));
    assert!(!page.contains("refresh_token"));
}

#[test]
fn given_oidc_callback_failure_when_browser_receives_response_then_sensitive_url_is_replaced() {
    let page = oidc_failure_page();

    assert!(page.contains("授权未完成"));
    assert!(page.contains("history.replaceState"));
    assert!(page.contains("/api/working/oauth/failure"));
    assert!(!page.contains("code="));
    assert!(!page.contains("state="));
    assert!(!page.contains("access_token"));
    assert!(!page.contains("refresh_token"));
}

#[test]
fn given_valid_oidc_callback_when_gateway_completes_auth_then_response_has_no_auth_payload() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({
                "issuer": "https://edu-api.example.test/module/auth",
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
        response(
            200,
            json!({ "data": { "id": 7, "email": "oidc@example.com" } }),
        ),
    ]));
    let client = Arc::new(
        EduApiClient::new("https://edu-api.example.test/module/auth", transport, 32).unwrap(),
    );
    let auth = Arc::new(
        AuthSession::new_with_oidc(
            Arc::clone(&client),
            Arc::new(MemoryStorage::default()),
            Some(client),
        )
        .unwrap(),
    );
    let redirect_uri = super::auth_session::working_oidc_redirect_uri();
    let authorization_url = auth.start_oidc(&redirect_uri).unwrap();
    let state = authorization_url
        .split('&')
        .find_map(|pair| pair.strip_prefix("state="))
        .unwrap();
    let gateway = WorkingGateway::new(auth);

    let result = handle_working_gateway_request(
        &gateway,
        "GET",
        &format!("/api/working/oauth/callback?code=code-1&state={state}"),
        None,
    )
    .unwrap();

    assert_eq!(result.status, 200);
    assert!(result.body.is_none());
}

#[test]
fn given_success_page_path_when_browser_reloads_then_gateway_keeps_serving_success_page() {
    let gateway = gateway(Arc::new(QueueTransport::new(Vec::new())));

    let result =
        handle_working_gateway_request(&gateway, "GET", "/api/working/oauth/success", None)
            .unwrap();

    assert_eq!(result.status, 200);
    assert!(result.body.is_none());
}

#[test]
fn given_failure_page_path_when_browser_reloads_then_gateway_keeps_serving_failure_page() {
    let gateway = gateway(Arc::new(QueueTransport::new(Vec::new())));

    let result =
        handle_working_gateway_request(&gateway, "GET", "/api/working/oauth/failure", None)
            .unwrap();

    assert_eq!(result.status, 200);
    assert!(result.body.is_none());
}

#[test]
fn login_oidc_route_uses_registered_rust_callback_uri() {
    let _env_lock = HTTP_API_ENV_LOCK.lock().unwrap();
    let transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "issuer": "https://edu-api.example.test/module/edu-api",
            "authorization_endpoint": "/oauth/authorize",
            "token_endpoint": "/oauth/token"
        }),
    )]));
    let client = Arc::new(
        EduApiClient::new(
            "https://edu-api.example.test/module/edu-api",
            transport.clone(),
            32,
        )
        .unwrap(),
    );
    let auth = Arc::new(
        AuthSession::new_with_oidc(
            Arc::clone(&client),
            Arc::new(MemoryStorage::default()),
            Some(client),
        )
        .unwrap(),
    );
    let gateway = WorkingGateway::new(auth);

    let result =
        handle_working_gateway_request(&gateway, "POST", "/api/working/login-oidc", Some("{}"))
            .unwrap();
    let authorization_url = result.body.unwrap()["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(authorization_url.contains(
        "redirect_uri=http%3A%2F%2F127.0.0.1%3A51730%2Fapi%2Fworking%2Foauth%2Fcallback"
    ));
}

#[test]
fn login_oidc_network_failure_does_not_report_storage_failure() {
    let transport = Arc::new(QueueTransport::new(Vec::new()));
    let client = Arc::new(
        EduApiClient::new("https://edu-api.example.test/module/auth", transport, 32).unwrap(),
    );
    let auth = Arc::new(
        AuthSession::new_with_oidc(
            Arc::clone(&client),
            Arc::new(MemoryStorage::default()),
            Some(client),
        )
        .unwrap(),
    );
    let gateway = WorkingGateway::new(auth);

    let error =
        handle_working_gateway_request(&gateway, "POST", "/api/working/login-oidc", Some("{}"))
            .unwrap_err();

    assert_eq!(error.status, 503);
    assert_eq!(error.code, "auth_network_unavailable");
}

#[test]
fn login_oidc_route_uses_configured_development_api_port() {
    let _env_lock = HTTP_API_ENV_LOCK.lock().unwrap();
    let previous_port = std::env::var("COPIS_HTTP_API_PORT").ok();
    std::env::set_var("COPIS_HTTP_API_PORT", "51740");

    let transport = Arc::new(QueueTransport::new(vec![response(
        200,
        json!({
            "issuer": "https://edu-api.example.test/module/edu-api",
            "authorization_endpoint": "/oauth/authorize",
            "token_endpoint": "/oauth/token"
        }),
    )]));
    let client = Arc::new(
        EduApiClient::new("https://edu-api.example.test/module/edu-api", transport, 32).unwrap(),
    );
    let auth = Arc::new(
        AuthSession::new_with_oidc(
            Arc::clone(&client),
            Arc::new(MemoryStorage::default()),
            Some(client),
        )
        .unwrap(),
    );
    let gateway = WorkingGateway::new(auth);
    let result =
        handle_working_gateway_request(&gateway, "POST", "/api/working/login-oidc", Some("{}"))
            .unwrap();
    let body = result.body.unwrap();
    let authorization_url = body["authorizationUrl"].as_str().unwrap();
    assert!(authorization_url.contains(
        "redirect_uri=http%3A%2F%2F127.0.0.1%3A51740%2Fapi%2Fworking%2Foauth%2Fcallback"
    ));

    match previous_port {
        Some(port) => std::env::set_var("COPIS_HTTP_API_PORT", port),
        None => std::env::remove_var("COPIS_HTTP_API_PORT"),
    }
}

#[test]
fn protected_route_rejects_without_auth_before_remote_request() {
    let transport = Arc::new(QueueTransport::new(Vec::new()));
    let gateway = gateway(transport.clone());

    let error = handle_working_gateway_request(&gateway, "GET", "/api/working/workspaces", None)
        .unwrap_err();

    assert!(matches!(error, GatewayError { status: 401, ref code, .. } if code == "unauthorized"));
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn login_and_workspace_routes_keep_renderer_compatible_envelopes() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token","user_id":7})),
        response(
            200,
            json!({"data":[{"id":3,"workspace_path":"/tmp/project","workspace_type":"local"}]}),
        ),
    ]));
    let gateway = gateway(transport.clone());

    let login = handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();
    assert_eq!(login.status, 200);
    assert_eq!(
        login
            .body
            .as_ref()
            .and_then(|body| body.get("authenticated"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert!(serde_json::to_string(&login.body)
        .unwrap()
        .contains("user@example.com"));
    assert!(!serde_json::to_string(&login.body)
        .unwrap()
        .contains("access-token"));

    let workspaces =
        handle_working_gateway_request(&gateway, "GET", "/api/working/workspaces", None).unwrap();
    assert_eq!(
        workspaces.body.unwrap(),
        json!([{"id":3,"workspace_path":"/tmp/project","workspace_type":"local"}])
    );
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/auth/login", "/api/working/workspaces",]
    );
}

#[test]
fn settings_route_aggregates_legacy_account_snapshot_sources() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token","user_id":7})),
        response(
            200,
            json!({
                "data": {"id": 7, "email": "user@example.com"},
                "has_checked_in": true,
                "vip": {"is_vip": true},
            }),
        ),
        response(
            200,
            json!({"data":[{"id":8,"email":"invited@example.com"}]}),
        ),
        response(
            200,
            json!({"data": {
                "members": [{"id": 7, "tokens": 1200}],
                "ledger": [
                    {"id": 10, "source_type": "reward", "amount_tokens": 50},
                    {"id": 12, "source_type": "alipay_diamond_purchase", "amount_tokens": 200}
                ]
            }}),
        ),
        response(
            200,
            json!({"data":[{"id":11,"type":"purchase","amount_tokens":100}]}),
        ),
        response(
            200,
            json!({"data":{"Code":"INVITE-7"},"invite_link":"https://example.test/invite/INVITE-7"}),
        ),
        response(
            200,
            json!({"data":{"channel":"feishu","weixin_bound":false,"feishu_bound":true}}),
        ),
    ]));
    let gateway = gateway(transport.clone());
    handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();

    let result =
        handle_working_gateway_request(&gateway, "GET", "/api/working/settings", None).unwrap();

    assert_eq!(
        result.body.unwrap(),
        json!({
            "user": {"id": 7, "email": "user@example.com"},
            "has_checked_in": true,
            "vip": {"is_vip": true},
            "invitedUsers": [{"id": 8, "email": "invited@example.com"}],
            "members": [{"id": 7, "tokens": 1200}],
            "ledger": [
                {"id": "family:10", "source_type": "reward", "amount_tokens": 50},
                {"id": "billing:11", "type": "purchase", "amount_tokens": 100}
            ],
            "inviteCode": "INVITE-7",
            "inviteLink": "https://example.test/invite/INVITE-7",
            "receiveChannel": {"channel":"feishu","weixin_bound":false,"feishu_bound":true}
        })
    );
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/auth/login",
            "/api/users/me",
            "/api/users/invited",
            "/api/family/wallet",
            "/api/users/billing-ledger",
            "/api/users/invite-code",
            "/api/working/receive-channel",
        ]
    );
}

#[test]
fn settings_route_preserves_user_envelope_fields() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token","user_id":7})),
        response(
            200,
            json!({
                "data": {"id": 7, "email": "user@example.com"},
                "has_checked_in": true,
                "vip": {"is_vip": true},
            }),
        ),
    ]));
    let gateway = gateway(transport);
    handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();

    let result =
        handle_working_gateway_request(&gateway, "GET", "/api/working/settings", None).unwrap();

    assert_eq!(
        result.body.unwrap(),
        json!({
            "user": {"id": 7, "email": "user@example.com"},
            "has_checked_in": true,
            "vip": {"is_vip": true},
            "invitedUsers": [],
            "members": [],
            "ledger": [],
            "receiveChannel": null,
        })
    );
}

#[test]
fn unauthorized_remote_response_refreshes_once_and_replays_gateway_request() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            200,
            json!({"token":"old-token","refresh_token":"refresh-token","user":{"id":7}}),
        ),
        response(401, json!({"code":"unauthorized"})),
        response(
            200,
            json!({"token":"new-token","refresh_token":"new-refresh-token"}),
        ),
        response(200, json!({"data":[{"id":3}]})),
    ]));
    let gateway = gateway(transport.clone());

    handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();
    let result =
        handle_working_gateway_request(&gateway, "GET", "/api/working/workspaces", None).unwrap();
    assert_eq!(result.status, 200);
    assert_eq!(transport.requests.lock().unwrap().len(), 4);
}

#[test]
fn rejects_traversal_and_invalid_pagination_without_remote_call() {
    let transport = Arc::new(QueueTransport::new(Vec::new()));
    let gateway = gateway(transport.clone());

    let traversal = handle_working_gateway_request(
        &gateway,
        "GET",
        "/api/working/sessions/a%2F..%2Fb/history",
        None,
    )
    .unwrap_err();
    assert!(
        matches!(traversal, GatewayError { status: 400, ref code, .. } if code == "invalid_path")
    );

    let page = handle_working_gateway_request(
        &gateway,
        "GET",
        "/api/working/orders?page=not-a-number",
        None,
    )
    .unwrap_err();
    assert!(matches!(page, GatewayError { status: 400, ref code, .. } if code == "invalid_query"));
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn maps_upstream_failure_to_public_code_without_forwarding_sensitive_body() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token","user":{"id":7}})),
        response(
            503,
            json!({"code":"edu_unavailable","message":"暂时不可用","password":"do-not-return"}),
        ),
    ]));
    let gateway = gateway(transport);
    handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();
    let error = handle_working_gateway_request(&gateway, "GET", "/api/working/current-user", None)
        .unwrap_err();
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "edu_unavailable");
    assert!(!error.message.contains("do-not-return"));
}

#[test]
fn maps_upstream_failure_includes_detail_when_present() {
    let transport = Arc::new(QueueTransport::new(vec![
        response(200, json!({"token":"access-token","user":{"id":7}})),
        response(
            502,
            json!({
                "error": "working image generation failed",
                "detail": "image model request failed: HTTP 401 Unauthorized"
            }),
        ),
    ]));
    let gateway = gateway(transport);
    handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/login",
        Some(r#"{"email":"user@example.com","password":"password"}"#),
    )
    .unwrap();
    let error = handle_working_gateway_request(
        &gateway,
        "POST",
        "/api/working/image",
        Some(r#"{"prompt":"cat"}"#),
    )
    .unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(error.code, "upstream_error");
    assert_eq!(
        error.message,
        "working image generation failed: image model request failed: HTTP 401 Unauthorized"
    );
}
