use super::auth_session::{AuthSession, AuthStorage, PersistedAuth};
use super::chatroom_client::{
    ChatroomClientError, ChatroomSocket, ChatroomSocketConnector, ChatroomSocketFrame,
};
use super::chatroom_execution::ChatroomOrigin;
use super::chatroom_gateway::{
    ChatroomBridge, ChatroomGateway, GatewayClock, GatewayHttpResponse, GatewayTransport,
    GatewayTransportResponse,
};
use super::chatroom_protocol::{
    reply_digest, ChatroomCapability, ChatroomCommand, ChatroomEvent, ChatroomProtocolOptions,
    ChatroomReplyDigestInput, CosAction, PrivateCommandAck,
};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
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

struct StartupProtocolEduTransport {
    requests: Mutex<Vec<String>>,
}

impl super::edu_api_client::EduApiTransport for StartupProtocolEduTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.requests.lock().unwrap().push(request.path.clone());
        let body = if request.path == "/api/chatrooms/v2/capabilities" {
            br#"{"capabilities":["agent-ready-v1","invocation-ack-v1","agent-delta-frame-id-v1"]}"#
                .to_vec()
        } else {
            serde_json::json!({"data":{"room":{"roomId":"room-1","status":"active"}}})
                .to_string()
                .into_bytes()
        };
        Ok(EduApiResponse {
            status: 200,
            headers: Vec::new(),
            body,
        })
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
    invocation_status_response: Mutex<Option<GatewayTransportResponse>>,
    request_errors: Mutex<Vec<String>>,
    request_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    room_check_status: Mutex<HashMap<String, u16>>,
    room_check_bodies: Mutex<HashMap<String, Vec<u8>>>,
    room_check_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    capability_request_count: AtomicUsize,
    capability_gates: Mutex<HashMap<usize, (mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl FakeTransport {
    fn push(&self, response: GatewayTransportResponse) {
        self.responses.lock().unwrap().push(response);
    }

    fn push_error(&self, error: &str) {
        self.request_errors.lock().unwrap().push(error.into());
    }

    fn set_invocation_status_response(&self, response: GatewayTransportResponse) {
        *self.invocation_status_response.lock().unwrap() = Some(response);
    }

    fn set_room_check_status(&self, room_id: &str, status: u16) {
        self.room_check_status
            .lock()
            .unwrap()
            .insert(room_id.into(), status);
    }

    fn set_room_check_body(&self, room_id: &str, body: Value) {
        self.room_check_bodies
            .lock()
            .unwrap()
            .insert(room_id.into(), body.to_string().into_bytes());
    }

    fn gate_next_room_check(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.room_check_gate.lock().unwrap() = Some((started, release_receiver));
        (started_receiver, release)
    }

    fn gate_next_request(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.request_gate.lock().unwrap() = Some((started, release_receiver));
        (started_receiver, release)
    }

    fn gate_capability_request(&self, ordinal: usize) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        self.capability_gates
            .lock()
            .unwrap()
            .insert(ordinal, (started, release_receiver));
        (started_receiver, release)
    }
}

fn all_protocol_options() -> ChatroomProtocolOptions {
    ChatroomProtocolOptions {
        agent_ready_v1: true,
        invocation_ack_v1: true,
        delta_frame_id_v1: true,
    }
}

impl GatewayTransport for FakeTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<GatewayTransportResponse, String> {
        // 既有测试只模拟业务请求；新增 SSE 成员校验默认返回可读的有效房间。
        if method == "GET" {
            if let Some(room_id) = path
                .strip_prefix("/api/chatrooms/v2/rooms/")
                .filter(|id| !id.contains('/') && !id.contains('?'))
            {
                let status = self
                    .room_check_status
                    .lock()
                    .unwrap()
                    .get(room_id)
                    .copied()
                    .unwrap_or(200);
                if let Some((started, release)) = self.room_check_gate.lock().unwrap().take() {
                    let _ = started.send(());
                    release
                        .recv_timeout(Duration::from_secs(2))
                        .map_err(|_| "测试校验未收到放行信号".to_string())?;
                }
                return Ok(GatewayTransportResponse {
                    status,
                    body: if status == 200 {
                        self.room_check_bodies
                            .lock()
                            .unwrap()
                            .get(room_id)
                            .cloned()
                            .unwrap_or_else(|| json!({"data":{"room":{"roomId":room_id,"status":"active"},"members":[],"agents":[]}}).to_string().into_bytes())
                    } else {
                        json!({"error":{"code":"not_found"}})
                            .to_string()
                            .into_bytes()
                    },
                });
            }
        }
        if method == "GET" && path == "/api/chatrooms/v2/capabilities" {
            let ordinal = self.capability_request_count.fetch_add(1, Ordering::AcqRel) + 1;
            if let Some((started, release)) = self.capability_gates.lock().unwrap().remove(&ordinal)
            {
                let _ = started.send(());
                release
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "capabilities gate 未收到放行信号".to_string())?;
            }
        }
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
        let mut errors = self.request_errors.lock().unwrap();
        if !errors.is_empty() {
            return Err(errors.remove(0));
        }
        drop(errors);
        if method == "GET"
            && path.starts_with("/api/chatrooms/v2/rooms/")
            && path.contains("/invocations/")
            && path.contains("/status?")
        {
            if let Some(response) = self.invocation_status_response.lock().unwrap().take() {
                return Ok(response);
            }
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
    invocation_attempts: AtomicUsize,
    invocation_error: Mutex<Option<String>>,
    disconnects: Mutex<Vec<Vec<u8>>>,
    server_failures: Mutex<Vec<Vec<u8>>>,
    server_failure_attempts: AtomicUsize,
    fail_server_failures_before_success: AtomicUsize,
    server_failure_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl ChatroomBridge for FakeBridge {
    fn send_invocation(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        self.invocation_attempts.fetch_add(1, Ordering::AcqRel);
        if let Some(error) = self.invocation_error.lock().unwrap().take() {
            return Err(error);
        }
        self.invocations.lock().unwrap().push(body);
        Ok(())
    }
    fn send_disconnected(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        self.disconnects.lock().unwrap().push(body);
        Ok(())
    }
    fn send_server_failure(&self, body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
        if let Some((started, release)) = self.server_failure_gate.lock().unwrap().take() {
            let _ = started.send(());
            release
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "测试 handoff barrier timeout".to_string())?;
        }
        let attempt = self.server_failure_attempts.fetch_add(1, Ordering::AcqRel);
        if attempt
            < self
                .fail_server_failures_before_success
                .load(Ordering::Acquire)
        {
            return Err("测试 Main bridge 暂不可用".into());
        }
        self.server_failures.lock().unwrap().push(body);
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
    fn send_server_failure(&self, _body: Vec<u8>, _shutdown: &AtomicBool) -> Result<(), String> {
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

struct CapabilitySnapshotConnector {
    plans: Mutex<VecDeque<mpsc::Receiver<Result<ChatroomEvent, ChatroomClientError>>>>,
    connected: mpsc::Sender<usize>,
    connection_count: AtomicUsize,
    commands: mpsc::Sender<(usize, ChatroomCommand)>,
    next_read: mpsc::Sender<usize>,
}

impl ChatroomSocketConnector for CapabilitySnapshotConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        let generation = self.connection_count.fetch_add(1, Ordering::AcqRel) + 1;
        let frames = self
            .plans
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ChatroomClientError::new("test", "missing socket plan"))?;
        let _ = self.connected.send(generation);
        Ok(Box::new(CapabilitySnapshotSocket {
            generation,
            frames,
            commands: self.commands.clone(),
            next_read: self.next_read.clone(),
            first_read: true,
        }))
    }
}

struct CapabilitySnapshotSocket {
    generation: usize,
    frames: mpsc::Receiver<Result<ChatroomEvent, ChatroomClientError>>,
    commands: mpsc::Sender<(usize, ChatroomCommand)>,
    next_read: mpsc::Sender<usize>,
    first_read: bool,
}

enum ReadinessTestInput {
    Frame(Result<ChatroomSocketFrame, ChatroomClientError>),
    DisconnectBarrier {
        reached: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    },
}

struct ReadinessTestConnector {
    plans: Mutex<VecDeque<mpsc::Receiver<ReadinessTestInput>>>,
    commands: mpsc::Sender<(usize, ChatroomCommand)>,
    connected: mpsc::Sender<usize>,
    next_generation: AtomicUsize,
}

struct ReadinessTestSocket {
    generation: usize,
    frames: mpsc::Receiver<ReadinessTestInput>,
    commands: mpsc::Sender<(usize, ChatroomCommand)>,
}

impl ChatroomSocketConnector for ReadinessTestConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        let generation = self.next_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let frames = self
            .plans
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ChatroomClientError::new("test", "missing readiness socket plan"))?;
        let _ = self.connected.send(generation);
        Ok(Box::new(ReadinessTestSocket {
            generation,
            frames,
            commands: self.commands.clone(),
        }))
    }
}

impl ChatroomSocket for ReadinessTestSocket {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        self.commands
            .send((self.generation, command.clone()))
            .map_err(|_| ChatroomClientError::new("test", "readiness command receiver closed"))
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        match self.receive_frame()? {
            ChatroomSocketFrame::Event(event) => Ok(event),
            ChatroomSocketFrame::EventWithRawJsonBytes { event, .. } => Ok(event),
            ChatroomSocketFrame::PrivateAck(_) => Err(ChatroomClientError::new(
                "unexpected_ack",
                "ACK must be consumed by receive_frame",
            )),
        }
    }

    fn receive_frame(&mut self) -> Result<ChatroomSocketFrame, ChatroomClientError> {
        match self.frames.recv_timeout(Duration::from_millis(10)) {
            Ok(ReadinessTestInput::Frame(frame)) => frame,
            Ok(ReadinessTestInput::DisconnectBarrier { reached, release }) => {
                let _ = reached.send(());
                let _ = release.recv_timeout(Duration::from_secs(2));
                Err(ChatroomClientError::new(
                    "disconnected",
                    "readiness socket disconnected at test barrier",
                ))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ChatroomClientError::new(
                "read_timeout",
                "readiness socket idle",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ChatroomClientError::new(
                "closed",
                "readiness socket closed",
            )),
        }
    }

    fn close(&mut self) {}
}

fn readiness_gateway_with_two_sockets() -> (
    Arc<ChatroomGateway>,
    [mpsc::Sender<ReadinessTestInput>; 2],
    mpsc::Receiver<(usize, ChatroomCommand)>,
    mpsc::Receiver<usize>,
    super::chatroom_gateway::SseSubscription,
    Arc<FakeTransport>,
) {
    let (frames_a_tx, frames_a_rx) = mpsc::channel();
    let (frames_b_tx, frames_b_rx) = mpsc::channel();
    let (commands_tx, commands_rx) = mpsc::channel();
    let (connected_tx, connected_rx) = mpsc::channel();
    let connector = Arc::new(ReadinessTestConnector {
        plans: Mutex::new(VecDeque::from([frames_a_rx, frames_b_rx])),
        commands: commands_tx,
        connected: connected_tx,
        next_generation: AtomicUsize::new(0),
    });
    let edu = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(edu, Arc::new(AuthenticatedTestStorage)).unwrap());
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..8 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
    }
    let gateway = ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        connector,
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        transport.clone(),
        ChatroomProtocolOptions {
            agent_ready_v1: true,
            invocation_ack_v1: true,
            delta_frame_id_v1: false,
        },
    )
    .unwrap();
    gateway.start();
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    (
        gateway,
        [frames_a_tx, frames_b_tx],
        commands_rx,
        connected_rx,
        subscription,
        transport,
    )
}

fn await_readiness_snapshot(
    gateway: &ChatroomGateway,
    frames: &mpsc::Sender<ReadinessTestInput>,
    commands: &mpsc::Receiver<(usize, ChatroomCommand)>,
    generation: usize,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let (actual_generation, command) = commands
            .recv_timeout(Duration::from_secs(2))
            .expect("expected readiness socket command");
        if actual_generation == generation && matches!(command, ChatroomCommand::Subscribe { .. }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "subscribe was not sent on expected socket"
        );
    }
    frames
        .send(ReadinessTestInput::Frame(Ok(ChatroomSocketFrame::Event(
            ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 0,
                payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
            },
        ))))
        .unwrap();
    loop {
        let response = gateway
            .handle_http(
                "GET",
                "/api/internal/chatrooms/rooms/room-1/status",
                &HashMap::new(),
                &[],
            )
            .unwrap();
        let GatewayHttpResponse::Json { body, .. } = response else {
            panic!("room readiness status should be JSON");
        };
        if body["socketGeneration"] == generation
            && body["snapshotReady"] == true
            && body["capabilityState"] == "ready"
            && body["selectedCapabilities"][0] == "agent-ready-v1"
        {
            assert_eq!(body["selectedCapabilities"][0], "agent-ready-v1");
            return;
        }
        assert!(
            Instant::now() < deadline,
            "socket snapshot was not accepted"
        );
        thread::yield_now();
    }
}

impl ChatroomSocket for CapabilitySnapshotSocket {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        self.commands
            .send((self.generation, command.clone()))
            .map_err(|_| ChatroomClientError::new("test", "command observer closed"))
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        if !self.first_read {
            let _ = self.next_read.send(self.generation);
        }
        self.first_read = false;
        match self.frames.recv_timeout(Duration::from_millis(10)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ChatroomClientError::new(
                "read_timeout",
                "scripted socket idle",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(ChatroomClientError::new("closed", "scripted socket closed"))
            }
        }
    }

    fn close(&mut self) {}
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

struct AckingGatewayConnector {
    incoming: Arc<Mutex<mpsc::Receiver<ChatroomSocketFrame>>>,
    outgoing: mpsc::Sender<ChatroomCommand>,
    connected: mpsc::Sender<u64>,
    disconnect_generations: Arc<Mutex<HashSet<u64>>>,
    next_generation: AtomicUsize,
}

struct AckingGatewayControl {
    incoming: mpsc::Sender<ChatroomSocketFrame>,
    outgoing: Mutex<mpsc::Receiver<ChatroomCommand>>,
    connected: Mutex<mpsc::Receiver<u64>>,
    disconnect_generations: Arc<Mutex<HashSet<u64>>>,
}

impl AckingGatewayControl {
    fn receive_command(&self) -> Result<ChatroomCommand, mpsc::RecvTimeoutError> {
        self.outgoing
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(2))
    }

    fn try_receive_command(&self) -> Result<ChatroomCommand, mpsc::TryRecvError> {
        self.outgoing.lock().unwrap().try_recv()
    }

    fn disconnect_generation(&self, generation: u64) {
        self.disconnect_generations
            .lock()
            .unwrap()
            .insert(generation);
    }

    fn receive_connection(&self) -> Result<u64, mpsc::RecvTimeoutError> {
        self.connected
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(2))
    }
}

struct AckingGatewaySocket {
    incoming: Arc<Mutex<mpsc::Receiver<ChatroomSocketFrame>>>,
    outgoing: mpsc::Sender<ChatroomCommand>,
    generation: u64,
    disconnect_generations: Arc<Mutex<HashSet<u64>>>,
    closed: AtomicBool,
}

impl AckingGatewayConnector {
    fn new() -> (Arc<Self>, AckingGatewayControl) {
        let (incoming_tx, incoming_rx) = mpsc::channel();
        let (outgoing_tx, outgoing_rx) = mpsc::channel();
        let (connected_tx, connected_rx) = mpsc::channel();
        let disconnect_generations = Arc::new(Mutex::new(HashSet::new()));
        (
            Arc::new(Self {
                incoming: Arc::new(Mutex::new(incoming_rx)),
                outgoing: outgoing_tx,
                connected: connected_tx,
                disconnect_generations: disconnect_generations.clone(),
                next_generation: AtomicUsize::new(0),
            }),
            AckingGatewayControl {
                incoming: incoming_tx,
                outgoing: Mutex::new(outgoing_rx),
                connected: Mutex::new(connected_rx),
                disconnect_generations,
            },
        )
    }
}

impl ChatroomSocketConnector for AckingGatewayConnector {
    fn connect(
        &self,
        _url: &str,
        _authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        let generation = self.next_generation.fetch_add(1, Ordering::AcqRel) as u64 + 1;
        let _ = self.connected.send(generation);
        Ok(Box::new(AckingGatewaySocket {
            incoming: self.incoming.clone(),
            outgoing: self.outgoing.clone(),
            generation,
            disconnect_generations: self.disconnect_generations.clone(),
            closed: AtomicBool::new(false),
        }))
    }
}

impl ChatroomSocket for AckingGatewaySocket {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        self.outgoing
            .send(command.clone())
            .map_err(|_| ChatroomClientError::new("closed", "测试控制端已关闭"))
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        match self.receive_frame()? {
            ChatroomSocketFrame::Event(event) => Ok(event),
            ChatroomSocketFrame::EventWithRawJsonBytes { event, .. } => Ok(event),
            ChatroomSocketFrame::PrivateAck(_) => Err(ChatroomClientError::new(
                "unexpected_ack",
                "ACK 帧必须由 receive_frame 消费",
            )),
        }
    }

    fn receive_frame(&mut self) -> Result<ChatroomSocketFrame, ChatroomClientError> {
        if self
            .disconnect_generations
            .lock()
            .unwrap()
            .remove(&self.generation)
        {
            return Err(ChatroomClientError::new(
                "disconnected",
                "测试 socket generation 被显式断开",
            ));
        }
        match self
            .incoming
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_millis(20))
        {
            Ok(frame) => Ok(frame),
            Err(mpsc::RecvTimeoutError::Timeout) if !self.closed.load(Ordering::Acquire) => {
                Err(ChatroomClientError::new("read_timeout", "测试 socket 空闲"))
            }
            Err(_) => Err(ChatroomClientError::new("closed", "测试 socket 已关闭")),
        }
    }

    fn close(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
}

fn acking_gateway(transport: Arc<FakeTransport>) -> (Arc<ChatroomGateway>, AckingGatewayControl) {
    acking_gateway_with_bridge(transport, Arc::new(FakeBridge::default()))
}

fn acking_gateway_with_bridge(
    transport: Arc<FakeTransport>,
    bridge: Arc<FakeBridge>,
) -> (Arc<ChatroomGateway>, AckingGatewayControl) {
    acking_gateway_with_options(
        transport,
        bridge,
        ChatroomProtocolOptions {
            agent_ready_v1: true,
            invocation_ack_v1: true,
            delta_frame_id_v1: false,
        },
    )
}

fn acking_gateway_with_options(
    transport: Arc<FakeTransport>,
    bridge: Arc<FakeBridge>,
    protocol_options: ChatroomProtocolOptions,
) -> (Arc<ChatroomGateway>, AckingGatewayControl) {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let (connector, control) = AckingGatewayConnector::new();
    let gateway = ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        connector,
        bridge,
        "device-test".into(),
        transport,
        protocol_options,
    )
    .unwrap();
    gateway.start();
    (gateway, control)
}

fn wait_for_capability_selection(
    gateway: &ChatroomGateway,
    control: &AckingGatewayControl,
) -> super::chatroom_gateway::SseSubscription {
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.active_socket_generation_for_test() == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_ne!(gateway.active_socket_generation_for_test(), 0);
    let subscribe = control
        .receive_command()
        .expect("Gateway 应在能力探测后发送 Subscribe");
    assert!(matches!(
        subscribe,
        ChatroomCommand::Subscribe {
            capabilities: Some(_),
            ..
        }
    ));
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: serde_json::json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !gateway
        .capability_state()
        .selected
        .contains(&ChatroomCapability::InvocationAckV1)
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(gateway
        .capability_state()
        .selected
        .contains(&ChatroomCapability::InvocationAckV1));
    subscription
}

fn acking_gateway_transport() -> Arc<FakeTransport> {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
    }
    transport
}

fn legacy_status_gateway(
    transport: Arc<FakeTransport>,
) -> (
    Arc<ChatroomGateway>,
    AckingGatewayControl,
    super::chatroom_gateway::SseSubscription,
    Arc<FakeBridge>,
) {
    let bridge = Arc::new(FakeBridge::default());
    let (gateway, control) = acking_gateway_with_bridge(transport, bridge.clone());
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.active_socket_generation_for_test() == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert_ne!(gateway.active_socket_generation_for_test(), 0);
    assert!(matches!(
        control.receive_command().unwrap(),
        ChatroomCommand::Subscribe { .. }
    ));
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": [], "source":"socket-b"}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.capability_state().socket_generation == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert_ne!(gateway.capability_state().socket_generation, 0);
    assert!(gateway.capability_state().selected.is_empty());
    (gateway, control, subscription, bridge)
}

fn completed_status_request(digest: &str) -> Vec<u8> {
    json!({
        "roomId":"room-1",
        "invocationId":"inv-1",
        "deviceId":"device-test",
        "traceId":"trace-1",
        "targetAgentId":"agent-1",
        "triggerMessageId":"parent-1",
        "depth":1,
        "expectedStatus":"completed",
        "failureCode":"",
        "clientMessageId":"reply-1",
        "replyDigest":digest
    })
    .to_string()
    .into_bytes()
}

