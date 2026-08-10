use super::{handle_request, parse_working_payment_route, WorkingPaymentRoute};
use crate::skill_market::{backend_env_test_lock, SkillMarketState};
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

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
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/alipay/page-orders").unwrap(),
        WorkingPaymentRoute::CreateAlipayPagePayOrder,
    );
    assert_eq!(
        parse_working_payment_route("POST", "/api/working/alipay/page-orders/payment%2F7/check")
            .unwrap(),
        WorkingPaymentRoute::CheckAlipayPagePayOrder {
            payment_id: "payment/7".to_string(),
        },
    );
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
    let result = handle_request(
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
    let result = handle_request(
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

#[test]
fn forwards_page_pay_requests_with_backend_auth_and_unwraps_data() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let backend = std::thread::spawn(move || {
        for expected in [
            (
                "/api/pay/alipay/page-orders",
                br#"{"package_id":7}"#.as_slice(),
            ),
            (
                "/api/pay/alipay/page-orders/payment%2F7/check",
                br#"{}"#.as_slice(),
            ),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            let (method, path, authorization, body) = read_request(&mut stream);
            assert_eq!(method, "POST");
            assert_eq!(path, expected.0);
            assert_eq!(authorization, "Bearer payment-token");
            assert_eq!(body, expected.1);
            respond(
                &mut stream,
                r#"{"data":{"payment_id":"payment/7","out_trade_no":"PAGE-7","cashier_url":"https://cashier.example.test/pay","status":"pending","credit_tokens":100,"package":{"id":7,"amount":"0.99","diamonds":100}}}"#,
            );
        }
    });

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    let state = SkillMarketState::new(Some("payment-token".to_string()));
    let created = handle_request(
        &state,
        "POST",
        "/api/working/alipay/page-orders",
        br#"{"packageId":7}"#,
    )
    .unwrap();
    let checked = handle_request(
        &state,
        "POST",
        "/api/working/alipay/page-orders/payment%2F7/check",
        br#"{}"#,
    )
    .unwrap();
    backend.join().unwrap();
    restore_backend_url(previous_backend);

    assert_eq!(created.body.unwrap()["payment_id"], "payment/7");
    assert_eq!(
        checked.body.unwrap()["cashier_url"],
        "https://cashier.example.test/pay"
    );
}

fn restore_backend_url(previous_backend: Option<String>) {
    match previous_backend {
        Some(value) => std::env::set_var("COPIS_BACKEND_URL", value),
        None => std::env::remove_var("COPIS_BACKEND_URL"),
    }
}
