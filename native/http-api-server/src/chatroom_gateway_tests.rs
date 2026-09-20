use super::auth_session::{AuthSession, AuthStorage, PersistedAuth};
use super::chatroom_client::{ChatroomClientError, ChatroomSocket, ChatroomSocketConnector};
use super::chatroom_gateway::{
    ChatroomBridge, ChatroomGateway, GatewayClock, GatewayHttpResponse, GatewayTransport,
    GatewayTransportResponse,
};
use super::chatroom_protocol::{ChatroomEvent, CosAction};
use super::edu_api_client::{EduApiClient, EduApiError, EduApiRequest, EduApiResponse};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Default)]
struct TestStorage;

impl AuthStorage for TestStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, super::auth_session::AuthError> {
        Ok(None)
    }
    fn save(&self, _auth: &PersistedAuth) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }
    fn clear(&self) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }
}

struct NoopEduTransport;

impl super::edu_api_client::EduApiTransport for NoopEduTransport {
    fn send(&self, _request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        Err(EduApiError::Transport("测试不应调用认证传输".into()))
    }
}

struct AuthenticatedTestStorage;

impl AuthStorage for AuthenticatedTestStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, super::auth_session::AuthError> {
        Ok(Some(PersistedAuth {
            access_token: "test-access-token".into(),
            refresh_token: None,
            provider: "test".into(),
            user: Some(json!({"id": 1})),
            expires_at: None,
        }))
    }

    fn save(&self, _auth: &PersistedAuth) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }

    fn clear(&self) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }
}

struct AuthenticatedUppercaseIdStorage;

impl AuthStorage for AuthenticatedUppercaseIdStorage {
    fn load(&self) -> Result<Option<PersistedAuth>, super::auth_session::AuthError> {
        Ok(Some(PersistedAuth {
            access_token: "test-access-token".into(),
            refresh_token: None,
            provider: "test".into(),
            user: Some(json!({"ID": 42})),
            expires_at: None,
        }))
    }

    fn save(&self, _auth: &PersistedAuth) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }

    fn clear(&self) -> Result<(), super::auth_session::AuthError> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeTransport {
    requests: Mutex<Vec<(String, String, Option<String>)>>,
    responses: Mutex<Vec<GatewayTransportResponse>>,
    request_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl FakeTransport {
    fn push(&self, response: GatewayTransportResponse) {
        self.responses.lock().unwrap().push(response);
    }

    fn gate_next_request(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.request_gate.lock().unwrap() = Some((started, release_receiver));
        (started_receiver, release)
    }
}

impl GatewayTransport for FakeTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<GatewayTransportResponse, String> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), path.into(), body));
        if let Some((started, release)) = self.request_gate.lock().unwrap().take() {
            let _ = started.send(());
            release
                .recv()
                .map_err(|_| "测试请求未收到放行信号".to_string())?;
        }
        let mut responses = self.responses.lock().unwrap();
        if responses.is_empty() {
            return Err("测试传输没有预置响应".to_string());
        }
        Ok(responses.remove(0))
    }
}

#[derive(Default)]
struct FakeBridge {
    invocations: Mutex<Vec<Vec<u8>>>,
    disconnects: Mutex<Vec<Vec<u8>>>,
}

impl ChatroomBridge for FakeBridge {
    fn send_invocation(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        self.invocations.lock().unwrap().push(body);
        Ok(())
    }
    fn send_disconnected(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        self.disconnects.lock().unwrap().push(body);
        Ok(())
    }
}

struct SaturatingBridge {
    invocations: Mutex<Vec<Vec<u8>>>,
    disconnects: Mutex<Vec<Vec<u8>>>,
    started: mpsc::Sender<()>,
    started_count: AtomicUsize,
    release: AtomicBool,
    in_flight: AtomicUsize,
}

impl SaturatingBridge {
    fn new() -> (Arc<Self>, mpsc::Receiver<()>) {
        let (started, receiver) = mpsc::channel();
        (
            Arc::new(Self {
                invocations: Mutex::new(Vec::new()),
                disconnects: Mutex::new(Vec::new()),
                started,
                started_count: AtomicUsize::new(0),
                release: AtomicBool::new(false),
                in_flight: AtomicUsize::new(0),
            }),
            receiver,
        )
    }

    fn release(&self) {
        self.release.store(true, Ordering::Release);
    }
}

impl ChatroomBridge for SaturatingBridge {
    fn send_invocation(&self, body: Vec<u8>, shutdown: &AtomicBool) -> Result<(), String> {
        self.invocations.lock().unwrap().push(body);
        let ordinal = self.started_count.fetch_add(1, Ordering::AcqRel);
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        if ordinal < 4 {
            let _ = self.started.send(());
            while !self.release.load(Ordering::Acquire) && !shutdown.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(2));
            }
        }
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        if shutdown.load(Ordering::Acquire) {
            Err("测试 bridge 已取消".into())
        } else {
            Ok(())
        }
    }

    fn send_disconnected(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        self.disconnects.lock().unwrap().push(body);
        Ok(())
    }
}

struct RecordingSocket {
    sent: Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    released: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}

impl ChatroomSocket for RecordingSocket {
    fn send_json(
        &mut self,
        command: &super::chatroom_protocol::ChatroomCommand,
    ) -> Result<(), ChatroomClientError> {
        self.sent.lock().unwrap().push(command.clone());
        Ok(())
    }

    fn receive_json(
        &mut self,
    ) -> Result<super::chatroom_protocol::ChatroomEvent, ChatroomClientError> {
        while !self.released.load(Ordering::Acquire) && !self.closed.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
        }
        Err(ChatroomClientError::new("closed", "测试 socket 已关闭"))
    }

    fn close(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
}

struct RecordingConnector {
    sent: Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    released: Arc<AtomicBool>,
    attempts: Arc<AtomicUsize>,
}

impl ChatroomSocketConnector for RecordingConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(RecordingSocket {
            sent: self.sent.clone(),
            released: self.released.clone(),
            closed: Arc::new(AtomicBool::new(false)),
        }))
    }
}

struct FakeSocket;

