use super::{
    handle_request, legacy_handle_request, parse_working_payment_route, poll_desktop_payments_once,
    recover_pending_desktop_payment, PaymentWorker, WorkingPaymentRoute, WorkingPaymentState,
};
use crate::payment_workspace::PaymentWorkspace;
use crate::pi_rpc::PaymentWorkerAction;
use crate::skill_market::{backend_env_test_lock, SkillMarketState};
use serde_json::json;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn parses_all_working_payment_routes() {
    assert_eq!(
        parse_working_payment_route("GET", "/api/working/diamond-packages").unwrap(),
        WorkingPaymentRoute::ListDiamondPackages,
    );
    assert_eq!(
        parse_working_payment_route("GET", "/api/working/diamond-purchases/pending").unwrap(),
        WorkingPaymentRoute::PendingDiamondPurchase,
    );
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/diamond-purchases").unwrap(),
        WorkingPaymentRoute::CreateDiamondPurchase,
    );
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/vip/upgrade").unwrap(),
        WorkingPaymentRoute::CreateVipUpgrade,
    );
    assert_eq!(
        parse_working_payment_route("GET", "/api/working/orders/order%2F7/payment").unwrap(),
        WorkingPaymentRoute::GetOrderPayment {
            order_id: "order/7".to_string(),
        },
    );
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/diamond-purchases/payment%2F7/check",)
            .unwrap(),
        WorkingPaymentRoute::CheckPayment {
            payment_id: "payment/7".to_string(),
        },
    );
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/diamond-purchases/payment%2F7/cancel",)
            .unwrap(),
        WorkingPaymentRoute::CancelDiamondPayment {
            payment_id: "payment/7".to_string(),
        },
    );
    assert!(parse_working_payment_route("POST", "/api/working/alipay/page-orders").is_err());
    assert!(parse_working_payment_route(
        "POST",
        "/api/working/alipay/page-orders/payment%2F7/check"
    )
    .is_err());
}

#[test]
fn payment_account_key_remains_stable_when_access_token_refreshes() {
    let state = SkillMarketState::new(Some("access-token-1".to_string()));
    state.set_working_auth(Some("access-token-1".to_string()), Some("user-7".to_string()));
    let initial_account_key = state.payment_account_key().unwrap();

    state.set_working_auth(Some("access-token-2".to_string()), Some("user-7".to_string()));

    assert_eq!(state.payment_account_key().as_deref(), Some(initial_account_key.as_str()));
    assert_eq!(state.access_token().as_deref(), Some("access-token-2"));
}

#[test]
fn payment_account_key_changes_when_working_user_changes() {
    let state = SkillMarketState::new(Some("access-token-1".to_string()));
    state.set_working_auth(Some("access-token-1".to_string()), Some("user-7".to_string()));
    let first_account_key = state.payment_account_key().unwrap();

    state.set_working_auth(Some("access-token-2".to_string()), Some("user-8".to_string()));

    assert_ne!(state.payment_account_key().as_deref(), Some(first_account_key.as_str()));
}

fn read_request(stream: &mut TcpStream) -> (String, String, String, Vec<u8>) {
    let mut header = Vec::new();
    let mut byte = [0_u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
    }
    let header_text = String::from_utf8(header).unwrap();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap().to_string();
    let path = request_parts.next().unwrap().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_string(), value.trim().to_string()))
        .collect();
    let authorization = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0_u8; content_length];
    stream.read_exact(&mut body).unwrap();
    (method, path, authorization, body)
}

fn respond(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body,
    );
    stream.write_all(response.as_bytes()).unwrap();
}

#[test]
fn forwards_create_payment_with_backend_auth_and_unwraps_data() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (method, path, authorization, body) = read_request(&mut stream);
        assert_eq!(method, "POST");
        assert_eq!(path, "/api/pay/alipay/diamond-purchases");
        assert_eq!(authorization, "Bearer payment-token");
        assert_eq!(body, br#"{"package_id":7}"#);
        respond(
            &mut stream,
            r#"{"data":{"package":{"id":7},"payment":{"payment_id":"payment-7"}}}"#,
        );
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let result = legacy_handle_request(
        &SkillMarketState::new(Some("payment-token".to_string())),
        "POST",
        "/api/working/diamond-purchases",
        br#"{"packageId":7}"#,
    )
    .unwrap();
    backend.join().unwrap();
    restore_backend_url(previous_backend);

    assert_eq!(
        result.body.unwrap(),
        json!({ "package": { "id": 7 }, "payment": { "payment_id": "payment-7" } })
    );
}

