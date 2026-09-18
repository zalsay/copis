use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use super::auth_session::{AuthError, AuthSession, AuthStorage, PersistedAuth};
use super::automation::WorkerAutomationContext;
use super::chatroom_client::{ChatroomClientError, ChatroomSocket, ChatroomSocketConnector};
use super::chatroom_gateway::{
    ChatroomBridge, ChatroomGateway, GatewayTransport, GatewayTransportResponse,
};
use super::edu_api_client::{EduApiClient, EduApiError, EduApiRequest, EduApiResponse};
use super::pi_rpc::{
    format_sse_event, is_agent_messages_route, is_agent_queue_route, is_agent_status_route,
    is_agent_stop_route, is_agent_workers_status_route, is_agent_workers_stop_all_route,
    parse_worker_frame, sse_headers,
};
use super::{
    append_recording_line, bind_automation_create_input, decode_hex, encode_hex,
    ensure_internal_success_with_body, find_subslice, handle_connection,
    handle_internal_recording_request, is_allowed_origin, is_internal_agent_alipay_bot_path,
    is_internal_agent_shell_path, is_internal_path, is_internal_token_valid,
    is_private_auth_bridge_path, is_safe_path_component, is_skill_market_path, is_vite_dev_origin,
    is_web_route_authorized, is_working_payment_path, is_workspace_dev_route,
    parse_internal_recording_route, recording_marker, Bridge, BridgeResponse, HttpRequest,
};

static NEXT_HTTP_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

struct MainTestStorage;

impl AuthStorage for MainTestStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError> {
        Ok(Some(PersistedAuth {
            access_token: "main-test-token".into(),
            refresh_token: None,
            provider: "test".into(),
            user: Some(serde_json::json!({"id": 1})),
            expires_at: None,
        }))
    }
    fn save(&self, _auth: &PersistedAuth) -> Result<(), AuthError> {
        Ok(())
    }
    fn clear(&self) -> Result<(), AuthError> {
        Ok(())
    }
}

struct MainTestEduTransport;

impl super::edu_api_client::EduApiTransport for MainTestEduTransport {
    fn send(&self, _request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        Err(EduApiError::Transport("测试不应调用认证传输".into()))
    }
}

struct MainTestSocket;

impl ChatroomSocket for MainTestSocket {
    fn send_json(
        &mut self,
        _command: &super::chatroom_protocol::ChatroomCommand,
    ) -> Result<(), ChatroomClientError> {
        Ok(())
    }
    fn receive_json(
        &mut self,
    ) -> Result<super::chatroom_protocol::ChatroomEvent, ChatroomClientError> {
        Err(ChatroomClientError::new("closed", "测试 socket 已关闭"))
    }
    fn close(&mut self) {}
}

struct MainTestConnector;

impl ChatroomSocketConnector for MainTestConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &std::sync::atomic::AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        Ok(Box::new(MainTestSocket))
    }
}

struct MainTestBridge;

impl ChatroomBridge for MainTestBridge {
    fn send_invocation(
        &self,
        _body: Vec<u8>,
        _shutdown: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        Ok(())
    }
    fn send_disconnected(
        &self,
        _body: Vec<u8>,
        _shutdown: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        Ok(())
    }
}

struct MainTestGatewayTransport {
    responses: std::sync::Mutex<Vec<GatewayTransportResponse>>,
}

impl GatewayTransport for MainTestGatewayTransport {
    fn request(
        &self,
        _method: &str,
        _path: &str,
        _body: Option<String>,
    ) -> Result<GatewayTransportResponse, String> {
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| "测试传输没有响应".to_string())
    }
}

fn main_test_gateway(response: GatewayTransportResponse) -> Arc<ChatroomGateway> {
    main_test_gateway_with_responses(vec![response])
}

fn main_test_gateway_with_responses(
    responses: Vec<GatewayTransportResponse>,
) -> Arc<ChatroomGateway> {
    let client = Arc::new(
        EduApiClient::new("https://example.com", Arc::new(MainTestEduTransport), 1).unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(MainTestStorage)).unwrap());
    ChatroomGateway::new_with_transport(
        auth,
        "https://example.com".into(),
        Arc::new(MainTestConnector),
        Arc::new(MainTestBridge),
        "123e4567-e89b-42d3-a456-426614174000".into(),
        Arc::new(MainTestGatewayTransport {
            responses: std::sync::Mutex::new(responses),
        }),
    )
    .unwrap()
}