impl ChatroomSocket for FakeSocket {
    fn send_json(
        &mut self,
        _command: &super::chatroom_protocol::ChatroomCommand,
    ) -> Result<(), ChatroomClientError> {
        Ok(())
    }
    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        Err(ChatroomClientError::new("closed", "测试 socket 已关闭"))
    }
    fn close(&mut self) {}
}

struct FakeConnector;

impl ChatroomSocketConnector for FakeConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        Ok(Box::new(FakeSocket))
    }
}

struct TestGatewayClock {
    now: Mutex<Instant>,
}

impl TestGatewayClock {
    fn new() -> Self {
        Self {
            now: Mutex::new(Instant::now()),
        }
    }

    fn advance(&self, duration: Duration) {
        let mut now = self.now.lock().unwrap();
        *now += duration;
    }
}

impl GatewayClock for TestGatewayClock {
    fn now(&self) -> Instant {
        *self.now.lock().unwrap()
    }
}

fn gateway(transport: Arc<FakeTransport>, bridge: Arc<FakeBridge>) -> Arc<ChatroomGateway> {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        bridge,
        "device-test".into(),
        transport,
    )
    .unwrap()
}

fn unauthenticated_gateway() -> Arc<ChatroomGateway> {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(TestStorage)).unwrap());
    ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .unwrap()
}

fn recording_gateway() -> (
    Arc<ChatroomGateway>,
    Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    Arc<AtomicUsize>,
    Arc<AtomicBool>,
) {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let released = Arc::new(AtomicBool::new(false));
    let attempts = Arc::new(AtomicUsize::new(0));
    let gateway = ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(RecordingConnector {
            sent: sent.clone(),
            released: released.clone(),
            attempts: attempts.clone(),
        }),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .unwrap();
    (gateway, sent, attempts, released)
}

fn saturated_gateway(
    bridge: Arc<SaturatingBridge>,
) -> (
    Arc<ChatroomGateway>,
    Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    Arc<AtomicBool>,
) {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let released = Arc::new(AtomicBool::new(false));
    let gateway = ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(RecordingConnector {
            sent: sent.clone(),
            released: released.clone(),
            attempts: Arc::new(AtomicUsize::new(0)),
        }),
        bridge,
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .unwrap();
    (gateway, sent, released)
}

fn gateway_with_saturating_bridge(bridge: Arc<SaturatingBridge>) -> Arc<ChatroomGateway> {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(TestStorage)).unwrap());
    ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        bridge,
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .unwrap()
}

fn invocation(room: &str, invocation_id: &str) -> ChatroomEvent {
    ChatroomEvent::AgentInvocation {
        room_id: room.into(),
        payload: json!({
            "invocationId": invocation_id,
            "traceId": "trace-1",
            "targetAgentId": "agent-1",
            "triggerMessageId": "message-1",
            "depth": 1,
            "sender": {"type":"user","id":"7","displayName":"用户#7"},
            "messages": [{"messageId":"message-1","sender":{"type":"user","id":"7","displayName":"用户#7"},"text":"hello","createdAt":1000}],
            "receivedAt": 2000
        }),
    }
}

#[test]
fn given_task_is_received_then_shutdown_before_execution_skips_queued_work() {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    let (loaded, release) = gateway.gate_next_task_for_test();
    gateway.start();
    gateway.publish_event_for_test(invocation("room-1", "inv-queued"));
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("task worker 未收到排队任务");

    let shutdown_gateway = Arc::clone(&gateway);
    let shutdown = thread::spawn(move || shutdown_gateway.shutdown());
    for _ in 0..100 {
        if gateway.shutdown_requested_for_test() {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert!(gateway.shutdown_requested_for_test());
    release.send(()).unwrap();
    shutdown.join().unwrap();
    assert!(bridge.invocations.lock().unwrap().is_empty());
}

#[test]
fn given_full_task_queue_then_invocation_reports_strict_bridge_busy_failure() {
    let (bridge, started) = SaturatingBridge::new();
    let (gateway, sent, released) = saturated_gateway(bridge.clone());
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.start();
    for _ in 0..100 {
        if sent.lock().unwrap().len() >= 1 {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(sent.lock().unwrap().len(), 1);

    for index in 0..4 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-block-{index}")));
    }
    for _ in 0..4 {
        started
            .recv_timeout(Duration::from_millis(500))
            .expect("未阻塞全部 invocation worker");
    }
    for index in 0..64 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-queued-{index}")));
    }
    gateway.publish_event_for_test(invocation("room-1", "inv-overflow"));

    released.store(true, Ordering::Release);
    for _ in 0..500 {
        let has_failure = sent.lock().unwrap().iter().any(|command| {
            matches!(
                command,
                super::chatroom_protocol::ChatroomCommand::AgentEvent {
                    invocation_id,
                    event: super::chatroom_protocol::AgentEventPayload::Failed { code, .. },
                    ..
                } if invocation_id == "inv-overflow" && code == "bridge_busy"
            )
        });
        if has_failure {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert!(sent.lock().unwrap().iter().any(|command| {
        matches!(
            command,
            super::chatroom_protocol::ChatroomCommand::AgentEvent {
                invocation_id,
                event: super::chatroom_protocol::AgentEventPayload::Failed { code, .. },
                ..
            } if invocation_id == "inv-overflow" && code == "bridge_busy"
        )
    }));
    gateway.shutdown();
}

#[test]
fn given_full_task_queue_then_disconnected_notification_is_merged_and_sent_once() {
    let (bridge, started) = SaturatingBridge::new();
    let gateway = gateway_with_saturating_bridge(bridge.clone());
    gateway.start();
    for index in 0..4 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-block-{index}")));
    }
    for _ in 0..4 {
        started
            .recv_timeout(Duration::from_millis(500))
            .expect("未阻塞全部 invocation worker");
    }
    for index in 0..64 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-queued-{index}")));
    }
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    bridge.release();
    for _ in 0..500 {
        if bridge.disconnects.lock().unwrap().len() == 1 {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(bridge.disconnects.lock().unwrap().len(), 1);
    gateway.shutdown();
}

#[test]
fn given_blocked_bridge_then_shutdown_cancels_call_and_clears_in_flight_worker() {
    let (bridge, started) = SaturatingBridge::new();
    let gateway = gateway_with_saturating_bridge(bridge.clone());
    gateway.start();
    gateway.publish_event_for_test(invocation("room-1", "inv-blocked"));
    started
        .recv_timeout(Duration::from_millis(500))
        .expect("bridge 未进入阻塞调用");
    let started_at = Instant::now();
    gateway.shutdown();
    assert!(started_at.elapsed() < Duration::from_secs(1));
    assert_eq!(bridge.in_flight.load(Ordering::Acquire), 0);
}

#[test]
fn given_real_bridge_pending_request_then_shutdown_cancels_and_removes_pending() {
    let bridge = Arc::new(super::Bridge::new());
    bridge.available.store(true, Ordering::Release);
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(TestStorage)).unwrap());
    let gateway = ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        bridge.clone(),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .unwrap();
    gateway.start();
    gateway.publish_event_for_test(invocation("room-1", "inv-real-bridge"));
    for _ in 0..100 {
        if !bridge.pending.lock().unwrap().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert!(!bridge.pending.lock().unwrap().is_empty());
    let started_at = Instant::now();
    gateway.shutdown();
    assert!(started_at.elapsed() < Duration::from_secs(1));
    assert!(bridge.pending.lock().unwrap().is_empty());
}

fn durable(room: &str, seq: u64) -> ChatroomEvent {
    ChatroomEvent::MessageCreated {
        room_id: room.into(),
        seq,
        payload: json!({"messageId": format!("m-{seq}")}),
    }
}

#[test]
fn given_seq_100_then_live_103_when_event_arrives_then_fetch_101_102_before_publishing_103() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":[
            {"eventId":"e101","roomId":"room-1","seq":101,"eventType":"message.created","payload":{"messageId":"m101"},"createdAt":"now"},
            {"eventId":"e102","roomId":"room-1","seq":102,"eventType":"message.created","payload":{"messageId":"m102"},"createdAt":"now"}
        ]})).unwrap(),
    });
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(transport.clone(), bridge);
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(durable("room-1", 103));
    let mut seqs = Vec::new();
    for _ in 0..3 {
        let event = subscription
            .receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        seqs.push(event["seq"].as_u64().unwrap());
    }
    assert_eq!(seqs, vec![101, 102, 103]);
    assert_eq!(
        transport.requests.lock().unwrap()[0].1,
        "/api/chatrooms/v2/rooms/room-1/events?afterSeq=100&limit=500"
    );
}