#[test]
fn preserves_payment_check_business_envelope() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (method, path, authorization, body) = read_request(&mut stream);
        assert_eq!(method, "POST");
        assert_eq!(path, "/api/pay/alipay/diamond-purchases/payment%2F7/check");
        assert_eq!(authorization, "Bearer payment-token");
        assert_eq!(body, br#"{}"#);
        respond(
            &mut stream,
            r#"{"skill":"alipay.payment.check","ok":true,"message":"ok","data":{"status":"resource_ready","payment":{"payment_id":"payment/7"}}}"#,
        );
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let result = legacy_handle_request(
        &SkillMarketState::new(Some("payment-token".to_string())),
        "POST",
        "/api/working/diamond-purchases/payment%2F7/check",
        br#"{}"#,
    )
    .unwrap();
    backend.join().unwrap();
    restore_backend_url(previous_backend);

    let body = result.body.unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["data"]["status"], "resource_ready");
}

fn restore_backend_url(previous_backend: Option<String>) {
    match previous_backend {
        Some(value) => std::env::set_var("COPIS_BACKEND_URL", value),
        None => std::env::remove_var("COPIS_BACKEND_URL"),
    }
}

struct PaymentWorkspaceFixture {
    root: PathBuf,
    workspace: PaymentWorkspace,
}

impl PaymentWorkspaceFixture {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "copis-working-payment-test-{}-{}",
            std::process::id(),
            suffix
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let project = root.join("project");
        let root_text = root.to_string_lossy().to_string();
        let project_text = project.to_string_lossy().to_string();
        let payment_home = root.join(".copis").join("payment");
        let payment_home_text = payment_home.to_string_lossy().to_string();
        let workspace =
            PaymentWorkspace::parse("default", &root_text, &project_text, &payment_home_text)
                .unwrap();
        Self { root, workspace }
    }
}

impl Drop for PaymentWorkspaceFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct FakePaymentWorker {
    results: Mutex<VecDeque<Result<serde_json::Value, String>>>,
    calls: Mutex<Vec<(PaymentWorkerAction, serde_json::Value)>>,
}

