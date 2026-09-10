use crate::model_request_client::{ModelRequestClient, DEFAULT_MODEL_REQUEST_URL};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn local_stream_disconnect_closes_silent_upstream_promptly() {
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = upstream.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: first\n\n").unwrap();
        socket.flush().unwrap();
        let mut byte = [0];
        matches!(socket.read(&mut byte), Ok(0))
    });
    let downstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = std::net::TcpStream::connect(downstream.local_addr().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (mut connection, _) = downstream.accept().unwrap();
    let proxy = thread::spawn(move || {
        let upstream = ModelRequestClient::new(&format!("http://{upstream_addr}"), 3).unwrap();
        let response = upstream
            .open("GET", "/config", "", "token", vec![])
            .unwrap();
        crate::send_working_model_stream_response(
            &mut connection,
            crate::working_model_proxy::WorkingModelStreamResponse {
                status: response.status,
                content_type: Some("text/event-stream".into()),
                body: response.body,
            },
            None,
        );
    });
    let mut received = Vec::new();
    while !received
        .windows(13)
        .any(|bytes| bytes == b"data: first\n\n")
    {
        let mut buffer = [0; 256];
        let read = client.read(&mut buffer).unwrap();
        assert!(read > 0);
        received.extend_from_slice(&buffer[..read]);
    }
    thread::sleep(Duration::from_millis(150));
    let started = Instant::now();
    client.shutdown(std::net::Shutdown::Both).unwrap();
    drop(client);
    proxy.join().unwrap();
    assert!(server.join().unwrap(), "upstream must observe EOF");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "cancellation waited for upstream timeout"
    );
}

fn environment_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[test]
fn model_client_uses_dedicated_default_base() {
    assert_eq!(
        DEFAULT_MODEL_REQUEST_URL,
        "https://pie.meetlife.com.cn/model-request"
    );
}

#[test]
fn invalid_model_base_configuration_fails_closed() {
    let _guard = environment_lock().lock().unwrap();
    let previous = std::env::var("COPIS_MODEL_REQUEST_BASE_URL").ok();
    std::env::set_var("COPIS_MODEL_REQUEST_BASE_URL", "not-a-url");
    assert!(ModelRequestClient::from_environment().is_err());
    match previous {
        Some(value) => std::env::set_var("COPIS_MODEL_REQUEST_BASE_URL", value),
        None => std::env::remove_var("COPIS_MODEL_REQUEST_BASE_URL"),
    }
}

#[test]
fn model_stream_timeout_defaults_to_960_seconds_and_is_capped() {
    use crate::model_request_client::{
        resolve_model_stream_timeout_secs, DEFAULT_MODEL_STREAM_TIMEOUT_SECS,
    };
    let _guard = environment_lock().lock().unwrap();
    let previous = std::env::var("COPIS_MODEL_STREAM_TIMEOUT_SECS").ok();
    std::env::remove_var("COPIS_MODEL_STREAM_TIMEOUT_SECS");
    assert_eq!(
        resolve_model_stream_timeout_secs(),
        DEFAULT_MODEL_STREAM_TIMEOUT_SECS
    );
    std::env::set_var("COPIS_MODEL_STREAM_TIMEOUT_SECS", "3600");
    assert_eq!(resolve_model_stream_timeout_secs(), 960);
    match previous {
        Some(value) => std::env::set_var("COPIS_MODEL_STREAM_TIMEOUT_SECS", value),
        None => std::env::remove_var("COPIS_MODEL_STREAM_TIMEOUT_SECS"),
    }
}

#[test]
fn stream_exposes_first_chunk_before_upstream_finishes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (first_chunk_sent, first_chunk_received) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = socket.read(&mut request).unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        socket.write_all(b"d\r\ndata: first\n\n\r\n").unwrap();
        socket.flush().unwrap();
        first_chunk_sent.send(()).unwrap();
        thread::sleep(Duration::from_millis(250));
        socket
            .write_all(b"e\r\ndata: second\n\n\r\n0\r\n\r\n")
            .unwrap();
        socket.flush().unwrap();
    });

    let client = ModelRequestClient::new(&format!("http://{address}"), 5).unwrap();
    let started = Instant::now();
    let mut response = client
        .open("POST", "/v1/responses", "{}", "token", vec![])
        .unwrap();
    first_chunk_received
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    let mut first = [0_u8; 13];
    response.body.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"data: first\n\n");
    assert!(started.elapsed() < Duration::from_millis(200));
    let mut remaining = String::new();
    response.body.read_to_string(&mut remaining).unwrap();
    assert_eq!(remaining, "data: second\n\n");
    server.join().unwrap();
}

#[test]
fn model_client_sends_only_the_supplied_bearer_and_model_headers_to_its_fixed_base() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let read = socket.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(request.contains("authorization: Bearer access-token"));
        assert!(request.contains("x-working-model-source-type: copis-agent-model"));
        assert!(request.contains("idempotency-key: copis-request-0123456789"));
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            )
            .unwrap();
    });
    let client = ModelRequestClient::new(&format!("http://{address}"), 5).unwrap();
    let mut response = client
        .open(
            "POST",
            "/v1/responses",
            "{}",
            "access-token",
            vec![
                (
                    "X-Working-Model-Source-Type".to_string(),
                    "copis-agent-model".to_string(),
                ),
                (
                    "Idempotency-Key".to_string(),
                    "copis-request-0123456789".to_string(),
                ),
            ],
        )
        .unwrap();
    let mut body = String::new();
    response.body.read_to_string(&mut body).unwrap();
    assert_eq!(body, "{}");
    server.join().unwrap();
}

#[test]
fn model_request_client_ignores_proxy_environment_variables() {
    let _guard = environment_lock().lock().unwrap();
    std::env::set_var("HTTP_PROXY", "http://127.0.0.1:9999");
    std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9999");
    std::env::set_var("ALL_PROXY", "socks5://127.0.0.1:9999");
    std::env::set_var("http_proxy", "http://127.0.0.1:9999");
    std::env::set_var("https_proxy", "http://127.0.0.1:9999");
    std::env::set_var("all_proxy", "socks5://127.0.0.1:9999");

    let client = ModelRequestClient::new(DEFAULT_MODEL_REQUEST_URL, 30).unwrap();
    assert!(client.proxy().is_none());

    std::env::remove_var("HTTP_PROXY");
    std::env::remove_var("HTTPS_PROXY");
    std::env::remove_var("ALL_PROXY");
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
    std::env::remove_var("all_proxy");
}