#[test]
fn given_duplicate_seq_when_event_arrives_then_publish_once() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(durable("room-1", 101));
    gateway.publish_event_for_test(durable("room-1", 101));
    assert_eq!(
        subscription
            .receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap()["seq"],
        101
    );
    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(20))
        .is_err());
}

#[test]
fn given_sse_subscription_for_room_when_public_event_arrives_then_receive_filtered_event() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentDelta {
        room_id: "room-1".into(),
        payload: json!({"delta":"ok", "objectKey":"private", "nested":{"sessionToken":"secret"}}),
    });
    let value = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(value["type"], "agent.delta");
    assert!(value.to_string().contains("[已过滤]") || !value.to_string().contains("private"));
    assert!(!value.to_string().contains("sessionToken"));
}

#[test]
fn given_connected_gateway_when_connected_event_repeats_then_do_not_reconnect_equivalent_subscription(
) {
    let (gateway, sent, attempts, released) = recording_gateway();
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(sent.lock().unwrap().len(), 1);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Connected);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(sent.lock().unwrap().len(), 1);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    released.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_internal_agent_text_when_unicode_whitespace_is_present_then_forward_to_client_boundary() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/delta",
        &HashMap::new(),
        serde_json::to_vec(
            &json!({"roomId":"room-1","invocationId":"inv-1","delta":"你好，\n世界"}),
        )
        .unwrap()
        .as_slice(),
    );
    assert!(matches!(result, Err(error) if error.code == "realtime_unavailable"));
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/completed",
        &HashMap::new(),
        serde_json::to_vec(&json!({"roomId":"room-1","invocationId":"inv-1","content":"第一行\n第二行","mentionAgentIds":[],"attachmentIds":[],"clientMessageId":"client-1"})).unwrap().as_slice(),
    );
    assert!(matches!(result, Err(error) if error.code == "realtime_unavailable"));
}

#[test]
fn given_internal_agent_text_when_control_or_limit_is_present_then_reject_request() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let control = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/delta",
        &HashMap::new(),
        b"{\"roomId\":\"room-1\",\"invocationId\":\"inv-1\",\"delta\":\"bad\\u0001\"}",
    );
    assert!(matches!(control, Err(error) if error.status == 400));
    let mut body = format!(
        "{{\"roomId\":\"room-1\",\"invocationId\":\"inv-1\",\"delta\":\"{}\"}}",
        "x".repeat(65 * 1024)
    );
    let oversized = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/delta",
        &HashMap::new(),
        body.as_bytes(),
    );
    assert!(matches!(oversized, Err(error) if error.status == 400));
    body.clear();
}

#[test]
fn given_auth_loss_when_connection_is_shutdown_then_clear_sse_and_room_state() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.set_room_cursor_for_test("room-1", 9);
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.shutdown_connection();
    assert_eq!(gateway.subscriber_count_for_test(), 0);
    assert_eq!(gateway.room_cursor_for_test("room-1"), None);
    assert_eq!(gateway.lease_count_for_test(), 0);
    gateway.resume_connection();
    assert_eq!(gateway.room_cursor_for_test("room-1"), None);
}

#[test]
fn given_unauthenticated_gateway_when_sse_is_requested_then_deny_without_cache_access() {
    let gateway = unauthenticated_gateway();
    let result = gateway.subscribe_sse(vec!["room-1".into()]);
    assert!(
        matches!(result, Err(error) if error.status == 401 && error.code == "not_authenticated")
    );
}