fn completed_status_event(
    room_id: &str,
    invocation_id: &str,
    client_message_id: &str,
    content: &str,
) -> ChatroomEvent {
    ChatroomEvent::AgentCompleted {
        room_id: room_id.into(),
        payload: json!({
            "invocationId":invocation_id,
            "content":content,
            "mentionAgentIds":[],
            "attachmentIds":[],
            "clientMessageId":client_message_id
        }),
    }
}

fn next_running_request(control: &AckingGatewayControl) -> String {
    loop {
        let command = control
            .receive_command()
            .expect("应收到 running lifecycle 命令");
        if let ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } = command
        {
            assert!(matches!(*command, ChatroomCommand::AgentRunning { .. }));
            return request_id;
        }
    }
}

fn next_accepted_request(control: &AckingGatewayControl) -> String {
    loop {
        let command = control
            .receive_command()
            .expect("应收到 accepted lifecycle 命令");
        if let ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } = command
        {
            assert!(matches!(*command, ChatroomCommand::AgentAccepted { .. }));
            return request_id;
        }
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
    gateway_with_options(transport, bridge, ChatroomProtocolOptions::default())
}

fn gateway_with_options(
    transport: Arc<FakeTransport>,
    bridge: Arc<FakeBridge>,
    protocol_options: ChatroomProtocolOptions,
) -> Arc<ChatroomGateway> {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        bridge,
        "device-test".into(),
        transport,
        protocol_options,
    )
    .unwrap()
}

fn management_gateway(transport: Arc<FakeTransport>) -> Arc<ChatroomGateway> {
    management_gateway_with_auth(transport).0
}

fn management_gateway_with_auth(
    transport: Arc<FakeTransport>,
) -> (Arc<ChatroomGateway>, Arc<AuthSession>) {
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let gateway = ChatroomGateway::new_with_transport_and_options(
        Arc::clone(&auth),
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "123e4567-e89b-42d3-a456-426614174000".into(),
        transport,
        ChatroomProtocolOptions::default(),
    )
    .unwrap();
    (gateway, auth)
}

fn unauthenticated_management_gateway(transport: Arc<FakeTransport>) -> Arc<ChatroomGateway> {
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
        "123e4567-e89b-42d3-a456-426614174000".into(),
        transport,
    )
    .unwrap()
}

fn management_receipt(action: &str, status: &str, room_agent_id: &str) -> Value {
    json!({
        "version": 1,
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "roomId": "room-1",
        "roomAgentId": room_agent_id,
        "ownerUserId": 1,
        "action": action,
        "status": status,
        "displayName": "测试助手",
        "memoryShared": false,
        "skillsShared": false
    })
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
    recording_gateway_with_transport(Arc::new(FakeTransport::default()))
}

fn recording_gateway_with_transport(
    transport: Arc<FakeTransport>,
) -> (
    Arc<ChatroomGateway>,
    Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    Arc<AtomicUsize>,
    Arc<AtomicBool>,
) {
    recording_gateway_with_options(transport, ChatroomProtocolOptions::default())
}

fn recording_gateway_with_options(
    transport: Arc<FakeTransport>,
    protocol_options: ChatroomProtocolOptions,
) -> (
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
    let gateway = ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(RecordingConnector {
            sent: sent.clone(),
            released: released.clone(),
            attempts: attempts.clone(),
        }),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        transport,
        protocol_options,
    )
    .unwrap();
    (gateway, sent, attempts, released)
}

#[test]
fn given_default_gateway_when_subscribing_then_keep_legacy_wire_and_skip_capability_get() {
    let transport = Arc::new(FakeTransport::default());
    let (gateway, sent, _, released) = recording_gateway_with_transport(transport.clone());
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.start();

    for _ in 0..200 {
        if !sent.lock().unwrap().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let subscribe = sent
        .lock()
        .unwrap()
        .iter()
        .find(|command| matches!(command, ChatroomCommand::Subscribe { .. }))
        .cloned()
        .expect("默认 Gateway 应发送旧格式 subscribe");
    assert!(matches!(
        subscribe,
        ChatroomCommand::Subscribe {
            capabilities: None,
            ..
        }
    ));
    assert!(!transport
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(_, path, _)| path == "/api/chatrooms/v2/capabilities"));
    released.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_formal_constructor_options_when_starting_then_default_off_and_opt_in_probe_the_real_path()
{
    for (name, options, expected_capabilities) in [
        ("default-off", ChatroomProtocolOptions::default(), None),
        (
            "explicit-opt-in",
            all_protocol_options(),
            Some(vec![
                ChatroomCapability::AgentReadyV1,
                ChatroomCapability::InvocationAckV1,
                ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        ),
    ] {
        let edu_transport = Arc::new(StartupProtocolEduTransport {
            requests: Mutex::new(Vec::new()),
        });
        let edu = Arc::new(
            EduApiClient::new(
                "https://test.invalid/module/edu-api",
                edu_transport.clone(),
                4,
            )
            .unwrap(),
        );
        let auth = Arc::new(AuthSession::new(edu, Arc::new(AuthenticatedTestStorage)).unwrap());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let released = Arc::new(AtomicBool::new(false));
        let attempts = Arc::new(AtomicUsize::new(0));
        let gateway = ChatroomGateway::new(
            auth,
            "https://test.invalid/module/edu-api".into(),
            Arc::new(RecordingConnector {
                sent: sent.clone(),
                released: released.clone(),
                attempts: attempts.clone(),
            }),
            Arc::new(FakeBridge::default()),
            "device-test".into(),
            options,
        )
        .unwrap();
        gateway.start();
        let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        let subscribe = loop {
            if let Some(command) = sent
                .lock()
                .unwrap()
                .iter()
                .find(|command| matches!(command, ChatroomCommand::Subscribe { .. }))
                .cloned()
            {
                break command;
            }
            assert!(Instant::now() < deadline, "{name}: subscribe was not sent");
            thread::sleep(Duration::from_millis(2));
        };
        let ChatroomCommand::Subscribe { capabilities, .. } = subscribe else {
            unreachable!();
        };
        assert_eq!(capabilities, expected_capabilities, "{name}");
        let probed = edu_transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "/api/chatrooms/v2/capabilities");
        assert_eq!(probed, expected_capabilities.is_some(), "{name}");
        released.store(true, Ordering::Release);
        gateway.shutdown();
    }
}

#[test]
fn given_delta_only_current_socket_selection_when_snapshot_arrives_then_remain_receive_only() {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1","agent-delta-frame-id-v1"]}"#.to_vec(),
        });
    }
    let (gateway, control) = acking_gateway_with_options(
        transport,
        Arc::new(FakeBridge::default()),
        ChatroomProtocolOptions {
            agent_ready_v1: false,
            invocation_ack_v1: false,
            delta_frame_id_v1: true,
        },
    );
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let subscribe = control.receive_command().unwrap();
    assert!(matches!(
        subscribe,
        ChatroomCommand::Subscribe {
            capabilities: Some(capabilities),
            ..
        } if capabilities == vec![ChatroomCapability::AgentDeltaFrameIdV1]
    ));
    let generation = gateway.active_socket_generation_for_test();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-delta-frame-id-v1"]}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.capability_state().selected != vec![ChatroomCapability::AgentDeltaFrameIdV1]
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(2));
    }
    let state = gateway.capability_state();
    assert_eq!(state.socket_generation, generation);
    assert_eq!(
        state.selected,
        vec![ChatroomCapability::AgentDeltaFrameIdV1]
    );

    let status = gateway
        .handle_http(
            "GET",
            "/api/internal/chatrooms/rooms/room-1/status",
            &HashMap::new(),
            b"",
        )
        .unwrap();
    let GatewayHttpResponse::Json { body, .. } = status else {
        panic!("typed room status expected");
    };
    assert_eq!(body["mode"], "legacy");
    assert_eq!(
        body["selectedCapabilities"],
        json!(["agent-delta-frame-id-v1"])
    );

    while control.try_receive_command().is_ok() {}
    let readiness = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            b"{}",
        )
        .unwrap();
    let GatewayHttpResponse::Json { body, .. } = readiness else {
        panic!("typed legacy readiness diagnostic expected");
    };
    assert_eq!(body["outcome"], "Unknown");
    assert_eq!(body["mode"], "legacy");
    assert!(matches!(
        control.try_receive_command(),
        Err(mpsc::TryRecvError::Empty)
    ));
    gateway.shutdown();
}

#[test]
fn given_opt_in_gateway_when_authenticated_probe_succeeds_then_subscribe_only_advertised_known_capabilities(
) {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","future-v9","invocation-ack-v1","agent-delta-frame-id-v1"]}"#.to_vec(),
        });
    }
    let (gateway, sent, _, released) =
        recording_gateway_with_options(transport.clone(), all_protocol_options());
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.start();

    for _ in 0..200 {
        if sent.lock().unwrap().iter().any(|command| {
            matches!(
                command,
                ChatroomCommand::Subscribe {
                    capabilities: Some(_),
                    ..
                }
            )
        }) {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let subscribe = sent
        .lock()
        .unwrap()
        .iter()
        .find(|command| matches!(command, ChatroomCommand::Subscribe { .. }))
        .cloned()
        .expect("认证能力探测成功后应订阅");
    assert!(matches!(
        subscribe,
        ChatroomCommand::Subscribe {
            capabilities: Some(capabilities),
            ..
        } if capabilities == vec![
            ChatroomCapability::AgentReadyV1,
            ChatroomCapability::InvocationAckV1,
            ChatroomCapability::AgentDeltaFrameIdV1,
        ]
    ));
    assert!(transport
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, path, body)| method == "GET"
            && path == "/api/chatrooms/v2/capabilities"
            && body.is_none()));
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    released.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_opt_in_gateway_when_capability_probe_is_unauthorized_then_do_not_downgrade_to_legacy_subscribe(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 401,
        body: b"{}".to_vec(),
    });
    let (gateway, sent, _, released) =
        recording_gateway_with_options(transport, all_protocol_options());
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.start();
    thread::sleep(Duration::from_millis(40));
    assert!(!sent
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, ChatroomCommand::Subscribe { .. })));
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    released.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_legacy_gateway_when_capability_endpoint_returns_404_then_use_old_subscribe_frame() {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 404,
            body: b"{}".to_vec(),
        });
    }
    let (gateway, sent, _, released) =
        recording_gateway_with_options(transport.clone(), all_protocol_options());
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.start();

    for _ in 0..200 {
        if sent
            .lock()
            .unwrap()
            .iter()
            .any(|command| matches!(command, ChatroomCommand::Subscribe { .. }))
        {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert!(sent.lock().unwrap().iter().any(|command| matches!(
        command,
        ChatroomCommand::Subscribe {
            capabilities: None,
            ..
        }
    )));
    assert!(transport
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(_, path, _)| path == "/api/chatrooms/v2/capabilities"));
    released.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_opt_in_gateway_when_capabilities_probe_fails_or_is_malformed_then_never_downgrade() {
    let cases = [
        (Some(403), Some(b"{}".to_vec()), None),
        (Some(503), Some(b"{}".to_vec()), None),
        (
            Some(200),
            Some(br#"{"capabilities":["agent-ready-v1"]"#.to_vec()),
            None,
        ),
        (Some(200), Some(vec![b' '; 4097]), None),
        (None, None, Some("network unavailable")),
    ];
    for (status, body, error) in cases {
        let transport = Arc::new(FakeTransport::default());
        if let Some(error) = error {
            transport.push_error(error);
        } else {
            transport.push(GatewayTransportResponse {
                status: status.unwrap(),
                body: body.unwrap(),
            });
        }
        let (gateway, sent, _, released) =
            recording_gateway_with_options(transport, all_protocol_options());
        let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
        gateway.start();
        assert!(!sent
            .lock()
            .unwrap()
            .iter()
            .any(|command| matches!(command, ChatroomCommand::Subscribe { .. })));
        assert_eq!(
            gateway.capability_state().selected,
            Vec::<ChatroomCapability>::new()
        );
        released.store(true, Ordering::Release);
        gateway.shutdown();
    }
}

#[test]
fn given_gateway_reconnects_when_capability_state_requires_fresh_http_and_current_socket_snapshot()
{
    let transport = Arc::new(FakeTransport::default());
    for capabilities in [
        br#"{"capabilities":["agent-ready-v1"]}"#.to_vec(),
        br#"{"capabilities":["agent-ready-v1"]}"#.to_vec(),
        br#"{"capabilities":["invocation-ack-v1"]}"#.to_vec(),
        br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
    ] {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: capabilities,
        });
    }
    let (initial_probe_started, release_initial_probe) = transport.gate_capability_request(1);
    let (socket_a_probe_started, release_socket_a_probe) = transport.gate_capability_request(2);
    let (socket_b_probe_started, release_socket_b_probe) = transport.gate_capability_request(3);
    let (socket_c_probe_started, release_socket_c_probe) = transport.gate_capability_request(4);

    let (frames_a, frames_a_rx) = mpsc::channel();
    let (frames_b, frames_b_rx) = mpsc::channel();
    let (frames_c, frames_c_rx) = mpsc::channel();
    let (connected_tx, connected_rx) = mpsc::channel();
    let (commands_tx, commands_rx) = mpsc::channel();
    let (next_read_tx, next_read_rx) = mpsc::channel();
    let connector = Arc::new(CapabilitySnapshotConnector {
        plans: Mutex::new(VecDeque::from([frames_a_rx, frames_b_rx, frames_c_rx])),
        connected: connected_tx,
        connection_count: AtomicUsize::new(0),
        commands: commands_tx,
        next_read: next_read_tx,
    });
    let client = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NoopEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
    let gateway = ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        connector,
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        transport.clone(),
        all_protocol_options(),
    )
    .unwrap();
    let _sse = gateway
        .subscribe_sse(vec!["room-1".into(), "room-2".into()])
        .unwrap();
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );

    let starting_gateway = gateway.clone();
    let start_worker = thread::spawn(move || starting_gateway.start());
    initial_probe_started
        .recv_timeout(Duration::from_secs(2))
        .expect("首个认证 GET 未进入 barrier");
    assert!(matches!(
        commands_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert!(matches!(
        connected_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_initial_probe.send(()).unwrap();
    start_worker.join().unwrap();
    let socket_a = connected_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("socket A 未连接");
    assert_eq!(socket_a, 1);
    assert!(matches!(
        commands_rx.recv_timeout(Duration::from_secs(2)),
        Ok((1, ChatroomCommand::Subscribe { capabilities: Some(caps), .. }))
            if caps == vec![ChatroomCapability::AgentReadyV1]
    ));
    socket_a_probe_started
        .recv_timeout(Duration::from_secs(2))
        .expect("socket A 的代际探测未进入 barrier");

    frames_a
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        1,
        "socket A snapshot 应先被 client 消费"
    );
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    frames_a
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        1,
        "socket A 第二个房间 snapshot 应先被 client 消费"
    );
    frames_a
        .send(Err(ChatroomClientError::new("closed", "force A reconnect")))
        .unwrap();
    let socket_b = connected_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("socket B 未自动重连");
    assert_eq!(socket_b, 2);
    assert!(matches!(
        commands_rx.recv_timeout(Duration::from_secs(2)),
        Ok((2, ChatroomCommand::Subscribe { capabilities: Some(caps), .. }))
            if caps == vec![ChatroomCapability::AgentReadyV1]
    ));
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    frames_b
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        2,
        "socket B snapshot 应先被 client 消费"
    );
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    frames_b
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        2,
        "socket B 第二个房间 snapshot 应先被 client 消费"
    );

    release_socket_a_probe.send(()).unwrap();
    socket_b_probe_started
        .recv_timeout(Duration::from_secs(3))
        .expect("socket B 的新认证探测未启动");
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    release_socket_b_probe.send(()).unwrap();
    let socket_c = connected_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("B 新广告能力应触发一次新订阅连接");
    assert_eq!(socket_c, 3);
    let b_update = commands_rx.recv_timeout(Duration::from_secs(3));
    assert!(
        matches!(
            &b_update,
            Ok((3, ChatroomCommand::Subscribe { capabilities: Some(caps), .. }))
                if caps == &vec![ChatroomCapability::InvocationAckV1]
        ),
        "C resubscribe frame: {b_update:?}; state={:?}; gets={}; commands={:?}",
        gateway.capability_state(),
        transport.capability_request_count.load(Ordering::Acquire),
        commands_rx.try_iter().collect::<Vec<_>>()
    );
    socket_c_probe_started
        .recv_timeout(Duration::from_secs(2))
        .expect("socket C 应重新验证能力");
    frames_c
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        3,
        "socket C 的当前 snapshot 应被 client 消费"
    );
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    frames_c
        .send(Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    assert_eq!(
        next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        3,
        "socket C 第二个房间 snapshot 应先被 client 消费"
    );
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    release_socket_c_probe.send(()).unwrap();
    for _ in 0..10_000 {
        if gateway.capability_state().selected == vec![ChatroomCapability::InvocationAckV1] {
            break;
        }
        thread::yield_now();
    }
    let state = gateway.capability_state();
    assert!(state.socket_generation > 0);
    assert_eq!(state.selected, vec![ChatroomCapability::InvocationAckV1]);
    assert_eq!(
        transport.capability_request_count.load(Ordering::Acquire),
        4,
        "能力重探测不应因等价 Subscribe 无限循环"
    );
    assert!(matches!(
        connected_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert!(matches!(
        commands_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    gateway.shutdown_connection();
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    let _ = frames_c.send(Err(ChatroomClientError::new("closed", "test teardown")));
    gateway.shutdown();
}

#[test]
fn given_logout_while_capabilities_get_is_delayed_when_response_returns_then_do_not_subscribe() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"capabilities":["agent-ready-v1"]}"#.to_vec(),
    });
    let (probe_started, release_probe) = transport.gate_capability_request(1);
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
    let attempts = Arc::new(AtomicUsize::new(0));
    let gateway = ChatroomGateway::new_with_transport_and_options(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(RecordingConnector {
            sent: sent.clone(),
            released: Arc::new(AtomicBool::new(false)),
            attempts: attempts.clone(),
        }),
        Arc::new(FakeBridge::default()),
        "device-test".into(),
        transport,
        all_protocol_options(),
    )
    .unwrap();
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let start_gateway = gateway.clone();
    let starter = thread::spawn(move || start_gateway.start());
    probe_started
        .recv_timeout(Duration::from_secs(2))
        .expect("capability GET 未进入 barrier");
    gateway.shutdown_connection();
    release_probe.send(()).unwrap();
    starter.join().unwrap();
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(attempts.load(Ordering::Acquire), 0);
    gateway.shutdown();
}

#[test]
fn given_late_sse_capability_get_is_gated_when_logout_runs_then_logout_finishes_before_get_release()
{
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"capabilities":["agent-ready-v1"]}"#.to_vec(),
    });
    let (probe_started, release_probe) = transport.gate_capability_request(1);
    let (gateway, sent, _, released_socket) =
        recording_gateway_with_options(transport.clone(), all_protocol_options());
    gateway.start();

    let subscribing_gateway = gateway.clone();
    let subscribe = thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    probe_started
        .recv_timeout(Duration::from_secs(2))
        .expect("late SSE capability GET did not reach gate");

    let (logout_done_tx, logout_done_rx) = mpsc::channel();
    let logout_gateway = gateway.clone();
    let logout = thread::spawn(move || {
        logout_gateway.shutdown_connection();
        let _ = logout_done_tx.send(());
    });
    let logout_before_release = logout_done_rx.recv_timeout(Duration::from_secs(1));

    release_probe.send(()).unwrap();
    let subscription_result = subscribe.join().unwrap();
    logout.join().unwrap();
    assert!(
        logout_before_release.is_ok(),
        "logout must complete while the remote capability GET is still gated"
    );
    assert!(subscription_result.is_ok());
    assert!(
        sent.lock().unwrap().is_empty(),
        "late GET must not enqueue Subscribe"
    );
    assert_eq!(
        gateway.capability_state().selected,
        Vec::<ChatroomCapability>::new()
    );
    released_socket.store(true, Ordering::Release);
    gateway.shutdown();
}