impl FakePaymentWorker {
    fn new(results: Vec<Result<serde_json::Value, String>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl PaymentWorker for FakePaymentWorker {
    fn execute_payment(
        &self,
        _workspace: &PaymentWorkspace,
        server_account_id: &str,
        action: PaymentWorkerAction,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        assert!(!server_account_id.contains("payment-token"));
        self.calls.lock().unwrap().push((action, request));
        self.results
            .lock()
            .unwrap()
            .pop_front()
            .expect("支付 Worker 缺少预期结果")
    }
}

#[test]
fn desktop_diamond_payment_is_automatically_checked_by_rust_and_never_calls_legacy_routes() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let expected = [
            (
                "GET",
                "/api/pay/alipay/diamond-purchases/pending",
                "Bearer payment-token",
                None,
                r#"{"data":null}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                Some(br#"{"flow_kind":"diamond"}"#.as_slice()),
                r#"{"data":{"capability":"wdpc_test","flow_kind":"diamond"}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/diamond/prepare",
                "Bearer wdpc_test",
                Some(br#"{"package_id":7}"#.as_slice()),
                r#"{"data":{"pending_existing":false,"payment":{"payment_id":"pay-7","out_trade_no":"ORDER-7","status":"created","amount":"9.90","currency":"CNY"},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"},"payment_needed":{"protocol":"402"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-context",
                "Bearer wdpc_test",
                Some(br#"{"payment_id":"pay-7"}"#.as_slice()),
                r#"{"data":{"payment_id":"pay-7","session_id":"pay-7","payment_needed":{"protocol":"402"},"resource_url":"https://seller.example.test/resource","method":"POST","data":"{}","headers":{"Content-Type":"application/json","X-Working-Desktop-Payment-Resource":"wdpr-test"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-started",
                "Bearer wdpc_test",
                Some(br#"{"payment_id":"pay-7","trade_no":"trade-7","cashier_url":"https://cashier.example.test/pay","qrcode_image":"data:image/png;base64,iVBORw0KGgo=","qrcode_mime_type":"image/png","bot_result":{"action":"payment.start","ok":true}}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-7","out_trade_no":"ORDER-7","trade_no":"trade-7","status":"pending_user_pay","amount":"9.90","currency":"CNY","cashier_url":"https://cashier.example.test/pay"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-finalize",
                "Bearer wdpc_test",
                Some(br#"{"payment_id":"pay-7","action":"check","check_result":{"status":"paid","trade_no":"trade-7","payment_proof":"proof-7","client_session":"client-7"}}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-7","out_trade_no":"ORDER-7","trade_no":"trade-7","status":"resource_ready","amount":"9.90","currency":"CNY","cashier_url":"https://cashier.example.test/pay"}}}"#,
            ),
        ];
        for (method_expected, path_expected, authorization_expected, body_expected, response) in expected {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, method_expected);
            assert_eq!(path, path_expected);
            assert_eq!(authorization, authorization_expected);
            if let Some(body_expected) = body_expected {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    serde_json::from_slice::<serde_json::Value>(body_expected).unwrap(),
                );
            }
            respond(&mut stream, response);
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![
        Ok(json!({
            "ok": true,
            "tradeNo": "trade-7",
            "cashierUrl": "https://cashier.example.test/pay",
            "qrCodeImage": "data:image/png;base64,iVBORw0KGgo=",
            "qrCodeMimeType": "image/png",
        })),
        Ok(json!({
            "ok": true,
            "status": "paid",
            "tradeNo": "trade-7",
            "paymentProof": "proof-7",
            "clientSession": "client-7",
        })),
    ]);
    let payment_state = WorkingPaymentState::new();
    let state = SkillMarketState::new(Some("payment-token".to_string()));
    state.set_working_auth(Some("payment-token".to_string()), Some("user-7".to_string()));

    let created = handle_request(
        &state,
        &payment_state,
        &worker,
        &fixture.workspace,
        "POST",
        "/api/working/diamond-purchases",
        br#"{"packageId":7}"#,
    )
    .unwrap();
    let failures =
        poll_desktop_payments_once(&payment_state, &worker, &fixture.workspace, "payment-token", "account-7");

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    let created_body = created.body.as_ref().unwrap();
    assert_eq!(created_body["payment"]["status"], "pending_user_pay");
    assert_eq!(failures, 0);
    let calls = worker.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, PaymentWorkerAction::PaymentStart);
    assert!(calls[0].1["paymentNeeded"]
        .as_str()
        .is_some_and(|value| value.contains("\"protocol\":\"402\"")));
    assert_eq!(calls[1].0, PaymentWorkerAction::PaymentCheck);
    assert_eq!(calls[1].1["resourceUrl"], "https://seller.example.test/resource");
    assert_eq!(calls[1].1["method"], "POST");
    assert_eq!(calls[1].1["data"], "{}");
    assert_eq!(calls[1].1["headers"][0]["name"], "Content-Type");
    assert!(calls[1].1.get("paymentNeeded").is_none());
    assert!(created_body.get("paymentProof").is_none());
}

#[test]
fn desktop_diamond_payment_reuses_a_pending_order_without_starting_a_second_payment() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let expected = [
            (
                "GET",
                "/api/pay/alipay/diamond-purchases/pending",
                "Bearer payment-token",
                None,
                r#"{"data":{"payment":{"payment_id":"pay-existing","status":"pending_user_pay","trade_no":"trade-existing","qrcode_image":"data:image/png;base64,iVBORw0KGgo="},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                Some(br#"{"flow_kind":"diamond"}"#.as_slice()),
                r#"{"data":{"capability":"wdpc_existing","flow_kind":"diamond"}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/diamond/prepare",
                "Bearer wdpc_existing",
                Some(br#"{"package_id":7}"#.as_slice()),
                r#"{"data":{"pending_existing":true,"payment":{"payment_id":"pay-existing","status":"pending_user_pay"},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-context",
                "Bearer wdpc_existing",
                Some(br#"{"payment_id":"pay-existing"}"#.as_slice()),
                r#"{"data":{"payment_id":"pay-existing","payment_needed":{"protocol":"402"},"resource_url":"https://seller.example.test/resource","method":"POST","data":"{}","headers":{"Content-Type":"application/json"}}}"#,
            ),
        ];
        for (method_expected, path_expected, authorization_expected, body_expected, response) in expected {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, method_expected);
            assert_eq!(path, path_expected);
            assert_eq!(authorization, authorization_expected);
            if let Some(body_expected) = body_expected {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    serde_json::from_slice::<serde_json::Value>(body_expected).unwrap(),
                );
            }
            respond(&mut stream, response);
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![]);
    let payment_state = WorkingPaymentState::new();
    let state = SkillMarketState::new(Some("payment-token".to_string()));
    state.set_working_auth(Some("payment-token".to_string()), Some("user-7".to_string()));

    let result = handle_request(
        &state,
        &payment_state,
        &worker,
        &fixture.workspace,
        "POST",
        "/api/working/diamond-purchases",
        br#"{"packageId":7}"#,
    )
    .unwrap();

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    let body = result.body.unwrap();
    assert_eq!(body["pending_existing"], true);
    assert_eq!(body["payment"]["payment_id"], "pay-existing");
    assert_eq!(body["payment"]["qrcode_image"], "data:image/png;base64,iVBORw0KGgo=");
    assert!(payment_state.flow("pay-existing").is_some());
    assert!(worker.calls.lock().unwrap().is_empty());
}

#[test]
fn desktop_diamond_payment_replaces_an_unusable_pending_order_before_starting_a_new_payment() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let expected = [
            (
                "GET",
                "/api/pay/alipay/diamond-purchases/pending",
                "Bearer payment-token",
                None,
                r#"{"data":{"payment":{"payment_id":"pay-old","status":"pending_user_pay"},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                Some(br#"{"flow_kind":"diamond"}"#.as_slice()),
                r#"{"data":{"capability":"wdpc_old","flow_kind":"diamond"}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/diamond/prepare",
                "Bearer wdpc_old",
                Some(br#"{"package_id":7}"#.as_slice()),
                r#"{"data":{"pending_existing":true,"payment":{"payment_id":"pay-old","status":"pending_user_pay"},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-finalize",
                "Bearer wdpc_old",
                Some(br#"{"payment_id":"pay-old","action":"cancel"}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-old","status":"cancelled"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                Some(br#"{"flow_kind":"diamond"}"#.as_slice()),
                r#"{"data":{"capability":"wdpc_new","flow_kind":"diamond"}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/diamond/prepare",
                "Bearer wdpc_new",
                Some(br#"{"package_id":7}"#.as_slice()),
                r#"{"data":{"pending_existing":false,"payment":{"payment_id":"pay-new","status":"created"},"package":{"id":7,"amount":"9.90","amount_cents":990,"diamonds":100,"currency":"CNY"},"payment_needed":{"protocol":"402"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-context",
                "Bearer wdpc_new",
                Some(br#"{"payment_id":"pay-new"}"#.as_slice()),
                r#"{"data":{"payment_id":"pay-new","payment_needed":{"protocol":"402"},"resource_url":"https://seller.example.test/resource","method":"POST","data":"{}","headers":{"Content-Type":"application/json"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-started",
                "Bearer wdpc_new",
                Some(br#"{"payment_id":"pay-new","trade_no":"trade-new","qrcode_image":"data:image/png;base64,iVBORw0KGgo=","qrcode_mime_type":"image/png","bot_result":{"action":"payment.start","ok":true}}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-new","status":"pending_user_pay","qrcode_image":"data:image/png;base64,iVBORw0KGgo="}}}"#,
            ),
        ];
        for (method_expected, path_expected, authorization_expected, body_expected, response) in expected {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, method_expected);
            assert_eq!(path, path_expected);
            assert_eq!(authorization, authorization_expected);
            if let Some(body_expected) = body_expected {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    serde_json::from_slice::<serde_json::Value>(body_expected).unwrap(),
                );
            }
            respond(&mut stream, response);
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![Ok(json!({
        "ok": true,
        "tradeNo": "trade-new",
        "qrCodeImage": "data:image/png;base64,iVBORw0KGgo=",
        "qrCodeMimeType": "image/png",
    }))]);
    let payment_state = WorkingPaymentState::new();
    let state = SkillMarketState::new(Some("payment-token".to_string()));
    state.set_working_auth(Some("payment-token".to_string()), Some("user-7".to_string()));

    let result = handle_request(
        &state,
        &payment_state,
        &worker,
        &fixture.workspace,
        "POST",
        "/api/working/diamond-purchases",
        br#"{"packageId":7}"#,
    )
    .unwrap();

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    assert_eq!(result.body.unwrap()["payment"]["payment_id"], "pay-new");
    let calls = worker.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PaymentWorkerAction::PaymentStart);
}

#[test]
fn desktop_payment_forwards_paid_status_without_payment_proof_for_go_api_fallback() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (method, path, authorization, body) = read_request(&mut stream);
        assert_eq!(method, "POST");
        assert_eq!(
            path,
            "/api/internal/working-desktop/alipay/payment-finalize"
        );
        assert_eq!(authorization, "Bearer wdpc_test");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({
                "payment_id": "pay-7",
                "action": "check",
                "check_result": {
                    "status": "paid",
                    "trade_no": "trade-7",
                },
            }),
        );
        respond(
            &mut stream,
            r#"{"data":{"payment":{"payment_id":"pay-7","status":"resource_ready"}}}"#,
        );
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![Ok(json!({
        "ok": true,
        "status": "paid",
        "tradeNo": "trade-7",
    }))]);
    let payment_state = WorkingPaymentState::new();
    payment_state.remember(
        "pay-7".to_string(),
        super::WorkingDesktopPaymentFlow {
            capability: "wdpc_test".to_string(),
            flow_kind: super::DesktopPaymentFlowKind::Diamond,
            trade_no: Some("trade-7".to_string()),
            out_shake_no: None,
            request_context: super::PaymentRequestContext {
                resource_url: "https://seller.example.test/resource".to_string(),
                method: "POST".to_string(),
                data: "{}".to_string(),
                headers: vec![json!({ "name": "Content-Type", "value": "application/json" })],
            },
        },
    );

    let result = super::check_desktop_payment(
        &payment_state,
        &worker,
        &fixture.workspace,
        "payment-token",
        "account-7",
        "pay-7",
    )
    .unwrap();

    backend.join().unwrap();
    restore_backend_url(previous_backend);
    assert_eq!(result["data"]["status"], "resource_ready");
}