#[test]
fn given_auth_loss_during_sse_registration_then_do_not_leave_subscriber() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let (loaded, release) = gateway.gate_sse_registration_for_test();
    let worker_gateway = Arc::clone(&gateway);
    let worker = thread::spawn(move || worker_gateway.subscribe_sse(vec!["room-1".into()]));
    loaded.recv_timeout(Duration::from_millis(500)).unwrap();
    gateway.shutdown_connection();
    release.send(()).unwrap();
    let result = worker.join().unwrap();
    assert!(matches!(result, Err(error) if error.status == 401));
    assert_eq!(gateway.subscriber_count_for_test(), 0);
    assert_eq!(gateway.room_cursor_for_test("room-1"), None);
}

#[test]
fn given_logout_login_aba_during_sse_registration_then_reject_old_auth_epoch() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let (loaded, release) = gateway.gate_sse_registration_for_test();
    let worker_gateway = Arc::clone(&gateway);
    let worker = thread::spawn(move || worker_gateway.subscribe_sse(vec!["room-1".into()]));
    loaded.recv_timeout(Duration::from_millis(500)).unwrap();

    gateway.shutdown_connection();
    gateway.resume_connection();
    gateway.set_room_cursor_for_test("room-2", 7);
    let new_subscription = gateway.subscribe_sse(vec!["room-2".into()]).unwrap();
    release.send(()).unwrap();
    let result = worker.join().unwrap();
    assert!(matches!(result, Err(error) if error.status == 401));
    assert_eq!(gateway.subscriber_count_for_test(), 1);
    assert_eq!(gateway.room_cursor_for_test("room-2"), Some(7));
    drop(new_subscription);
    assert_eq!(gateway.room_cursor_for_test("room-1"), None);
}

#[test]
fn given_auth_loss_then_resume_before_new_socket_connected_then_old_events_stay_rejected() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.set_room_cursor_for_test("room-1", 9);
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.shutdown_connection();
    gateway.resume_connection();

    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    assert!(!gateway.connection_paused_for_test());
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 9,
            payload: json!({"name":"旧账号快照"}),
        },
    });
    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .is_err());
    assert_eq!(gateway.subscriber_count_for_test(), 1);
}

#[test]
fn given_logout_after_event_acceptance_check_then_old_event_cannot_reach_new_subscriber() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (loaded, release) = gateway.gate_client_event_acceptance_for_test();
    let event_gateway = Arc::clone(&gateway);
    let event = thread::spawn(move || {
        event_gateway.handle_client_event_for_test(
            super::chatroom_client::ChatroomClientEvent::EventAt {
                generation: 0,
                event: ChatroomEvent::RoomSnapshot {
                    room_id: "room-1".into(),
                    latest_seq: 1,
                    payload: json!({"name":"旧账号快照"}),
                },
            },
        );
    });
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("旧事件未到达 acceptance gate");

    gateway.shutdown_connection();
    gateway.resume_connection();
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    release.send(()).unwrap();
    event.join().unwrap();

    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .is_err());
}

#[test]
fn given_logout_after_connected_acceptance_check_then_old_generation_is_not_accepted() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let (loaded, release) = gateway.gate_client_event_acceptance_for_test();
    let connected_gateway = Arc::clone(&gateway);
    let connected = thread::spawn(move || {
        connected_gateway.handle_client_event_for_test(
            super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
        );
    });
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("ConnectedAt 未到达 acceptance gate");

    gateway.shutdown_connection();
    gateway.resume_connection();
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    release.send(()).unwrap();
    connected.join().unwrap();

    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .is_err());
}

#[test]
fn given_successful_leave_or_removal_when_route_finishes_then_room_is_unsubscribed() {
    for (method, path, body) in [
        ("POST", "/api/chatrooms/v2/rooms/room-1/leave", Vec::new()),
        ("DELETE", "/api/chatrooms/v2/rooms/room-1", Vec::new()),
        (
            "DELETE",
            "/api/chatrooms/v2/rooms/room-1/members/1",
            Vec::new(),
        ),
    ] {
        let transport = Arc::new(FakeTransport::default());
        transport.push(GatewayTransportResponse {
            status: 204,
            body: Vec::new(),
        });
        let gateway = gateway(transport, Arc::new(FakeBridge::default()));
        gateway.set_room_cursor_for_test("room-1", 7);
        gateway.register_lease_for_test("room-1", "agent-1", "device-1");
        gateway
            .handle_http(method, path, &HashMap::new(), &body)
            .unwrap();
        assert_eq!(
            gateway.room_cursor_for_test("room-1"),
            None,
            "{method} {path}"
        );
        assert_eq!(gateway.lease_count_for_test(), 0, "{method} {path}");
    }
}

#[test]
fn given_successful_delete_of_other_agent_or_member_when_route_finishes_then_room_stays_subscribed()
{
    for path in [
        "/api/chatrooms/v2/rooms/room-1/agents/agent-1",
        "/api/chatrooms/v2/rooms/room-1/members/42",
    ] {
        let transport = Arc::new(FakeTransport::default());
        transport.push(GatewayTransportResponse {
            status: 204,
            body: Vec::new(),
        });
        let gateway = gateway(transport, Arc::new(FakeBridge::default()));
        gateway.set_room_cursor_for_test("room-1", 7);
        gateway.register_lease_for_test("room-1", "agent-1", "device-1");
        gateway
            .handle_http("DELETE", path, &HashMap::new(), &[])
            .unwrap();
        assert_eq!(gateway.room_cursor_for_test("room-1"), Some(7), "{path}");
        if path.contains("agents") {
            assert_eq!(gateway.lease_count_for_test(), 0);
        }
    }
}