#[test]
fn given_reconnected_gateway_when_current_probe_is_401_or_404_then_fail_closed_or_use_legacy_frame()
{
    for status in [401, 404] {
        let transport = Arc::new(FakeTransport::default());
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
        transport.push(GatewayTransportResponse {
            status,
            body: b"{}".to_vec(),
        });
        if status == 404 {
            transport.push(GatewayTransportResponse {
                status: 404,
                body: b"{}".to_vec(),
            });
        }
        let (a_probe_started, release_a_probe) = transport.gate_capability_request(2);
        let (b_probe_started, release_b_probe) = transport.gate_capability_request(3);
        let (frames_a, frames_a_rx) = mpsc::channel();
        let (frames_b, frames_b_rx) = mpsc::channel();
        let (_frames_c, frames_c_rx) = mpsc::channel();
        let (connected_tx, connected_rx) = mpsc::channel();
        let (commands_tx, commands_rx) = mpsc::channel();
        let (next_read_tx, next_read_rx) = mpsc::channel();
        let connector = Arc::new(CapabilitySnapshotConnector {
            plans: Mutex::new(VecDeque::from([frames_a_rx, frames_b_rx, frames_c_rx])),
            connected: connected_tx,
            connection_count: AtomicUsize::new(0),
            commands: commands_tx,
            next_read: next_read_tx,
        });
        let client = Arc::new(
            EduApiClient::new(
                "https://test.invalid/module/edu-api",
                Arc::new(NoopEduTransport),
                4,
            )
            .unwrap(),
        );
        let auth = Arc::new(AuthSession::new(client, Arc::new(AuthenticatedTestStorage)).unwrap());
        let gateway = ChatroomGateway::new_with_transport_and_options(
            auth,
            "https://test.invalid/module/edu-api".into(),
            connector,
            Arc::new(FakeBridge::default()),
            "device-test".into(),
            transport,
            all_protocol_options(),
        )
        .unwrap();
        let _sse = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
        let start_gateway = gateway.clone();
        let starter = thread::spawn(move || start_gateway.start());
        let _ = connected_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            commands_rx.recv_timeout(Duration::from_secs(2)),
            Ok((
                1,
                ChatroomCommand::Subscribe {
                    capabilities: Some(_),
                    ..
                }
            ))
        ));
        a_probe_started
            .recv_timeout(Duration::from_secs(2))
            .expect("socket A current capability GET did not start");
        release_a_probe.send(()).unwrap();
        starter.join().unwrap();
        frames_a
            .send(Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 0,
                payload: json!({"capabilities":["agent-ready-v1"]}),
            }))
            .unwrap();
        assert_eq!(
            next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            1
        );
        frames_a
            .send(Err(ChatroomClientError::new("closed", "reconnect")))
            .unwrap();
        assert_eq!(
            connected_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            2
        );
        assert!(matches!(
            commands_rx.recv_timeout(Duration::from_secs(2)),
            Ok((
                2,
                ChatroomCommand::Subscribe {
                    capabilities: Some(_),
                    ..
                }
            ))
        ));
        frames_b
            .send(Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 0,
                payload: json!({"capabilities":["agent-ready-v1"]}),
            }))
            .unwrap();
        assert_eq!(
            next_read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            2
        );
        b_probe_started
            .recv_timeout(Duration::from_secs(3))
            .expect("socket B current capability GET did not start");
        assert_eq!(
            gateway.capability_state().selected,
            Vec::<ChatroomCapability>::new()
        );
        release_b_probe.send(()).unwrap();
        if status == 404 {
            assert_eq!(
                connected_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                3
            );
            assert!(matches!(
                commands_rx.recv_timeout(Duration::from_secs(2)),
                Ok((
                    3,
                    ChatroomCommand::Subscribe {
                        capabilities: None,
                        ..
                    }
                ))
            ));
        } else {
            assert!(matches!(
                connected_rx.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            assert_eq!(
                gateway.capability_state().selected,
                Vec::<ChatroomCapability>::new()
            );
        }
        gateway.shutdown_connection();
        gateway.shutdown();
    }
}

fn saturated_gateway(
    bridge: Arc<SaturatingBridge>,
) -> (
    Arc<ChatroomGateway>,
    Arc<Mutex<Vec<super::chatroom_protocol::ChatroomCommand>>>,
    Arc<AtomicBool>,
) {
    saturated_gateway_with_transport(bridge, Arc::new(FakeTransport::default()))
}

fn saturated_gateway_with_transport(
    bridge: Arc<SaturatingBridge>,
    transport: Arc<FakeTransport>,
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
        transport,
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
fn given_full_task_queue_when_room_is_revoked_then_prune_retries_after_capacity_returns() {
    let (bridge, started) = SaturatingBridge::new();
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("stale-room", 404);
    let (gateway, _, released) = saturated_gateway_with_transport(bridge.clone(), transport);
    gateway.set_room_cursor_for_test("stale-room", 2);
    gateway.start();
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    for index in 0..4 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-block-{index}")));
    }
    for _ in 0..4 {
        started
            .recv_timeout(Duration::from_millis(500))
            .expect("未阻塞全部 worker");
    }
    for index in 0..64 {
        gateway.publish_event_for_test(invocation("room-1", &format!("inv-queued-{index}")));
    }
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Status {
        code: "not_found".into(),
        message: "聊天室不存在".into(),
    });
    bridge.release();
    let until = Instant::now() + Duration::from_secs(2);
    while gateway.room_cursor_for_test("stale-room").is_some() && Instant::now() < until {
        thread::yield_now();
    }
    let removed = gateway.room_cursor_for_test("stale-room").is_none();
    released.store(true, Ordering::Release);
    gateway.shutdown();
    assert!(removed, "队列满时不可永久丢失旧房间核对任务");
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
fn given_selected_delta_frame_capability_when_sse_receives_delta_then_preserve_valid_frame_id() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.set_current_socket_generations_for_test(10, 20);
    gateway.set_capabilities_for_test(20, vec![ChatroomCapability::AgentDeltaFrameIdV1]);
    gateway.handle_socket_event_for_test(
        10,
        20,
        ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "part",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        },
    );

    let event = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .expect("当前 socket 已选择新能力时应保留公开 frameId");
    assert_eq!(event["type"], "agent.delta");
    assert_eq!(
        event["payload"]["frameId"],
        "0123456789abcdef0123456789abcdef"
    );
    assert_eq!(event["payload"].as_object().unwrap().len(), 3);
}

#[test]
fn given_unselected_delta_frame_capability_when_delta_has_id_then_drop_it_but_keep_legacy_delta() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    gateway.set_current_socket_generations_for_test(10, 20);
    gateway.set_capabilities_for_test(20, Vec::new());
    gateway.handle_socket_event_for_test(
        10,
        20,
        ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "new-shape",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        },
    );
    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(20))
        .is_err());

    gateway.handle_socket_event_for_test(
        10,
        20,
        ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","delta":"legacy"}),
        },
    );
    let event = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .expect("旧格式 delta 仍按原路径发布");
    assert_eq!(event["payload"]["delta"], "legacy");
    assert!(event["payload"]["frameId"].is_null());
}

#[test]
fn given_room_sse_subscription_when_recovery_marker_arrives_then_forward_only_to_matching_room() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let event = crate::chatroom_protocol::parse_event(
        br#"{"type":"room.recovery_ready","roomId":"room-2","payload":{}}"#,
    )
    .expect("recovery marker should parse");
    gateway.publish_event_for_test(event);
    assert!(subscription
        .receiver
        .recv_timeout(Duration::from_millis(20))
        .is_err());

    let event = crate::chatroom_protocol::parse_event(
        br#"{"type":"room.recovery_ready","roomId":"room-1","payload":{}}"#,
    )
    .expect("recovery marker should parse");
    gateway.publish_event_for_test(event);
    let forwarded = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(forwarded["type"], "room.recovery_ready");
    assert_eq!(forwarded["roomId"], "room-1");
    assert!(forwarded.get("seq").is_none());
}

#[test]
fn given_terminal_invocations_query_when_valid_get_then_proxy_normalized_allowlisted_query() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"invocations":[],"nextCursor":null}"#.to_vec(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));

    let response = gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?limit=25&after=inv-9",
            &HashMap::new(),
            &[],
        )
        .unwrap();

    assert!(matches!(
        response,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    assert_eq!(
        transport.requests.lock().unwrap()[0].1,
        "/api/chatrooms/v2/rooms/room-1/invocations/terminal?after=inv-9&limit=25"
    );
}

#[test]
fn given_terminal_invocations_query_with_invalid_method_route_or_query_then_reject_without_proxying(
) {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));

    for (method, path) in [
        (
            "POST",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal-extra",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?url=https://evil.test",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?limit=101",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?after=inv-1&after=inv-2",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?after=../other",
        ),
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/terminal?limit=1&extra=1",
        ),
    ] {
        assert!(
            gateway
                .handle_http(method, path, &HashMap::new(), &[])
                .is_err(),
            "accepted {method} {path}"
        );
    }
    assert!(gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room%2Fother/invocations/terminal",
            &HashMap::new(),
            &[],
        )
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_invocation_metadata_when_member_gets_exact_route_then_proxy_and_validate_public_dto() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocation":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":1,"status":"accepted"}}}"#.to_vec(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));

    let response = gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata",
            &HashMap::new(),
            &[],
        )
        .unwrap();

    match response {
        GatewayHttpResponse::Json { status, body } => {
            assert_eq!(status, 200);
            assert_eq!(body["data"]["invocation"]["invocationId"], "inv-1");
            assert!(body["data"].get("replyDigest").is_none());
        }
        _ => panic!("metadata response had an unexpected shape"),
    }
    assert_eq!(
        transport.requests.lock().unwrap()[0].1,
        "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata"
    );
}

#[test]
fn given_invocation_metadata_when_route_or_upstream_contract_is_invalid_then_reject_without_fallback(
) {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));

    for (method, path, body) in [
        (
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata?deviceId=x",
            &[][..],
        ),
        (
            "POST",
            "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata",
            &br#"{}"#[..],
        ),
    ] {
        assert!(gateway
            .handle_http(method, path, &HashMap::new(), body)
            .is_err());
    }
    assert!(transport.requests.lock().unwrap().is_empty());

    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocation":{"invocationId":"inv-other","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":1,"status":"accepted"}}}"#.to_vec(),
    });
    let mismatch = gateway.handle_http(
        "GET",
        "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata",
        &HashMap::new(),
        &[],
    );
    let mismatch = match mismatch {
        Err(error) => error,
        Ok(_) => panic!("mismatched invocation metadata was accepted"),
    };
    assert_eq!(mismatch.status, 502);

    for body in [
        br#"{"data":{"invocation":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":1,"status":"accepted","executorSessionKey":"private"}}}"#.as_slice(),
        br#"{"data":{"invocation":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":"1","status":"accepted"}}}"#.as_slice(),
        br#"{"data":{"invocation":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":1,"status":"unknown"}}}"#.as_slice(),
        br#"{"data":{"invocation":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"message-1","depth":1,"status":"completed","finishedAt":"not-a-timestamp"}}}"#.as_slice(),
    ] {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: body.to_vec(),
        });
        let rejected = gateway.handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/metadata",
            &HashMap::new(),
            &[],
        );
        match rejected {
            Err(error) => assert_eq!(error.status, 502),
            Ok(_) => panic!("invalid upstream invocation metadata was accepted"),
        }
    }

    transport.push(GatewayTransportResponse {
        status: 404,
        body: br#"{"error":"not found","code":"not_found"}"#.to_vec(),
    });
    let not_found = gateway
        .handle_http(
            "GET",
            "/api/chatrooms/v2/rooms/room-1/invocations/missing/metadata",
            &HashMap::new(),
            &[],
        )
        .unwrap();
    assert!(matches!(
        not_found,
        GatewayHttpResponse::Json { status: 404, .. }
    ));
    assert_eq!(transport.requests.lock().unwrap().len(), 6);
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
    assert!(matches!(result, Err(error) if error.code == "lifecycle_unknown"));
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
fn given_missing_room_when_sse_subscribes_then_report_it_without_poisoning_valid_rooms() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("missing-room", 404);
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let missing = gateway.subscribe_sse(vec!["missing-room".into()]).unwrap();
    let rejected = missing
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(rejected["type"], "local.status");
    assert_eq!(rejected["roomId"], "missing-room");
    assert_eq!(rejected["code"], "room_not_found");
    assert_eq!(gateway.room_cursor_for_test("missing-room"), None);
    drop(missing);

    let valid = gateway.subscribe_sse(vec!["valid-room".into()]);
    assert!(valid.is_ok());
    assert_eq!(gateway.subscriber_count_for_test(), 1);
}

#[test]
fn given_cached_offline_snapshot_when_sse_precheck_returns_fresh_online_detail_then_send_fresh_agent_projection(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({
            "data": {
                "room": {"roomId": "room-1", "status": "active"},
                "members": [],
                "agents": [{
                    "roomAgentId": "agent-1",
                    "displayName": "Grok",
                    "status": "online",
                    "availability": "online",
                    "memoryShared": true,
                    "skillsShared": false,
                    "localPath": "/Users/secret/project"
                }]
            }
        }),
    );
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({
            "room": {"roomId": "room-1", "status": "active"},
            "members": [],
            "agents": [{
                "roomAgentId": "agent-1",
                "displayName": "Grok",
                "status": "offline",
                "availability": "offline"
            }]
        }),
    });

    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["type"], "room.snapshot");
    assert_eq!(snapshot["latestSeq"], 8);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "online");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "online");
    assert_eq!(snapshot["payload"]["agents"][0]["memoryShared"], true);
    assert!(snapshot["payload"]["agents"][0].get("localPath").is_none());
}

#[test]
fn given_fresh_room_projection_when_agent_states_are_not_ready_then_preserve_authoritative_availability(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({
            "data": {
                "room": {"roomId": "room-1", "status": "active"},
                "members": [],
                "agents": [
                    {"roomAgentId":"agent-preparing","status":"online","availability":"preparing"},
                    {"roomAgentId":"agent-config","status":"offline","availability":"configuration_error"},
                    {"roomAgentId":"agent-disabled","status":"disabled","availability":"disabled"},
                    {"roomAgentId":"agent-offline","status":"offline","availability":"offline"}
                ]
            }
        }),
    );
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[]}),
    });

    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    let agents = snapshot["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents[0]["availability"], "preparing");
    assert_eq!(agents[1]["availability"], "configuration_error");
    assert_eq!(agents[2]["status"], "disabled");
    assert_eq!(agents[3]["status"], "offline");
}

#[test]
fn given_fresh_offline_detail_when_cache_is_online_then_sse_does_not_replay_stale_online_state() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"offline"}]}}),
    );
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}),
    });

    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "offline");
}

#[test]
fn given_unrelated_member_presence_during_room_detail_check_then_keep_fresh_agent_projection() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"offline"}]}),
    });

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::MemberPresenceChanged {
        room_id: "room-1".into(),
        payload: json!({"userId":"member-1","status":"online","online":true}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "online");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "online");
}

#[test]
fn given_plain_online_presence_for_modern_nonready_agent_then_do_not_upgrade_readiness() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"preparing"}]}),
    });

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentPresenceChanged {
        room_id: "room-1".into(),
        payload: json!({"roomAgentId":"agent-1","status":"online","online":true}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
    assert_eq!(
        snapshot["payload"]["agents"][0]["availability"],
        "preparing"
    );
}

fn snapshot_after_inflight_agent_presence(cached: &str, ws_status: &str) -> Value {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":cached,"availability":cached}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":cached,"availability":cached}]}),
    });

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentPresenceChanged {
        room_id: "room-1".into(),
        payload: json!({"roomAgentId":"agent-1","status":ws_status,"online":ws_status == "online"}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap()
}

#[test]
fn given_cached_and_http_online_then_newer_ws_offline_then_emit_offline_initial_snapshot() {
    let snapshot = snapshot_after_inflight_agent_presence("online", "offline");
    assert_eq!(snapshot["latestSeq"], 8);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "offline");
}

#[test]
fn given_cached_and_http_offline_then_newer_ws_online_then_emit_online_initial_snapshot() {
    let snapshot = snapshot_after_inflight_agent_presence("offline", "online");
    assert_eq!(snapshot["latestSeq"], 8);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "online");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "online");
}

fn snapshot_after_inflight_persistent_agent_event(
    cached_status: &str,
    http_status: &str,
    event: ChatroomEvent,
) -> Value {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","displayName":"HTTP","status":http_status,"availability":http_status}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","displayName":"Cached","status":cached_status,"availability":cached_status}]}),
    });
    gateway.set_room_cursor_for_test("room-1", 8);

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(event);
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap()
}

#[test]
fn given_http_online_then_contiguous_agent_offline_commits_during_detail_check_then_emit_offline_snapshot(
) {
    let snapshot = snapshot_after_inflight_persistent_agent_event(
        "online",
        "online",
        ChatroomEvent::AgentOffline {
            room_id: "room-1".into(),
            seq: 9,
            payload: json!({"roomAgentId":"agent-1","reason":"client_release"}),
        },
    );
    assert_eq!(snapshot["latestSeq"], 8);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
    assert_eq!(snapshot["payload"]["agents"][0]["availability"], "offline");
}

#[test]
fn given_http_offline_then_contiguous_agent_updated_online_commits_during_detail_check_then_keep_updated_projection(
) {
    let snapshot = snapshot_after_inflight_persistent_agent_event(
        "offline",
        "offline",
        ChatroomEvent::AgentUpdated {
            room_id: "room-1".into(),
            seq: 9,
            payload: json!({"roomAgentId":"agent-1","displayName":"Updated","status":"online","availability":"online"}),
        },
    );
    assert_eq!(snapshot["latestSeq"], 8);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "online");
    assert_eq!(snapshot["payload"]["agents"][0]["displayName"], "Updated");
}

#[test]
fn given_new_agent_updated_commits_during_detail_check_then_include_sanitized_agent_in_initial_snapshot(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-existing","displayName":"Existing","status":"online","availability":"online"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-existing","displayName":"Existing","status":"online","availability":"online"}]}),
    });
    gateway.set_room_cursor_for_test("room-1", 8);

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentUpdated {
        room_id: "room-1".into(),
        seq: 9,
        payload: json!({"roomAgentId":"agent-new","displayName":"New Agent","status":"online","availability":"online","localPath":"/private/agent","secret":"hidden"}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    let agents = snapshot["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    let added = agents
        .iter()
        .find(|agent| agent["roomAgentId"] == "agent-new")
        .unwrap();
    assert_eq!(added["displayName"], "New Agent");
    assert_eq!(added["status"], "online");
    assert!(added.get("localPath").is_none());
    assert!(added.get("secret").is_none());
}

#[test]
fn given_agent_updated_removed_true_commits_during_detail_check_then_remove_only_that_agent() {
    let transport = Arc::new(FakeTransport::default());
    let detail = json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-a","status":"online"},{"roomAgentId":"agent-b","status":"online"}]}});
    transport.set_room_check_body("room-1", detail);
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-a","status":"online"},{"roomAgentId":"agent-b","status":"online"}]}),
    });
    gateway.set_room_cursor_for_test("room-1", 8);

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentUpdated {
        room_id: "room-1".into(),
        seq: 9,
        payload: json!({"roomAgentId":"agent-a","removed":true}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    let agents = snapshot["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["roomAgentId"], "agent-b");
}

#[test]
fn given_contiguous_agent_busy_or_disabled_event_then_emit_its_authoritative_projection() {
    let cases = [
        (
            ChatroomEvent::AgentBusy {
                room_id: "room-1".into(),
                seq: 9,
                payload: json!({"roomAgentId":"agent-1","reason":"agent_busy"}),
            },
            "busy",
        ),
        (
            ChatroomEvent::AgentDisabled {
                room_id: "room-1".into(),
                seq: 9,
                payload: json!({"roomAgentId":"agent-1","reason":"agent_disabled"}),
            },
            "disabled",
        ),
    ];
    for (event, expected) in cases {
        let snapshot = snapshot_after_inflight_persistent_agent_event("online", "online", event);
        assert_eq!(snapshot["payload"]["agents"][0]["status"], expected);
        assert_eq!(snapshot["payload"]["agents"][0]["availability"], expected);
    }
}

#[test]
fn given_offline_event_for_unknown_agent_during_detail_check_then_do_not_create_agent() {
    let snapshot = snapshot_after_inflight_persistent_agent_event(
        "online",
        "online",
        ChatroomEvent::AgentOffline {
            room_id: "room-1".into(),
            seq: 9,
            payload: json!({"roomAgentId":"unknown-agent","reason":"client_release"}),
        },
    );
    let agents = snapshot["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["roomAgentId"], "agent-1");
}

#[test]
fn given_persistent_agent_updated_plain_online_for_preparing_agent_then_preserve_not_ready_state() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"preparing"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","displayName":"Cached","status":"offline","availability":"preparing"}]}),
    });
    gateway.set_room_cursor_for_test("room-1", 8);

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::AgentUpdated {
        room_id: "room-1".into(),
        seq: 9,
        payload: json!({"roomAgentId":"agent-1","displayName":"Updated","status":"online"}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
    assert_eq!(
        snapshot["payload"]["agents"][0]["availability"],
        "preparing"
    );
    assert_eq!(snapshot["payload"]["agents"][0]["displayName"], "Updated");
}

#[test]
fn given_out_of_order_agent_offline_event_is_buffered_then_do_not_change_current_projection() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}),
    });
    gateway.set_room_cursor_for_test("room-1", 8);

    gateway.publish_event_for_test(ChatroomEvent::AgentOffline {
        room_id: "room-1".into(),
        seq: 10,
        payload: json!({"roomAgentId":"agent-1","reason":"client_release"}),
    });

    let snapshot = gateway.room_snapshot_for_test("room-1").unwrap();
    assert_eq!(
        super::chatroom_protocol::public_event(&snapshot)["payload"]["agents"][0]["status"],
        "online"
    );
    assert_eq!(gateway.room_cursor_for_test("room-1"), Some(8));
    assert_eq!(gateway.buffered_count_for_test("room-1"), 1);
}