#[test]
fn desktop_payment_prefers_out_shake_no_and_forwards_paid_status_without_payment_proof() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (method, path, authorization, body) = read_request(&mut stream);
        assert_eq!(method, "POST");
        assert_eq!(
            path,
            "/api/internal/working-desktop/alipay/payment-finalize"
        );
        assert_eq!(authorization, "Bearer wdpc_test");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({
                "payment_id": "pay-7",
                "action": "check",
                "check_result": {
                    "status": "paid",
                    "out_shake_no": "shake-7",
                },
            }),
        );
        respond(
            &mut stream,
            r#"{"data":{"payment":{"payment_id":"pay-7","status":"resource_ready"}}}"#,
        );
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![Ok(json!({
        "ok": true,
        "status": "paid",
        "outShakeNo": "shake-7",
    }))]);
    let payment_state = WorkingPaymentState::new();
    payment_state.remember(
        "pay-7".to_string(),
        super::WorkingDesktopPaymentFlow {
            capability: "wdpc_test".to_string(),
            flow_kind: super::DesktopPaymentFlowKind::Diamond,
            trade_no: Some("trade-7".to_string()),
            out_shake_no: Some("shake-7".to_string()),
            request_context: super::PaymentRequestContext {
                resource_url: "https://seller.example.test/resource".to_string(),
                method: "POST".to_string(),
                data: "{}".to_string(),
                headers: vec![json!({ "name": "Content-Type", "value": "application/json" })],
            },
        },
    );

    let result = super::check_desktop_payment(
        &payment_state,
        &worker,
        &fixture.workspace,
        "payment-token",
        "account-7",
        "pay-7",
    )
    .unwrap();

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    assert_eq!(result["data"]["status"], "resource_ready");
    let calls = worker.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PaymentWorkerAction::PaymentCheck);
    assert_eq!(calls[0].1["outShakeNo"], "shake-7");
    assert!(calls[0].1.get("tradeNo").is_none());
}