#[test]
fn given_current_member_removed_when_auth_user_uses_uppercase_id_then_leave_room_subscription() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth =
        Arc::new(AuthSession::new(client, Arc::new(AuthenticatedUppercaseIdStorage)).unwrap());
    let gateway = ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        transport,
    )
    .unwrap();
    gateway.set_room_cursor_for_test("room-1", 7);
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");

    gateway
        .handle_http(
            "DELETE",
            "/api/chatrooms/v2/rooms/room-1/members/42",
            &HashMap::new(),
            &[],
        )
        .unwrap();

    assert_eq!(gateway.room_cursor_for_test("room-1"), None);
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_continuous_client_events_when_lease_expires_then_event_path_ticks_it() {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let clock = Arc::new(TestGatewayClock::new());
    let gateway = ChatroomGateway::new_with_transport_and_clock(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
        clock.clone(),
    )
    .unwrap();
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    clock.advance(Duration::from_secs(61));
    for _ in 0..10 {
        gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Event(
            ChatroomEvent::AgentPresenceChanged {
                room_id: "room-1".into(),
                payload: json!({}),
            },
        ));
    }
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_agent_invocation_when_upstream_event_arrives_then_forward_only_sanitized_payload_to_bridge(
) {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.publish_event_for_test(ChatroomEvent::AgentInvocation {
        room_id: "room-1".into(),
        payload: json!({
            "invocationId":"inv-1", "traceId":"trace-1", "targetAgentId":"agent-1",
            "triggerMessageId":"msg-1", "depth":1,
            "sender":{"type":"user","id":"7","displayName":"用户#7"},
            "messages":[{"messageId":"msg-1","sender":{"type":"user","id":"7","displayName":"用户#7"},"text":"hello","createdAt":1000}],
            "receivedAt":2000
        }),
    });
    let body = bridge.invocations.lock().unwrap().first().cloned().unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["roomId"], "room-1");
    assert_eq!(value["invocationId"], "inv-1");
    assert_eq!(value["depth"], 1);
    assert_eq!(value["sender"]["type"], "user");
    assert_eq!(value["messages"][0]["messageId"], "msg-1");
    assert_eq!(value["receivedAt"], 2000);
    assert!(value.get("status").is_none());
    assert!(value.get("statusCode").is_none());
    assert!(value.get("context").is_none());
    assert!(value.get("accessToken").is_none());
}

#[test]
fn given_legacy_or_malformed_agent_invocation_when_upstream_event_arrives_then_bridge_is_not_called(
) {
    for payload in [
        json!({"invocationId":"inv-legacy","traceId":"trace","targetAgentId":"agent","triggerMessageId":"msg","depth":0}),
        json!({"invocationId":"inv-bad","traceId":"trace","targetAgentId":"agent","triggerMessageId":"msg","depth":0,"sender":{"type":"user","id":"7","displayName":"user"},"messages":[{"messageId":"msg","sender":{"type":"user","id":"7","displayName":"user"},"text":"bad\u{0001}","createdAt":1}],"receivedAt":2}),
        json!({"invocationId":"inv-mismatch","traceId":"trace","targetAgentId":"agent","triggerMessageId":"msg-expected","depth":0,"sender":{"type":"user","id":"7","displayName":"user"},"messages":[{"messageId":"msg-other","sender":{"type":"user","id":"7","displayName":"user"},"text":"hello","createdAt":1}],"receivedAt":2}),
        json!({"invocationId":"inv-sender-mismatch","traceId":"trace","targetAgentId":"agent","triggerMessageId":"msg","depth":0,"sender":{"type":"user","id":"7","displayName":"user"},"messages":[{"messageId":"msg","sender":{"type":"agent","id":"agent","displayName":"Agent"},"text":"hello","createdAt":1}],"receivedAt":2}),
    ] {
        let bridge = Arc::new(FakeBridge::default());
        let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
        gateway.publish_event_for_test(ChatroomEvent::AgentInvocation {
            room_id: "room-1".into(),
            payload,
        });
        assert!(bridge.invocations.lock().unwrap().is_empty());
    }
}

#[test]
fn given_internal_sts_route_when_grant_is_valid_then_return_grant_to_main_but_public_route_never_returns_secret_fields(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":{"attachmentId":"att-1","bucket":"b","region":"r","objectKey":"private/key","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"session","startTime":1,"expiredTime":2},"action":"upload"}})).unwrap(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let internal = gateway.handle_http("POST", "/api/internal/chatrooms/cos/upload-grant", &HashMap::new(), br#"{"roomId":"room-1","fileName":"a.txt","mimeType":"text/plain","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#).unwrap();
    let GatewayHttpResponse::Json { body, .. } = internal else {
        panic!("expected JSON")
    };
    assert_eq!(body["tmpSecretKey"], "key");
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"rooms":[]}"#.to_vec(),
    });
    let public = gateway
        .handle_http("GET", "/api/chatrooms/v2/rooms", &HashMap::new(), &[])
        .unwrap();
    let GatewayHttpResponse::Json { body, .. } = public else {
        panic!("expected JSON")
    };
    assert!(!body.to_string().contains("tmpSecretKey"));
}

#[test]
fn given_offline_agent_invocation_result_when_message_is_submitted_then_return_agent_offline_without_local_queue(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 409,
        body: br#"{"error":"offline","code":"agent_offline","accessToken":"jwt"}"#.to_vec(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let response = gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms/room-1/messages",
            &HashMap::new(),
            br#"{"content":"hello"}"#,
        )
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = response else {
        panic!("expected JSON")
    };
    assert_eq!(status, 409);
    assert_eq!(body["code"], "agent_offline");
    assert!(!body.to_string().contains("jwt"));
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn given_shutdown_when_gateway_has_subscriptions_and_leases_then_unsubscribe_and_release_all() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.register_lease_for_test("room-1", "agent-1", "device-test");
    gateway.shutdown();
    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(20))
        .is_err());
    assert!(gateway.command_after_shutdown_for_test().is_err());
}

#[test]
fn given_exact_routes_when_method_or_segment_is_invalid_then_reject_locally() {
    assert!(super::chatroom_gateway::is_chatroom_path(
        "/api/chatrooms/v2/rooms"
    ));
    assert!(!super::chatroom_gateway::is_chatroom_path(
        "/api/other/rooms/room-1"
    ));
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    for (method, path) in [
        ("POST", "/api/chatrooms/v2/events"),
        ("POST", "/api/chatrooms/v2/rooms/room-1/read"),
        ("GET", "/api/chatrooms/v2/rooms/room-1/members/user-1"),
    ] {
        assert!(gateway
            .handle_http(method, path, &HashMap::new(), &[])
            .is_err());
    }
    assert!(gateway
        .handle_http(
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1/read",
            &HashMap::new(),
            br#"{"seq":1}"#
        )
        .is_err());
    assert!(gateway
        .handle_http(
            "DELETE",
            "/api/chatrooms/v2/rooms/room-1/members/user-1",
            &HashMap::new(),
            &[]
        )
        .is_err());
}