#[test]
fn given_bridge_eof_when_cleanup_runs_then_shutdown_shared_gateway_without_process_exit() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();
    let bridge = Arc::new(Bridge::new());
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    lifecycle.register_gateway(&gateway);

    super::read_bridge_responses_from(std::io::Cursor::new(Vec::<u8>::new()), &bridge, &lifecycle);

    assert!(gateway.shutdown_requested_for_test());
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_bridge_eof_before_gateway_registration_when_cleanup_runs_then_wait_for_registration_and_shutdown_gateway(
) {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();
    let bridge = Arc::new(Bridge::new());
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let cleanup_bridge = Arc::clone(&bridge);
    let cleanup_lifecycle = Arc::clone(&lifecycle);
    let cleanup = thread::spawn(move || {
        super::cleanup_after_bridge_disconnect(&cleanup_bridge, &cleanup_lifecycle);
        finished_tx.send(()).unwrap();
    });

    assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
    lifecycle.register_gateway(&gateway);
    finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("gateway 注册后 EOF 清理应完成");
    cleanup.join().unwrap();

    assert!(gateway.shutdown_requested_for_test());
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_registered_gateway_when_startup_fails_then_shutdown_and_release_resources() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    lifecycle.register_gateway(&gateway);

    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let failed_lifecycle = Arc::clone(&lifecycle);
    let transition = thread::spawn(move || {
        failed_lifecycle.mark_startup_failed();
        finished_tx.send(()).unwrap();
    });
    finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("startup-failed transition 应在有限时间内完成 gateway shutdown");
    transition.join().unwrap();

    lifecycle.mark_startup_failed();

    assert!(gateway.shutdown_requested_for_test());
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_startup_failed_when_late_started_gateway_registers_then_shutdown_and_release_resources() {
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    lifecycle.mark_startup_failed();

    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();

    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let register_lifecycle = Arc::clone(&lifecycle);
    let register_gateway = Arc::clone(&gateway);
    thread::spawn(move || {
        register_lifecycle.register_gateway(&register_gateway);
        finished_tx.send(()).unwrap();
    });

    finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("StartupFailed 后迟到 gateway 注册应在有限时间内完成 shutdown");
    assert!(gateway.shutdown_requested_for_test());
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_registered_gateway_when_different_gateway_registers_then_reject_new_without_shutdown_original(
) {
    let original = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    original.register_lease_for_test("room-1", "agent-1", "device-1");
    original.start();
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    lifecycle.register_gateway(&original);

    let incoming = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    incoming.register_lease_for_test("room-2", "agent-2", "device-2");
    incoming.start();
    lifecycle.register_gateway(&incoming);

    assert!(!original.shutdown_requested_for_test());
    assert_eq!(original.lease_count_for_test(), 1);
    assert!(incoming.shutdown_requested_for_test());
    assert_eq!(incoming.lease_count_for_test(), 0);
}

#[test]
fn given_registered_gateway_when_same_gateway_registers_again_then_keep_gateway_running() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();
    let lifecycle = Arc::new(super::ChatroomGatewayLifecycle::new());
    lifecycle.register_gateway(&gateway);

    lifecycle.register_gateway(&gateway);

    assert!(!gateway.shutdown_requested_for_test());
    assert_eq!(gateway.lease_count_for_test(), 1);
}

fn run_chatroom_http(request: HttpRequest, gateway: Arc<ChatroomGateway>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        super::handle_chatroom_http(&mut stream, &request, None, Some(&gateway));
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    server.join().unwrap();
    response
}

fn run_handle_connection(
    request: HttpRequest,
    bridge: Arc<Bridge>,
    gateway: Option<Arc<ChatroomGateway>>,
) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let directory = std::env::temp_dir().join(format!(
        "copis-main-connection-{}-{}",
        std::process::id(),
        NEXT_HTTP_TEST_DIR.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    let memory_store =
        Arc::new(super::memory::MemoryStore::open(directory.join("memory")).unwrap());
    let expert_team_store = Arc::new(
        super::expert_teams::ExpertTeamStore::open(directory.join("expert-teams")).unwrap(),
    );
    let skill_market_state = Arc::new(super::skill_market::SkillMarketState::new(None));
    let payment_project_root = directory.join("payment-workspace");
    let payment_project = payment_project_root.join("project");
    std::fs::create_dir_all(&payment_project).unwrap();
    let payment_project_root = std::fs::canonicalize(payment_project_root).unwrap();
    let payment_project = payment_project_root.join("project");
    let payment_workspace = Arc::new(
        super::payment_workspace::PaymentWorkspace::parse(
            "default",
            payment_project_root.to_string_lossy().as_ref(),
            payment_project.to_string_lossy().as_ref(),
            payment_project_root
                .join(".copis")
                .join("payment")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
    );
    let working_payment_state = Arc::new(super::working_payment::WorkingPaymentState::new());
    let workspace_mcp_store = Arc::new(super::workspace_mcp::WorkspaceMcpStore::open(
        directory.join("mcp"),
    ));
    let workspace_dev_store = Arc::new(super::workspace_dev::WorkspaceDevStore::open(
        directory.join("dev"),
    ));
    let workspace_skills_store = Arc::new(super::workspace_skills::WorkspaceSkillsStore::open(
        directory.join("skills"),
    ));
    let automation_store = Arc::new(super::automation::AutomationStore::open(
        directory.join("automations"),
    ));
    let automation_scheduler = Arc::new(super::automation_scheduler::AutomationScheduler::new(
        Arc::clone(&automation_store),
        Arc::clone(&bridge),
        Arc::clone(&workers),
    ));
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        handle_connection(
            stream,
            bridge,
            None,
            workers,
            memory_store,
            expert_team_store,
            skill_market_state,
            working_payment_state,
            payment_workspace,
            workspace_mcp_store,
            workspace_dev_store,
            workspace_skills_store,
            automation_store,
            automation_scheduler,
            gateway,
        );
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    let mut wire = format!(
        "{} {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n",
        request.method, request.target
    );
    for (name, value) in &request.headers {
        wire.push_str(name);
        wire.push_str(": ");
        wire.push_str(value);
        wire.push_str("\r\n");
    }
    wire.push_str(&format!("Content-Length: {}\r\n\r\n", request.body.len()));
    client.write_all(wire.as_bytes()).unwrap();
    client.write_all(&request.body).unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    server.join().unwrap();
    let _ = std::fs::remove_dir_all(&directory);
    response
}

fn run_handle_connection_sse(bridge: Arc<Bridge>, gateway: Arc<ChatroomGateway>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let directory = std::env::temp_dir().join(format!(
        "copis-main-sse-{}-{}",
        std::process::id(),
        NEXT_HTTP_TEST_DIR.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    let memory_store =
        Arc::new(super::memory::MemoryStore::open(directory.join("memory")).unwrap());
    let expert_team_store = Arc::new(
        super::expert_teams::ExpertTeamStore::open(directory.join("expert-teams")).unwrap(),
    );
    let skill_market_state = Arc::new(super::skill_market::SkillMarketState::new(None));
    let payment_project_root = directory.join("payment-workspace");
    let payment_project = payment_project_root.join("project");
    std::fs::create_dir_all(&payment_project).unwrap();
    let payment_project_root = std::fs::canonicalize(payment_project_root).unwrap();
    let payment_project = payment_project_root.join("project");
    let payment_workspace = Arc::new(
        super::payment_workspace::PaymentWorkspace::parse(
            "default",
            payment_project_root.to_string_lossy().as_ref(),
            payment_project.to_string_lossy().as_ref(),
            payment_project_root
                .join(".copis")
                .join("payment")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
    );
    let working_payment_state = Arc::new(super::working_payment::WorkingPaymentState::new());
    let workspace_mcp_store = Arc::new(super::workspace_mcp::WorkspaceMcpStore::open(
        directory.join("mcp"),
    ));
    let workspace_dev_store = Arc::new(super::workspace_dev::WorkspaceDevStore::open(
        directory.join("dev"),
    ));
    let workspace_skills_store = Arc::new(super::workspace_skills::WorkspaceSkillsStore::open(
        directory.join("skills"),
    ));
    let automation_store = Arc::new(super::automation::AutomationStore::open(
        directory.join("automations"),
    ));
    let automation_scheduler = Arc::new(super::automation_scheduler::AutomationScheduler::new(
        Arc::clone(&automation_store),
        Arc::clone(&bridge),
        Arc::clone(&workers),
    ));
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        handle_connection(
            stream,
            bridge,
            None,
            workers,
            memory_store,
            expert_team_store,
            skill_market_state,
            working_payment_state,
            payment_workspace,
            workspace_mcp_store,
            workspace_dev_store,
            workspace_skills_store,
            automation_store,
            automation_scheduler,
            Some(gateway),
        );
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    client
        .write_all(b"GET /api/chatrooms/v2/events?roomId=room-1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let mut response = [0_u8; 256];
    let _ = client.read(&mut response).unwrap();
    client.shutdown(std::net::Shutdown::Both).unwrap();
    server.join().unwrap();
    let _ = std::fs::remove_dir_all(&directory);
    String::from_utf8_lossy(&response).into_owned()
}

#[test]
fn given_renderer_chatroom_request_when_routed_then_use_gateway_and_never_forward_to_business_bridge(
) {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"access_token":"jwt","objectKey":"private","memory":"secret","items":[{"sessionToken":"sts"}]}}"#.to_vec(),
    });
    let response = run_chatroom_http(
        HttpRequest {
            method: "GET".to_string(),
            target: "/api/chatrooms/v2/rooms".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        },
        gateway,
    );
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    for field in [
        "access_token",
        "refresh_token",
        "Authorization",
        "tmpSecretKey",
        "sessionToken",
        "objectKey",
        "memory",
    ] {
        assert!(!response.contains(field), "public response leaked {field}");
    }
    assert!(!super::chatroom_http_route_owned("/api/working/profile"));
}

#[test]
fn given_internal_chatroom_invocation_without_internal_token_then_return_403() {
    let request = HttpRequest {
        method: "POST".to_string(),
        target: "/api/internal/chatrooms/invocations/invocation-1/running".to_string(),
        headers: HashMap::new(),
        body: br#"{"roomId":"room-1","agentId":"agent-1","deviceId":"device-1"}"#.to_vec(),
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        super::handle_chatroom_http(&mut stream, &request, None, None);
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    server.join().unwrap();
    assert!(response.starts_with("HTTP/1.1 403 Forbidden"));
    assert!(response.contains(r#""code":"internal_token_required""#));
}

#[test]
fn given_internal_chatroom_options_without_token_then_return_403_before_preflight() {
    assert!(!super::chatroom_preflight_is_authorized(
        "OPTIONS",
        "/api/internal/chatrooms/cos/upload-grant",
        false,
    ));
    assert!(super::chatroom_preflight_is_authorized(
        "OPTIONS",
        "/api/chatrooms/v2/events",
        false,
    ));
}

#[test]
fn given_device_id_when_validating_then_require_uuid_v4_and_rfc_variant() {
    assert!(super::valid_chatroom_device_id(
        "123e4567-e89b-42d3-a456-426614174000"
    ));
    assert!(!super::valid_chatroom_device_id("device-1"));
    assert!(!super::valid_chatroom_device_id(
        "00000000-0000-0000-8000-000000000000"
    ));
    assert!(!super::valid_chatroom_device_id(
        "123e4567-e89b-52d3-a456-426614174000"
    ));
}

#[test]
fn given_device_file_write_failure_then_resolver_fails_closed() {
    let config_path =
        std::env::temp_dir().join(format!("copis-chatroom-device-file-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&config_path);
    std::fs::create_dir_all(&config_path).unwrap();
    let target = config_path.join("client-device.json");
    std::fs::write(&target, b"not-json").unwrap();
    assert!(super::resolve_chatroom_device_id_at(&target).is_err());
    let _ = std::fs::remove_dir_all(config_path);
}

#[test]
fn given_concurrent_device_resolution_when_target_is_absent_then_both_use_one_uuid_file() {
    let directory = std::env::temp_dir().join(format!(
        "copis-chatroom-device-concurrent-{}-{}",
        std::process::id(),
        NEXT_HTTP_TEST_DIR.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    let target = directory.join("client-device.json");
    let barrier = Arc::new(Barrier::new(3));
    let first_target = target.clone();
    let first_barrier = Arc::clone(&barrier);
    let first = thread::spawn(move || {
        first_barrier.wait();
        super::resolve_chatroom_device_id_at(&first_target).unwrap()
    });
    let second_target = target.clone();
    let second_barrier = Arc::clone(&barrier);
    let second = thread::spawn(move || {
        second_barrier.wait();
        super::resolve_chatroom_device_id_at(&second_target).unwrap()
    });
    barrier.wait();
    let first_id = first.join().unwrap();
    let second_id = second.join().unwrap();
    assert_eq!(first_id, second_id);
    assert!(super::valid_chatroom_device_id(&first_id));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o777, 0o600);
    }
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(unix))]
#[test]
fn given_windows_device_target_when_two_publishers_race_then_existing_target_is_not_replaced() {
    let directory = std::env::temp_dir().join(format!(
        "copis-chatroom-device-windows-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    let target = directory.join("client-device.json");
    let first = directory.join("first.tmp");
    let second = directory.join("second.tmp");
    std::fs::write(
        &first,
        br#"{"version":1,"deviceId":"123e4567-e89b-42d3-a456-426614174000","createdAt":1}"#,
    )
    .unwrap();
    std::fs::write(
        &second,
        br#"{"version":1,"deviceId":"123e4567-e89b-42d3-a456-426614174001","createdAt":1}"#,
    )
    .unwrap();
    super::publish_chatroom_device_file(&first, &target).unwrap();
    assert!(super::publish_chatroom_device_file(&second, &target).is_err());
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("42d3-a456-426614174000"));
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(unix)]
#[test]
fn given_valid_device_file_with_broad_permissions_then_repair_to_0600_and_reuse_id() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let config_path = std::env::temp_dir().join(format!(
        "copis-chatroom-device-permissions-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&config_path);
    std::fs::create_dir_all(&config_path).unwrap();
    let device_id = "123e4567-e89b-42d3-a456-426614174000";
    let target = config_path.join("client-device.json");
    std::fs::write(
        &target,
        format!(r#"{{"version":1,"deviceId":"{device_id}","createdAt":1}}"#),
    )
    .unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        super::resolve_chatroom_device_id_at(&target).unwrap(),
        device_id
    );
    assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o777, 0o600);
    let _ = std::fs::remove_dir_all(config_path);
}

#[test]
fn given_internal_cos_grant_with_valid_token_then_only_internal_response_contains_temporary_credentials(
) {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous = std::env::var("COPIS_HTTP_API_INTERNAL_TOKEN").ok();
    std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", "task4-internal-token");
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"attachmentId":"att-1","bucket":"b","region":"r","objectKey":"private/key","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"session","startTime":1,"expiredTime":2},"action":"upload"}}"#.to_vec(),
    });
    let response = run_chatroom_http(
        HttpRequest {
            method: "POST".to_string(),
            target: "/api/internal/chatrooms/cos/upload-grant".to_string(),
            headers: HashMap::from([(
                "x-copis-internal-token".to_string(),
                "task4-internal-token".to_string(),
            )]),
            body: br#"{"roomId":"room-1","fileName":"a.txt","mimeType":"text/plain","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.to_vec(),
        },
        gateway,
    );
    assert!(response.contains("tmpSecretKey"));
    assert!(response.contains("sessionToken"));
    assert!(response.contains("objectKey"));
    assert!(!response.contains("Authorization"));
    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", value),
        None => std::env::remove_var("COPIS_HTTP_API_INTERNAL_TOKEN"),
    }
}

#[test]
fn given_sse_request_when_connection_closes_then_main_does_not_shutdown_background_gateway() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous_heartbeat = std::env::var("COPIS_CHATROOM_SSE_HEARTBEAT_MS").ok();
    std::env::set_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS", "20");
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":[]}"#.to_vec(),
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (done, done_receiver) = std::sync::mpsc::channel();
    let server_gateway = Arc::clone(&gateway);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = HttpRequest {
            method: "GET".to_string(),
            target: "/api/chatrooms/v2/events?roomId=room-1".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        super::handle_chatroom_http(&mut stream, &request, None, Some(&server_gateway));
        let _ = done.send(());
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    let mut headers = [0_u8; 64];
    let _ = client.read(&mut headers);
    client.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(done_receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok());
    server.join().unwrap();
    assert!(!gateway.shutdown_requested_for_test());
    match previous_heartbeat {
        Some(value) => std::env::set_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS", value),
        None => std::env::remove_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS"),
    }
}

#[test]
fn given_handle_connection_public_chatroom_request_when_routed_then_bypass_legacy_bridge() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"items":[],"access_token":"secret"}}"#.to_vec(),
    });
    let bridge = Arc::new(Bridge::new());
    bridge.available.store(false, Ordering::Release);
    let response = run_handle_connection(
        HttpRequest {
            method: "GET".to_string(),
            target: "/api/chatrooms/v2/rooms".to_string(),
            headers: HashMap::from([("origin".to_string(), "http://127.0.0.1:5174".into())]),
            body: Vec::new(),
        },
        bridge,
        Some(gateway),
    );
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(!response.contains("access_token"));
}