#[test]
fn given_new_ws_snapshot_during_room_detail_request_then_keep_its_cursor_and_agent_projection() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"offline"}]}),
    });

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 9,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"offline"}]}),
    });
    release_check.send(()).unwrap();

    let subscription = subscribing.join().unwrap().unwrap();
    let snapshot = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(snapshot["latestSeq"], 9);
    assert_eq!(snapshot["payload"]["agents"][0]["status"], "offline");
}

#[test]
fn given_auth_epoch_changes_during_room_detail_check_then_reject_subscription_without_injecting_snapshot(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_body(
        "room-1",
        json!({"data":{"room":{"roomId":"room-1","status":"active"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"online","availability":"online"}]}}),
    );
    let (check_started, release_check) = transport.gate_next_room_check();
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 8,
        payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[{"roomAgentId":"agent-1","status":"offline","availability":"offline"}]}),
    });

    let subscribing_gateway = gateway.clone();
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["room-1".into()]));
    check_started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.shutdown_connection();
    release_check.send(()).unwrap();

    assert!(matches!(subscribing.join().unwrap(), Err(error) if error.status == 401));
    assert_eq!(gateway.subscriber_count_for_test(), 0);
}

#[test]
fn given_valid_and_missing_rooms_when_sse_subscribes_then_keep_valid_room_live() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("missing-room", 404);
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let subscription = gateway
        .subscribe_sse(vec!["valid-room".into(), "missing-room".into()])
        .unwrap();
    let rejected = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(rejected["roomId"], "missing-room");
    assert_eq!(rejected["code"], "room_not_found");
    assert_eq!(gateway.room_cursor_for_test("valid-room"), Some(0));
    assert_eq!(gateway.room_cursor_for_test("missing-room"), None);
}

#[test]
fn given_stale_cached_room_when_sse_precheck_rejects_it_then_remove_old_gateway_state() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("stale-room", 404);
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("stale-room", 7);
    let subscription = gateway
        .subscribe_sse(vec!["valid-room".into(), "stale-room".into()])
        .unwrap();
    let rejected = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(rejected["code"], "room_not_found");
    assert_eq!(gateway.room_cursor_for_test("stale-room"), None);
    assert_eq!(gateway.room_cursor_for_test("valid-room"), Some(0));
}

#[test]
fn given_remote_not_found_when_stale_room_is_subscribed_then_keep_valid_room_only() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("stale-room", 404);
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("valid-room", 4);
    gateway.set_room_cursor_for_test("stale-room", 2);

    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::LocalStatus {
            room_id: None,
            code: "not_found".into(),
            message: "聊天室不存在".into(),
        },
    });
    assert_eq!(gateway.room_cursor_for_test("stale-room"), None);
    assert_eq!(gateway.room_cursor_for_test("valid-room"), Some(4));
}

#[test]
fn given_real_ws_error_when_stale_room_is_pruned_then_notify_its_sse_subscriber() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let subscription = gateway
        .subscribe_sse(vec!["valid-room".into(), "stale-room".into()])
        .unwrap();
    transport.set_room_check_status("stale-room", 404);
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::LocalStatus {
            room_id: None,
            code: "not_found".into(),
            message: "聊天室不存在".into(),
        },
    });
    let statuses = (0..3)
        .filter_map(|_| {
            subscription
                .receiver
                .recv_timeout(Duration::from_millis(50))
                .ok()
        })
        .collect::<Vec<_>>();
    assert!(statuses
        .iter()
        .any(|event| event["roomId"] == "stale-room" && event["code"] == "room_not_found"));
    assert_eq!(gateway.room_cursor_for_test("stale-room"), None);
}

#[test]
fn given_room_validation_waits_on_network_when_ws_error_arrives_then_event_loop_remains_responsive()
{
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("stale-room", 404);
    let (gateway, _, _, released) = recording_gateway_with_transport(transport.clone());
    gateway.set_room_cursor_for_test("stale-room", 2);
    gateway.start();
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (started, release) = transport.gate_next_room_check();
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::LocalStatus {
            room_id: None,
            code: "not_found".into(),
            message: "聊天室不存在".into(),
        },
    });
    let validation_started = started.recv_timeout(Duration::from_millis(500)).is_ok();
    let other_event_processed = if validation_started {
        let (done, observed) = mpsc::channel();
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move || {
            worker_gateway.handle_client_event_for_test(
                super::chatroom_client::ChatroomClientEvent::Disconnected,
            );
            let _ = done.send(());
        });
        let result = observed.recv_timeout(Duration::from_millis(100)).is_ok();
        let _ = release.send(());
        worker.join().unwrap();
        result
    } else {
        let _ = release.send(());
        false
    };
    released.store(true, Ordering::Release);
    gateway.shutdown();
    assert!(validation_started, "应在后台开始验证旧房间");
    assert!(other_event_processed, "远端请求不得阻塞实时事件处理");
}

#[test]
fn given_second_not_found_during_first_prune_then_recheck_after_first_finishes() {
    let transport = Arc::new(FakeTransport::default());
    let (gateway, _, _, released) = recording_gateway_with_transport(transport.clone());
    gateway.set_room_cursor_for_test("stale-room", 2);
    gateway.start();
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (started, release) = transport.gate_next_room_check();
    let error = || super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::LocalStatus {
            room_id: None,
            code: "not_found".into(),
            message: "聊天室不存在".into(),
        },
    };
    gateway.handle_client_event_for_test(error());
    started.recv_timeout(Duration::from_millis(500)).unwrap();
    transport.set_room_check_status("stale-room", 404);
    gateway.handle_client_event_for_test(error());
    release.send(()).unwrap();
    let until = Instant::now() + Duration::from_millis(500);
    while gateway.room_cursor_for_test("stale-room").is_some() && Instant::now() < until {
        thread::yield_now();
    }
    let removed = gateway.room_cursor_for_test("stale-room").is_none();
    released.store(true, Ordering::Release);
    gateway.shutdown();
    assert!(removed, "首轮校验结束后必须补查期间收到的失效状态");
}

#[test]
fn given_socket_already_connected_when_sse_attaches_then_initial_status_reports_remote_state() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let subscription = gateway.subscribe_sse(vec!["valid-room".into()]).unwrap();
    let status = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(status["type"], "local.status");
    assert_eq!(status["code"], "realtime_connected");
}

#[test]
fn given_room_snapshot_from_current_socket_when_main_checks_internal_status_then_only_live_room_is_ready(
) {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.set_room_cursor_for_test("room-1", 0);
    let status = || -> (bool, u64) {
        let result = gateway
            .handle_http(
                "GET",
                "/api/internal/chatrooms/rooms/room-1/status",
                &HashMap::new(),
                &[],
            )
            .unwrap();
        let GatewayHttpResponse::Json { status, body } = result else {
            panic!("应返回 JSON")
        };
        assert_eq!(status, 200);
        (
            body["ready"].as_bool().unwrap(),
            body["epoch"].as_u64().unwrap(),
        )
    };
    let snapshot = || super::chatroom_client::ChatroomClientEvent::EventAt {
        generation: 0,
        event: ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"room":{"roomId":"room-1"},"members":[],"agents":[]}),
        },
    };
    let (ready, initial_epoch) = status();
    assert!(!ready);
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (ready, connected_epoch) = status();
    assert!(!ready, "WebSocket 建连尚不代表房间订阅就绪");
    assert!(connected_epoch > initial_epoch);
    gateway.handle_client_event_for_test(snapshot());
    assert_eq!(status(), (true, connected_epoch));
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Disconnected);
    let (ready, disconnected_epoch) = status();
    assert!(!ready);
    assert!(disconnected_epoch > connected_epoch);
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (ready, reconnected_epoch) = status();
    assert!(!ready, "旧连接的 snapshot 不能证明新连接就绪");
    assert!(reconnected_epoch > disconnected_epoch);
    gateway.handle_client_event_for_test(snapshot());
    assert_eq!(status(), (true, reconnected_epoch));
}

#[test]
fn given_disconnect_during_sse_registration_then_new_subscriber_receives_final_disconnected_status()
{
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt { generation: 0 },
    );
    let (loaded, release) = gateway.gate_sse_status_snapshot_for_test();
    let subscribing_gateway = Arc::clone(&gateway);
    let subscribing =
        thread::spawn(move || subscribing_gateway.subscribe_sse(vec!["valid-room".into()]));
    loaded.recv_timeout(Duration::from_millis(500)).unwrap();
    let disconnected_gateway = Arc::clone(&gateway);
    let (started, started_receiver) = mpsc::channel();
    let disconnecting = thread::spawn(move || {
        let _ = started.send(());
        disconnected_gateway.handle_client_event_for_test(
            super::chatroom_client::ChatroomClientEvent::Disconnected,
        );
    });
    started_receiver
        .recv_timeout(Duration::from_millis(500))
        .unwrap();
    let _ = release.send(());
    let subscription = subscribing.join().unwrap().unwrap();
    disconnecting.join().unwrap();
    let first = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(first["code"], "realtime_connected");
    let last = subscription
        .receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    assert_eq!(last["code"], "realtime_disconnected");
}

#[test]
fn given_transient_room_lookup_failure_when_reconciling_then_preserve_subscription() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_room_check_status("valid-room", 502);
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    gateway.set_room_cursor_for_test("valid-room", 4);
    gateway.handle_client_event_for_test(super::chatroom_client::ChatroomClientEvent::Status {
        code: "not_found".into(),
        message: "聊天室不存在".into(),
    });
    assert_eq!(gateway.room_cursor_for_test("valid-room"), Some(4));
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
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(1, 1, ChatroomEvent::AgentInvocation {
        room_id: "room-1".into(),
        payload: json!({
            "invocationId":"inv-1", "traceId":"trace-1", "targetAgentId":"agent-1",
            "triggerMessageId":"msg-1", "depth":1,
            "sender":{"type":"user","id":"7","displayName":"用户#7"},
            "messages":[{"messageId":"msg-1","sender":{"type":"user","id":"7","displayName":"用户#7"},"text":"hello","createdAt":1000}],
            "receivedAt":2000
        }),
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let body = bridge.invocations.lock().unwrap().first().cloned().unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["invocation"]["roomId"], "room-1");
    assert_eq!(value["invocation"]["invocationId"], "inv-1");
    assert_eq!(value["invocation"]["depth"], 1);
    assert_eq!(value["invocation"]["sender"]["type"], "user");
    assert_eq!(value["invocation"]["messages"][0]["messageId"], "msg-1");
    assert_eq!(value["invocation"]["receivedAt"], 2000);
    assert_eq!(value["gatewayOrigin"]["clientGeneration"], 1);
    assert_eq!(value["gatewayOrigin"]["socketGeneration"], 1);
    assert!(value["invocation"].get("status").is_none());
    assert!(value["invocation"].get("accessToken").is_none());
}

#[test]
fn given_same_current_socket_invocation_replays_then_fake_main_bridge_dispatches_once() {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    let event = invocation("room-1", "lost-ack-replay");
    gateway.handle_socket_event_for_test(1, 1, event.clone());
    gateway.handle_socket_event_for_test(1, 1, event);

    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocation_attempts.load(Ordering::Acquire) < 1 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(bridge.invocation_attempts.load(Ordering::Acquire), 1);
    let bodies = bridge.invocations.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    let forwarded = bodies
        .iter()
        .map(|body| serde_json::from_slice::<Value>(body).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        forwarded[0]["invocation"]["invocationId"],
        "lost-ack-replay"
    );
    assert_eq!(forwarded[0]["gatewayOrigin"]["socketGeneration"], 1);
    drop(bodies);
    gateway.shutdown();
}

#[test]
fn given_main_rejects_legacy_flat_bridge_when_invocation_arrives_then_publish_fixed_pairing_diagnostic(
) {
    let bridge = Arc::new(FakeBridge::default());
    *bridge.invocation_error.lock().unwrap() =
        Some(super::chatroom_gateway::CHATROOM_NATIVE_RUNTIME_UNSUPPORTED.to_string());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_snapshot_ready_for_test("room-1");
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let _ = subscription.receiver.recv().unwrap();
    gateway.forward_invocation_now(
        &invocation("room-1", "pairing-invocation"),
        ChatroomOrigin {
            client_generation: 1,
            socket_generation: 1,
            auth_epoch: 0,
        },
    );
    let status = subscription
        .receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(bridge.invocation_attempts.load(Ordering::Acquire), 1);
    assert_eq!(status["type"], "local.status");
    assert_eq!(status["code"], "invocation_invalid");
    assert_eq!(
        status["message"],
        "当前本机 Rust 运行时不支持可信聊天室来源校验，请更新并重启 Copis",
    );
    assert!(bridge.invocations.lock().unwrap().is_empty());
    gateway.shutdown();
}

#[test]
fn given_queued_terminal_from_socket_a_when_socket_b_takes_over_then_old_failure_is_not_bridged() {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    let client_generation_a = 1;
    let socket_generation_a = 1;
    let (loaded, release) = gateway.gate_next_task_for_test();
    gateway.handle_socket_event_for_test(
        client_generation_a,
        socket_generation_a,
        ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: serde_json::json!({"invocationId":"inv-a","failureCode":"agent_offline"}),
        },
    );
    loaded
        .recv_timeout(Duration::from_secs(1))
        .expect("旧终态应到达 dequeue barrier");
    gateway
        .set_current_socket_generations_for_test(client_generation_a + 1, socket_generation_a + 1);
    release.send(()).unwrap();
    thread::sleep(Duration::from_millis(30));
    assert!(
        bridge.server_failures.lock().unwrap().is_empty(),
        "A 的迟到事件不得在 B 接管后送入 Main"
    );
    gateway.shutdown();
}

#[test]
fn given_current_socket_terminal_when_forwarded_then_bridge_receives_original_source_generations() {
    let bridge = Arc::new(FakeBridge::default());
    bridge
        .fail_server_failures_before_success
        .store(2, Ordering::Release);
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    let client_generation = 1;
    let socket_generation = 1;
    let (loaded, release) = gateway.gate_next_task_for_test();
    gateway.handle_socket_event_for_test(
        client_generation,
        socket_generation,
        ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: serde_json::json!({"invocationId":"inv-current","failureCode":"agent_offline"}),
        },
    );
    loaded
        .recv_timeout(Duration::from_secs(1))
        .expect("当前终态应到达 dequeue barrier");
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.server_failures.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let bodies = bridge.server_failures.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    let envelope: Value = serde_json::from_slice(&bodies[0]).unwrap();
    assert_eq!(envelope["invocationId"], "inv-current");
    assert_eq!(envelope["clientGeneration"], client_generation);
    assert_eq!(envelope["socketGeneration"], socket_generation);
    assert_eq!(envelope["authEpoch"], 0);
    assert_eq!(bridge.server_failure_attempts.load(Ordering::Acquire), 3);
    drop(bodies);
    gateway.shutdown();
}

#[test]
fn given_first_terminal_bridge_attempt_fails_after_socket_takeover_then_do_not_retry_old_a_origin()
{
    let bridge = Arc::new(FakeBridge::default());
    bridge
        .fail_server_failures_before_success
        .store(4, Ordering::Release);
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    *bridge.server_failure_gate.lock().unwrap() = Some((started, release_rx));
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(10, 20);
    gateway.set_room_cursor_for_test("room-a", 0);
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(
        10,
        20,
        ChatroomEvent::AgentFailed {
            room_id: "room-a".into(),
            payload: serde_json::json!({"invocationId":"retry-a","failureCode":"agent_offline"}),
        },
    );
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("A proof should reach bridge barrier");
    gateway.set_current_socket_generations_for_test(11, 21);
    release.send(()).unwrap();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        bridge.server_failure_attempts.load(Ordering::Acquire),
        1,
        "B takeover must stop A retry before another send"
    );
    assert!(bridge.server_failures.lock().unwrap().is_empty());
    gateway.shutdown();
}

#[test]
fn given_first_terminal_bridge_attempt_fails_after_auth_epoch_changes_then_do_not_retry_old_proof()
{
    let bridge = Arc::new(FakeBridge::default());
    bridge
        .fail_server_failures_before_success
        .store(4, Ordering::Release);
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    *bridge.server_failure_gate.lock().unwrap() = Some((started, release_rx));
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(10, 20);
    gateway.set_room_cursor_for_test("room-a", 0);
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(10, 20, ChatroomEvent::AgentFailed {
        room_id: "room-a".into(), payload: serde_json::json!({"invocationId":"retry-auth-a","failureCode":"agent_offline"}),
    });
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("A proof should reach bridge barrier");
    gateway.shutdown_connection();
    release.send(()).unwrap();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        bridge.server_failure_attempts.load(Ordering::Acquire),
        1,
        "auth boundary must stop retries carrying the old auth epoch"
    );
    assert!(bridge.server_failures.lock().unwrap().is_empty());
    gateway.shutdown();
}

#[test]
fn given_full_control_task_queue_when_server_failed_arrives_then_revoke_handoff_uses_bounded_direct_delivery(
) {
    let bridge = Arc::new(FakeBridge::default());
    bridge
        .fail_server_failures_before_success
        .store(2, Ordering::Release);
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    let registry = workers.chatroom_execution_registry();
    gateway.attach_execution_runtime(Arc::clone(&registry), workers);
    gateway.set_current_socket_generations_for_test(10, 12);
    gateway.set_room_cursor_for_test("room-1", 0);
    let origin = super::chatroom_execution::ChatroomOrigin {
        client_generation: 10,
        socket_generation: 12,
        auth_epoch: 0,
    };
    assert!(registry.record_source("room-1", "queue-terminal", "agent-a", origin));
    assert!(
        registry.bind(super::chatroom_execution::ChatroomExecutionBinding {
            room_id: "room-1".into(),
            invocation_id: "queue-terminal".into(),
            target_agent_id: "agent-a".into(),
            session_id: "queue-session".into(),
            worker_run_id: "queue-run".into(),
            origin,
        })
    );
    gateway.fill_task_queue_for_test();
    gateway.handle_socket_event_for_test(10, 12, ChatroomEvent::AgentFailed {
        room_id: "room-1".into(), payload: serde_json::json!({"invocationId":"queue-terminal","failureCode":"agent_offline"}),
    });
    assert_eq!(bridge.server_failure_attempts.load(Ordering::Acquire), 3);
    assert!(registry.binding("room-1", "queue-terminal").is_none());
    gateway.shutdown();
}

#[test]
fn given_socket_a_invocation_waiting_at_dequeue_when_b_takes_over_then_a_origin_is_not_restamped_or_forwarded(
) {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(11, 21);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    let (loaded, release) = gateway.gate_next_task_for_test();
    gateway.handle_socket_event_for_test(
        11,
        21,
        ChatroomEvent::AgentInvocation {
            room_id: "room-1".into(),
            payload: serde_json::json!({
                "invocationId":"origin-a-inv", "traceId":"origin-a-trace", "targetAgentId":"agent-a",
                "triggerMessageId":"origin-a-msg", "depth":0,
                "sender":{"type":"user","id":"host","displayName":"用户"},
                "messages":[{"messageId":"origin-a-msg","sender":{"type":"user","id":"host","displayName":"用户"},"text":"hello","createdAt":1000}],
                "receivedAt":2000
            }),
        },
    );
    loaded
        .recv_timeout(Duration::from_secs(1))
        .expect("invocation 应进入 queue barrier");
    gateway.set_current_socket_generations_for_test(12, 22);
    release.send(()).unwrap();
    thread::sleep(Duration::from_millis(30));
    assert!(
        bridge.invocations.lock().unwrap().is_empty(),
        "A 的迟到 invocation 不得改用 B generation 投递"
    );
    gateway.shutdown();
}