#[test]
fn given_public_attachment_id_when_sanitizing_then_preserve_business_id_and_remove_object_key() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body:
            br#"{"attachmentId":"att-1","objectKey":"private","nested":{"sessionToken":"secret"}}"#
                .to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let response = gateway
        .handle_http("GET", "/api/chatrooms/v2/rooms", &HashMap::new(), &[])
        .unwrap();
    let GatewayHttpResponse::Json { body, .. } = response else {
        panic!("expected JSON")
    };
    assert_eq!(body["attachmentId"], "att-1");
    assert!(body.get("objectKey").is_none());
    assert!(body.to_string().contains("att-1"));
    assert!(!body.to_string().contains("secret"));
    let _ = CosAction::Upload;
}

#[test]
fn given_concurrent_live_events_when_gap_recovers_then_each_sequence_is_published_once() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":[
            {"eventId":"e101","roomId":"room-1","seq":101,"eventType":"message.created","payload":{"messageId":"m101"},"createdAt":"now"},
            {"eventId":"e102","roomId":"room-1","seq":102,"eventType":"message.created","payload":{"messageId":"m102"},"createdAt":"now"}
        ]})).unwrap(),
    });
    let (started, release) = transport.gate_next_request();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let first_gateway = Arc::clone(&gateway);
    let first =
        std::thread::spawn(move || first_gateway.publish_event_for_test(durable("room-1", 103)));
    started.recv().unwrap();
    let second_gateway = Arc::clone(&gateway);
    let second =
        std::thread::spawn(move || second_gateway.publish_event_for_test(durable("room-1", 104)));
    release.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    let mut seqs = Vec::new();
    for _ in 0..4 {
        seqs.push(
            subscription.receiver.recv().unwrap()["seq"]
                .as_u64()
                .unwrap(),
        );
    }
    assert_eq!(seqs, vec![101, 102, 103, 104]);
}

#[test]
fn given_malformed_recovery_page_when_gap_is_detected_then_cursor_is_retained_and_resync_is_reported(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":[{"eventId":"e102","roomId":"room-1","seq":102,"eventType":"message.created","payload":{},"createdAt":"now"}]}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(durable("room-1", 103));
    let status = subscription.receiver.recv().unwrap();
    assert_eq!(status["code"], "realtime_gap");
    assert_eq!(gateway.room_cursor_for_test("room-1"), Some(100));
}

#[test]
fn given_non_contiguous_recovery_page_when_gap_is_detected_then_do_not_commit_partial_page() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":[
            {"eventId":"e101","roomId":"room-1","seq":101,"eventType":"message.created","payload":{"messageId":"m101"},"createdAt":"now"},
            {"eventId":"e103","roomId":"room-1","seq":103,"eventType":"message.created","payload":{"messageId":"m103"},"createdAt":"now"}
        ]}))
        .unwrap(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(durable("room-1", 104));
    let status = subscription.receiver.recv().unwrap();
    assert_eq!(status["code"], "realtime_gap");
    assert_eq!(gateway.room_cursor_for_test("room-1"), Some(100));
    assert!(subscription.receiver.try_recv().is_err());
}

#[test]
fn given_local_sse_route_when_opened_then_never_proxy_to_edu_api() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let response = gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/events?roomId=room-1",
            &HashMap::new(),
            &[],
        )
        .unwrap();
    assert!(matches!(response, GatewayHttpResponse::Sse(_)));
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_sse_query_with_empty_duplicate_or_mixed_segments_then_reject_locally() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    for query in [
        "roomId=room-1&",
        "&roomId=room-1",
        "roomId=room-1&&roomId=room-2",
        "roomId=room-1&roomId=room-2",
        "roomId=room-1&roomIds=room-2",
    ] {
        assert!(
            gateway
                .handle_http(
                    "GET",
                    &format!("/api/chatrooms/v2/events?{query}"),
                    &HashMap::new(),
                    &[],
                )
                .is_err(),
            "query should be rejected: {query}"
        );
    }
    assert!(matches!(
        gateway
            .handle_http(
                "GET",
                "/api/chatrooms/v2/events?roomIds=room-1,room-2",
                &HashMap::new(),
                &[],
            )
            .unwrap(),
        GatewayHttpResponse::Sse(_)
    ));
}

#[test]
fn given_read_seq_above_i64_max_then_reject_before_proxying() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    assert!(gateway
        .handle_http(
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1/read",
            &HashMap::new(),
            br#"{"seq":9223372036854775808}"#,
        )
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_slow_sse_subscriber_when_durable_event_fills_reserve_then_close_with_resync_status() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    for _ in 0..64 {
        gateway.publish_event_for_test(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"delta":"part"}),
        });
    }
    gateway.publish_event_for_test(durable("room-1", 1));
    for _ in 0..63 {
        let _ = subscription.receiver.recv().unwrap();
    }
    let marker = subscription.receiver.recv().unwrap();
    assert_eq!(marker["code"], "resync_required");
    assert!(subscription.receiver.recv().is_err());
}

#[test]
fn given_sse_consumer_drains_events_when_more_than_capacity_arrives_then_subscription_stays_open() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    for seq in 1..=128 {
        gateway.publish_event_for_test(durable("room-1", seq));
        assert!(subscription
            .receiver
            .recv_timeout(Duration::from_millis(100))
            .is_ok());
    }
    gateway.publish_event_for_test(durable("room-1", 129));
    assert_eq!(subscription.receiver.recv().unwrap()["seq"], 129);
}

#[test]
fn given_sse_subscription_when_receiver_is_dropped_then_registry_is_released() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    assert_eq!(gateway.subscriber_count_for_test(), 1);
    drop(subscription);
    assert_eq!(gateway.subscriber_count_for_test(), 0);
}