#[test]
fn desktop_payment_keeps_a_nonempty_proof_for_the_normal_confirmation_path() {
    let result = super::payment_check_result(&json!({
        "status": "paid",
        "tradeNo": "trade-7",
        "paymentProof": "proof-7",
    }))
    .unwrap();

    assert_eq!(result["status"], "paid");
    assert_eq!(result["payment_proof"], "proof-7");
}

#[test]
fn desktop_payment_forwards_paid_status_without_any_trade_identifier_for_out_trade_no_fallback() {
    let result = super::payment_check_result(&json!({
        "status": "paid",
    }))
    .unwrap();

    assert_eq!(result, json!({ "status": "paid" }));
}

#[test]
fn rust_automatically_recovers_pending_payment_after_restart() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let expected = [
            (
                "GET",
                "/api/pay/alipay/diamond-purchases/pending",
                "Bearer payment-token",
                None,
                r#"{"data":{"payment":{"payment_id":"pay-7","trade_no":"trade-7","out_shake_no":"shake-7","status":"pending_user_pay"},"package":{"id":7}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                Some(br#"{"flow_kind":"diamond"}"#.as_slice()),
                r#"{"data":{"capability":"wdpc_rehydrated","flow_kind":"diamond"}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/diamond/prepare",
                "Bearer wdpc_rehydrated",
                Some(br#"{"package_id":7}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-7","status":"pending_user_pay"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-context",
                "Bearer wdpc_rehydrated",
                Some(br#"{"payment_id":"pay-7"}"#.as_slice()),
                r#"{"data":{"payment_id":"pay-7","payment_needed":{"protocol":"402"},"resource_url":"https://seller.example.test/resource","method":"POST","data":"{}","headers":{"Content-Type":"application/json"}}}"#,
            ),
            (
                "POST",
                "/api/internal/working-desktop/alipay/payment-finalize",
                "Bearer wdpc_rehydrated",
                Some(br#"{"payment_id":"pay-7","action":"check","check_result":{"status":"paid","trade_no":"trade-7","out_shake_no":"shake-7","payment_proof":"proof-7","client_session":"client-7"}}"#.as_slice()),
                r#"{"data":{"payment":{"payment_id":"pay-7","status":"resource_ready"}}}"#,
            ),
        ];
        for (method_expected, path_expected, authorization_expected, body_expected, response) in
            expected
        {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, method_expected);
            assert_eq!(path, path_expected);
            assert_eq!(authorization, authorization_expected);
            if let Some(body_expected) = body_expected {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    serde_json::from_slice::<serde_json::Value>(body_expected).unwrap(),
                );
            }
            respond(&mut stream, response);
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![Ok(json!({
        "ok": true,
        "status": "paid",
        "tradeNo": "trade-7",
        "outShakeNo": "shake-7",
        "paymentProof": "proof-7",
        "clientSession": "client-7",
    }))]);
    let payment_state = WorkingPaymentState::new();

    let recovered = recover_pending_desktop_payment(&payment_state, "payment-token").unwrap();
    let failures =
        poll_desktop_payments_once(&payment_state, &worker, &fixture.workspace, "payment-token", "account-7");

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    assert!(recovered);
    assert_eq!(failures, 0);
    let calls = worker.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PaymentWorkerAction::PaymentCheck);
    assert_eq!(calls[0].1["outShakeNo"], "shake-7");
    assert!(calls[0].1.get("tradeNo").is_none());
    assert_eq!(calls[0].1["resourceUrl"], "https://seller.example.test/resource");
    assert!(calls[0].1.get("paymentNeeded").is_none());
}