#[test]
fn given_trusted_socket_invocation_when_forwarded_then_main_envelope_keeps_ingress_origin() {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(31, 41);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(
        31,
        41,
        ChatroomEvent::AgentInvocation {
            room_id: "room-1".into(),
            payload: serde_json::json!({
                "invocationId":"origin-current-inv", "traceId":"origin-current-trace", "targetAgentId":"agent-a",
                "triggerMessageId":"origin-current-msg", "depth":0,
                "sender":{"type":"user","id":"host","displayName":"用户"},
                "messages":[{"messageId":"origin-current-msg","sender":{"type":"user","id":"host","displayName":"用户"},"text":"hello","createdAt":1000}],
                "receivedAt":2000
            }),
        },
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let body = bridge.invocations.lock().unwrap().first().cloned().unwrap();
    let envelope: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(envelope["gatewayOrigin"]["clientGeneration"], 31);
    assert_eq!(envelope["gatewayOrigin"]["socketGeneration"], 41);
    assert_eq!(envelope["gatewayOrigin"]["authEpoch"], 0);
    gateway.shutdown();
}

#[test]
fn given_first_client_generation_zero_invocation_when_main_binds_owner_then_native_accepts_exact_origin(
) {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    gateway.attach_execution_runtime(workers.chatroom_execution_registry(), Arc::clone(&workers));
    gateway.set_current_socket_generations_for_test(0, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: serde_json::json!({"capabilities":["agent-ready-v1"]}),
    });
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(0, 1, ChatroomEvent::AgentInvocation {
        room_id: "room-1".into(),
        payload: serde_json::json!({
            "invocationId":"first-origin-inv", "traceId":"first-origin-trace", "targetAgentId":"agent-a",
            "triggerMessageId":"first-origin-msg", "depth":0,
            "sender":{"type":"user","id":"host","displayName":"用户"},
            "messages":[{"messageId":"first-origin-msg","sender":{"type":"user","id":"host","displayName":"用户"},"text":"hello","createdAt":1}],
            "receivedAt":2
        }),
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let envelope: Value = serde_json::from_slice(&bridge.invocations.lock().unwrap()[0]).unwrap();
    assert_eq!(envelope["gatewayOrigin"]["clientGeneration"], 0);
    assert_eq!(envelope["gatewayOrigin"]["socketGeneration"], 1);

    let bind_body = serde_json::json!({
        "roomId":"room-1", "invocationId":"first-origin-inv", "targetAgentId":"agent-a",
        "sessionId":"first-origin-session", "workerRunId":"first-origin-run",
        "origin":{"clientGeneration":0,"socketGeneration":1,"authEpoch":0}
    })
    .to_string();
    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/execution-bindings/bind",
            &HashMap::new(),
            bind_body.as_bytes(),
        )
        .unwrap();
    assert!(matches!(
        response,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    assert!(workers
        .chatroom_execution_registry()
        .binding("room-1", "first-origin-inv")
        .is_some());
    gateway.shutdown();
}

#[test]
fn given_authenticated_invocation_and_exact_main_binding_when_server_failed_arrives_then_native_binding_is_revoked_before_bridge_handoff(
) {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    gateway.attach_execution_runtime(workers.chatroom_execution_registry(), Arc::clone(&workers));
    gateway.set_current_socket_generations_for_test(7, 11);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.publish_event_for_test(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: serde_json::json!({"capabilities":["agent-ready-v1"]}),
    });
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(7, 11, ChatroomEvent::AgentInvocation {
        room_id: "room-1".into(),
        payload: serde_json::json!({
            "invocationId":"bound-inv", "traceId":"bound-trace", "targetAgentId":"agent-a",
            "triggerMessageId":"bound-msg", "depth":0,
            "sender":{"type":"user","id":"host","displayName":"用户"},
            "messages":[{"messageId":"bound-msg","sender":{"type":"user","id":"host","displayName":"用户"},"text":"hello","createdAt":1}],
            "receivedAt":2
        }),
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let bind_body = serde_json::json!({
        "roomId":"room-1", "invocationId":"bound-inv", "targetAgentId":"agent-a",
        "sessionId":"bound-session", "workerRunId":"bound-run",
        "origin":{"clientGeneration":7,"socketGeneration":11,"authEpoch":0}
    })
    .to_string();
    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/execution-bindings/bind",
            &HashMap::new(),
            bind_body.as_bytes(),
        )
        .unwrap();
    assert!(matches!(
        response,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    assert!(workers
        .chatroom_execution_registry()
        .binding("room-1", "bound-inv")
        .is_some());

    gateway.handle_socket_event_for_test(
        7,
        11,
        ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: serde_json::json!({"invocationId":"bound-inv","failureCode":"agent_offline"}),
        },
    );
    assert!(workers
        .chatroom_execution_registry()
        .binding("room-1", "bound-inv")
        .is_none());
    let release = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/execution-bindings/release",
            &HashMap::new(),
            bind_body.as_bytes(),
        )
        .unwrap();
    assert!(
        matches!(release, GatewayHttpResponse::Json { status: 409, .. }),
        "迟到旧 release 不得改变已撤销/新 owner 状态"
    );
    gateway.shutdown();
}

#[cfg(unix)]
#[test]
fn given_real_native_chatroom_children_when_main_bridge_is_unavailable_then_server_failure_revokes_only_target_token_and_child(
) {
    let bridge = Arc::new(FakeBridge::default());
    bridge
        .fail_server_failures_before_success
        .store(16, Ordering::Release);
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
    let registry = workers.chatroom_execution_registry();
    gateway.attach_execution_runtime(Arc::clone(&registry), Arc::clone(&workers));
    let root = std::env::temp_dir().join(format!(
        "copis-chatroom-native-terminal-{}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let origin = super::chatroom_execution::ChatroomOrigin {
        client_generation: 5,
        socket_generation: 9,
        auth_epoch: 1,
    };
    let binding_a = super::chatroom_execution::ChatroomExecutionBinding {
        room_id: "room-a".into(),
        invocation_id: "native-inv-a".into(),
        target_agent_id: "agent-a".into(),
        session_id: "native-session-a".into(),
        worker_run_id: "native-run-a".into(),
        origin,
    };
    let binding_b = super::chatroom_execution::ChatroomExecutionBinding {
        room_id: "room-b".into(),
        invocation_id: "native-inv-b".into(),
        target_agent_id: "agent-a".into(),
        session_id: "native-session-b".into(),
        worker_run_id: "native-run-b".into(),
        origin,
    };
    assert!(registry.record_source("room-a", "native-inv-a", "agent-a", origin));
    assert!(registry.record_source("room-b", "native-inv-b", "agent-a", origin));
    assert!(registry.bind(binding_a));
    assert!(registry.bind(binding_b));
    for (session, run) in [
        ("native-session-a", "native-run-a"),
        ("native-session-b", "native-run-b"),
    ] {
        let reservation = workers
            .reserve_startup_for(session, Some(run.into()))
            .unwrap();
        let config = serde_json::json!({
            "sessionId":session,
            "query":{"sessionId":session,"cwd":root,"channelId":"fake-provider","model":"no-model-call","permissionMode":"bypassPermissions","triggeredBy":"user","automationEnabled":false,"capabilityProfile":"chatroom","useRustFileApi":true,"fileAccessPolicy":{"readRoots":[root],"readFiles":[],"writeRoots":[root],"permissionMode":"bypassPermissions"}}
        });
        workers
            .start_reserved_with_fake_worker(&reservation, config)
            .unwrap();
    }
    let token_a = workers
        .active_file_token_for_test("native-session-a")
        .unwrap();
    let token_b = workers
        .active_file_token_for_test("native-session-b")
        .unwrap();
    assert!(workers
        .file_policies()
        .contains_worker_token("native-session-a", &token_a));
    assert!(workers
        .file_policies()
        .contains_worker_token("native-session-b", &token_b));

    gateway.set_current_socket_generations_for_test(5, 9);
    gateway.set_room_cursor_for_test("room-a", 0);
    gateway.handle_socket_event_for_test(5, 9, ChatroomEvent::AgentFailed {
        room_id: "room-a".into(), payload: serde_json::json!({"invocationId":"native-inv-a","failureCode":"agent_offline"}),
    });
    let target_child_stopped = !workers.is_active("native-session-a");
    let target_token_revoked = !workers
        .file_policies()
        .contains_worker_token("native-session-a", &token_a);
    let unrelated_child_kept = workers.is_active("native-session-b");
    let unrelated_token_kept = workers
        .file_policies()
        .contains_worker_token("native-session-b", &token_b);
    let target_binding_revoked = registry.binding("room-a", "native-inv-a").is_none();
    assert_eq!(
        bridge.server_failure_attempts.load(Ordering::Acquire),
        3,
        "Main 不可达时仍需有界重送状态 handoff"
    );

    assert!(workers
        .stop_owned("native-session-b", Some("native-run-b"))
        .unwrap());
    if workers.is_active("native-session-a") {
        let _ = workers.stop_owned("native-session-a", Some("native-run-a"));
    }
    gateway.shutdown();
    fs::remove_dir_all(root).unwrap();
    assert!(target_child_stopped && target_token_revoked && target_binding_revoked);
    assert!(unrelated_child_kept && unrelated_token_kept);
}

#[test]
fn given_invocation_sender_names_with_edge_whitespace_when_forwarded_then_bridge_receives_canonical_names(
) {
    let bridge = Arc::new(FakeBridge::default());
    let gateway = gateway(Arc::new(FakeTransport::default()), bridge.clone());
    gateway.set_current_socket_generations_for_test(1, 1);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.start_task_pool_for_test();
    gateway.handle_socket_event_for_test(1, 1, ChatroomEvent::AgentInvocation {
        room_id: "room-1".into(),
        payload: json!({
            "invocationId":"inv-1", "traceId":"trace-1", "targetAgentId":"agent-1",
            "triggerMessageId":"msg-1", "depth":1,
            "sender":{"type":"user","id":"7","displayName":"\u{feff}\u{a0}用户#7\u{feff}"},
            "messages":[{"messageId":"msg-1","sender":{"type":"user","id":"7","displayName":"\u{feff}\u{a0}用户#7\u{feff}"},"text":"hello","createdAt":1000}],
            "receivedAt":2000
        }),
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while bridge.invocations.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let body = bridge.invocations.lock().unwrap().first().cloned().unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["invocation"]["sender"]["displayName"], "用户#7");
    assert_eq!(
        value["invocation"]["messages"][0]["sender"]["displayName"],
        "用户#7"
    );
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
fn given_internal_lease_release_when_schema_is_strict_then_proxy_bounded_pairs() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let body = br#"{"deviceId":"device-1","leases":[{"roomId":"room-1","roomAgentId":"agent-1"}]}"#;
    assert!(matches!(
        gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/agents/leases/release",
                &HashMap::new(),
                body,
            )
            .unwrap(),
        GatewayHttpResponse::Empty { status: 204 }
    ));
    {
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "POST");
        assert_eq!(requests[0].1, "/api/chatrooms/v2/agents/leases/release");
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].2.as_deref().unwrap()).unwrap(),
            serde_json::from_slice::<Value>(body).unwrap()
        );
    }

    assert!(gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/agents/leases/release",
            &HashMap::new(),
            br#"{"deviceId":"device-1","leases":[{"roomId":"room-1","roomAgentId":"agent-1","token":"secret"}]}"#,
        )
        .is_err());
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
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
fn given_running_invocation_when_gateway_is_offline_then_do_not_return_fake_204() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/running",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("离线 running 生命周期不能返回假成功"),
    };
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "lifecycle_unknown");
}

#[test]
fn given_unselected_invocation_ack_capability_when_running_then_do_not_enqueue_or_confirm() {
    let gateway = gateway_with_options(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
        ChatroomProtocolOptions {
            agent_ready_v1: true,
            invocation_ack_v1: true,
            delta_frame_id_v1: false,
        },
    );
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/running",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("HTTP 广告或本地命令队列都不能替代当前 socket ACK 能力"),
    };
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "lifecycle_unknown");
}

#[test]
fn given_legacy_socket_when_server_commits_accepted_event_then_confirm_only_after_public_event() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.active_socket_generation_for_test() == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_ne!(gateway.active_socket_generation_for_test(), 0);
    let _subscribe = control.receive_command().unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": []}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.capability_state().socket_generation == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(gateway.capability_state().selected.is_empty());

    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/accepted",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","agentId":"agent-1","deviceId":"device-test"}"#,
        )
    });
    let command = control
        .receive_command()
        .expect("旧协议 accepted 命令应发送");
    assert!(matches!(command, ChatroomCommand::AgentAccepted { .. }));
    assert!(!request.is_finished(), "本地发送本身不能完成确认");
    for (room_id, invocation_id) in [("room-2", "inv-1"), ("room-1", "inv-other")] {
        control
            .incoming
            .send(ChatroomSocketFrame::Event(ChatroomEvent::AgentAccepted {
                room_id: room_id.into(),
                payload: json!({"invocationId": invocation_id}),
            }))
            .unwrap();
        thread::sleep(Duration::from_millis(10));
        assert!(
            !request.is_finished(),
            "错 room/invocation 事件不能确认 waiter"
        );
    }
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::AgentAccepted {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1"}),
        }))
        .unwrap();
    let response = request.join().unwrap().expect("服务端提交事件应确认");
    let generation = gateway.active_socket_generation_for_test();
    match response {
        GatewayHttpResponse::Json { status: 200, body } => {
            assert_eq!(body["outcome"], "confirmed");
            assert_eq!(body["mode"], "legacy");
            assert_eq!(body["source"], "server-event");
            assert_eq!(body["generation"], generation);
        }
        _ => panic!("legacy server event 应映射为 typed confirmed"),
    }
    let running_gateway = gateway.clone();
    let running = thread::spawn(move || {
        running_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/running",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
        )
    });
    match running.join().unwrap().unwrap() {
        GatewayHttpResponse::Json { status: 200, body } => {
            assert_eq!(body["outcome"], "advisory");
            assert_eq!(body["mode"], "legacy");
            assert_eq!(body["source"], "accepted-event+local-advisory");
            assert!(body.get("confirmed").is_none());
        }
        _ => panic!("legacy running 应返回明确 advisory"),
    }
    assert!(matches!(
        control.try_receive_command(),
        Err(mpsc::TryRecvError::Empty)
    ));
    drop(subscription);
    gateway.shutdown();
}

#[test]
fn given_two_gateway_process_boots_when_counter_matches_then_lifecycle_ids_differ_and_stay_bounded()
{
    let first = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let second = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let first_id = first.lifecycle_request_id_for_test(1);
    let second_id = second.lifecycle_request_id_for_test(1);
    assert_ne!(first_id, second_id);
    assert!(first_id.len() <= 64);
    assert!(second_id.len() <= 64);
}

#[test]
fn given_gateway_connection_paused_by_logout_when_running_then_reject_before_ack_wait() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    gateway.shutdown_connection();
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/invocations/inv-1/running",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("logout 后不得确认生命周期"),
    };
    assert_eq!(error.status, 401);
    assert_eq!(error.code, "not_authenticated");
}

#[test]
fn given_selected_ack_capability_when_running_then_gateway_waits_for_real_socket_ack() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/running",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
        )
    });
    let request_id = next_running_request(&control);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id: request_id.clone(),
            command: "agent.running".into(),
            ok: true,
            invocation_id: Some("inv-1".into()),
            status: Some("running".into()),
            error_code: None,
        }))
        .unwrap();
    let response = request.join().expect("HTTP 确认线程应返回").unwrap();
    match response {
        GatewayHttpResponse::Json { status, body } => {
            assert_eq!(status, 200);
            assert_eq!(body["confirmed"], true);
            assert_eq!(body["requestId"], request_id);
            assert_eq!(body["status"], "running");
        }
        GatewayHttpResponse::Empty { status } => panic!("不得把确认降格为无证据 {status}"),
        GatewayHttpResponse::Sse(_) => panic!("生命周期 route 不应返回 SSE"),
    }
    gateway.shutdown();
}

#[test]
fn given_accepted_ack_when_server_reports_running_then_confirm_actual_running_status() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/accepted",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","agentId":"agent-1","deviceId":"device-1"}"#,
        )
    });
    let request_id = next_accepted_request(&control);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id: request_id.clone(),
            command: "agent.accepted".into(),
            ok: true,
            invocation_id: Some("inv-1".into()),
            status: Some("running".into()),
            error_code: None,
        }))
        .unwrap();
    let response = request.join().expect("HTTP 确认线程应结束");
    match response {
        Ok(GatewayHttpResponse::Json { status, body }) => {
            assert_eq!(status, 200);
            assert_eq!(body["confirmed"], true);
            assert_eq!(body["command"], "agent.accepted");
            assert_eq!(body["status"], "running");
            assert_eq!(body["requestId"], request_id);
        }
        Ok(GatewayHttpResponse::Empty { status }) => panic!("不得返回无 ACK 证据的 {status}"),
        Ok(GatewayHttpResponse::Sse(_)) => panic!("accepted route 不应返回 SSE"),
        Err(error) => panic!("服务端 running 已真实确认，但 Gateway 拒绝了它: {error:?}"),
    }
    gateway.shutdown();
}

#[test]
fn given_accepted_ack_with_terminal_completed_status_then_return_unknown() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/accepted",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","agentId":"agent-1","deviceId":"device-1"}"#,
        )
    });
    let request_id = next_accepted_request(&control);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id,
            command: "agent.accepted".into(),
            ok: true,
            invocation_id: Some("inv-1".into()),
            status: Some("completed".into()),
            error_code: None,
        }))
        .unwrap();
    let result = request.join().expect("HTTP 确认线程应结束");
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("completed 不能作为 accepted 请求的确认状态"),
    };
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "lifecycle_unknown");
    gateway.shutdown();
}

#[test]
fn given_running_ack_wait_when_logout_pauses_socket_then_late_ack_cannot_confirm() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/running",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
        )
    });
    let request_id = next_running_request(&control);
    let started = Instant::now();
    gateway.shutdown_connection();
    assert!(started.elapsed() < Duration::from_secs(1));
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id,
            command: "agent.running".into(),
            ok: true,
            invocation_id: Some("inv-1".into()),
            status: Some("running".into()),
            error_code: None,
        }))
        .unwrap();
    let result = request.join().expect("HTTP 确认线程应结束");
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("logout 代际后的晚到 ACK 不得生成确认成功"),
    };
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "lifecycle_unknown");
    gateway.shutdown();
}

#[test]
fn given_running_negative_forbidden_ack_when_gateway_waits_then_return_rejection_not_success() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/running",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
        )
    });
    let request_id = next_running_request(&control);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id,
            command: "agent.running".into(),
            ok: false,
            invocation_id: Some("inv-1".into()),
            status: Some("rejected".into()),
            error_code: Some("forbidden".into()),
        }))
        .unwrap();
    let result = request.join().expect("HTTP 确认线程应结束");
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("服务端 forbidden NACK 不能返回成功"),
    };
    assert_eq!(error.status, 403);
    assert_eq!(error.code, "lifecycle_rejected");
    gateway.shutdown();
}

#[test]
fn given_running_ack_with_different_status_when_gateway_waits_then_return_unknown() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/running",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1"}"#,
        )
    });
    let request_id = next_running_request(&control);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id,
            command: "agent.running".into(),
            ok: true,
            invocation_id: Some("inv-1".into()),
            status: Some("accepted".into()),
            error_code: None,
        }))
        .unwrap();
    let result = request.join().expect("HTTP 确认线程应结束");
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("错状态 ACK 不得声称 running 已确认"),
    };
    assert_eq!(error.status, 503);
    assert_eq!(error.code, "lifecycle_unknown");
    gateway.shutdown();
}

#[test]
fn given_selected_ack_capability_when_delta_then_send_on_current_socket_without_ack() {
    let (gateway, control) = acking_gateway(acking_gateway_transport());
    let _subscription = wait_for_capability_selection(&gateway, &control);
    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/invocations/inv-1/delta",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","delta":"partial"}"#,
        )
        .unwrap();
    assert!(matches!(
        response,
        GatewayHttpResponse::Empty { status: 204 }
    ));
    let mut saw_delta = false;
    for _ in 0..3 {
        match control.receive_command().expect("应发送当前代际 delta") {
            ChatroomCommand::AgentEvent {
                event: super::chatroom_protocol::AgentEventPayload::Delta { text },
                ..
            } => {
                assert_eq!(text, "partial");
                saw_delta = true;
                break;
            }
            ChatroomCommand::Subscribe { .. } => continue,
            other => panic!("unexpected socket command: {other:?}"),
        }
    }
    assert!(saw_delta);
    gateway.shutdown();
}