#[test]
fn given_cursor_100_when_snapshot_latest_is_103_then_catch_up_events_are_not_skipped() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 103,
        payload: json!({"name":"room"}),
    });
    gateway.publish_event_for_test(durable("room-1", 101));
    gateway.publish_event_for_test(durable("room-1", 102));
    gateway.publish_event_for_test(durable("room-1", 103));
    assert_eq!(
        subscription.receiver.recv().unwrap()["type"],
        "room.snapshot"
    );
    assert_eq!(subscription.receiver.recv().unwrap()["seq"], 101);
    assert_eq!(subscription.receiver.recv().unwrap()["seq"], 102);
    assert_eq!(subscription.receiver.recv().unwrap()["seq"], 103);
    assert_eq!(gateway.room_cursor_for_test("room-1"), Some(103));
}

#[test]
fn given_recovery_page_overlaps_live_buffer_when_recovered_then_publish_each_sequence_once() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":[
            {"eventId":"e101","roomId":"room-1","seq":101,"eventType":"message.created","payload":{"messageId":"m101"},"createdAt":"now"},
            {"eventId":"e102","roomId":"room-1","seq":102,"eventType":"message.created","payload":{"messageId":"m102"},"createdAt":"now"},
            {"eventId":"e103","roomId":"room-1","seq":103,"eventType":"message.created","payload":{"messageId":"m103"},"createdAt":"now"}
        ]}))
        .unwrap(),
    });
    let (started, release) = transport.gate_next_request();
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("room-1", 100);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let recovery_gateway = Arc::clone(&gateway);
    let recovery = std::thread::spawn(move || {
        recovery_gateway.publish_event_for_test(durable("room-1", 103));
    });
    started.recv().unwrap();
    gateway.publish_event_for_test(durable("room-1", 103));
    release.send(()).unwrap();
    recovery.join().unwrap();
    let mut seqs = Vec::new();
    for _ in 0..3 {
        seqs.push(
            subscription.receiver.recv().unwrap()["seq"]
                .as_u64()
                .unwrap(),
        );
    }
    assert_eq!(seqs, vec![101, 102, 103]);
    assert!(subscription.receiver.try_recv().is_err());
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    assert_eq!(gateway.buffered_count_for_test("room-1"), 0);
}

#[test]
fn given_public_routes_when_body_or_query_schema_is_invalid_then_reject_without_proxying() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    for (method, path, body) in [
        (
            "POST",
            "/api/chatrooms/v2/rooms",
            br#"{"name":"x","shareCode":"AB12","extra":1}"#.as_slice(),
        ),
        (
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1",
            br#"{}"#.as_slice(),
        ),
        (
            "POST",
            "/api/chatrooms/v2/join",
            br#"{"shareCode":""}"#.as_slice(),
        ),
        (
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1/read",
            br#"{"seq":-1}"#.as_slice(),
        ),
        (
            "POST",
            "/api/chatrooms/v2/rooms/room-1/agents",
            br#"{"displayName":"a","deviceId":"d","unknown":true}"#.as_slice(),
        ),
        (
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1/agents/agent-1",
            br#"{"avatar":3}"#.as_slice(),
        ),
        (
            "POST",
            "/api/chatrooms/v2/rooms/room-1/lease",
            br#"{"deviceId":"d","deviceId":"d2"}"#.as_slice(),
        ),
    ] {
        assert!(gateway
            .handle_http(method, path, &HashMap::new(), body)
            .is_err());
    }
    assert!(gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room-1/messages?afterSeq=1&limit=10",
            &HashMap::new(),
            &[],
        )
        .is_err());
    assert!(gateway
        .handle_http("GET", "/api/chatrooms/v2/rooms", &HashMap::new(), br#"{}"#)
        .is_err());
    assert!(gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms",
            &HashMap::new(),
            br#"{"name":"x","shareCode":"AB12"} trailing"#,
        )
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_internal_routes_when_schema_contains_unknown_or_sensitive_fields_then_reject_without_proxying(
) {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    assert!(gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/cos/download-grant",
            &HashMap::new(),
            br#"{"roomId":"room-1","attachmentId":"att-1","objectKey":"private"}"#,
        )
        .is_err());
    assert!(gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/cos/finalize",
            &HashMap::new(),
            br#"{"roomId":"room-1","attachmentId":"att-1","sizeBytes":1,"etag":"e","sha256":"s","objectKey":"private"}"#,
        )
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_phase_one_upload_schema_when_filename_and_mime_are_valid_then_accept_exact_limits() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 400,
        body: br#"{}"#.to_vec(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let file_name = "a".repeat(200);
    let body = json!({
        "roomId": "room-1",
        "fileName": file_name,
        "mimeType": "text/plain; charset=utf-8",
        "sizeBytes": 256 * 1024 * 1024,
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })
    .to_string();
    assert!(gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/cos/upload-grant",
            &HashMap::new(),
            body.as_bytes(),
        )
        .is_ok());
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn given_phase_one_upload_schema_when_mime_is_not_parseable_then_reject_without_proxying() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let body = br#"{"roomId":"room-1","fileName":"report.txt","mimeType":"not a mime","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    assert!(gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/cos/upload-grant",
            &HashMap::new(),
            body,
        )
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_running_invocation_state_when_received_then_return_local_noop_without_upstream_command() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    assert!(matches!(
        gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/invocations/inv-1/running",
                &HashMap::new(),
                br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
            )
            .unwrap(),
        GatewayHttpResponse::Empty { status: 204 }
    ));
}

#[test]
fn given_invalid_gateway_base_url_when_constructed_then_fail_closed() {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(TestStorage)).unwrap());
    assert!(ChatroomGateway::new_with_transport(
        auth,
        "https://test.invalid/module/edu-api?token=jwt".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
    )
    .is_err());
}

#[test]
fn given_public_response_with_phase_one_sensitive_fields_when_sanitized_then_remove_recursively() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"attachmentId":"att-1","attachmentIds":["att-2"],"deviceHash":"h","rawDevice":"r","cosKey":"c","storageKey":"s","qcs":"qcs::secret","nested":{"Authorization":"jwt","localPath":"/Users/private"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let GatewayHttpResponse::Json { body, .. } = gateway
        .handle_http("GET", "/api/chatrooms/v2/rooms", &HashMap::new(), &[])
        .unwrap()
    else {
        panic!("expected JSON")
    };
    assert_eq!(body["attachmentId"], "att-1");
    assert_eq!(body["attachmentIds"][0], "att-2");
    for key in ["deviceHash", "rawDevice", "cosKey", "storageKey", "qcs"] {
        assert!(body.get(key).is_none());
    }
    assert!(body["nested"].get("Authorization").is_none());
    assert!(body["nested"].get("localPath").is_none());
}