#[test]
fn given_handle_connection_chatroom_routes_when_internal_token_is_missing_or_valid_then_gate_before_cos_response(
) {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous = std::env::var("COPIS_HTTP_API_INTERNAL_TOKEN").ok();
    std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", "task4-round2-token");
    let missing = run_handle_connection(
        HttpRequest {
            method: "OPTIONS".to_string(),
            target: "/api/internal/chatrooms/cos/upload-grant".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        },
        Arc::new(Bridge::new()),
        Some(main_test_gateway(GatewayTransportResponse {
            status: 500,
            body: Vec::new(),
        })),
    );
    assert!(missing.starts_with("HTTP/1.1 403 Forbidden"));

    let valid = run_handle_connection(
        HttpRequest {
            method: "POST".to_string(),
            target: "/api/internal/chatrooms/cos/upload-grant".to_string(),
            headers: HashMap::from([
                (
                    "x-copis-internal-token".to_string(),
                    "task4-round2-token".into(),
                ),
                ("origin".to_string(), "http://evil.example".into()),
            ]),
            body: br#"{"roomId":"room-1","fileName":"a.txt","mimeType":"text/plain","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.to_vec(),
        },
        Arc::new(Bridge::new()),
        Some(main_test_gateway(GatewayTransportResponse {
            status: 200,
            body: br#"{"data":{"attachmentId":"att-1","bucket":"b","region":"r","objectKey":"private","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"session","startTime":1,"expiredTime":2},"action":"upload"}}"#.to_vec(),
        })),
    );
    assert!(valid.starts_with("HTTP/1.1 200 OK"));

    let valid_without_origin = run_handle_connection(
        HttpRequest {
            method: "POST".to_string(),
            target: "/api/internal/chatrooms/cos/upload-grant".to_string(),
            headers: HashMap::from([(
                "x-copis-internal-token".to_string(),
                "task4-round2-token".into(),
            )]),
            body: br#"{"roomId":"room-1","fileName":"a.txt","mimeType":"text/plain","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.to_vec(),
        },
        Arc::new(Bridge::new()),
        Some(main_test_gateway(GatewayTransportResponse {
            status: 200,
            body: br#"{"data":{"attachmentId":"att-1","bucket":"b","region":"r","objectKey":"private","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"session","startTime":1,"expiredTime":2},"action":"upload"}}"#.to_vec(),
        })),
    );
    assert!(valid_without_origin.starts_with("HTTP/1.1 200 OK"));
    assert!(valid_without_origin.contains("tmpSecretKey"));

    let public_without_web_token = run_handle_connection(
        HttpRequest {
            method: "GET".to_string(),
            target: "/api/chatrooms/v2/rooms".to_string(),
            headers: HashMap::from([("origin".to_string(), "http://evil.example".into())]),
            body: Vec::new(),
        },
        Arc::new(Bridge::new()),
        Some(main_test_gateway(GatewayTransportResponse {
            status: 500,
            body: Vec::new(),
        })),
    );
    assert!(public_without_web_token.starts_with("HTTP/1.1 403 Forbidden"));
    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", value),
        None => std::env::remove_var("COPIS_HTTP_API_INTERNAL_TOKEN"),
    }
}