#[test]
fn given_lifecycle_confirmation_when_any_ack_identity_or_state_differs_then_reject() {
    let confirmed = super::chatroom_ack::ConfirmedCommand {
        room_id: "room-1".into(),
        request_id: "gw-life-1".into(),
        command: "agent.running".into(),
        invocation_id: Some("inv-1".into()),
        status: Some("running".into()),
        generation: 7,
    };
    let expected = (
        "room-1",
        "inv-1",
        "agent.running",
        "gw-life-1",
        "running",
        7,
    );
    assert!(super::chatroom_gateway::valid_lifecycle_confirmation(
        &confirmed, expected.0, expected.1, expected.2, expected.3, expected.4, expected.5,
    ));
    assert!(!super::chatroom_gateway::valid_lifecycle_confirmation(
        &confirmed, "room-2", expected.1, expected.2, expected.3, expected.4, expected.5,
    ));
    assert!(!super::chatroom_gateway::valid_lifecycle_confirmation(
        &confirmed, expected.0, expected.1, expected.2, expected.3, "accepted", expected.5,
    ));
    assert!(!super::chatroom_gateway::valid_lifecycle_confirmation(
        &confirmed, expected.0, expected.1, expected.2, "old-id", expected.4, expected.5,
    ));
    assert!(!super::chatroom_gateway::valid_lifecycle_confirmation(
        &confirmed, expected.0, expected.1, expected.2, expected.3, expected.4, 8,
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
    assert_eq!(
        super::chatroom_gateway::canonicalize_invocation_display_name(
            "\u{feff}\u{a0}Agent\u{feff}"
        ),
        Some("Agent".to_owned())
    );
    assert!(
        super::chatroom_gateway::canonicalize_invocation_display_name(&"界".repeat(42)).is_some()
    );
    assert!(
        super::chatroom_gateway::canonicalize_invocation_display_name(&"界".repeat(43)).is_none()
    );
    assert!(!super::chatroom_gateway::valid_invocation_display_name(
        &"界".repeat(43)
    ));
    for value in ["bad\nname", "bad\tname", "bad\0name", "bad\u{0085}name"] {
        assert!(!super::chatroom_gateway::valid_invocation_display_name(
            value
        ));
    }
}

#[test]
fn given_completed_status_query_when_server_proof_matches_then_confirm_without_reply_body() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"completed","finishedAt":"2026-09-29T00:00:00Z","replyMessageId":"message-1","replyClientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.to_vec(),
    });
    let prior_gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    prior_gateway.shutdown();
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let result = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"completed","failureCode":"","clientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        )
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = result else {
        panic!("status query must return typed JSON");
    };
    assert_eq!(status, 200);
    assert_eq!(body["outcome"], "Confirmed");
    assert_eq!(body["status"], "completed");
    assert_eq!(body["replyMessageId"], "message-1");
    assert!(body.get("content").is_none());
    assert!(body.to_string().find("device-test").is_none());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].0, "GET");
    assert_eq!(
        requests[0].1,
        "/api/chatrooms/v2/rooms/room-1/invocations/inv-1/status?deviceId=device-test"
    );
}

#[test]
fn given_legacy_status_route_404_when_delayed_matching_public_completion_arrives_then_confirm() {
    let transport = acking_gateway_transport();
    transport.set_invocation_status_response(GatewayTransportResponse {
        status: 404,
        body: br#"{"error":{"code":"route_not_found"}}"#.to_vec(),
    });
    let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
    let digest = reply_digest(&ChatroomReplyDigestInput {
        client_message_id: "reply-1",
        content: "done",
        mention_agent_ids: &[],
        attachment_ids: &[],
    });
    let (started, release) = transport.gate_next_request();
    let request_gateway = gateway.clone();
    let request_body = completed_status_request(&digest);
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            &request_body,
        )
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();

    control
        .incoming
        .send(ChatroomSocketFrame::Event(completed_status_event(
            "room-other",
            "inv-1",
            "reply-1",
            "done",
        )))
        .unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(completed_status_event(
            "room-1",
            "inv-other",
            "reply-1",
            "done",
        )))
        .unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(completed_status_event(
            "room-1", "inv-1", "reply-1", "done",
        )))
        .unwrap();
    release.send(()).unwrap();

    let GatewayHttpResponse::Json { status, body } = request.join().unwrap().unwrap() else {
        panic!("legacy status event must return typed JSON");
    };
    assert_eq!(status, 200);
    assert_eq!(body["outcome"], "Confirmed");
    assert_eq!(body["mode"], "legacy");
    assert_eq!(body["source"], "server-event");
    assert_eq!(body["roomId"], "room-1");
    assert_eq!(body["invocationId"], "inv-1");
    assert_eq!(
        body["terminalProof"],
        json!({
            "kind": "matched-server-event-v1",
            "replyClientMessageId": "reply-1",
            "replyDigest": digest,
        })
    );
    assert_eq!(
        body["generation"],
        gateway.active_socket_generation_for_test()
    );
    gateway.shutdown();
}

#[test]
fn given_legacy_terminal_lifecycle_event_when_exact_completed_or_failed_event_arrives_then_return_only_event_derived_proof(
) {
    let scenarios = [
        (
            "completed",
            json!({
                "roomId":"room-1", "invocationId":"inv-1", "content":"done",
                "mentionAgentIds":[], "attachmentIds":[], "clientMessageId":"reply-1"
            }),
            ChatroomEvent::AgentCompleted {
                room_id: "room-1".into(),
                payload: json!({
                    "invocationId":"inv-1", "content":"done", "mentionAgentIds":[],
                    "attachmentIds":[], "clientMessageId":"reply-1"
                }),
            },
            json!({
                "kind":"matched-server-event-v1", "replyClientMessageId":"reply-1",
                "replyDigest":"b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37"
            }),
        ),
        (
            "failed",
            json!({
                "roomId":"room-1", "invocationId":"inv-1", "failureCode":"agent_offline",
                "message":"offline"
            }),
            ChatroomEvent::AgentFailed {
                room_id: "room-1".into(),
                payload: json!({"invocationId":"inv-1", "failureCode":"agent_offline"}),
            },
            json!({"kind":"matched-server-event-v1", "failureCode":"agent_offline"}),
        ),
    ];

    for (state, request_body, event, expected_proof) in scenarios {
        let transport = acking_gateway_transport();
        let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport);
        let body = request_body.to_string();
        let request_gateway = gateway.clone();
        let path = format!("/api/internal/chatrooms/invocations/inv-1/{state}");
        let request = thread::spawn(move || {
            request_gateway.handle_http("POST", &path, &HashMap::new(), body.as_bytes())
        });

        let sent = control.receive_command().unwrap();
        assert!(matches!(sent, ChatroomCommand::AgentEvent { .. }));
        control
            .incoming
            .send(ChatroomSocketFrame::Event(event))
            .unwrap();
        let GatewayHttpResponse::Json { body, .. } = request.join().unwrap().unwrap() else {
            panic!("matching legacy terminal event must return typed JSON");
        };

        assert_eq!(body["outcome"], "confirmed");
        assert_eq!(body["mode"], "legacy");
        assert_eq!(body["source"], "server-event");
        assert_eq!(body["status"], state);
        assert_eq!(body["terminalProof"], expected_proof);
        assert_eq!(
            body["generation"],
            gateway.active_socket_generation_for_test()
        );
        assert_eq!(
            body.as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "command",
                "generation",
                "invocationId",
                "mode",
                "outcome",
                "roomId",
                "source",
                "status",
                "terminalProof"
            ]
        );
        gateway.shutdown();
    }
}

#[test]
fn given_legacy_status_route_404_when_terminal_event_mismatches_then_return_unknown() {
    let digest = reply_digest(&ChatroomReplyDigestInput {
        client_message_id: "reply-1",
        content: "done",
        mention_agent_ids: &[],
        attachment_ids: &[],
    });
    for event in [
        completed_status_event("room-1", "inv-1", "wrong-client", "done"),
        completed_status_event("room-1", "inv-1", "reply-1", "different-digest"),
        ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","failureCode":"agent_offline"}),
        },
    ] {
        let transport = acking_gateway_transport();
        transport.set_invocation_status_response(GatewayTransportResponse {
            status: 404,
            body: Vec::new(),
        });
        let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
        gateway.set_legacy_status_wait_timeout_for_test(Duration::from_millis(100));
        let (started, release) = transport.gate_next_request();
        let request_gateway = gateway.clone();
        let request_body = completed_status_request(&digest);
        let request = thread::spawn(move || {
            request_gateway.handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
                &HashMap::new(),
                &request_body,
            )
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        control
            .incoming
            .send(ChatroomSocketFrame::Event(event))
            .unwrap();
        release.send(()).unwrap();
        let GatewayHttpResponse::Json { body, .. } = request.join().unwrap().unwrap() else {
            panic!("legacy status mismatch must return typed JSON");
        };
        assert_eq!(body["outcome"], "Unknown");
        gateway.shutdown();
    }
}

#[test]
fn given_legacy_status_route_404_when_failed_event_code_matches_then_confirm() {
    let transport = acking_gateway_transport();
    transport.set_invocation_status_response(GatewayTransportResponse {
        status: 404,
        body: Vec::new(),
    });
    let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
    let (started, release) = transport.gate_next_request();
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#,
        )
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","failureCode":"agent_offline"}),
        }))
        .unwrap();
    release.send(()).unwrap();
    let GatewayHttpResponse::Json { body, .. } = request.join().unwrap().unwrap() else {
        panic!("matching failed status event must return typed JSON");
    };
    assert_eq!(body["outcome"], "Confirmed");
    assert_eq!(body["mode"], "legacy");
    assert_eq!(body["source"], "server-event");
    assert_eq!(body["status"], "failed");
    assert_eq!(
        body["terminalProof"],
        json!({ "kind": "matched-server-event-v1", "failureCode": "agent_offline" })
    );
    gateway.shutdown();
}

#[test]
fn given_legacy_status_route_404_when_failed_event_code_differs_then_return_unknown() {
    let transport = acking_gateway_transport();
    let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
    let (started, release) = transport.gate_next_request();
    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#,
        )
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::AgentFailed {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","failureCode":"agent_busy"}),
        }))
        .unwrap();
    release.send(()).unwrap();

    let GatewayHttpResponse::Json { body, .. } = request.join().unwrap().unwrap() else {
        panic!("mismatched failed event must return typed status");
    };
    assert_eq!(body["outcome"], "Unknown");
    assert!(body.get("terminalProof").is_none());
    gateway.shutdown();
}

#[test]
fn given_legacy_status_route_404_when_no_terminal_event_arrives_then_return_bounded_unknown() {
    let transport = acking_gateway_transport();
    transport.set_invocation_status_response(GatewayTransportResponse {
        status: 404,
        body: Vec::new(),
    });
    let (gateway, _control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
    gateway.set_legacy_status_wait_timeout_for_test(Duration::from_millis(35));
    let started_at = Instant::now();
    let result = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            &completed_status_request(&"a".repeat(64)),
        )
        .unwrap();
    let GatewayHttpResponse::Json { body, .. } = result else {
        panic!("legacy 404 without evidence must return typed JSON");
    };
    assert_eq!(body["outcome"], "Unknown");
    assert!(started_at.elapsed() < Duration::from_millis(500));
    gateway.shutdown();
}

#[test]
fn given_legacy_status_route_unauthorized_when_matching_event_arrives_then_reject_without_fallback()
{
    for status in [401, 403] {
        let transport = acking_gateway_transport();
        transport.set_invocation_status_response(GatewayTransportResponse {
            status,
            body: Vec::new(),
        });
        let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport.clone());
        let digest = reply_digest(&ChatroomReplyDigestInput {
            client_message_id: "reply-1",
            content: "done",
            mention_agent_ids: &[],
            attachment_ids: &[],
        });
        let (started, release) = transport.gate_next_request();
        let request_gateway = gateway.clone();
        let request_body = completed_status_request(&digest);
        let request = thread::spawn(move || {
            request_gateway.handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
                &HashMap::new(),
                &request_body,
            )
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        control
            .incoming
            .send(ChatroomSocketFrame::Event(completed_status_event(
                "room-1", "inv-1", "reply-1", "done",
            )))
            .unwrap();
        release.send(()).unwrap();
        let GatewayHttpResponse::Json { body, .. } = request.join().unwrap().unwrap() else {
            panic!("legacy status permission failure must return typed JSON");
        };
        assert_eq!(body["outcome"], "Rejected");
        assert_ne!(body["outcome"], "Confirmed");
        gateway.shutdown();
    }
}

#[test]
fn given_socket_b_status_waiter_when_socket_a_late_event_arrives_then_unknown_until_b_event() {
    let transport = acking_gateway_transport();
    for _ in 0..4 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
    }
    let (gateway, control, subscription, bridge) = legacy_status_gateway(transport.clone());
    let generation_a = gateway.active_socket_generation_for_test();
    assert_eq!(control.receive_connection().unwrap(), generation_a);
    let auth_generation = gateway.pause_generation_for_test();
    loop {
        let event = subscription
            .receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("socket A connected SSE status must arrive");
        if event["code"] == "realtime_connected" {
            break;
        }
    }

    control.disconnect_generation(generation_a);
    let generation_b = control.receive_connection().unwrap();
    assert!(generation_b > generation_a);
    let disconnected_deadline = Instant::now() + Duration::from_secs(2);
    while gateway.websocket_connected_for_test() && Instant::now() < disconnected_deadline {
        thread::yield_now();
    }
    loop {
        if matches!(
            control.receive_command().unwrap(),
            ChatroomCommand::Subscribe { .. }
        ) {
            break;
        }
    }
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": [], "source":"socket-b"}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while (!gateway.websocket_connected_for_test()
        || gateway.active_socket_generation_for_test() != generation_b)
        && Instant::now() < deadline
    {
        thread::yield_now();
    }
    assert!(gateway.websocket_connected_for_test());
    assert_eq!(gateway.active_socket_generation_for_test(), generation_b);
    assert_eq!(gateway.pause_generation_for_test(), auth_generation);
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway
        .room_snapshot_for_test("room-1")
        .and_then(|event| match event {
            ChatroomEvent::RoomSnapshot { payload, .. } => payload.get("source").cloned(),
            _ => None,
        })
        != Some(json!("socket-b"))
        && Instant::now() < deadline
    {
        thread::yield_now();
    }
    let b_snapshot = gateway.room_snapshot_for_test("room-1").unwrap();
    assert!(
        matches!(&b_snapshot, ChatroomEvent::RoomSnapshot { payload, .. } if payload["source"] == "socket-b")
    );
    loop {
        let event = subscription
            .receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("socket B connected SSE status must arrive");
        if event["code"] == "realtime_connected" {
            break;
        }
    }
    loop {
        let event = subscription
            .receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("socket B snapshot SSE event must arrive");
        if event["type"] == "room.snapshot" && event["payload"]["source"] == "socket-b" {
            break;
        }
    }
    while subscription.receiver.try_recv().is_ok() {}
    let disconnect_deadline = Instant::now() + Duration::from_secs(2);
    while bridge.disconnects.lock().unwrap().is_empty() && Instant::now() < disconnect_deadline {
        thread::yield_now();
    }
    gateway.set_legacy_status_wait_timeout_for_test(Duration::from_millis(35));

    let digest = reply_digest(&ChatroomReplyDigestInput {
        client_message_id: "reply-1",
        content: "done",
        mention_agent_ids: &[],
        attachment_ids: &[],
    });
    transport.set_invocation_status_response(GatewayTransportResponse {
        status: 404,
        body: Vec::new(),
    });
    let (started, release) = transport.gate_next_request();
    let request_gateway = gateway.clone();
    let request_body = completed_status_request(&digest);
    let old_event_request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            &request_body,
        )
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::SocketEventAt {
            generation: auth_generation,
            socket_generation: generation_a,
            event: completed_status_event("room-1", "inv-1", "reply-1", "done"),
        },
    );
    let stale_completion_sse = subscription.receiver.try_recv();
    assert!(
        matches!(stale_completion_sse, Err(mpsc::TryRecvError::Empty)),
        "unexpected SSE from stale completion: {stale_completion_sse:?}"
    );
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::SocketEventAt {
            generation: auth_generation,
            socket_generation: generation_a,
            event: ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 999,
                payload: json!({"source":"socket-a"}),
            },
        },
    );
    assert_eq!(gateway.room_snapshot_for_test("room-1"), Some(b_snapshot));
    assert!(matches!(
        subscription.receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    let invocation_dispatch = gateway.observe_next_invocation_dispatch_for_test();
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::SocketEventAt {
            generation: auth_generation,
            socket_generation: generation_a,
            event: ChatroomEvent::AgentInvocation {
                room_id: "room-1".into(),
                payload: json!({
                    "invocationId":"inv-1", "traceId":"trace-1", "targetAgentId":"agent-1",
                    "triggerMessageId":"msg-1", "depth":1,
                    "sender":{"type":"user","id":"7","displayName":"用户#7"},
                    "messages":[{"messageId":"msg-1","sender":{"type":"user","id":"7","displayName":"用户#7"},"text":"hello","createdAt":1000}],
                    "receivedAt":2000
                }),
            },
        },
    );
    match invocation_dispatch.recv_timeout(Duration::from_millis(35)) {
        Ok(origin) => panic!("stale A invocation was dispatched with origin {origin:?}"),
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            panic!("invocation dispatch observer disconnected unexpectedly");
        }
    }
    assert!(bridge.invocations.lock().unwrap().is_empty());
    release.send(()).unwrap();
    let GatewayHttpResponse::Json { body, .. } = old_event_request.join().unwrap().unwrap() else {
        panic!("stale A event must leave B status query typed");
    };
    assert_eq!(body["outcome"], "Unknown");
    assert_eq!(body["generation"], generation_b);

    transport.set_invocation_status_response(GatewayTransportResponse {
        status: 404,
        body: Vec::new(),
    });
    let (started, release) = transport.gate_next_request();
    let request_gateway = gateway.clone();
    let request_body = completed_status_request(&digest);
    let current_event_request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            &request_body,
        )
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    control
        .incoming
        .send(ChatroomSocketFrame::Event(completed_status_event(
            "room-1", "inv-1", "reply-1", "done",
        )))
        .unwrap();
    release.send(()).unwrap();
    let GatewayHttpResponse::Json { body, .. } = current_event_request.join().unwrap().unwrap()
    else {
        panic!("current B event must return typed confirmation");
    };
    assert_eq!(body["outcome"], "Confirmed");
    assert_eq!(body["mode"], "legacy");
    assert_eq!(body["source"], "server-event");
    assert_eq!(body["generation"], generation_b);
    gateway.shutdown();
}

#[test]
fn given_status_proof_when_reply_body_field_is_added_then_reject_without_leaking_it() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"completed","finishedAt":"2026-09-29T00:00:00Z","replyMessageId":"message-1","replyClientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content":"must not pass through"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let input = br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"completed","failureCode":"","clientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    let GatewayHttpResponse::Json { body, .. } = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
            &HashMap::new(),
            input,
        )
        .unwrap()
    else {
        panic!("typed status response expected")
    };
    assert_eq!(body["outcome"], "Rejected");
    assert!(body.get("content").is_none());
}

#[test]
fn given_status_query_when_local_device_or_auth_is_wrong_then_do_not_probe_upstream() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = gateway(transport.clone(), Arc::new(FakeBridge::default()));
    let input = br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"other-device","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#;
    let error = match gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
        &HashMap::new(),
        input,
    ) {
        Ok(_) => panic!("wrong device must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.status, 403);
    assert!(transport.requests.lock().unwrap().is_empty());

    let unauthenticated = unauthenticated_gateway();
    let trusted_device_input = br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#;
    let error = match unauthenticated.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
        &HashMap::new(),
        trusted_device_input,
    ) {
        Ok(_) => panic!("unauthenticated status must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.status, 401);
}

#[test]
fn given_status_upstream_errors_or_invalid_payload_then_classify_without_success() {
    let transport = Arc::new(FakeTransport::default());
    for (status, body) in [
        (401, br#"{"error":"unauthorized"}"#.to_vec()),
        (403, br#"{"error":"forbidden"}"#.to_vec()),
        (400, br#"{"error":"bad request"}"#.to_vec()),
        (404, Vec::new()),
        (500, br#"{"error":"server"}"#.to_vec()),
        (200, b"not-json".to_vec()),
        (200, vec![b' '; 128 * 1024 + 1]),
        (200, br#"{"data":{"roomId":"room-2"}}"#.to_vec()),
        (200, br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"completed","finishedAt":"not-a-time","replyMessageId":"message-1","replyClientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.to_vec()),
    ] {
        transport.push(GatewayTransportResponse { status, body });
    }
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let input = br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"completed","failureCode":"","clientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    for expected in [
        "Rejected", "Rejected", "Rejected", "Unknown", "Unknown", "Rejected", "Rejected",
        "Rejected", "Rejected",
    ] {
        let GatewayHttpResponse::Json { body, .. } = gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
                &HashMap::new(),
                input,
            )
            .unwrap()
        else {
            panic!("status query must always return typed classification")
        };
        assert_eq!(body["outcome"], expected);
        assert_ne!(body["outcome"], "Confirmed");
    }
}

#[test]
fn given_status_not_found_or_wrong_reply_proof_then_never_claim_confirmation() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 404,
        body: vec![],
    });
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"completed","finishedAt":"2026-09-29T00:00:00Z","replyMessageId":"message-1","replyClientMessageId":"other-client","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let input = br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"completed","failureCode":"","clientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    for expected in ["Unknown", "Rejected"] {
        let GatewayHttpResponse::Json { body, .. } = gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
                &HashMap::new(),
                input,
            )
            .unwrap()
        else {
            panic!("typed status response expected")
        };
        assert_eq!(body["outcome"], expected);
        assert_ne!(body["outcome"], "Confirmed");
    }
}

#[test]
fn given_active_status_when_completion_confirmation_is_expected_then_remain_unknown() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"running"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let GatewayHttpResponse::Json { body, .. } = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"completed","failureCode":"","clientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
    ).unwrap() else { panic!("typed status response expected") };
    assert_eq!(body["outcome"], "Unknown");
}