#[test]
fn given_lease_response_when_upstream_rejects_then_do_not_register_until_2xx_and_clear_offline() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 409,
        body: br#"{"code":"agent_busy"}"#.to_vec(),
    });
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms/room-1/agents/agent-1/lease",
            &HashMap::new(),
            br#"{"deviceId":"device-1"}"#,
        )
        .unwrap();
    assert_eq!(gateway.lease_count_for_test(), 0);
    gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms/room-1/agents/agent-1/lease",
            &HashMap::new(),
            br#"{"deviceId":"device-1"}"#,
        )
        .unwrap();
    assert_eq!(gateway.lease_count_for_test(), 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.publish_event_for_test(ChatroomEvent::AgentOffline {
        room_id: "room-1".into(),
        seq: 1,
        payload: json!({"roomAgentId":"agent-1"}),
    });
    assert_eq!(gateway.lease_count_for_test(), 0);
}

#[test]
fn given_running_gateway_when_injected_clock_passes_lease_expiry_then_event_loop_removes_lease() {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let clock = Arc::new(TestGatewayClock::new());
    let gateway = ChatroomGateway::new_with_transport_and_clock(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        Arc::new(FakeTransport::default()),
        clock.clone(),
    )
    .unwrap();
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.start();

    clock.advance(Duration::from_secs(61));
    let expired = (0..20).any(|_| {
        thread::sleep(Duration::from_millis(50));
        gateway.lease_count_for_test() == 0
    });
    gateway.shutdown();
    assert!(expired);
}

#[test]
fn given_completed_invocation_when_published_then_keep_agent_lease() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.publish_event_for_test(ChatroomEvent::AgentCompleted {
        room_id: "room-1".into(),
        payload: json!({"roomAgentId":"agent-1"}),
    });
    assert_eq!(gateway.lease_count_for_test(), 1);
}

#[test]
fn given_room_a_recovery_is_blocked_when_room_b_event_arrives_then_dispatcher_keeps_publishing() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::to_vec(&json!({"data":[
            {"eventId":"e1","roomId":"room-a","seq":1,"eventType":"message.created","payload":{"messageId":"m1"},"createdAt":"now"}
        ]}))
        .unwrap(),
    });
    let (started, release) = transport.gate_next_request();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.start();
    gateway.set_room_cursor_for_test("room-a", 0);
    gateway.set_room_cursor_for_test("room-b", 0);
    let room_a = gateway.subscribe_sse(vec!["room-a".into()]).unwrap();
    let room_b = gateway.subscribe_sse(vec!["room-b".into()]).unwrap();
    gateway.publish_event_for_test(durable("room-a", 2));
    started.recv_timeout(Duration::from_millis(500)).unwrap();
    gateway.publish_event_for_test(durable("room-b", 1));
    let room_b_event = loop {
        let event = room_b
            .receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        if event["seq"].as_u64() == Some(1) {
            break event;
        }
    };
    assert_eq!(room_b_event["seq"], 1);
    release.send(()).unwrap();
    let room_a_event = loop {
        let event = room_a
            .receiver
            .recv_timeout(Duration::from_millis(500))
            .unwrap();
        if event["seq"].as_u64() == Some(1) {
            break event;
        }
    };
    assert_eq!(room_a_event["seq"], 1);
    gateway.shutdown();
}

#[test]
fn given_read_and_member_management_routes_when_forwarded_then_use_phase_one_methods_exactly() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    gateway
        .handle_http(
            "PATCH",
            "/api/chatrooms/v2/rooms/room-1/read",
            &HashMap::new(),
            br#"{"seq":1}"#,
        )
        .unwrap();
    gateway
        .handle_http(
            "DELETE",
            "/api/chatrooms/v2/rooms/room-1/members/42",
            &HashMap::new(),
            &[],
        )
        .unwrap();
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].0, "PATCH");
    assert_eq!(requests[0].1, "/api/chatrooms/v2/rooms/room-1/read");
    assert_eq!(requests[1].0, "DELETE");
    assert_eq!(requests[1].1, "/api/chatrooms/v2/rooms/room-1/members/42");
}

#[test]
fn given_message_with_stable_id_when_submitted_then_use_one_authenticated_send_path() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"messageId":"m-1"}}"#.to_vec(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    gateway.handle_http(
        "POST",
        "/api/chatrooms/v2/rooms/room-1/messages",
        &HashMap::new(),
        br#"{"content":"hello","mentionAgentIds":[],"attachmentIds":[],"clientMessageId":"550e8400-e29b-41d4-a716-446655440000"}"#,
    ).unwrap();
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .2
        .as_ref()
        .unwrap()
        .contains("550e8400-e29b-41d4-a716-446655440000"));
}

#[test]
fn given_public_attachment_authorization_route_when_requested_then_deny_even_if_internal_grant_exists(
) {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    assert!(gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms/room-1/attachments/upload-authorizations",
            &HashMap::new(),
            &[]
        )
        .is_err());
}

#[test]
fn given_disconnect_transition_when_repeated_then_notify_bridge_once_until_reconnected() {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    assert_eq!(bridge.disconnects.lock().unwrap().len(), 1);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Connected);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    assert_eq!(bridge.disconnects.lock().unwrap().len(), 2);
}

#[test]
fn given_chatroom_agent_display_name_when_validating_then_use_trimmed_utf8_limit_and_reject_controls(
) {
    assert!(super::chatroom_gateway::valid_invocation_display_name(
        &format!("  {}  ", "界".repeat(42))
    ));
    assert!(!super::chatroom_gateway::valid_invocation_display_name(
        &"界".repeat(43)
    ));
    for value in ["bad\nname", "bad\tname", "bad\0name", "bad\u{0085}name"] {
        assert!(!super::chatroom_gateway::valid_invocation_display_name(
            value
        ));
    }
}