#[test]
fn given_listener_sse_fin_when_connection_closes_then_release_subscription_and_reuse_gateway() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous_heartbeat = std::env::var("COPIS_CHATROOM_SSE_HEARTBEAT_MS").ok();
    std::env::set_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS", "20");
    let gateway = main_test_gateway_with_responses(vec![
        GatewayTransportResponse {
            status: 200,
            body: br#"{"data":{"items":[]}}"#.to_vec(),
        },
        GatewayTransportResponse {
            status: 200,
            body: br#"{"data":[]}"#.to_vec(),
        },
    ]);
    let sse_response = run_handle_connection_sse(Arc::new(Bridge::new()), Arc::clone(&gateway));
    assert!(
        sse_response.starts_with("HTTP/1.1 200\r\n"),
        "unexpected SSE response: {sse_response:?}"
    );
    assert_eq!(gateway.subscriber_count_for_test(), 0);
    assert!(!gateway.shutdown_requested_for_test());
    let subsequent = run_handle_connection(
        HttpRequest {
            method: "GET".to_string(),
            target: "/api/chatrooms/v2/rooms".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        },
        Arc::new(Bridge::new()),
        Some(gateway.clone()),
    );
    assert!(subsequent.starts_with("HTTP/1.1 200 OK"));
    match previous_heartbeat {
        Some(value) => std::env::set_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS", value),
        None => std::env::remove_var("COPIS_CHATROOM_SSE_HEARTBEAT_MS"),
    }
}