#[test]
fn given_failed_expectation_when_server_proves_same_failure_then_confirm_without_digest() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"failed","failureCode":"agent_offline","finishedAt":"2026-09-29T00:00:00Z"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let GatewayHttpResponse::Json { body, .. } = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#,
    ).unwrap() else { panic!("typed status response expected") };
    assert_eq!(body["outcome"], "Confirmed");
    assert_eq!(body["status"], "failed");
    assert_eq!(body["failureCode"], "agent_offline");
}

#[test]
fn given_failed_expectation_when_server_proves_completed_then_reject_opposite_terminal() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"invocationId":"inv-1","roomId":"room-1","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"status":"completed","finishedAt":"2026-09-29T00:00:00Z","replyMessageId":"message-1","replyClientMessageId":"client-1","replyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.to_vec(),
    });
    let gateway = gateway(transport, Arc::new(FakeBridge::default()));
    let GatewayHttpResponse::Json { body, .. } = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status",
        &HashMap::new(),
        br#"{"roomId":"room-1","invocationId":"inv-1","deviceId":"device-test","traceId":"trace-1","targetAgentId":"agent-1","triggerMessageId":"parent-1","depth":1,"expectedStatus":"failed","failureCode":"agent_offline","clientMessageId":"","replyDigest":""}"#,
    ).unwrap() else { panic!("typed status response expected") };
    assert_eq!(body["outcome"], "Rejected");
}

#[test]
fn given_internal_room_status_when_snapshot_is_missing_then_report_trusted_capability_state() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );

    let GatewayHttpResponse::Json { body, .. } = gateway
        .handle_http(
            "GET",
            "/api/internal/chatrooms/rooms/room-1/status",
            &HashMap::new(),
            &[],
        )
        .unwrap()
    else {
        panic!("typed room status response expected");
    };

    assert_eq!(body["capabilityState"], "preparing");
    assert_eq!(body["selectedCapabilities"], json!([]));
    assert_eq!(body["socketGeneration"], 0);
    assert_eq!(body["snapshotReady"], false);
}

#[test]
fn given_go_snapshot_history_and_recovery_events_when_gateway_processes_them_then_room_status_and_sse_remain_responsive(
) {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let client_generation = gateway.pause_generation_for_test();
    let socket_generation = 41;
    gateway.set_current_socket_generations_for_test(client_generation, socket_generation);
    gateway.handle_client_event_for_test(
        super::chatroom_client::ChatroomClientEvent::ConnectedAt {
            generation: client_generation,
        },
    );

    let (processed, processed_rx) = mpsc::channel();
    let event_gateway = Arc::clone(&gateway);
    thread::spawn(move || {
        for raw in [
            br#"{"type":"room.snapshot","roomId":"room-1","latestSeq":0,"payload":{"room":{"roomId":"room-1","nextSeq":2},"members":[],"agents":[{"roomAgentId":"agent-1","memoryShared":false,"skillsShared":true}]}}"#.as_slice(),
            br#"{"type":"agent.updated","roomId":"room-1","seq":1,"payload":{"roomId":"room-1","roomAgentId":"agent-1","displayName":"Agent","status":"offline","memoryShared":false,"skillsShared":true}}"#.as_slice(),
            br#"{"type":"room.recovery_ready","roomId":"room-1","payload":{}}"#.as_slice(),
            br#"{"type":"message.created","roomId":"room-1","seq":2,"payload":{"messageId":"message-1","content":"connected"}}"#.as_slice(),
        ] {
            let event = super::chatroom_protocol::parse_event(raw).unwrap();
            event_gateway.handle_socket_event_for_test(
                client_generation,
                socket_generation,
                event,
            );
        }
        let _ = processed.send(());
    });
    processed_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("snapshot/history/recovery event path must release auth_boundary");

    let GatewayHttpResponse::Json { body, .. } = gateway
        .handle_http(
            "GET",
            "/api/internal/chatrooms/rooms/room-1/status",
            &HashMap::new(),
            &[],
        )
        .expect("room status should not block after snapshot/history processing")
    else {
        panic!("typed room status response expected");
    };
    assert_eq!(body["snapshotReady"], true);
    assert_eq!(body["socketGeneration"], socket_generation);

    let mut events = Vec::new();
    for _ in 0..5 {
        events.push(
            subscription
                .receiver
                .recv_timeout(Duration::from_millis(250))
                .expect("SSE should receive connected, snapshot, history and recovery events"),
        );
    }
    let room_events = events
        .into_iter()
        .filter(|event| event["type"] != "local.status")
        .collect::<Vec<_>>();
    assert_eq!(
        room_events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "room.snapshot",
            "agent.updated",
            "room.recovery_ready",
            "message.created"
        ]
    );
    assert_eq!(
        room_events[0]["payload"]["agents"][0]["memoryShared"],
        false
    );
    assert_eq!(room_events[1]["payload"]["skillsShared"], true);
}

#[test]
fn given_started_gateway_when_offline_history_event_cleans_lease_then_release_auth_boundary() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let client_generation = gateway.pause_generation_for_test();
    let socket_generation = 73;
    gateway.set_current_socket_generations_for_test(client_generation, socket_generation);
    gateway.set_started_for_test(true);
    gateway.set_room_cursor_for_test("room-1", 0);
    gateway.register_lease_for_test("room-1", "agent-1", "device-1");

    let (finished, finished_rx) = mpsc::channel();
    let event_gateway = Arc::clone(&gateway);
    thread::spawn(move || {
        event_gateway.handle_socket_event_for_test(
            client_generation,
            socket_generation,
            ChatroomEvent::AgentOffline {
                room_id: "room-1".into(),
                seq: 1,
                payload: json!({"roomAgentId":"agent-1"}),
            },
        );
        let _ = finished.send(());
    });

    assert!(
        finished_rx.recv_timeout(Duration::from_secs(1)).is_ok(),
        "offline history event must not reacquire auth_boundary while holding it"
    );
    assert_eq!(gateway.lease_count_for_test(), 0);
    assert_eq!(gateway.room_cursor_for_test("room-1"), Some(1));
}

#[test]
fn given_ready_and_ack_capabilities_when_ready_is_requested_then_require_current_private_ack() {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
    }
    let (gateway, control) = acking_gateway(transport);
    let subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.active_socket_generation_for_test() == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_ne!(gateway.active_socket_generation_for_test(), 0);
    assert!(matches!(
        control.receive_command().unwrap(),
        ChatroomCommand::Subscribe { .. }
    ));
    control
        .incoming
        .send(ChatroomSocketFrame::Event(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities":["agent-ready-v1","invocation-ack-v1"]}),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !gateway
        .capability_state()
        .selected
        .contains(&ChatroomCapability::AgentReadyV1)
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(gateway
        .capability_state()
        .selected
        .contains(&ChatroomCapability::AgentReadyV1));
    gateway.register_lease_for_test("room-1", "legacy-agent", "device-test");
    gateway.tick_leases_for_test(Instant::now() + Duration::from_secs(61));
    assert_eq!(gateway.lease_count_for_test(), 0);
    assert!(matches!(
        control.try_receive_command(),
        Err(mpsc::TryRecvError::Empty)
    ));

    let request_gateway = gateway.clone();
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        )
    });
    let command = control
        .receive_command()
        .expect("ready 应经所选现代协议发送");
    let (request_id, generation) = match command {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } => match *command {
            ChatroomCommand::Ready {
                room_id,
                request_id: embedded_request_id,
                room_agent_id,
            } => {
                assert_eq!(embedded_request_id, request_id);
                assert_eq!(room_id, "room-1");
                assert_eq!(room_agent_id, "agent-1");
                (request_id, gateway.active_socket_generation_for_test())
            }
            other => panic!("expected wrapped ready command, got {other:?}"),
        },
        other => panic!("expected confirmed lifecycle wrapper, got {other:?}"),
    };
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id: request_id.clone(),
            command: "agent.ready".into(),
            ok: true,
            invocation_id: None,
            status: Some("ready".into()),
            error_code: None,
        }))
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = request
        .join()
        .expect("ready route should return")
        .expect("private ACK should confirm readiness")
    else {
        panic!("ready route should return JSON");
    };
    assert_eq!(status, 200);
    assert_eq!(body["outcome"], "confirmed");
    assert_eq!(body["mode"], "agent-ready-v1");
    assert_eq!(body["source"], "private-ack");
    assert_eq!(body["generation"], generation);
    assert_eq!(body["requestId"], request_id);

    let rejected_gateway = gateway.clone();
    let rejected = thread::spawn(move || {
        rejected_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/unready",
            &HashMap::new(),
            br#"{}"#,
        )
    });
    let command = control
        .receive_command()
        .expect("unready 应经同代 modern 协议发送");
    let (rejected_request_id, rejected_generation) = match command {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } => match *command {
            ChatroomCommand::Unready {
                room_id,
                request_id: embedded_request_id,
                room_agent_id,
            } => {
                assert_eq!(embedded_request_id, request_id);
                assert_eq!(room_id, "room-1");
                assert_eq!(room_agent_id, "agent-1");
                (request_id, gateway.active_socket_generation_for_test())
            }
            other => panic!("expected wrapped unready command, got {other:?}"),
        },
        other => panic!("expected confirmed lifecycle wrapper, got {other:?}"),
    };
    assert_eq!(rejected_generation, generation);
    control
        .incoming
        .send(ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id: rejected_request_id,
            command: "agent.unready".into(),
            ok: false,
            invocation_id: None,
            status: None,
            error_code: Some("forbidden".into()),
        }))
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = rejected
        .join()
        .expect("unready route should return")
        .expect("private NACK should be a typed HTTP result")
    else {
        panic!("unready route should return JSON");
    };
    assert_eq!(status, 403);
    assert_eq!(body["outcome"], "Rejected");
    assert_eq!(body["code"], "lifecycle_rejected");
    drop(subscription);
    gateway.shutdown();
}

#[test]
fn given_ready_waiter_on_socket_a_when_socket_b_takes_over_then_only_b_ack_confirms() {
    let (gateway, socket_frames, commands, connected, _subscription, _transport) =
        readiness_gateway_with_two_sockets();
    assert_eq!(connected.recv_timeout(Duration::from_secs(2)), Ok(1));
    await_readiness_snapshot(&gateway, &socket_frames[0], &commands, 1);

    let gateway_a = gateway.clone();
    let (a_result_tx, a_result_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = gateway_a.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        );
        let _ = a_result_tx.send(result);
    });
    let (generation_a, ready_a) = commands
        .recv_timeout(Duration::from_secs(2))
        .expect("socket A should send ready");
    let (request_a, command_a) = match ready_a {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } => (request_id, *command),
        other => panic!("expected A lifecycle wrapper, got {other:?}"),
    };
    assert_eq!(generation_a, 1);
    assert!(matches!(command_a, ChatroomCommand::Ready { .. }));

    let (disconnect_reached_tx, disconnect_reached_rx) = mpsc::channel();
    let (disconnect_release_tx, disconnect_release_rx) = mpsc::channel();
    socket_frames[0]
        .send(ReadinessTestInput::DisconnectBarrier {
            reached: disconnect_reached_tx,
            release: disconnect_release_rx,
        })
        .unwrap();
    disconnect_reached_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("socket A reader should reach disconnect barrier");
    socket_frames[0]
        .send(ReadinessTestInput::Frame(Ok(
            ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
                room_id: "room-1".into(),
                request_id: request_a.clone(),
                command: "agent.ready".into(),
                ok: true,
                invocation_id: None,
                status: Some("ready".into()),
                error_code: None,
            }),
        )))
        .unwrap();
    disconnect_release_tx.send(()).unwrap();
    let a_response = a_result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("A readiness request must finish when A disconnects")
        .expect("typed readiness result expected");
    let GatewayHttpResponse::Json { status, body } = a_response else {
        panic!("A disconnect must map to typed JSON");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");

    assert_eq!(connected.recv_timeout(Duration::from_secs(3)), Ok(2));
    await_readiness_snapshot(&gateway, &socket_frames[1], &commands, 2);
    let gateway_b = gateway.clone();
    let (b_result_tx, b_result_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = gateway_b.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        );
        let _ = b_result_tx.send(result);
    });
    let (generation_b, ready_b) = commands
        .recv_timeout(Duration::from_secs(2))
        .expect("socket B should send its own ready");
    let (request_b, command_b) = match ready_b {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } => (request_id, *command),
        other => panic!("expected B lifecycle wrapper, got {other:?}"),
    };
    assert_eq!(generation_b, 2);
    assert_ne!(request_a, request_b);
    assert!(matches!(command_b, ChatroomCommand::Ready { .. }));
    assert!(
        b_result_rx.try_recv().is_err(),
        "A's queued late ACK must not confirm B"
    );
    socket_frames[1]
        .send(ReadinessTestInput::Frame(Ok(
            ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
                room_id: "room-1".into(),
                request_id: request_b,
                command: "agent.ready".into(),
                ok: true,
                invocation_id: None,
                status: Some("ready".into()),
                error_code: None,
            }),
        )))
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = b_result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("B readiness request should finish after B ACK")
        .expect("typed readiness result expected")
    else {
        panic!("B private ACK should return JSON");
    };
    assert_eq!(status, 200);
    assert_eq!(body["outcome"], "confirmed");
    assert_eq!(body["generation"], 2);
    gateway.shutdown();
}

#[test]
fn given_ready_waiter_when_room_is_unsubscribed_before_ack_then_return_unknown() {
    let (gateway, socket_frames, commands, connected, _subscription, _transport) =
        readiness_gateway_with_two_sockets();
    assert_eq!(connected.recv_timeout(Duration::from_secs(2)), Ok(1));
    await_readiness_snapshot(&gateway, &socket_frames[0], &commands, 1);

    let gateway_ready = gateway.clone();
    let (result_tx, result_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = gateway_ready.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        );
        let _ = result_tx.send(result);
    });
    let (_, command) = commands
        .recv_timeout(Duration::from_secs(2))
        .expect("ready command should be sent before room leave");
    let request_id = match command {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } if matches!(*command, ChatroomCommand::Ready { .. }) => request_id,
        other => panic!("expected ready command, got {other:?}"),
    };

    let leave = gateway
        .handle_http(
            "POST",
            "/api/chatrooms/v2/rooms/room-1/leave",
            &HashMap::new(),
            &[],
        )
        .expect("fixture leave response is successful");
    assert!(matches!(
        leave,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    socket_frames[0]
        .send(ReadinessTestInput::Frame(Ok(
            ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
                room_id: "room-1".into(),
                request_id,
                command: "agent.ready".into(),
                ok: true,
                invocation_id: None,
                status: Some("ready".into()),
                error_code: None,
            }),
        )))
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("ready waiter should finish after ACK")
        .expect("typed readiness result expected")
    else {
        panic!("ready outcome should remain a typed JSON response");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");
    gateway.shutdown();
}

#[test]
fn given_ready_ack_after_auth_epoch_changes_on_same_socket_then_return_unknown() {
    let (gateway, socket_frames, commands, connected, _subscription, _transport) =
        readiness_gateway_with_two_sockets();
    assert_eq!(connected.recv_timeout(Duration::from_secs(2)), Ok(1));
    await_readiness_snapshot(&gateway, &socket_frames[0], &commands, 1);
    let gateway_ready = gateway.clone();
    let (result_tx, result_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = gateway_ready.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        );
        let _ = result_tx.send(result);
    });
    let (generation, command) = commands
        .recv_timeout(Duration::from_secs(2))
        .expect("ready command should be sent");
    let request_id = match command {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } if matches!(*command, ChatroomCommand::Ready { .. }) => request_id,
        other => panic!("expected ready command, got {other:?}"),
    };
    assert_eq!(generation, 1);
    gateway.advance_auth_epoch_without_disconnect_for_test();
    socket_frames[0]
        .send(ReadinessTestInput::Frame(Ok(
            ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
                room_id: "room-1".into(),
                request_id,
                command: "agent.ready".into(),
                ok: true,
                invocation_id: None,
                status: Some("ready".into()),
                error_code: None,
            }),
        )))
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("ready result should return")
        .expect("typed readiness response expected")
    else {
        panic!("ready response should be JSON");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");
    gateway.shutdown();
}

#[test]
fn given_ready_request_without_authentication_then_return_typed_rejected() {
    let gateway = unauthenticated_gateway();
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
        &HashMap::new(),
        br#"{}"#,
    );
    let GatewayHttpResponse::Json { status, body } = result
        .unwrap_or_else(|error| panic!("authentication error must use typed envelope: {error:?}"))
    else {
        panic!("authentication rejection should have typed JSON");
    };
    assert_eq!(status, 401);
    assert_eq!(body["outcome"], "Rejected");
    assert_eq!(body["code"], "not_authenticated");
    gateway.shutdown();
}

#[test]
fn given_ready_ack_capacity_is_full_then_return_typed_unknown_unavailable() {
    let (gateway, socket_frames, commands, connected, _subscription, _transport) =
        readiness_gateway_with_two_sockets();
    assert_eq!(connected.recv_timeout(Duration::from_secs(2)), Ok(1));
    await_readiness_snapshot(&gateway, &socket_frames[0], &commands, 1);
    let (done_tx, done_rx) = mpsc::channel();
    for _ in 0..256 {
        let request_gateway = gateway.clone();
        let done = done_tx.clone();
        thread::spawn(move || {
            let result = request_gateway.handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
                &HashMap::new(),
                br#"{}"#,
            );
            let _ = done.send(result);
        });
        let (generation, command) = commands
            .recv_timeout(Duration::from_secs(2))
            .expect("each ready waiter should send on the current socket");
        assert_eq!(generation, 1);
        assert!(matches!(
            command,
            ChatroomCommand::ConfirmedLifecycle { .. }
        ));
    }

    let GatewayHttpResponse::Json { status, body } = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        )
        .expect("pending capacity error should have typed JSON")
    else {
        panic!("typed unavailable result expected");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");
    assert_eq!(body["code"], "lifecycle_unavailable");

    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    socket_frames[0]
        .send(ReadinessTestInput::DisconnectBarrier {
            reached: reached_tx,
            release: release_rx,
        })
        .unwrap();
    reached_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("socket should reach cleanup barrier");
    release_tx.send(()).unwrap();
    for _ in 0..256 {
        assert!(done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("disconnect should release pending waiter")
            .is_ok());
    }
    gateway.shutdown();
}

#[test]
fn given_gateway_logout_while_ready_ack_is_pending_then_late_ack_never_confirms() {
    let (gateway, socket_frames, commands, connected, _subscription, _transport) =
        readiness_gateway_with_two_sockets();
    assert_eq!(connected.recv_timeout(Duration::from_secs(2)), Ok(1));
    await_readiness_snapshot(&gateway, &socket_frames[0], &commands, 1);
    let request_gateway = gateway.clone();
    let (result_tx, result_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        );
        let _ = result_tx.send(result);
    });
    let (_, command) = commands
        .recv_timeout(Duration::from_secs(2))
        .expect("ready request should become pending before logout");
    let request_id = match command {
        ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } if matches!(*command, ChatroomCommand::Ready { .. }) => request_id,
        other => panic!("expected ready command, got {other:?}"),
    };
    gateway.shutdown_connection();
    let _ = socket_frames[0].send(ReadinessTestInput::Frame(Ok(
        ChatroomSocketFrame::PrivateAck(PrivateCommandAck {
            room_id: "room-1".into(),
            request_id,
            command: "agent.ready".into(),
            ok: true,
            invocation_id: None,
            status: Some("ready".into()),
            error_code: None,
        }),
    )));
    let GatewayHttpResponse::Json { status, body } = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("logout should release the pending readiness request")
        .expect("typed readiness response expected")
    else {
        panic!("logout outcome should be typed JSON");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");
    gateway.shutdown();
}

#[test]
fn given_legacy_socket_when_modern_ready_route_is_called_then_do_not_send_unknown_frame() {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 404,
            body: br#"{}"#.to_vec(),
        });
    }
    let (gateway, control, _subscription, _bridge) = legacy_status_gateway(transport);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let status = gateway
            .handle_http(
                "GET",
                "/api/internal/chatrooms/rooms/room-1/status",
                &HashMap::new(),
                &[],
            )
            .unwrap();
        let GatewayHttpResponse::Json { body, .. } = status else {
            panic!("typed status expected");
        };
        if body["snapshotReady"] == true || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }

    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        )
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = response else {
        panic!("typed readiness response expected");
    };
    assert_eq!(status, 409);
    assert_eq!(body["outcome"], "Unknown");
    assert_eq!(body["mode"], "legacy");
    assert!(matches!(
        control.try_receive_command(),
        Err(mpsc::TryRecvError::Empty)
    ));
    gateway.shutdown();
}