#[test]
fn desktop_vip_payment_uses_prepare_only_route_and_builds_renderer_package() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        let expected = [
            (
                "/api/internal/working-desktop/payment-capabilities",
                "Bearer payment-token",
                br#"{"flow_kind":"vip"}"#.as_slice(),
                r#"{"data":{"capability":"wdpc_vip","flow_kind":"vip"}}"#,
            ),
            (
                "/api/internal/working-desktop/alipay/vip/prepare",
                "Bearer wdpc_vip",
                br#"{}"#.as_slice(),
                r#"{"data":{"pending_existing":false,"payment":{"payment_id":"vip-pay-1","out_trade_no":"VIP-1","status":"created","goods_name":"pi-vip","amount":"49.90","currency":"CNY"},"vip":{"service_id":"pi-vip","days":30,"amount":"49.90","amount_cents":4990,"bonus_diamonds":500},"payment_needed":{"protocol":"402"}}}"#,
            ),
            (
                "/api/internal/working-desktop/alipay/payment-context",
                "Bearer wdpc_vip",
                br#"{"payment_id":"vip-pay-1"}"#.as_slice(),
                r#"{"data":{"payment_id":"vip-pay-1","session_id":"vip-pay-1","payment_needed":{"protocol":"402"},"resource_url":"https://seller.example.test/resource","method":"POST","data":"{}","headers":{"Content-Type":"application/json","X-Working-Desktop-Payment-Resource":"wdpr-vip"}}}"#,
            ),
            (
                "/api/internal/working-desktop/alipay/payment-started",
                "Bearer wdpc_vip",
                br#"{"payment_id":"vip-pay-1","trade_no":"vip-trade-1","cashier_url":"https://cashier.example.test/vip","bot_result":{"action":"payment.start","ok":true}}"#.as_slice(),
                r#"{"data":{"payment":{"payment_id":"vip-pay-1","out_trade_no":"VIP-1","trade_no":"vip-trade-1","status":"pending_user_pay","goods_name":"pi-vip","amount":"49.90","currency":"CNY","cashier_url":"https://cashier.example.test/vip"}}}"#,
            ),
        ];
        for (path_expected, authorization_expected, body_expected, response) in expected {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, "POST");
            assert_eq!(path, path_expected);
            assert_eq!(authorization, authorization_expected);
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::from_slice::<serde_json::Value>(body_expected).unwrap(),
            );
            respond(&mut stream, response);
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let fixture = PaymentWorkspaceFixture::new();
    let worker = FakePaymentWorker::new(vec![Ok(json!({
        "ok": true,
        "tradeNo": "vip-trade-1",
        "cashierUrl": "https://cashier.example.test/vip",
    }))]);
    let payment_state = WorkingPaymentState::new();
    let state = SkillMarketState::new(Some("payment-token".to_string()));
    state.set_working_auth(Some("payment-token".to_string()), Some("user-7".to_string()));

    let created = handle_request(
        &state,
        &payment_state,
        &worker,
        &fixture.workspace,
        "POST",
        "/api/working/vip/upgrade",
        br#"{}"#,
    )
    .unwrap();

    backend.join().unwrap();
    restore_backend_url(previous_backend);

    let body = created.body.as_ref().unwrap();
    assert_eq!(body["is_vip"], true);
    assert_eq!(body["vip"]["days"], 30);
    assert_eq!(body["package"]["service_id"], "pi-vip");
    assert_eq!(body["package"]["diamonds"], 500);
    assert_eq!(
        worker.calls.lock().unwrap()[0].0,
        PaymentWorkerAction::PaymentStart
    );
}