#[test]
fn given_process_shutdown_when_gateway_is_running_then_close_ws_and_release_leases() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let occupied = std::net::TcpListener::bind((super::HOST, port)).unwrap();
    let result = super::bind_and_start_chatroom_gateway(port, &gateway);
    assert!(result.is_err());
    assert!(gateway.shutdown_requested_for_test());
    drop(occupied);
}

#[test]
fn given_auth_storage_state_change_then_pause_and_resume_chatroom_gateway() {
    let gateway = main_test_gateway(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let storage = super::BridgeAuthStorage {
        bridge: Arc::new(Bridge::new()),
        chatroom_gateway: Arc::new(super::ChatroomGatewayLifecycle::new()),
    };
    storage.chatroom_gateway.register_gateway(&gateway);
    storage.notify_chatroom_gateway(false);
    assert!(gateway.connection_paused_for_test());
    assert_eq!(gateway.lease_count_for_test(), 0);
    storage.notify_chatroom_gateway(true);
    assert!(!gateway.connection_paused_for_test());
}

#[test]
fn given_daily_tool_payload_without_protected_fields_when_binding_then_capability_context_is_used()
{
    let input = serde_json::json!({
        "name": "每日检查钻石余额",
        "prompt": "提醒用户：请检查 Copis 钻石余额。",
        "scheduleType": "daily",
        "timeOfDay": "08:00",
        "channelId": "forged-channel",
        "workspaceId": "forged-workspace"
    });
    let context = WorkerAutomationContext {
        triggered_by: "user".to_string(),
        channel_id: "capability-channel".to_string(),
        model_id: Some("capability-model".to_string()),
        workspace_id: Some("capability-workspace".to_string()),
        source_automation_id: None,
    };

    let created = bind_automation_create_input(input, &context, "session-1").unwrap();

    assert_eq!(created.schedule_type, "daily");
    assert_eq!(created.time_of_day.as_deref(), Some("08:00"));
    assert_eq!(created.channel_id, "capability-channel");
    assert_eq!(created.model_id.as_deref(), Some("capability-model"));
    assert_eq!(
        created.workspace_id.as_deref(),
        Some("capability-workspace")
    );
    assert_eq!(created.source_session_id.as_deref(), Some("session-1"));
}

#[test]
fn auth_storage_bridge_paths_are_private_to_stdio() {
    assert!(is_private_auth_bridge_path(
        "/api/internal/auth-storage/load"
    ));
    assert!(is_private_auth_bridge_path(
        "/api/internal/auth-storage/save"
    ));
    assert!(is_private_auth_bridge_path(
        "/api/internal/auth-storage/clear"
    ));
    assert!(is_private_auth_bridge_path(
        "/api/internal/auth-state/changed"
    ));
    assert!(!is_private_auth_bridge_path("/api/working/auth-state"));
    assert!(!is_private_auth_bridge_path(
        "/api/internal/auth-storage/load?x=1"
    ));
}

#[test]
fn hex_round_trip_supports_utf8() {
    let value = "Copis HTTP API / 测试";
    let encoded = encode_hex(value.as_bytes());
    assert_eq!(
        String::from_utf8(decode_hex(&encoded).unwrap()).unwrap(),
        value
    );
}

#[test]
fn rejects_malformed_hex() {
    assert!(decode_hex("0").is_none());
    assert!(decode_hex("zz").is_none());
}

#[test]
fn given_prepare_run_response_without_title_when_validated_then_keeps_the_config_body() {
    let body = r#"{"sessionId":"session-1","config":{"query":{}}}"#.to_string();
    let response = BridgeResponse {
        status: 200,
        body: Some(body.clone()),
    };

    assert_eq!(
        ensure_internal_success_with_body(response).unwrap(),
        Some(body)
    );
}

#[test]
fn finds_http_delimiter() {
    assert_eq!(
        find_subslice(b"GET / HTTP/1.1\r\n\r\n", b"\r\n\r\n"),
        Some(14)
    );
    assert_eq!(find_subslice(b"abc", b"\r\n"), None);
}

#[test]
fn allows_vite_and_packaged_electron_origins() {
    assert!(is_allowed_origin("null"));
}

#[test]
fn parses_only_safe_recording_routes() {
    let route = parse_internal_recording_route(
        "/internal/browser-workflows/recordings/workspace-1/recording-1/event?x=1",
    )
    .unwrap();
    assert_eq!(route.workspace, "workspace-1");
    assert_eq!(route.recording_id, "recording-1");
    assert_eq!(route.action, "event");
    assert!(parse_internal_recording_route(
        "/internal/browser-workflows/recordings/../recording-1/event",
    )
    .is_none());
    assert!(!is_safe_path_component("workspace/escape"));
}

#[test]
fn recording_markers_are_single_jsonl_lines() {
    let marker = String::from_utf8(recording_marker("recording-1", "recording_finished")).unwrap();
    assert!(marker.ends_with('}'));
    assert!(!marker.contains('\n'));
    assert!(marker.contains("recording-1"));
}

#[test]
fn stores_recording_in_registered_session_directory_without_exposing_absolute_path() {
    let root = std::env::temp_dir().join(format!(
        "copis-browser-recording-session-{}",
        std::process::id()
    ));
    let directory = root.join("browser/agent-workspaces/session-1");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&directory).unwrap();
    let directory_text = directory.to_string_lossy();
    let bridge = Bridge::new();
    let start = HttpRequest {
        method: "POST".to_string(),
        target: "/internal/browser-workflows/recordings/workspace-1/recording-1/start".to_string(),
        headers: HashMap::new(),
        body: serde_json::to_vec(&serde_json::json!({
            "kind": "recording_started",
            "recordingId": "recording-1",
            "recordingDirectory": directory_text,
            "sessionId": "session-1",
        }))
        .unwrap(),
    };

    assert_eq!(
        handle_internal_recording_request(&start, &bridge)
            .unwrap()
            .status,
        201
    );
    let event = HttpRequest {
        method: "POST".to_string(),
        target: "/internal/browser-workflows/recordings/workspace-1/recording-1/event".to_string(),
        headers: HashMap::new(),
        body: br#"{"type":"click"}"#.to_vec(),
    };
    assert_eq!(
        handle_internal_recording_request(&event, &bridge)
            .unwrap()
            .status,
        204
    );

    let content = std::fs::read_to_string(directory.join("recording-1.jsonl")).unwrap();
    assert!(content.contains(r#""kind":"recording_started""#));
    assert!(content.contains(r#""type":"click""#));
    assert!(!content.contains(directory_text.as_ref()));

    let finish = HttpRequest {
        method: "POST".to_string(),
        target: "/internal/browser-workflows/recordings/workspace-1/recording-1/finish".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert_eq!(
        handle_internal_recording_request(&finish, &bridge)
            .unwrap()
            .status,
        200
    );
    let read = HttpRequest {
        method: "GET".to_string(),
        target: "/internal/browser-workflows/recordings/workspace-1/recording-1/content"
            .to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert_eq!(
        handle_internal_recording_request(&read, &bridge)
            .unwrap()
            .status,
        200
    );
    assert!(!bridge.recording_paths.lock().unwrap().is_empty());
    assert!(!bridge.recording_locks.lock().unwrap().is_empty());
    let release = HttpRequest {
        method: "POST".to_string(),
        target: "/internal/browser-workflows/recordings/workspace-1/recording-1/release"
            .to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert_eq!(
        handle_internal_recording_request(&release, &bridge)
            .unwrap()
            .status,
        204
    );
    assert!(bridge.recording_paths.lock().unwrap().is_empty());
    assert!(bridge.recording_locks.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn appends_valid_jsonl_lines_and_rejects_multiline_payloads() {
    let path = std::env::temp_dir().join(format!("copis-recording-{}.jsonl", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let bridge = Bridge::new();
    append_recording_line(&bridge, &path, br#"{"kind":"recording_started"}"#, true).unwrap();
    append_recording_line(&bridge, &path, br#"{"type":"click"}"#, false).unwrap();
    assert!(append_recording_line(&bridge, &path, b"{\"type\":\"click\"}\n{}", false).is_err());
    let content = std::fs::read_to_string(&path).unwrap();
    assert_eq!(content.lines().count(), 2);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cors_allows_any_origin_without_bypassing_auth() {
    assert!(is_allowed_origin("http://127.0.0.1:5174"));
    assert!(is_allowed_origin("http://localhost:5174"));
    assert!(is_allowed_origin("http://127.0.0.1:5175"));
    assert!(is_allowed_origin("http://example.com"));
    let headers = super::pi_rpc::sse_headers_with_origin(200, Some("http://example.com"));
    assert!(headers.contains("Access-Control-Allow-Origin: *\r\n"));
    assert!(!headers.contains("Access-Control-Allow-Credentials"));
    let listener = std::net::TcpListener::bind((super::HOST, 0)).unwrap();
    assert!(listener.local_addr().unwrap().ip().is_loopback());
    let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut server, _) = listener.accept().unwrap();
    super::send_empty_response(&mut server, 204, Some("http://127.0.0.1:5175"));
    drop(server);
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
}

#[test]
fn requires_web_token_for_browser_origins() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous = std::env::var("COPIS_HTTP_API_WEB_TOKEN").ok();
    std::env::set_var("COPIS_HTTP_API_WEB_TOKEN", "web-token-1");

    let without_header = HttpRequest {
        method: "GET".to_string(),
        target: "/api/memory".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert!(!is_web_route_authorized(
        Some("null"),
        &without_header,
        "/api/memory"
    ));

    let mut headers = HashMap::new();
    headers.insert("x-copis-web-token".to_string(), "web-token-1".to_string());
    let with_header = HttpRequest {
        method: "GET".to_string(),
        target: "/api/memory".to_string(),
        headers,
        body: Vec::new(),
    };
    assert!(is_web_route_authorized(
        Some("null"),
        &with_header,
        "/api/memory"
    ));

    let wrong_header = HttpRequest {
        method: "GET".to_string(),
        target: "/api/memory".to_string(),
        headers: HashMap::from([("x-copis-web-token".to_string(), "wrong".to_string())]),
        body: Vec::new(),
    };
    assert!(!is_web_route_authorized(
        Some("null"),
        &wrong_header,
        "/api/memory"
    ));

    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_WEB_TOKEN", value),
        None => std::env::remove_var("COPIS_HTTP_API_WEB_TOKEN"),
    }
}

#[test]
fn web_token_gate_exempts_vite_origin_and_local_process() {
    let request = HttpRequest {
        method: "GET".to_string(),
        target: "/api/memory".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert!(is_vite_dev_origin("http://127.0.0.1:5174"));
    assert!(is_vite_dev_origin("http://localhost:5174"));
    assert!(!is_vite_dev_origin("http://example.com"));
    assert!(is_web_route_authorized(
        Some("http://127.0.0.1:5174"),
        &request,
        "/api/memory"
    ));
    assert!(is_web_route_authorized(None, &request, "/api/memory"));
}

#[test]
fn web_token_gate_skips_internal_and_health_routes() {
    let request = HttpRequest {
        method: "GET".to_string(),
        target: "/api/health".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert!(is_internal_path("/internal/working-auth/token"));
    assert!(is_internal_path("/api/internal/agent/prepare"));
    assert!(!is_internal_path("/api/memory"));
    assert!(is_web_route_authorized(
        Some("null"),
        &request,
        "/api/health"
    ));
    assert!(is_web_route_authorized(
        Some("null"),
        &request,
        "/internal/working-auth/token"
    ));
    assert!(is_web_route_authorized(
        Some("null"),
        &request,
        "/api/internal/agent/prepare"
    ));
}

#[test]
fn internal_token_uses_constant_time_comparison() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    assert!(super::agent_files::tokens_equal("abc-123", "abc-123"));
    assert!(!super::agent_files::tokens_equal("abc-123", "abc-124"));
    assert!(!super::agent_files::tokens_equal("abc-123", "abc-12"));
    assert!(!super::agent_files::tokens_equal("abc-123", ""));

    let previous = std::env::var("COPIS_HTTP_API_INTERNAL_TOKEN").ok();
    std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", "internal-token-1");

    let valid = HttpRequest {
        method: "GET".to_string(),
        target: "/internal/working-auth/token".to_string(),
        headers: HashMap::from([(
            "x-copis-internal-token".to_string(),
            "internal-token-1".to_string(),
        )]),
        body: Vec::new(),
    };
    assert!(is_internal_token_valid(&valid));

    let invalid = HttpRequest {
        method: "GET".to_string(),
        target: "/internal/working-auth/token".to_string(),
        headers: HashMap::from([(
            "x-copis-internal-token".to_string(),
            "internal-token-2".to_string(),
        )]),
        body: Vec::new(),
    };
    assert!(!is_internal_token_valid(&invalid));

    let missing = HttpRequest {
        method: "GET".to_string(),
        target: "/internal/working-auth/token".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    assert!(!is_internal_token_valid(&missing));

    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", value),
        None => std::env::remove_var("COPIS_HTTP_API_INTERNAL_TOKEN"),
    }
}

#[test]
fn bridge_request_times_out_and_cleans_pending() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous = std::env::var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS").ok();
    std::env::set_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS", "50");
    let bridge = Bridge::new();
    let request = HttpRequest {
        method: "GET".to_string(),
        target: "/api/example".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };
    let result = bridge.send_request(&request);
    let error = match result {
        Err(message) => message,
        Ok(_) => panic!("预期业务桥超时错误"),
    };
    assert_eq!(error, super::BRIDGE_TIMEOUT_MESSAGE);
    assert!(bridge.pending.lock().unwrap().is_empty());
    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS", value),
        None => std::env::remove_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS"),
    }
}

#[test]
fn slow_connection_is_closed_by_read_timeout() {
    let _environment = super::skill_market::backend_env_test_lock().lock().unwrap();
    let previous = std::env::var("COPIS_HTTP_API_READ_TIMEOUT_MS").ok();
    std::env::set_var("COPIS_HTTP_API_READ_TIMEOUT_MS", "80");

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let directory =
        std::env::temp_dir().join(format!("copis-http-read-timeout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    let bridge = Arc::new(Bridge::new());
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    let memory_store =
        Arc::new(super::memory::MemoryStore::open(directory.join("memory")).unwrap());
    let expert_team_store = Arc::new(
        super::expert_teams::ExpertTeamStore::open(directory.join("expert-teams")).unwrap(),
    );
    let skill_market_state = Arc::new(super::skill_market::SkillMarketState::new(None));
    let payment_project_root = directory.join("payment-workspace");
    let payment_project = payment_project_root.join("project");
    std::fs::create_dir_all(&payment_project).unwrap();
    let payment_project_root = std::fs::canonicalize(payment_project_root).unwrap();
    let payment_project = payment_project_root.join("project");
    let payment_workspace = Arc::new(
        super::payment_workspace::PaymentWorkspace::parse(
            "default",
            payment_project_root.to_string_lossy().as_ref(),
            payment_project.to_string_lossy().as_ref(),
            payment_project_root
                .join(".copis")
                .join("payment")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
    );
    let working_payment_state = Arc::new(super::working_payment::WorkingPaymentState::new());
    let workspace_mcp_store = Arc::new(super::workspace_mcp::WorkspaceMcpStore::open(
        directory.join("mcp"),
    ));
    let workspace_dev_store = Arc::new(super::workspace_dev::WorkspaceDevStore::open(
        directory.join("dev"),
    ));
    let workspace_skills_store = Arc::new(super::workspace_skills::WorkspaceSkillsStore::open(
        directory.join("skills"),
    ));
    let automation_store = Arc::new(super::automation::AutomationStore::open(
        directory.join("automations"),
    ));
    let automation_scheduler = Arc::new(super::automation_scheduler::AutomationScheduler::new(
        Arc::clone(&automation_store),
        Arc::clone(&bridge),
        Arc::clone(&workers),
    ));

    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        handle_connection(
            stream,
            bridge,
            None,
            workers,
            memory_store,
            expert_team_store,
            skill_market_state,
            working_payment_state,
            payment_workspace,
            workspace_mcp_store,
            workspace_dev_store,
            workspace_skills_store,
            automation_store,
            automation_scheduler,
            None,
        );
    });
    let mut client = std::net::TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut buffer = Vec::new();
    client.read_to_end(&mut buffer).unwrap();
    server.join().unwrap();
    let text = String::from_utf8_lossy(&buffer);
    assert!(
        text.contains("400"),
        "预期读超时后返回 400，实际响应: {}",
        text
    );

    let _ = std::fs::remove_dir_all(&directory);
    match previous {
        Some(value) => std::env::set_var("COPIS_HTTP_API_READ_TIMEOUT_MS", value),
        None => std::env::remove_var("COPIS_HTTP_API_READ_TIMEOUT_MS"),
    }
}

#[test]
fn recognizes_openai_responses_working_model_route() {
    assert!(super::is_working_model_route(
        "POST",
        "/api/internal/working-model/v1/responses"
    ));
    assert!(!super::is_working_model_route(
        "GET",
        "/api/internal/working-model/v1/responses"
    ));
}

#[test]
fn recognizes_only_agent_message_post_as_stream_route() {
    assert!(is_agent_messages_route(
        "POST",
        "/api/agent/sessions/session-1/messages"
    ));
    assert!(!is_agent_messages_route(
        "GET",
        "/api/agent/sessions/session-1/messages"
    ));
    assert!(!is_agent_messages_route("POST", "/api/agent/sessions"));
}

#[test]
fn recognizes_only_agent_stop_post_as_stop_route() {
    assert!(is_agent_stop_route(
        "POST",
        "/api/agent/sessions/session-1/stop"
    ));
    assert!(!is_agent_stop_route(
        "GET",
        "/api/agent/sessions/session-1/stop"
    ));
    assert!(!is_agent_stop_route(
        "POST",
        "/api/agent/sessions/session-1/stop/extra"
    ));
}

#[test]
fn recognizes_only_agent_queue_post_as_queue_route() {
    assert!(is_agent_queue_route(
        "POST",
        "/api/agent/sessions/session-1/queue"
    ));
    assert!(!is_agent_queue_route(
        "GET",
        "/api/agent/sessions/session-1/queue"
    ));
    assert!(!is_agent_queue_route(
        "POST",
        "/api/agent/sessions/session-1/queue/extra"
    ));
}

#[test]
fn recognizes_only_pi_worker_lifecycle_routes() {
    assert!(is_agent_status_route(
        "GET",
        "/api/agent/sessions/session-1/status"
    ));
    assert!(!is_agent_status_route(
        "POST",
        "/api/agent/sessions/session-1/status"
    ));
    assert!(is_agent_workers_status_route(
        "GET",
        "/api/agent/workers/status"
    ));
    assert!(is_agent_workers_stop_all_route(
        "POST",
        "/api/agent/workers/stop-all"
    ));
    assert!(!is_agent_workers_stop_all_route(
        "GET",
        "/api/agent/workers/stop-all"
    ));
}

#[test]
fn recognizes_skill_market_routes_as_rust_owned_routes() {
    assert!(is_skill_market_path("/api/working/skill-market"));
    assert!(is_skill_market_path("/api/working/skill-market/12/install"));
    assert!(!is_skill_market_path("/api/working/skill-markets"));
}

#[test]
fn recognizes_working_payment_routes_as_rust_owned_routes() {
    assert!(is_working_payment_path("/api/working/diamond-packages"));
    assert!(is_working_payment_path(
        "/api/working/diamond-purchases/payment-1/check"
    ));
    assert!(is_working_payment_path("/api/working/vip/upgrade"));
    assert!(is_working_payment_path("/api/working/orders/12/payment"));
    assert!(!is_working_payment_path("/api/working/diamond-package"));
    assert!(!is_working_payment_path("/api/working/orders"));
    assert!(!is_working_payment_path("/api/working/orders/12"));
}

#[test]
fn recognizes_only_workspace_dev_project_routes() {
    assert!(is_workspace_dev_route(
        "GET",
        "/api/workspaces/demo/dev-projects"
    ));
    assert!(is_workspace_dev_route(
        "POST",
        "/api/workspaces/demo/dev-projects/start"
    ));
    assert!(is_workspace_dev_route(
        "POST",
        "/api/workspaces/demo/dev-projects/stop"
    ));
    assert!(!is_workspace_dev_route(
        "POST",
        "/api/workspaces/demo/dev-projects"
    ));
    assert!(!is_workspace_dev_route(
        "GET",
        "/api/workspaces/demo/dev-projects/start"
    ));
    assert!(!is_workspace_dev_route(
        "POST",
        "/api/workspaces/demo/dev-projects/restart"
    ));
}

#[test]
fn recognizes_only_exact_internal_agent_shell_route() {
    assert!(is_internal_agent_shell_path("/api/internal/agent/shell"));
    assert!(!is_internal_agent_shell_path("/api/internal/agent/shell/"));
    assert!(!is_internal_agent_shell_path(
        "/api/internal/agent/files/shell"
    ));
}

#[test]
fn recognizes_only_exact_internal_agent_alipay_bot_route() {
    assert!(is_internal_agent_alipay_bot_path(
        "/api/internal/agent/alipay-bot"
    ));
    assert!(!is_internal_agent_alipay_bot_path(
        "/api/internal/agent/alipay-bot/"
    ));
    assert!(!is_internal_agent_alipay_bot_path(
        "/api/internal/agent/files/alipay-bot"
    ));
}

#[test]
fn formats_sse_response_headers_without_content_length() {
    let headers = sse_headers(200);
    assert!(headers.contains("Content-Type: text/event-stream"));
    assert!(headers.contains("Cache-Control: no-cache"));
    assert!(!headers.contains("Content-Length"));
}

#[test]
fn formats_json_as_an_sse_data_frame() {
    assert_eq!(
        format_sse_event(r#"{"type":"text_delta","text":"你好"}"#),
        "data: {\"type\":\"text_delta\",\"text\":\"你好\"}\n\n"
    );
}

#[test]
fn parses_worker_jsonl_frames_without_accepting_non_objects() {
    let frame =
        parse_worker_frame(r#"{"type":"event","sessionId":"s1"}"#).expect("valid worker frame");
    assert_eq!(frame["type"], "event");
    assert!(parse_worker_frame("[]").is_none());
    assert!(parse_worker_frame("not-json").is_none());
}