#[test]
fn given_modern_ready_request_without_room_snapshot_then_reject_before_socket_send() {
    let transport = Arc::new(FakeTransport::default());
    for _ in 0..2 {
        transport.push(GatewayTransportResponse {
            status: 200,
            body: br#"{"capabilities":["agent-ready-v1","invocation-ack-v1"]}"#.to_vec(),
        });
    }
    let (gateway, control) = acking_gateway(transport);
    let _subscription = gateway.subscribe_sse(vec!["room-1".into()]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.active_socket_generation_for_test() == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_ne!(gateway.active_socket_generation_for_test(), 0);
    assert!(matches!(
        control.receive_command().unwrap(),
        ChatroomCommand::Subscribe { .. }
    ));

    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
            &HashMap::new(),
            br#"{}"#,
        )
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = response else {
        panic!("typed readiness response expected");
    };
    assert_eq!(status, 503);
    assert_eq!(body["outcome"], "Unknown");
    assert_eq!(body["mode"], "agent-ready-v1");
    assert!(matches!(
        control.try_receive_command(),
        Err(mpsc::TryRecvError::Empty)
    ));
    gateway.shutdown();
}

#[test]
fn given_ready_request_with_renderer_supplied_device_then_reject_instead_of_overriding_host() {
    let gateway = gateway(
        Arc::new(FakeTransport::default()),
        Arc::new(FakeBridge::default()),
    );
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
        &HashMap::new(),
        br#"{"deviceId":"attacker-device"}"#,
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("ready request must not accept caller-specified device identity"),
    };
    assert_eq!(error.status, 400);
    assert_eq!(error.code, "invalid_chatroom_request");
}

#[test]
fn given_management_capabilities_request_without_websocket_when_probed_then_use_frozen_upstream_path(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: br#"{"data":{"version":1}}"#.to_vec(),
    });
    let gateway = management_gateway(transport.clone());

    let response = gateway
        .handle_http(
            "GET",
            "/api/internal/chatrooms/agent-management/capabilities",
            &HashMap::new(),
            b"",
        )
        .expect("管理能力探测不依赖WebSocket ready");

    assert!(matches!(
        response,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    assert_eq!(
        *transport.requests.lock().unwrap(),
        vec![(
            "GET".into(),
            "/api/chatrooms/v2/agent-management/capabilities".into(),
            None
        )]
    );
}

#[test]
fn given_valid_register_management_command_without_websocket_when_forwarded_then_use_host_device_and_exact_receipt(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": management_receipt("register", "registered", "agent-1")})
            .to_string()
            .into_bytes(),
    });
    let gateway = management_gateway(transport.clone());
    let command = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手",
        "memoryShared": false
    });

    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
            &HashMap::new(),
            command.to_string().as_bytes(),
        )
        .expect("无WebSocket时管理注册仍可独立完成");
    let GatewayHttpResponse::Json { status, body } = response else {
        panic!("管理写入必须返回可核验回执");
    };

    assert_eq!(status, 200);
    assert_eq!(
        body["data"],
        management_receipt("register", "registered", "agent-1")
    );
    assert_eq!(
        *transport.requests.lock().unwrap(),
        vec![(
            "POST".into(),
            "/api/chatrooms/v2/rooms/room-1/agent-management/operations".into(),
            Some(command.to_string())
        )]
    );
}

#[test]
fn given_management_status_query_when_forwarded_then_use_only_operation_and_device() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": management_receipt("remove", "removed", "agent-1")})
            .to_string()
            .into_bytes(),
    });
    let gateway = management_gateway(transport.clone());
    let body = br#"{"operationId":"43d51f60-215e-45d4-9462-2d9a22562282","deviceId":"123e4567-e89b-42d3-a456-426614174000"}"#;

    let response = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations/status",
            &HashMap::new(),
            body,
        )
        .unwrap();
    assert!(matches!(
        response,
        GatewayHttpResponse::Json { status: 200, .. }
    ));
    assert_eq!(
        *transport.requests.lock().unwrap(),
        vec![(
            "POST".into(),
            "/api/chatrooms/v2/rooms/room-1/agent-management/operations/status".into(),
            Some(
                serde_json::json!({
                    "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
                    "deviceId": "123e4567-e89b-42d3-a456-426614174000"
                })
                .to_string(),
            )
        )]
    );
}

#[test]
fn given_management_identity_or_schema_mismatch_when_called_then_reject_before_upstream() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = management_gateway(transport.clone());
    let valid = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    let mut cases = vec![valid.clone()];
    cases[0]["deviceId"] = json!("123e4567-e89b-42d3-a456-426614174001");
    let mut unknown = valid.clone();
    unknown["ownerUserId"] = json!(1);
    cases.push(unknown);
    let mut null_boolean = valid.clone();
    null_boolean["memoryShared"] = Value::Null;
    cases.push(null_boolean);
    let mut wrong_action_field = valid;
    wrong_action_field["roomAgentId"] = json!("agent-1");
    cases.push(wrong_action_field);
    let wrong_action = serde_json::json!({
        "action": "create",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    cases.push(wrong_action);
    let wrong_operation_id = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-15d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    cases.push(wrong_operation_id);
    let oversized_avatar = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手",
        "avatar": "x".repeat(513)
    });
    cases.push(oversized_avatar);

    for command in cases {
        let result = gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
            &HashMap::new(),
            command.to_string().as_bytes(),
        );
        let Err(error) = result else {
            panic!("管理代理必须拒绝 {command}");
        };
        assert_eq!(error.status, 400, "管理命令错误状态不稳定：{command}");
        assert_eq!(error.code, "invalid_request", "错误码不稳定：{command}");
    }
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_invalid_management_status_query_fields_when_called_then_return_stable_invalid_request() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = management_gateway(transport.clone());
    let base = serde_json::json!({
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000"
    });
    let mut invalid_queries = vec![base.clone()];
    invalid_queries[0]["deviceId"] = Value::Null;
    let mut invalid_operation_id = base.clone();
    invalid_operation_id["operationId"] = json!("not-a-uuid");
    invalid_queries.push(invalid_operation_id);
    let mut caller_supplied_actor = base;
    caller_supplied_actor["ownerUserId"] = json!(1);
    invalid_queries.push(caller_supplied_actor);

    for query in invalid_queries {
        let result = gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations/status",
            &HashMap::new(),
            query.to_string().as_bytes(),
        );
        let Err(error) = result else {
            panic!("状态查询不得接受无效或调用方指定的身份字段");
        };
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "invalid_request");
    }
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_unverified_actor_or_unsupported_method_when_management_route_is_called_then_reject_without_transport(
) {
    let transport = Arc::new(FakeTransport::default());
    let gateway = unauthenticated_management_gateway(transport.clone());
    let body = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    })
    .to_string();
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
        &HashMap::new(),
        body.as_bytes(),
    );
    let Err(error) = result else {
        panic!("没有认证 actor 不得代理管理请求");
    };
    assert_eq!(error.status, 401);
    assert_eq!(error.code, "not_authenticated");

    let result = gateway.handle_http(
        "GET",
        "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
        &HashMap::new(),
        b"",
    );
    let Err(error) = result else {
        panic!("GET 不得命中 POST 管理操作路由");
    };
    assert_eq!(error.status, 405);
    assert_eq!(error.code, "method_not_allowed");
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_management_route_query_parameters_when_called_then_reject_instead_of_silently_dropping_them(
) {
    let transport = Arc::new(FakeTransport::default());
    let gateway = management_gateway(transport.clone());
    let result = gateway.handle_http(
        "GET",
        "/api/internal/chatrooms/agent-management/capabilities?version=2",
        &HashMap::new(),
        b"",
    );
    let Err(error) = result else {
        panic!("精确管理接口不能静默忽略查询参数");
    };
    assert_eq!(error.status, 400);
    assert_eq!(error.code, "invalid_request");
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_management_body_over_64_kibibytes_when_called_then_reject_before_upstream() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = management_gateway(transport.clone());
    let command = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手",
        "avatar": "x".repeat(65_536)
    });
    let body = command.to_string();
    assert!(body.len() > 64 * 1024);

    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
        &HashMap::new(),
        body.as_bytes(),
    );
    let Err(error) = result else {
        panic!("超限管理请求必须拒绝");
    };

    assert_eq!(error.status, 400);
    assert_eq!(error.code, "invalid_request");
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_upstream_management_error_when_returned_then_preserve_status_and_machine_code() {
    for (status, code) in [
        (404, "not_found"),
        (409, "management_operation_conflict"),
        (503, "service_unavailable"),
    ] {
        let transport = Arc::new(FakeTransport::default());
        transport.push(GatewayTransportResponse {
            status,
            body: serde_json::json!({"error":"upstream context","code":code})
                .to_string()
                .into_bytes(),
        });
        let gateway = management_gateway(transport);
        let command = serde_json::json!({
            "action": "register",
            "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
            "deviceId": "123e4567-e89b-42d3-a456-426614174000",
            "displayName": "测试助手"
        });
        let response = gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
                &HashMap::new(),
                command.to_string().as_bytes(),
            )
            .unwrap();
        let GatewayHttpResponse::Json {
            status: actual_status,
            body,
        } = response
        else {
            panic!("错误响应不能变成空成功");
        };
        assert_eq!(actual_status, status);
        assert_eq!(body["code"], code);
        assert_eq!(body["error"], "upstream context");
    }
}

#[test]
fn given_unknown_management_receipt_when_status_is_queried_then_keep_404_context_and_leave_leases_untouched(
) {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 404,
        body: serde_json::json!({
            "error": {
                "code": "management_operation_not_found",
                "message": "没有该回执",
                "context": {"operation": "lookup"}
            }
        })
        .to_string()
        .into_bytes(),
    });
    let gateway = management_gateway(transport);
    gateway.register_lease_for_test("room-1", "agent-1", "device-test");
    let body = br#"{"operationId":"43d51f60-215e-45d4-9462-2d9a22562282","deviceId":"123e4567-e89b-42d3-a456-426614174000"}"#;
    let result = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations/status",
            &HashMap::new(),
            body,
        )
        .unwrap();
    let GatewayHttpResponse::Json { status, body } = result else {
        panic!("历史回执404不得伪装为空成功");
    };
    assert_eq!(status, 404);
    assert_eq!(body["error"]["code"], "management_operation_not_found");
    assert_eq!(body["error"]["context"]["operation"], "lookup");
    assert!(gateway.has_lease_for_test("room-1", "agent-1"));
}

struct NestedManagementNotFoundEduTransport;

impl EduApiTransport for NestedManagementNotFoundEduTransport {
    fn send(&self, _request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        Ok(EduApiResponse {
            status: 404,
            headers: Vec::new(),
            body: json!({
                "error": {
                    "code": "management_operation_not_found",
                    "message": "没有该回执"
                }
            })
            .to_string()
            .into_bytes(),
        })
    }
}

#[test]
fn given_nested_edu_api_management_not_found_when_gateway_queries_status_then_preserve_contract_code(
) {
    let edu = Arc::new(
        EduApiClient::new(
            "https://test.invalid/module/edu-api",
            Arc::new(NestedManagementNotFoundEduTransport),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(AuthSession::new(edu, Arc::new(AuthenticatedTestStorage)).unwrap());
    let gateway = ChatroomGateway::new(
        auth,
        "https://test.invalid/module/edu-api".into(),
        Arc::new(FakeConnector),
        Arc::new(FakeBridge::default()),
        "123e4567-e89b-42d3-a456-426614174000".into(),
        ChatroomProtocolOptions::default(),
    )
    .unwrap();
    let body = br#"{"operationId":"43d51f60-215e-45d4-9462-2d9a22562282","deviceId":"123e4567-e89b-42d3-a456-426614174000"}"#;

    let result = gateway
        .handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations/status",
            &HashMap::new(),
            body,
        )
        .unwrap();

    let GatewayHttpResponse::Json { status, body } = result else {
        panic!("管理状态查询必须保持 JSON 错误响应");
    };
    assert_eq!(status, 404);
    assert_eq!(body["code"], "management_operation_not_found");
}

#[test]
fn given_new_management_fields_on_legacy_public_crud_when_posted_then_keep_old_parser_strict() {
    let transport = Arc::new(FakeTransport::default());
    let gateway = management_gateway(transport.clone());
    let body = serde_json::json!({
        "displayName": "测试助手",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282"
    })
    .to_string();
    let result = gateway.handle_http(
        "POST",
        "/api/chatrooms/v2/rooms/room-1/agents",
        &HashMap::new(),
        body.as_bytes(),
    );
    let Err(error) = result else {
        panic!("普通公开CRUD不得接纳管理代理字段");
    };
    assert_eq!(error.status, 400);
    assert_eq!(error.code, "invalid_chatroom_request");
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn given_wrong_management_receipt_actor_or_private_fields_when_returned_then_reject_receipt() {
    let mut wrong_actor = management_receipt("register", "registered", "agent-1");
    wrong_actor["ownerUserId"] = json!(2);
    let mut private_field = management_receipt("register", "registered", "agent-1");
    private_field["deviceIdHash"] = json!("must-not-cross-native-boundary");
    let mut wrong_operation_id = management_receipt("register", "registered", "agent-1");
    wrong_operation_id["operationId"] = json!("1520f285-e09f-4409-af57-5442ebdcb7cf");
    let wrong_status = management_receipt("register", "removed", "agent-1");
    let mut wrong_action = management_receipt("register", "registered", "agent-1");
    wrong_action["action"] = json!("remove");

    for receipt in [
        wrong_actor,
        private_field,
        wrong_operation_id,
        wrong_status,
        wrong_action,
    ] {
        let transport = Arc::new(FakeTransport::default());
        transport.push(GatewayTransportResponse {
            status: 200,
            body: serde_json::json!({"data":receipt}).to_string().into_bytes(),
        });
        let gateway = management_gateway(transport);
        let command = serde_json::json!({
            "action": "register",
            "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
            "deviceId": "123e4567-e89b-42d3-a456-426614174000",
            "displayName": "测试助手"
        });
        let result = gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
            &HashMap::new(),
            command.to_string().as_bytes(),
        );
        let Err(error) = result else {
            panic!("不能接受身份错误或包含私有字段的上游回执");
        };
        assert_eq!(error.status, 502);
        assert_eq!(error.code, "invalid_management_receipt");
    }
}

#[test]
fn given_multiple_legacy_agent_leases_when_sharing_updates_or_agent_registers_then_keep_existing_leases_and_remove_only_target(
) {
    let transport = Arc::new(FakeTransport::default());
    let mut update_receipt = management_receipt("update-sharing", "updated", "agent-1");
    update_receipt["operationId"] = json!("43d51f60-215e-45d4-9462-2d9a22562282");
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": update_receipt})
            .to_string()
            .into_bytes(),
    });
    let mut register_receipt = management_receipt("register", "registered", "agent-3");
    register_receipt["operationId"] = json!("1520f285-e09f-4409-af57-5442ebdcb7cf");
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": register_receipt})
            .to_string()
            .into_bytes(),
    });
    let mut remove_receipt = management_receipt("remove", "removed", "agent-1");
    remove_receipt["operationId"] = json!("834a2451-e6fa-44fe-8f41-4f1d74168605");
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": remove_receipt})
            .to_string()
            .into_bytes(),
    });
    let gateway = management_gateway(transport);
    gateway.register_lease_for_test("room-1", "agent-1", "device-test");
    gateway.register_lease_for_test("room-1", "agent-2", "device-test");

    let requests = [
        serde_json::json!({
            "action": "update-sharing",
            "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
            "deviceId": "123e4567-e89b-42d3-a456-426614174000",
            "roomAgentId": "agent-1",
            "memoryShared": true
        }),
        serde_json::json!({
            "action": "register",
            "operationId": "1520f285-e09f-4409-af57-5442ebdcb7cf",
            "deviceId": "123e4567-e89b-42d3-a456-426614174000",
            "displayName": "第三个助手"
        }),
        serde_json::json!({
            "action": "remove",
            "operationId": "834a2451-e6fa-44fe-8f41-4f1d74168605",
            "deviceId": "123e4567-e89b-42d3-a456-426614174000",
            "roomAgentId": "agent-1"
        }),
    ];
    for command in requests {
        gateway
            .handle_http(
                "POST",
                "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
                &HashMap::new(),
                command.to_string().as_bytes(),
            )
            .unwrap();
        if command["action"] != "remove" {
            assert!(gateway.has_lease_for_test("room-1", "agent-1"));
            assert!(gateway.has_lease_for_test("room-1", "agent-2"));
            assert_eq!(gateway.lease_count_for_test(), 2);
        }
    }

    assert!(!gateway.has_lease_for_test("room-1", "agent-1"));
    assert!(gateway.has_lease_for_test("room-1", "agent-2"));
    assert_eq!(gateway.lease_count_for_test(), 1);
}

#[test]
fn given_empty_success_management_response_when_returned_then_reject_without_receipt() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 204,
        body: Vec::new(),
    });
    let gateway = management_gateway(transport);
    let command = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    let result = gateway.handle_http(
        "POST",
        "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
        &HashMap::new(),
        command.to_string().as_bytes(),
    );

    assert!(result.is_err(), "204 不足以证明管理操作成功");
}

#[test]
fn given_auth_epoch_changes_during_management_io_when_old_receipt_returns_then_discard_it() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": management_receipt("register", "registered", "agent-1")})
            .to_string()
            .into_bytes(),
    });
    let (started, release) = transport.gate_next_request();
    let gateway = management_gateway(transport);
    let request_gateway = Arc::clone(&gateway);
    let command = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
            &HashMap::new(),
            command.to_string().as_bytes(),
        )
    });

    started.recv_timeout(Duration::from_secs(2)).unwrap();
    gateway.advance_auth_epoch_without_disconnect_for_test();
    release.send(()).unwrap();
    let result = request.join().unwrap();
    let Err(error) = result else {
        panic!("旧身份的管理回执不得跨 auth epoch 返回");
    };
    assert_eq!(error.status, 409);
    assert_eq!(error.code, "auth_changed");
}

#[test]
fn given_actor_logs_out_during_management_io_when_old_receipt_returns_then_discard_it() {
    let transport = Arc::new(FakeTransport::default());
    transport.push(GatewayTransportResponse {
        status: 200,
        body: serde_json::json!({"data": management_receipt("register", "registered", "agent-1")})
            .to_string()
            .into_bytes(),
    });
    let (started, release) = transport.gate_next_request();
    let (gateway, auth) = management_gateway_with_auth(transport);
    let request_gateway = Arc::clone(&gateway);
    let command = serde_json::json!({
        "action": "register",
        "operationId": "43d51f60-215e-45d4-9462-2d9a22562282",
        "deviceId": "123e4567-e89b-42d3-a456-426614174000",
        "displayName": "测试助手"
    });
    let request = thread::spawn(move || {
        request_gateway.handle_http(
            "POST",
            "/api/internal/chatrooms/rooms/room-1/agent-management/operations",
            &HashMap::new(),
            command.to_string().as_bytes(),
        )
    });

    started.recv_timeout(Duration::from_secs(2)).unwrap();
    auth.logout().unwrap();
    release.send(()).unwrap();
    let result = request.join().unwrap();
    let Err(error) = result else {
        panic!("登出后的旧 actor 回执不得返回");
    };
    assert_eq!(error.status, 409);
    assert_eq!(error.code, "auth_changed");
}

#[test]
fn given_ready_only_socket_selection_when_readiness_is_queried_then_require_ready_and_ack_for_modern_mode(
) {
    let cases = [
        ("ready-only", vec![ChatroomCapability::AgentReadyV1], false),
        ("ack-only", vec![ChatroomCapability::InvocationAckV1], false),
        (
            "delta-only",
            vec![ChatroomCapability::AgentDeltaFrameIdV1],
            false,
        ),
        (
            "ready-and-ack",
            vec![
                ChatroomCapability::AgentReadyV1,
                ChatroomCapability::InvocationAckV1,
            ],
            true,
        ),
    ];
    for (name, selected, modern) in cases {
        let gateway = gateway_with_options(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeBridge::default()),
            all_protocol_options(),
        );
        gateway.set_current_socket_generations_for_test(1, 1);
        gateway.set_capabilities_for_test(1, selected);
        gateway.set_room_snapshot_ready_for_test("room-1");

        let status = gateway
            .handle_http(
                "GET",
                "/api/internal/chatrooms/rooms/room-1/status",
                &HashMap::new(),
                b"",
            )
            .unwrap();
        let GatewayHttpResponse::Json { body, .. } = status else {
            panic!("房间状态应返回 JSON: {name}");
        };
        assert_eq!(
            body["capabilityState"],
            if modern { "ready" } else { "legacy" },
            "{name}"
        );
        assert_eq!(
            body["mode"],
            if modern { "modern" } else { "legacy" },
            "{name}"
        );

        if !modern {
            let readiness = gateway
                .handle_http(
                    "POST",
                    "/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready",
                    &HashMap::new(),
                    b"{}",
                )
                .unwrap();
            let GatewayHttpResponse::Json { body, .. } = readiness else {
                panic!("partial pair readiness must return a typed diagnostic: {name}");
            };
            assert_eq!(body["outcome"], "Unknown", "{name}");
            assert_eq!(body["code"], "legacy_mode", "{name}");
            assert_eq!(body["mode"], "legacy", "{name}");
        }
        gateway.shutdown();
    }
}
