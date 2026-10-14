use super::auth_session::{AuthError, AuthSession, AuthStorage, PersistedAuth};
use super::chatroom_client::{
    decode_message, decode_socket_frame, websocket_connect_config, BackoffWaiter, ChatroomClient,
    ChatroomClientError, ChatroomClientEvent, ChatroomHostResolver, ChatroomSocket,
    ChatroomSocketConnector, TungsteniteConnector,
};
use super::chatroom_protocol::{public_event, ChatroomCommand, ChatroomEvent, RoomCursor};
use super::edu_api_client::{
    EduApiClient, EduApiError, EduApiRequest, EduApiResponse, EduApiTransport,
};
use serde_json::json;
use std::collections::VecDeque;
use std::net::{SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::Message;

#[derive(Default)]
struct MemoryStorage {
    value: Mutex<Option<PersistedAuth>>,
    clears: AtomicUsize,
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
        self.clears.fetch_add(1, Ordering::SeqCst);
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

struct RefreshTransport {
    calls: AtomicUsize,
}

impl EduApiTransport for RefreshTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.path, "/api/auth/refresh");
        Ok(EduApiResponse {
            status: 200,
            headers: Vec::new(),
            body: br#"{"token":"new-token","refresh_token":"new-refresh"}"#.to_vec(),
        })
    }
}

struct FailingRefreshTransport {
    calls: AtomicUsize,
}

impl EduApiTransport for FailingRefreshTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.path, "/api/auth/refresh");
        Err(EduApiError::Transport("测试刷新网络失败".into()))
    }
}

struct RetryableRefreshTransport {
    calls: AtomicUsize,
}

impl EduApiTransport for RetryableRefreshTransport {
    fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(request.path, "/api/auth/refresh");
        if call == 1 {
            return Err(EduApiError::Transport("测试刷新网络失败".into()));
        }
        Ok(EduApiResponse {
            status: 200,
            headers: Vec::new(),
            body: br#"{"token":"new-token","refresh_token":"new-refresh"}"#.to_vec(),
        })
    }
}

struct FakeSocket {
    received: Mutex<VecDeque<Result<ChatroomEvent, ChatroomClientError>>>,
    receive_release: Mutex<Option<mpsc::Receiver<()>>>,
    receive_started: Mutex<Option<mpsc::Sender<()>>>,
    receive_count: AtomicUsize,
    receive_gate: Mutex<Option<ReceiveSequenceGate>>,
    sent: Mutex<Vec<ChatroomCommand>>,
    on_non_subscribe_send: Mutex<Option<mpsc::Sender<()>>>,
    ack_frame: Mutex<Option<super::chatroom_protocol::PrivateCommandAck>>,
    ack_ok: AtomicBool,
    ack_room_override: Mutex<Option<String>>,
    ack_command_override: Mutex<Option<String>>,
    ack_invocation_override: Mutex<Option<String>>,
    reject_after_close: AtomicBool,
    on_subscribe: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    closed: AtomicBool,
    send_count: AtomicUsize,
    fail_on_send: AtomicUsize,
    fail_connected_ordinary: AtomicBool,
    fail_first_ordinary: AtomicBool,
    ordinary_send_count: AtomicUsize,
}

struct ReceiveSequenceGate {
    call_at: usize,
    observed: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

impl FakeSocket {
    fn new(events: Vec<Result<ChatroomEvent, ChatroomClientError>>) -> Arc<Self> {
        Arc::new(Self {
            received: Mutex::new(events.into()),
            receive_release: Mutex::new(None),
            receive_started: Mutex::new(None),
            receive_count: AtomicUsize::new(0),
            receive_gate: Mutex::new(None),
            sent: Mutex::new(Vec::new()),
            on_non_subscribe_send: Mutex::new(None),
            ack_frame: Mutex::new(None),
            ack_ok: AtomicBool::new(true),
            ack_room_override: Mutex::new(None),
            ack_command_override: Mutex::new(None),
            ack_invocation_override: Mutex::new(None),
            reject_after_close: AtomicBool::new(false),
            on_subscribe: Mutex::new(None),
            closed: AtomicBool::new(false),
            send_count: AtomicUsize::new(0),
            fail_on_send: AtomicUsize::new(0),
            fail_connected_ordinary: AtomicBool::new(false),
            fail_first_ordinary: AtomicBool::new(false),
            ordinary_send_count: AtomicUsize::new(0),
        })
    }

    fn gated_disconnect() -> (Arc<Self>, mpsc::Sender<()>) {
        let (socket, _started, release) = Self::gated_disconnect_with_start();
        (socket, release)
    }

    fn gate_receive_call(&self, call_at: usize) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (observed, observed_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        *self.receive_gate.lock().unwrap() = Some(ReceiveSequenceGate {
            call_at,
            observed,
            release: release_rx,
        });
        (observed_rx, release)
    }

    fn gated_disconnect_with_start() -> (Arc<Self>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (release, wait) = mpsc::channel();
        let (started, started_receiver) = mpsc::channel();
        let socket = Self::new(vec![Err(ChatroomClientError::new(
            "disconnected",
            "测试立即断开",
        ))]);
        *socket.receive_release.lock().unwrap() = Some(wait);
        *socket.receive_started.lock().unwrap() = Some(started);
        (socket, started_receiver, release)
    }

    fn with_send_failures(
        events: Vec<Result<ChatroomEvent, ChatroomClientError>>,
        failures: usize,
    ) -> Arc<Self> {
        let socket = Self::new(events);
        socket.fail_on_send.store(failures, Ordering::SeqCst);
        socket
    }

    fn with_connected_ordinary_failures(
        events: Vec<Result<ChatroomEvent, ChatroomClientError>>,
        fail_first_ordinary: bool,
    ) -> Arc<Self> {
        let socket = Self::new(events);
        socket.fail_connected_ordinary.store(true, Ordering::SeqCst);
        socket
            .fail_first_ordinary
            .store(fail_first_ordinary, Ordering::SeqCst);
        socket
    }

    fn on_subscribe(socket: &Arc<Self>, callback: Arc<dyn Fn() + Send + Sync>) {
        *socket.on_subscribe.lock().unwrap() = Some(callback);
    }

    fn observe_non_subscribe_send(&self) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::channel();
        *self.on_non_subscribe_send.lock().unwrap() = Some(sender);
        receiver
    }

    fn close_during_test(&self) {
        self.reject_after_close.store(true, Ordering::SeqCst);
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl ChatroomSocket for Arc<FakeSocket> {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        if self.reject_after_close.load(Ordering::SeqCst) && self.closed.load(Ordering::SeqCst) {
            return Err(ChatroomClientError::new("disconnected", "测试断开连接"));
        }
        let send_number = self.send_count.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_on_send.load(Ordering::SeqCst) == send_number {
            return Err(ChatroomClientError::new("send_failed", "测试写入失败"));
        }
        if !matches!(command, ChatroomCommand::Subscribe { .. })
            && self.fail_connected_ordinary.load(Ordering::SeqCst)
        {
            let ordinary_number = self.ordinary_send_count.fetch_add(1, Ordering::SeqCst) + 1;
            let fail_first = self.fail_first_ordinary.load(Ordering::SeqCst);
            if ordinary_number >= 2 || (fail_first && ordinary_number == 1) {
                return Err(ChatroomClientError::new(
                    "send_failed",
                    "测试连接态写入失败",
                ));
            }
        }
        self.sent.lock().unwrap().push(command.clone());
        if !matches!(command, ChatroomCommand::Subscribe { .. }) {
            if let Some(observer) = self.on_non_subscribe_send.lock().unwrap().as_ref() {
                let _ = observer.send(());
            }
        }
        if let ChatroomCommand::ConfirmedLifecycle {
            request_id,
            command,
        } = command
        {
            let (room_id, command_name, invocation_id) = match command.as_ref() {
                ChatroomCommand::Ready { room_id, .. } => (room_id.clone(), "agent.ready", None),
                ChatroomCommand::Unready { room_id, .. } => {
                    (room_id.clone(), "agent.unready", None)
                }
                ChatroomCommand::AgentAccepted {
                    room_id,
                    invocation_id,
                    ..
                } => (
                    room_id.clone(),
                    "agent.accepted",
                    Some(invocation_id.clone()),
                ),
                ChatroomCommand::AgentEvent {
                    room_id,
                    invocation_id,
                    event,
                } => (
                    room_id.clone(),
                    match event {
                        super::chatroom_protocol::AgentEventPayload::Delta { .. } => "agent.delta",
                        super::chatroom_protocol::AgentEventPayload::Completed { .. } => {
                            "agent.completed"
                        }
                        super::chatroom_protocol::AgentEventPayload::Failed { .. } => {
                            "agent.failed"
                        }
                    },
                    Some(invocation_id.clone()),
                ),
                _ => unreachable!(),
            };
            let mut ack = super::chatroom_protocol::PrivateCommandAck {
                room_id,
                request_id: request_id.clone(),
                command: command_name.into(),
                ok: self.ack_ok.load(Ordering::SeqCst),
                invocation_id,
                status: Some("accepted".into()),
                error_code: (!self.ack_ok.load(Ordering::SeqCst)).then(|| "forbidden".into()),
            };
            if let Some(room_id) = self.ack_room_override.lock().unwrap().clone() {
                ack.room_id = room_id;
            }
            if let Some(command) = self.ack_command_override.lock().unwrap().clone() {
                ack.command = command;
            }
            if let Some(invocation_id) = self.ack_invocation_override.lock().unwrap().clone() {
                ack.invocation_id = Some(invocation_id);
            }
            *self.ack_frame.lock().unwrap() = Some(ack);
        }
        if matches!(command, ChatroomCommand::Subscribe { .. }) {
            if let Some(callback) = self.on_subscribe.lock().unwrap().clone() {
                callback();
            }
        }
        Ok(())
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        let call = self.receive_count.fetch_add(1, Ordering::SeqCst) + 1;
        let gate = {
            let mut gate = self.receive_gate.lock().unwrap();
            if gate.as_ref().is_some_and(|value| value.call_at == call) {
                gate.take()
            } else {
                None
            }
        };
        if let Some(gate) = gate {
            let _ = gate.observed.send(());
            gate.release
                .recv_timeout(Duration::from_secs(1))
                .expect("测试 receive gate 未释放");
        }
        if let Some(started) = self.receive_started.lock().unwrap().take() {
            let _ = started.send(());
        }
        if let Some(release) = self.receive_release.lock().unwrap().take() {
            release
                .recv_timeout(Duration::from_secs(1))
                .expect("测试 socket 未收到放行信号");
        }
        self.received
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(ChatroomClientError::new("read_timeout", "测试读取超时")))
    }

    fn receive_frame(
        &mut self,
    ) -> Result<super::chatroom_client::ChatroomSocketFrame, ChatroomClientError> {
        if let Some(ack) = self.ack_frame.lock().unwrap().take() {
            return Ok(super::chatroom_client::ChatroomSocketFrame::PrivateAck(ack));
        }
        self.receive_json()
            .map(super::chatroom_client::ChatroomSocketFrame::Event)
    }

    fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

enum ConnectResult {
    Socket(Arc<FakeSocket>),
    Error(ChatroomClientError),
}

struct ConnectGate {
    loaded: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

struct FakeConnector {
    results: Mutex<VecDeque<ConnectResult>>,
    authorizations: Mutex<Vec<String>>,
    attempts: AtomicUsize,
    connect_gate: Mutex<Option<ConnectGate>>,
}

impl FakeConnector {
    fn new(results: Vec<ConnectResult>) -> Arc<Self> {
        Arc::new(Self {
            results: Mutex::new(results.into()),
            authorizations: Mutex::new(Vec::new()),
            attempts: AtomicUsize::new(0),
            connect_gate: Mutex::new(None),
        })
    }

    fn gate_next_connect(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.connect_gate.lock().unwrap() = Some(ConnectGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }
}

impl ChatroomSocketConnector for FakeConnector {
    fn connect(
        &self,
        _url: &str,
        authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.authorizations
            .lock()
            .unwrap()
            .push(authorization.to_string());
        if let Some(gate) = self.connect_gate.lock().unwrap().take() {
            let _ = gate.loaded.send(());
            gate.release
                .recv_timeout(Duration::from_secs(1))
                .expect("测试 connector connect 未收到放行信号");
        }
        match self.results.lock().unwrap().pop_front() {
            Some(ConnectResult::Socket(socket)) => Ok(Box::new(socket)),
            Some(ConnectResult::Error(error)) => Err(error),
            None => Err(ChatroomClientError::new("transport", "测试连接结果耗尽")),
        }
    }
}

struct SlowResolver {
    started: Mutex<Option<mpsc::Sender<()>>>,
    calls: AtomicUsize,
}

struct LoopbackResolver(SocketAddr);

impl ChatroomHostResolver for LoopbackResolver {
    fn resolve(
        &self,
        _host: &str,
        _port: u16,
        _stop: &AtomicBool,
    ) -> Result<Vec<SocketAddr>, ChatroomClientError> {
        Ok(vec![self.0])
    }
}

impl ChatroomHostResolver for SlowResolver {
    fn resolve(
        &self,
        _host: &str,
        _port: u16,
        stop: &AtomicBool,
    ) -> Result<Vec<std::net::SocketAddr>, ChatroomClientError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(signal) = self.started.lock().unwrap().take() {
            let _ = signal.send(());
        }
        while !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(ChatroomClientError::new(
            "client_closed",
            "聊天室连接已关闭",
        ))
    }
}

struct FakeBackoff {
    waits: Mutex<Vec<Duration>>,
}

impl FakeBackoff {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            waits: Mutex::new(Vec::new()),
        })
    }
}

impl BackoffWaiter for FakeBackoff {
    fn wait(&self, duration: Duration, _stop: &AtomicBool) -> bool {
        self.waits.lock().unwrap().push(duration);
        true
    }
}

fn auth(transport: Arc<dyn EduApiTransport>, storage: Arc<MemoryStorage>) -> Arc<AuthSession> {
    *storage.value.lock().unwrap() = Some(PersistedAuth {
        access_token: "old-token".into(),
        refresh_token: Some("refresh-token".into()),
        provider: "legacy".into(),
        user: Some(json!({"id": 7})),
        expires_at: None,
    });
    let client =
        Arc::new(EduApiClient::new("https://edu.example/module/edu-api", transport, 8).unwrap());
    Arc::new(AuthSession::new(client, storage).unwrap())
}

fn subscribe() -> ChatroomCommand {
    ChatroomCommand::Subscribe {
        rooms: vec![RoomCursor {
            room_id: "room-1".into(),
            after_seq: 0,
        }],
        device_id: "device-1".into(),
        capabilities: None,
    }
}

fn renew_lease() -> ChatroomCommand {
    ChatroomCommand::RenewLease {
        room_id: "room-1".into(),
        agent_id: "agent-1".into(),
        device_id: "device-1".into(),
    }
}

fn wait_for_status(
    receiver: &mpsc::Receiver<ChatroomClientEvent>,
    expected_code: &str,
    timeout: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match receiver.recv_timeout(Duration::from_millis(20).min(remaining)) {
            Ok(ChatroomClientEvent::Status { code, .. }) if code == expected_code => return true,
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

fn receive_until(
    receiver: &mpsc::Receiver<ChatroomClientEvent>,
    predicate: impl Fn(&ChatroomClientEvent) -> bool,
) -> ChatroomClientEvent {
    for _ in 0..20 {
        let event = receiver
            .recv_timeout(Duration::from_millis(100))
            .expect("测试事件超时");
        if predicate(&event) {
            return event;
        }
    }
    panic!("未收到预期事件");
}

#[test]
fn given_ws_handshake_401_when_client_connects_then_refresh_once_and_retry_with_new_bearer() {
    let storage = Arc::new(MemoryStorage::default());
    let transport = Arc::new(RefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
        ConnectResult::Socket(socket),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(transport.clone(), storage),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(
        connector.authorizations.lock().unwrap().as_slice(),
        ["Bearer old-token", "Bearer new-token"]
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    client.shutdown();
}

#[test]
fn given_connected_when_equivalent_subscribe_is_repeated_then_do_not_reconnect() {
    let first = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(first)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    client.command(subscribe()).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);
    client.shutdown();
}

#[test]
fn given_device_or_capabilities_change_when_connected_then_reconnect_with_new_identity() {
    let first = FakeSocket::new(Vec::new());
    let second = FakeSocket::new(Vec::new());
    let third = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first.clone()),
        ConnectResult::Socket(second.clone()),
        ConnectResult::Socket(third.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });

    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "device-2".into(),
            capabilities: None,
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert!(first.closed.load(Ordering::SeqCst));
    assert!(matches!(
        second.sent.lock().unwrap().first(),
        Some(ChatroomCommand::Subscribe { device_id, capabilities: None, .. })
            if device_id == "device-2"
    ));

    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "device-2".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
            ]),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert!(second.closed.load(Ordering::SeqCst));
    assert!(matches!(
        third.sent.lock().unwrap().first(),
        Some(ChatroomCommand::Subscribe { device_id, capabilities: Some(capabilities), .. })
            if device_id == "device-2"
                && capabilities == &[super::chatroom_protocol::ChatroomCapability::AgentReadyV1]
    ));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 3);
    client.shutdown();
}

#[test]
fn given_invalid_command_when_client_is_unavailable_then_reject_before_queue_mutation() {
    let connector = FakeConnector::new(Vec::new());
    let (events, _receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.start();
    let error = client
        .command(ChatroomCommand::Unsubscribe { room_id: "".into() })
        .unwrap_err();
    assert_eq!(error.code, "invalid_command");
    client.command(subscribe()).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);
    client.shutdown();
}

#[test]
fn given_second_ws_401_after_refresh_when_client_connects_then_emit_auth_expired_and_stop() {
    let storage = Arc::new(MemoryStorage::default());
    let transport = Arc::new(RefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let connector = FakeConnector::new(vec![
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
    ]);
    let (events, receiver) = mpsc::channel();
    let auth = auth(transport.clone(), storage.clone());
    let client = ChatroomClient::new(
        auth.clone(),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "auth_expired"),
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 2);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    assert!(!auth.auth_state().authenticated);
    client.shutdown();
}

#[test]
fn given_temporary_refresh_failure_when_ws_401_then_keep_auth_and_reach_unavailable_without_auth_expired(
) {
    let storage = Arc::new(MemoryStorage::default());
    let transport = Arc::new(FailingRefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let connector = FakeConnector::new(
        std::iter::once(ConnectResult::Error(ChatroomClientError::new(
            "unauthorized",
            "未授权",
        )))
        .chain(
            (0..7).map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败"))),
        )
        .collect(),
    );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let auth = auth(transport.clone(), storage.clone());
    let client = ChatroomClient::new_with_backoff(
        auth.clone(),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff.clone(),
    );
    client.start();
    client.command(subscribe()).unwrap();

    let mut seen_auth_expired = false;
    loop {
        let event = receiver
            .recv_timeout(Duration::from_millis(100))
            .expect("未收到刷新失败结果");
        match event {
            ChatroomClientEvent::Status { code, .. } if code == "auth_expired" => {
                seen_auth_expired = true;
            }
            ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable" => break,
            _ => {}
        }
    }
    assert!(!seen_auth_expired);
    assert!(auth.auth_state().authenticated);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    assert_eq!(storage.clears.load(Ordering::SeqCst), 0);
    assert_eq!(connector.authorizations.lock().unwrap().len(), 8);
    assert_eq!(backoff.waits.lock().unwrap().len(), 7);
    client.shutdown();
}

#[test]
fn given_temporary_refresh_failure_then_second_ws_401_when_connecting_then_clear_auth_once_without_third_retry(
) {
    let storage = Arc::new(MemoryStorage::default());
    let transport = Arc::new(FailingRefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let connector = FakeConnector::new(vec![
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
    ]);
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let auth = auth(transport.clone(), storage.clone());
    let client = ChatroomClient::new_with_backoff(
        auth.clone(),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();

    let auth_expired = wait_for_status(&receiver, "auth_expired", Duration::from_secs(1));
    let auth_expired_count = receiver
        .try_iter()
        .filter(|event| {
            matches!(event, ChatroomClientEvent::Status { code, .. } if code == "auth_expired")
        })
        .count()
        + usize::from(auth_expired);
    let attempts = connector.attempts.load(Ordering::SeqCst);
    client.shutdown();

    assert!(auth_expired, "第二次握手 401 应立即使认证失效");
    assert_eq!(auth_expired_count, 1);
    assert_eq!(storage.clears.load(Ordering::SeqCst), 1);
    assert!(!auth.auth_state().authenticated);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    assert_eq!(attempts, 2, "认证失效后不应进行第三次连接");
}

#[test]
fn given_unavailable_after_temporary_refresh_failure_when_command_arrives_then_retry_refresh_with_new_budget(
) {
    let first_socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(
        std::iter::once(ConnectResult::Error(ChatroomClientError::new(
            "unauthorized",
            "未授权",
        )))
        .chain(
            (0..7).map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败"))),
        )
        .chain([
            ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
            ConnectResult::Socket(first_socket.clone()),
        ])
        .collect(),
    );
    let transport = Arc::new(RetryableRefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let auth = auth(transport.clone(), Arc::new(MemoryStorage::default()));
    let client = ChatroomClient::new_with_backoff(
        auth.clone(),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    client
        .command(ChatroomCommand::RenewLease {
            room_id: "room-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert!(auth.auth_state().authenticated);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    assert_eq!(connector.authorizations.lock().unwrap().len(), 10);
    assert_eq!(first_socket.sent.lock().unwrap().len(), 2);
    client.shutdown();
}

#[test]
fn given_socket_event_when_reader_receives_then_emit_structured_event_without_jwt() {
    let storage = Arc::new(MemoryStorage::default());
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 1,
            payload: json!({"messages": []}),
        }),
        Ok(ChatroomEvent::MessageCreated {
            room_id: "room-1".into(),
            seq: 2,
            payload: json!({"messageId":"m-1"}),
        }),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            storage,
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    let event = receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::MessageCreated { seq: 2, .. },
                ..
            }
        )
    });
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::MessageCreated { seq: 2, .. },
            ..
        }
    ));
    assert!(!encoded.contains("old-token"));
    assert!(!encoded.contains("Authorization"));
    client.shutdown();
}

#[test]
fn given_disconnect_when_reader_retries_then_use_bounded_exponential_backoff() {
    let connector = FakeConnector::new(
        (0..16)
            .map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")))
            .collect(),
    );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff.clone(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    assert_eq!(
        backoff.waits.lock().unwrap().as_slice(),
        [
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
            Duration::from_secs(16),
            Duration::from_secs(30),
            Duration::from_secs(30)
        ]
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 8);
    client
        .command(ChatroomCommand::RenewLease {
            room_id: "room-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        })
        .unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 16);
    assert_eq!(backoff.waits.lock().unwrap().len(), 14);
    client.shutdown();
}

#[test]
fn given_immediate_disconnects_with_ordinary_commands_then_budget_still_reaches_unavailable() {
    let mut results = Vec::new();
    let mut releases = Vec::new();
    for _ in 0..8 {
        let (socket, release) = FakeSocket::gated_disconnect();
        results.push(ConnectResult::Socket(socket));
        releases.push(release);
    }
    let connector = FakeConnector::new(results);
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();
    for release in releases {
        receive_until(&receiver, |event| {
            matches!(event, ChatroomClientEvent::ConnectedAt { .. })
        });
        client
            .command(ChatroomCommand::RenewLease {
                room_id: "room-1".into(),
                agent_id: "agent-1".into(),
                device_id: "device-1".into(),
            })
            .unwrap();
        release.send(()).unwrap();
    }
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 8);
    client.shutdown();
}

#[test]
fn given_unavailable_then_ordinary_command_wakes_one_new_retry_budget() {
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(
        (0..8)
            .map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")))
            .chain([ConnectResult::Socket(socket.clone())])
            .collect(),
    );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    client
        .command(ChatroomCommand::RenewLease {
            room_id: "room-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(connector.authorizations.lock().unwrap().len(), 9);
    client.shutdown();
}

#[test]
fn given_unavailable_then_burst_ordinary_commands_only_one_can_claim_wake_budget() {
    let connector =
        FakeConnector::new(
            (0..8)
                .map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")))
                .chain((0..100).map(|_| {
                    ConnectResult::Error(ChatroomClientError::new("transport", "连接失败"))
                }))
                .collect(),
        );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );

    let (loaded, release) = client.gate_next_command();
    let command_client = Arc::new(client);
    let first_command_client = command_client.clone();
    let first = std::thread::spawn(move || {
        first_command_client
            .command(ChatroomCommand::RenewLease {
                room_id: "room-1".into(),
                agent_id: "agent-1".into(),
                device_id: "device-1".into(),
            })
            .unwrap();
    });
    loaded
        .recv_timeout(Duration::from_secs(1))
        .expect("测试第一个命令未观察到唤醒预算");
    for _ in 0..7 {
        command_client
            .command(ChatroomCommand::RenewLease {
                room_id: "room-1".into(),
                agent_id: "agent-1".into(),
                device_id: "device-1".into(),
            })
            .unwrap();
    }
    release.send(()).unwrap();
    first.join().unwrap();

    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 16);
    command_client.shutdown();
}

#[test]
fn given_pending_commands_before_connect_then_flush_all_in_order_after_initial_subscribe() {
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    client
        .command(ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "message-1".into(),
            content: "hello".into(),
            mention_agent_ids: Vec::new(),
            attachment_ids: Vec::new(),
        })
        .unwrap();
    client
        .command(ChatroomCommand::RenewLease {
            room_id: "room-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    for _ in 0..10_000 {
        if socket.sent.lock().unwrap().len() == 3 {
            break;
        }
        std::thread::yield_now();
    }
    let sent = socket.sent.lock().unwrap();
    assert!(matches!(&sent[0], ChatroomCommand::Subscribe { .. }));
    assert!(matches!(&sent[1], ChatroomCommand::SendMessage { .. }));
    assert!(matches!(&sent[2], ChatroomCommand::RenewLease { .. }));
    client.shutdown();
}

#[test]
fn given_pause_after_unavailable_generation_check_then_close_command_is_discarded() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    let (loaded, release) = client.gate_unavailable_command_apply();
    client.start();
    client.command(ChatroomCommand::Close).unwrap();
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("unavailable 命令未到达 apply gate");
    client.pause();
    assert_eq!(client.selected_capabilities(), (0, Vec::new()));
    release.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    client.resume();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    client.shutdown();
}

#[test]
fn given_pause_after_socket_ready_then_connected_event_is_discarded_and_socket_closes() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    let (loaded, release) = client.gate_connection_ready();
    client.start();
    client.command(subscribe()).unwrap();
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("socket ready 未到达 gate");
    client.pause();
    release.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert!(receiver
        .try_iter()
        .all(|event| !matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    assert!(socket.closed.load(Ordering::SeqCst));
    client.shutdown();
}

#[test]
fn given_pending_send_failure_then_reconnect_preserves_command_for_ordered_retry() {
    let first = FakeSocket::with_send_failures(Vec::new(), 2);
    let second = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first.clone()),
        ConnectResult::Socket(second.clone()),
    ]);
    let backoff = FakeBackoff::new();
    let (events, _receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        backoff,
    );
    client.start();
    client.command(subscribe()).unwrap();
    for _ in 0..100_000 {
        if first.sent.lock().unwrap().len() == 1 {
            break;
        }
        std::thread::yield_now();
    }
    assert!(matches!(
        first.sent.lock().unwrap().first(),
        Some(ChatroomCommand::Subscribe { .. })
    ));
    client
        .command(ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "message-1".into(),
            content: "hello".into(),
            mention_agent_ids: Vec::new(),
            attachment_ids: Vec::new(),
        })
        .unwrap();
    for _ in 0..10_000 {
        if first.send_count.load(Ordering::SeqCst) >= 2 {
            break;
        }
        std::thread::yield_now();
    }
    assert_eq!(first.send_count.load(Ordering::SeqCst), 2);
    for _ in 0..10_000 {
        if second.sent.lock().unwrap().len() == 2 {
            break;
        }
        std::thread::yield_now();
    }
    assert_eq!(second.sent.lock().unwrap().len(), 2);
    let first_sent = first.sent.lock().unwrap();
    assert_eq!(first_sent.len(), 1);
    assert!(matches!(&first_sent[0], ChatroomCommand::Subscribe { .. }));
    let sent = second.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert!(matches!(&sent[0], ChatroomCommand::Subscribe { .. }));
    assert!(
        matches!(&sent[1], ChatroomCommand::SendMessage { client_message_id, .. } if client_message_id == "message-1")
    );
    client.shutdown();
}

#[test]
fn given_connected_pending_send_fails_on_eight_sockets_then_stop_before_ninth_and_preserve_order() {
    let client_slot: Arc<Mutex<Option<Arc<ChatroomClient>>>> = Arc::new(Mutex::new(None));
    let mut results = Vec::new();
    for index in 0..8 {
        let socket = FakeSocket::with_connected_ordinary_failures(Vec::new(), index == 0);
        let command_client_slot = client_slot.clone();
        let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let client = command_client_slot
                .lock()
                .unwrap()
                .as_ref()
                .expect("测试客户端尚未就绪")
                .clone();
            client.command(renew_lease()).unwrap();
        });
        FakeSocket::on_subscribe(&socket, callback);
        results.push(ConnectResult::Socket(socket));
    }
    let ninth = FakeSocket::new(Vec::new());
    results.push(ConnectResult::Socket(ninth.clone()));
    let connector = FakeConnector::new(results);
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    ));
    *client_slot.lock().unwrap() = Some(client.clone());
    client.start();
    client.command(subscribe()).unwrap();

    for _ in 0..8 {
        receive_until(&receiver, |event| {
            matches!(event, ChatroomClientEvent::ConnectedAt { .. })
        });
    }
    let unavailable = wait_for_status(&receiver, "realtime_unavailable", Duration::from_secs(1));
    let attempts = connector.attempts.load(Ordering::SeqCst);
    if !unavailable || attempts != 8 {
        client.shutdown();
        panic!("连接态发送失败应在第 8 次后停止：unavailable={unavailable}, attempts={attempts}");
    }

    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 9);
    let sent = ninth.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert!(matches!(&sent[0], ChatroomCommand::Subscribe { .. }));
    assert!(matches!(&sent[1], command if *command == renew_lease()));
    drop(sent);
    client.shutdown();
}

#[test]
fn given_unavailable_status_is_observed_then_ordinary_command_claims_the_next_retry_budget() {
    let mut results = Vec::new();
    for _ in 0..8 {
        results.push(ConnectResult::Error(ChatroomClientError::new(
            "transport",
            "测试连接失败",
        )));
    }
    let ninth = FakeSocket::new(Vec::new());
    results.push(ConnectResult::Socket(ninth.clone()));
    let connector = FakeConnector::new(results);
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    ));
    let (status_observed, release_status) = client.gate_next_unavailable_status();
    client.start();
    client.command(subscribe()).unwrap();

    status_observed
        .recv_timeout(Duration::from_secs(1))
        .expect("未观察到 realtime_unavailable 发布窗口");
    client.command(renew_lease()).unwrap();
    release_status.send(()).unwrap();

    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 9);
    assert!(matches!(
        ninth.sent.lock().unwrap().as_slice(),
        [
            ChatroomCommand::Subscribe { .. },
            ChatroomCommand::RenewLease { .. }
        ]
    ));
    client.shutdown();
}

#[test]
fn given_pending_send_exhausts_budget_then_observed_unavailable_status_wakes_once() {
    let client_slot: Arc<Mutex<Option<Arc<ChatroomClient>>>> = Arc::new(Mutex::new(None));
    let mut results = Vec::new();
    for index in 0..8 {
        let socket = FakeSocket::with_connected_ordinary_failures(Vec::new(), index == 0);
        let command_client_slot = client_slot.clone();
        let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let client = command_client_slot
                .lock()
                .unwrap()
                .as_ref()
                .expect("测试客户端尚未就绪")
                .clone();
            client.command(renew_lease()).unwrap();
        });
        FakeSocket::on_subscribe(&socket, callback);
        results.push(ConnectResult::Socket(socket));
    }
    let ninth = FakeSocket::new(Vec::new());
    results.push(ConnectResult::Socket(ninth.clone()));
    let connector = FakeConnector::new(results);
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff,
    ));
    *client_slot.lock().unwrap() = Some(client.clone());
    let (status_observed, release_status) = client.gate_next_unavailable_status();
    client.start();
    client.command(subscribe()).unwrap();
    for _ in 0..8 {
        receive_until(&receiver, |event| {
            matches!(event, ChatroomClientEvent::ConnectedAt { .. })
        });
    }

    status_observed
        .recv_timeout(Duration::from_secs(1))
        .expect("未观察到 pending 写失败后的 realtime_unavailable 发布窗口");
    client.command(renew_lease()).unwrap();
    release_status.send(()).unwrap();

    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 9);
    let sent = ninth.sent.lock().unwrap();
    assert_eq!(sent.len(), 3);
    assert!(matches!(&sent[0], ChatroomCommand::Subscribe { .. }));
    assert!(matches!(&sent[1], ChatroomCommand::RenewLease { .. }));
    assert!(matches!(&sent[2], ChatroomCommand::RenewLease { .. }));
    drop(sent);
    client.shutdown();
}

#[test]
fn given_invalid_socket_frames_then_return_stable_protocol_errors_without_payload_leak() {
    let invalid_utf8 = decode_message(Message::Binary(vec![0xff].into())).unwrap_err();
    assert_eq!(invalid_utf8.code, "protocol_invalid");
    let invalid_json = decode_message(Message::Text("not-json".into())).unwrap_err();
    assert_eq!(invalid_json.code, "protocol_invalid");
    let oversized = decode_message(Message::Binary(vec![b' '; 128 * 1024 + 1].into())).unwrap_err();
    assert_eq!(oversized.code, "payload_too_large");
    let encoded = format!("{:?}", invalid_utf8);
    assert!(!encoded.contains("ff"));
}

#[test]
fn given_completed_frame_over_64_kib_but_under_128_kib_when_client_decodes_then_preserve_content() {
    let content = "界".repeat(21_845);
    let frame = json!({
        "type":"agent.completed",
        "roomId":"room-1",
        "payload":{
            "invocationId":"invocation-1",
            "content":content,
            "mentionAgentIds":["agent-1", "agent-2", "agent-3"],
            "attachmentIds":["attachment-1", "attachment-2"],
            "clientMessageId":"client-message-1"
        }
    });
    let encoded = serde_json::to_string(&frame).unwrap();
    assert!(encoded.len() > 64 * 1024);
    assert!(encoded.len() <= 128 * 1024);

    let event = decode_message(Message::Text(encoded.into()))
        .unwrap()
        .expect("completed frame should decode");
    match event {
        ChatroomEvent::AgentCompleted { payload, .. } => {
            assert_eq!(payload["content"], content);
        }
        other => panic!("unexpected client event: {other:?}"),
    }
}

#[test]
fn given_websocket_redirect_then_connector_policy_forbids_forwarding_authorization() {
    let (config, max_redirects) = websocket_connect_config();
    assert_eq!(max_redirects, 0);
    assert_eq!(config.max_message_size, Some(128 * 1024));
    assert_eq!(config.max_frame_size, Some(128 * 1024));
}

#[test]
fn given_websocket_connector_when_inspecting_timeouts_then_connect_and_io_are_bounded() {
    let (connect, read, write) = super::chatroom_client::websocket_io_timeouts();
    assert!(connect <= Duration::from_secs(1));
    assert!(super::chatroom_client::websocket_handshake_timeout() <= Duration::from_secs(1));
    assert!(read <= Duration::from_secs(1));
    assert!(write <= Duration::from_secs(1));
}

#[test]
fn given_loopback_chatroom_server_when_tungstenite_connector_connects_then_wire_contract_is_real() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("绑定 loopback WebSocket listener");
    listener
        .set_nonblocking(true)
        .expect("配置 loopback listener 非阻塞");
    let address = listener.local_addr().unwrap();
    let (server_done, server_done_receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let accept_deadline = Instant::now() + Duration::from_secs(1);
        let (stream, _) = loop {
            match listener.accept() {
                Ok(connection) => break connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < accept_deadline,
                        "loopback listener 接受连接超时"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("接受 WebSocket 连接失败: {error}"),
            }
        };
        stream
            .set_nonblocking(false)
            .expect("配置 WebSocket 流阻塞模式");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let websocket = tungstenite::accept_hdr(stream, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), "/api/chatrooms/v2/ws");
            assert_eq!(
                request
                    .headers()
                    .get("authorization")
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer integration-secret")
            );
            Ok(response)
        })
        .expect("完成 WebSocket 握手");
        let mut websocket = websocket;
        let subscribe = websocket.read().expect("读取真实订阅帧");
        let subscribe_json = match subscribe {
            Message::Text(text) => {
                serde_json::from_str::<serde_json::Value>(text.as_ref()).expect("命令帧应为 JSON")
            }
            other => panic!("订阅帧类型错误: {other:?}"),
        };
        assert_eq!(
            subscribe_json,
            json!({"type":"subscribe","payload":{"roomIds":["room-1"],"afterSeq":{"room-1":0},"deviceId":"device-1"}})
        );
        let command = websocket.read().expect("读取真实命令帧");
        let command_json = match command {
            Message::Text(text) => {
                serde_json::from_str::<serde_json::Value>(text.as_ref()).expect("命令帧应为 JSON")
            }
            other => panic!("命令帧类型错误: {other:?}"),
        };
        assert_eq!(
            command_json,
            json!({"type":"message.create","roomId":"room-1","payload":{"content":"hello","mentionAgentIds":[],"attachmentIds":[],"clientMessageId":"client-1"}})
        );
        websocket
            .send(Message::Text(
                r#"{"type":"agent.delta","roomId":"room-1","payload":{"invocationId":"invocation-1","delta":"world"}}"#.into()
            ))
            .expect("发送真实事件帧");
        let _ = server_done.send(());
    });

    let connector = TungsteniteConnector::with_resolver(Arc::new(LoopbackResolver(address)));
    let stop = AtomicBool::new(false);
    let mut socket = connector
        .connect(
            "ws://edu.example/api/chatrooms/v2/ws",
            "Bearer integration-secret",
            &stop,
        )
        .expect("连接 loopback WebSocket");
    socket.send_json(&subscribe()).expect("发送真实订阅");
    socket
        .send_json(&ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "client-1".into(),
            content: "hello".into(),
            mention_agent_ids: Vec::new(),
            attachment_ids: Vec::new(),
        })
        .expect("发送真实命令");
    assert_eq!(
        socket.receive_json().unwrap(),
        ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"invocation-1","delta":"world"}),
        }
    );
    socket.close();
    let server_finished = server_done_receiver
        .recv_timeout(Duration::from_secs(2))
        .is_ok();
    let server_result = server.join();
    assert!(server_finished, "真实 WebSocket 服务端未在限定时间内完成");
    server_result.expect("回收 loopback WebSocket 服务端");
}

#[test]
fn given_slow_resolver_when_client_shuts_down_then_worker_cancels_without_new_resolver_threads() {
    let (started, started_receiver) = mpsc::channel();
    let resolver = Arc::new(SlowResolver {
        started: Mutex::new(Some(started)),
        calls: AtomicUsize::new(0),
    });
    let connector = Arc::new(TungsteniteConnector::with_resolver(resolver.clone()));
    let (events, _receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "ws://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    started_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("测试 resolver 未开始");
    let started = std::time::Instant::now();
    client.shutdown();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn given_subscription_change_when_connected_then_reconnect_with_only_new_initial_subscribe() {
    let first = FakeSocket::new(Vec::new());
    let second = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first.clone()),
        ConnectResult::Socket(second.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 4,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 8,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    client
        .command(ChatroomCommand::Unsubscribe {
            room_id: "room-1".into(),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let first_sent = first.sent.lock().unwrap();
    assert_eq!(first_sent.len(), 1);
    assert!(matches!(&first_sent[0], ChatroomCommand::Subscribe { rooms, .. } if rooms.len() == 2));
    let second_sent = second.sent.lock().unwrap();
    assert_eq!(second_sent.len(), 1);
    assert!(
        matches!(&second_sent[0], ChatroomCommand::Subscribe { rooms, .. } if rooms.len() == 1 && rooms[0].room_id == "room-2")
    );
    client.shutdown();
}

#[test]
fn given_cursor_only_and_room_order_changes_when_connected_then_keep_socket_and_reconnect_with_latest_cursor(
) {
    let first = FakeSocket::new(vec![
        Err(ChatroomClientError::new("read_timeout", "测试空闲超时")),
        Err(ChatroomClientError::new("read_timeout", "测试空闲超时")),
        Err(ChatroomClientError::new("disconnected", "测试自然断线")),
    ]);
    let second = FakeSocket::new(Vec::new());
    let (first_receive_started, release_first_receive) = first.gate_receive_call(1);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first.clone()),
        ConnectResult::Socket(second.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    ));
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 29,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 8,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    first_receive_started
        .recv_timeout(Duration::from_secs(1))
        .expect("测试首次 receive 未开始");
    let (second_receive_started, release_second_receive) = first.gate_receive_call(2);
    let generation = client.active_socket_generation();

    let accepted_client = client.clone();
    let accepted = thread::spawn(move || {
        accepted_client.request_and_confirm_with_timeout(
            ChatroomCommand::AgentAccepted {
                room_id: "room-1".into(),
                invocation_id: "inv-1".into(),
                agent_id: "agent-1".into(),
                device_id: "device-1".into(),
            },
            "room-1",
            "req-cursor-update",
            "agent.accepted",
            Some("inv-1"),
            Duration::from_secs(1),
        )
    });
    let ack_deadline = Instant::now() + Duration::from_secs(1);
    while client.pending_ack_count() == 0 && Instant::now() < ack_deadline {
        thread::yield_now();
    }
    assert_eq!(
        client.pending_ack_count(),
        1,
        "accepted ack waiter 应先挂起"
    );
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 30,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 8,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();
    let (drain_started, release_drain) = client.gate_connected_command_drain();
    release_first_receive.send(()).unwrap();
    drain_started
        .recv_timeout(Duration::from_secs(1))
        .expect("测试连接态命令 drain 未开始");
    release_drain.send(()).unwrap();

    let accepted = accepted.join().unwrap().expect("accepted 应在原连接确认");
    assert_eq!(accepted.status.as_deref(), Some("accepted"));
    second_receive_started
        .recv_timeout(Duration::from_secs(1))
        .expect("测试第二次 receive 未开始");

    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 8,
                },
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 30,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();
    let (reorder_drain_started, release_reorder_drain) = client.gate_connected_command_drain();
    release_second_receive.send(()).unwrap();
    reorder_drain_started
        .recv_timeout(Duration::from_secs(1))
        .expect("测试房间顺序更新 drain 未开始");
    let (third_receive_started, release_third_receive) = first.gate_receive_call(3);
    release_reorder_drain.send(()).unwrap();
    third_receive_started
        .recv_timeout(Duration::from_secs(1))
        .expect("测试第三次 receive 未开始");

    assert_eq!(client.active_socket_generation(), generation);
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);
    assert!(!first.closed.load(Ordering::SeqCst));
    assert!(receiver
        .try_iter()
        .all(|event| { !matches!(event, ChatroomClientEvent::Disconnected) }));

    release_third_receive.send(()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 2);
    assert!(matches!(
        second.sent.lock().unwrap().first(),
        Some(ChatroomCommand::Subscribe { rooms, device_id, capabilities: None })
            if device_id == "device-1"
                && rooms == &vec![
                    RoomCursor { room_id: "room-2".into(), after_seq: 8 },
                    RoomCursor { room_id: "room-1".into(), after_seq: 30 },
                ]
    ));
    client.shutdown();
}

#[test]
fn given_shutdown_when_socket_is_active_then_send_close_and_join_worker() {
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    client.shutdown();
    assert!(socket.closed.load(Ordering::SeqCst));
    client.shutdown();
}

#[test]
fn given_client_is_dropped_without_shutdown_then_worker_closes_socket() {
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    drop(client);
    assert!(socket.closed.load(Ordering::SeqCst));
}

#[test]
fn given_pause_and_resume_during_connect_when_socket_is_rejected_then_worker_restarts() {
    let first = FakeSocket::new(Vec::new());
    let second = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first.clone()),
        ConnectResult::Socket(second.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let authenticated = auth(
        Arc::new(RefreshTransport {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(MemoryStorage::default()),
    );
    let (connect_loaded, connect_release) = connector.gate_next_connect();
    let client = ChatroomClient::new_with_backoff(
        authenticated.clone(),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    connect_loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("首次 connect 未进入 gate");
    client.pause();
    client.resume();
    authenticated.refresh_single_flight().unwrap();
    connect_release.send(()).unwrap();

    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| { matches!(event, ChatroomClientEvent::Disconnected) }));
    assert!(first.closed.load(Ordering::SeqCst));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);

    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-2".into(),
                after_seq: 0,
            }],
            device_id: "device-2".into(),
            capabilities: None,
        })
        .unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| { matches!(event, ChatroomClientEvent::ConnectedAt { .. }) }));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 2);
    assert_eq!(
        connector.authorizations.lock().unwrap().as_slice(),
        ["Bearer old-token", "Bearer new-token"]
    );
    assert_eq!(first.sent.lock().unwrap().len(), 0);
    let second_sent = second.sent.lock().unwrap();
    assert_eq!(second_sent.len(), 1);
    assert!(
        matches!(&second_sent[0], ChatroomCommand::Subscribe { rooms, device_id, .. } if rooms[0].room_id == "room-2" && device_id == "device-2")
    );
    client.shutdown();
}

#[test]
fn given_temporary_pause_when_authenticated_client_is_restarted_then_new_socket_connects() {
    let storage = Arc::new(MemoryStorage::default());
    let auth = auth(
        Arc::new(RefreshTransport {
            calls: AtomicUsize::new(0),
        }),
        storage,
    );
    let (first, first_receive_started, first_receive_release) =
        FakeSocket::gated_disconnect_with_start();
    let second = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first),
        ConnectResult::Socket(second),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth,
        "wss://edu.example/api/chatrooms/v2/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    first_receive_started
        .recv_timeout(Duration::from_millis(500))
        .expect("首个 socket 未进入可控 receive");
    client.pause();
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);
    assert!(receiver.recv_timeout(Duration::from_millis(20)).is_err());
    first_receive_release.send(()).unwrap();
    let disconnected = (0..10).any(|_| {
        receiver
            .recv_timeout(Duration::from_millis(100))
            .is_ok_and(|event| matches!(event, ChatroomClientEvent::Disconnected))
    });
    assert!(disconnected);
    client.resume();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 2);
    client.shutdown();
    client.shutdown();
}

#[test]
fn given_resume_arrives_during_connected_command_drain_then_reconnect_requires_new_subscribe() {
    let first = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let second = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first),
        ConnectResult::Socket(second),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    );
    let (drain_loaded, drain_release) = client.gate_connected_command_drain();
    client.start();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    drain_loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("connected command drain 未进入 gate");

    client.pause();
    client.resume();
    drain_release.send(()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::Disconnected)));

    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 2);
    client.shutdown();
}

#[test]
fn given_pause_after_connected_generation_check_then_command_is_not_flushed() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    let (loaded, release) = client.gate_connected_command_apply();
    client.start();
    client.command(subscribe()).unwrap();
    receiver
        .recv_timeout(Duration::from_millis(500))
        .expect("未建立聊天室连接");
    client.command(renew_lease()).unwrap();
    loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("connected 命令未到达 apply gate");
    client.pause();
    release.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let sent = socket.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(matches!(
        sent.first(),
        Some(ChatroomCommand::Subscribe { .. })
    ));
    drop(sent);
    client.shutdown();
}

#[test]
fn given_paused_client_when_ordinary_command_arrives_then_stay_paused_until_explicit_resume() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
    );
    client.pause();
    client.start();
    let error = client.command(renew_lease()).unwrap_err();
    assert_eq!(error.code, "client_paused");
    assert!(receiver.recv_timeout(Duration::from_millis(40)).is_err());
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 0);
    client.resume();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| { matches!(event, ChatroomClientEvent::ConnectedAt { .. }) }));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 1);
    client.shutdown();
}

#[test]
fn given_command_wins_pause_check_race_then_paused_worker_drops_it_before_resume() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    client.start();
    let (command_loaded, command_release) = client.gate_next_command();
    let command_client = Arc::clone(&client);
    let command = thread::spawn(move || command_client.command(renew_lease()));
    command_loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("命令未进入发送 gate");
    client.pause();
    client.resume();
    command_release.send(()).unwrap();
    assert!(command.join().unwrap().is_ok());

    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    let sent = socket.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(matches!(
        sent.first(),
        Some(ChatroomCommand::Subscribe { .. })
    ));
    client.shutdown();
}

#[test]
fn given_stale_resume_after_a_newer_pause_then_resume_sentinel_does_not_clear_pause() {
    let first = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let second = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(first),
        ConnectResult::Socket(second),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    );
    let (drain_loaded, drain_release) = client.gate_connected_command_drain();
    client.start();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    drain_loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("connected command drain 未进入 gate");

    client.pause();
    client.resume();
    client.pause();
    drain_release.send(()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::Disconnected)));

    let error = client.command(subscribe()).unwrap_err();
    assert_eq!(error.code, "client_paused");
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    client.resume();
    client.command(subscribe()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 2);
    client.shutdown();
}

#[test]
fn given_protocol_receive_error_when_socket_disconnects_then_emit_safe_status_before_disconnect() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "protocol_invalid",
        "不应公开的底层错误内容",
    ))]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    let connected = receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert!(matches!(connected, ChatroomClientEvent::ConnectedAt { .. }));
    let receive_failure = receiver.recv_timeout(Duration::from_millis(500));
    client.shutdown();

    assert!(matches!(
        receive_failure,
        Ok(ChatroomClientEvent::Status { code, message })
            if code == "protocol_invalid" && message == "聊天室实时连接读取失败"
    ));
}

#[test]
fn given_stale_ordinary_command_is_dropped_then_restore_wake_budget_for_next_command() {
    let socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "read_timeout",
        "测试空闲连接",
    ))]);
    let connector = FakeConnector::new(
        (0..8)
            .map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")))
            .chain([ConnectResult::Socket(socket)])
            .collect(),
    );
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );

    let (command_loaded, command_release) = client.gate_next_command();
    let command_client = Arc::clone(&client);
    let command = thread::spawn(move || command_client.command(renew_lease()));
    command_loaded
        .recv_timeout(Duration::from_millis(500))
        .expect("普通命令未进入发送 gate");
    client.pause();
    client.resume();
    command_release.send(()).unwrap();
    assert!(command.join().unwrap().is_ok());

    client.command(renew_lease()).unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_millis(500))
        .is_ok_and(|event| matches!(event, ChatroomClientEvent::ConnectedAt { .. })));
    assert_eq!(connector.attempts.load(Ordering::SeqCst), 9);
    client.shutdown();
}

#[test]
fn given_connected_socket_disconnects_immediately_then_failure_budget_is_not_reset() {
    let connector = FakeConnector::new(
        (0..8)
            .map(|_| {
                ConnectResult::Socket(FakeSocket::new(vec![Err(ChatroomClientError::new(
                    "disconnected",
                    "测试立即断开",
                ))]))
            })
            .collect(),
    );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff.clone(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    assert!(wait_for_status(
        &receiver,
        "realtime_unavailable",
        Duration::from_millis(500),
    ));
    assert_eq!(connector.authorizations.lock().unwrap().len(), 8);
    assert_eq!(backoff.waits.lock().unwrap().len(), 7);
    client.shutdown();
}

#[test]
fn given_read_timeout_after_connection_then_failure_budget_is_reset_before_later_disconnect() {
    let stable_socket = FakeSocket::new(vec![
        Err(ChatroomClientError::new("read_timeout", "测试读取超时")),
        Err(ChatroomClientError::new("disconnected", "测试随后断开")),
    ]);
    let connector = FakeConnector::new(
        vec![
            ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")),
            ConnectResult::Error(ChatroomClientError::new("transport", "连接失败")),
            ConnectResult::Socket(stable_socket),
        ]
        .into_iter()
        .chain(
            (0..7).map(|_| ConnectResult::Error(ChatroomClientError::new("transport", "连接失败"))),
        )
        .collect(),
    );
    let backoff = FakeBackoff::new();
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        backoff.clone(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
    assert_eq!(connector.authorizations.lock().unwrap().len(), 10);
    assert_eq!(
        backoff.waits.lock().unwrap().as_slice(),
        [
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
            Duration::from_secs(16),
            Duration::from_secs(30),
            Duration::from_secs(30),
        ]
    );
    client.shutdown();
}

#[test]
fn given_temporary_refresh_failure_then_successful_socket_then_two_401s_then_expire_auth() {
    let first_socket = FakeSocket::new(vec![Err(ChatroomClientError::new(
        "disconnected",
        "测试断开",
    ))]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
        ConnectResult::Socket(first_socket),
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
        ConnectResult::Error(ChatroomClientError::new("unauthorized", "未授权")),
    ]);
    let transport = Arc::new(RetryableRefreshTransport {
        calls: AtomicUsize::new(0),
    });
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(transport.clone(), Arc::new(MemoryStorage::default())),
        "wss://edu.example/ws".into(),
        connector.clone(),
        events,
        FakeBackoff::new(),
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "auth_expired"),
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    assert_eq!(connector.authorizations.lock().unwrap().len(), 4);
    client.shutdown();
}

#[test]
fn given_private_command_ack_frame_when_decoding_socket_frame_then_keep_it_out_of_public_events() {
    let ack = r#"{"type":"command.ack","roomId":"room-1","payload":{"requestId":"req-1","command":"agent.completed","ok":true,"invocationId":"inv-1","status":"completed"}}"#;
    let frame = decode_socket_frame(Message::Text(ack.to_string().into()))
        .unwrap()
        .unwrap();
    assert!(
        matches!(frame, super::chatroom_client::ChatroomSocketFrame::PrivateAck(value)
        if value.request_id == "req-1" && value.status.as_deref() == Some("completed"))
    );

    let event = r#"{"type":"room.snapshot","roomId":"room-1","latestSeq":0,"payload":{}}"#;
    let frame = decode_socket_frame(Message::Text(event.to_string().into()))
        .unwrap()
        .unwrap();
    assert!(matches!(
        frame,
        super::chatroom_client::ChatroomSocketFrame::EventWithRawJsonBytes {
            raw_json_bytes,
            ..
        } if raw_json_bytes == event.len()
    ));
}

#[test]
fn given_go_snapshot_history_replay_and_live_event_when_decoding_then_keep_socket_stream_valid() {
    let frames = [
        r#"{"type":"room.snapshot","roomId":"room-1","latestSeq":0,"payload":{"room":{"roomId":"room-1","nextSeq":2},"members":[],"agents":[{"roomAgentId":"agent-1","memoryShared":false,"skillsShared":true}]}}"#,
        r#"{"type":"agent.updated","roomId":"room-1","seq":1,"payload":{"roomId":"room-1","roomAgentId":"agent-1","displayName":"Agent","status":"offline","memoryShared":false,"skillsShared":true}}"#,
        r#"{"type":"room.recovery_ready","roomId":"room-1","payload":{}}"#,
        r#"{"type":"message.created","roomId":"room-1","seq":2,"payload":{"messageId":"message-1","content":"connected"}}"#,
    ];

    let decoded = frames
        .iter()
        .map(|raw| {
            let frame = decode_socket_frame(Message::Text((*raw).to_string().into()))
                .expect("wire event should pass client decoder")
                .expect("text frame should contain an event");
            let event = match frame {
                super::chatroom_client::ChatroomSocketFrame::Event(event)
                | super::chatroom_client::ChatroomSocketFrame::EventWithRawJsonBytes {
                    event,
                    ..
                } => event,
                super::chatroom_client::ChatroomSocketFrame::PrivateAck(_) => {
                    panic!("event fixture decoded as a private ACK")
                }
            };
            public_event(&event)
        })
        .collect::<Vec<_>>();

    assert_eq!(decoded[0]["payload"]["agents"][0]["memoryShared"], false);
    assert_eq!(decoded[0]["payload"]["agents"][0]["skillsShared"], true);
    assert_eq!(decoded[1]["payload"]["memoryShared"], false);
    assert_eq!(decoded[1]["payload"]["skillsShared"], true);
    assert_eq!(decoded[2]["type"], "room.recovery_ready");
    assert_eq!(decoded[3]["type"], "message.created");
}

#[test]
fn given_live_socket_when_lifecycle_command_requests_confirmation_then_reader_resolves_private_ack()
{
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let confirmed = client
        .request_and_confirm(
            ChatroomCommand::Ready {
                room_id: "room-1".into(),
                request_id: "req-live".into(),
                room_agent_id: "agent-1".into(),
            },
            "room-1",
            "req-live",
            "agent.ready",
            None,
        )
        .unwrap();
    assert_eq!(confirmed.status.as_deref(), Some("accepted"));
    assert!(
        matches!(socket.sent.lock().unwrap().last(), Some(ChatroomCommand::ConfirmedLifecycle { request_id, .. }) if request_id == "req-live")
    );
    client.shutdown();
}

#[test]
fn given_capability_request_when_initial_snapshot_echoes_intersection_then_select_only_that_intersection(
) {
    let snapshot = ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"capabilities": ["agent-ready-v1", "invocation-ack-v1", "future-v9"]}),
    };
    let later_snapshot = ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 1,
        payload: json!({}),
    };
    let second_initial_snapshot = ChatroomEvent::RoomSnapshot {
        room_id: "room-2".into(),
        latest_seq: 0,
        payload: json!({"capabilities": ["agent-ready-v1", "invocation-ack-v1"]}),
    };
    let socket = FakeSocket::new(vec![
        Ok(snapshot),
        Ok(second_initial_snapshot),
        Ok(later_snapshot),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
            ]),
        })
        .unwrap();
    let event = receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { latest_seq: 0, .. },
                ..
            }
        )
    });
    let generation = match event {
        ChatroomClientEvent::SocketEventAt { generation, .. } => generation,
        _ => unreachable!(),
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline && client.selected_capabilities().1.is_empty() {
        thread::yield_now();
    }
    assert_eq!(
        client.selected_capabilities(),
        (
            generation.max(1),
            vec![super::chatroom_protocol::ChatroomCapability::AgentReadyV1]
        )
    );
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::SocketEventAt { event: ChatroomEvent::RoomSnapshot { room_id, .. }, .. } if room_id == "room-2"),
    );
    assert_eq!(
        client.selected_capabilities().1,
        vec![super::chatroom_protocol::ChatroomCapability::AgentReadyV1]
    );
    receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { latest_seq: 1, .. },
                ..
            }
        )
    });
    assert_eq!(
        client.selected_capabilities().1,
        vec![super::chatroom_protocol::ChatroomCapability::AgentReadyV1]
    );
    client.shutdown();
}

#[test]
fn given_multiple_room_snapshots_when_first_arrives_then_selection_waits_for_consistent_complete_set(
) {
    for second_payload in [
        json!({}),
        json!({"capabilities": ["agent-ready-v1"]}),
        json!({"capabilities": ["agent-ready-v1", "invocation-ack-v1"]}),
    ] {
        let socket = FakeSocket::new(vec![
            Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 0,
                payload: json!({"capabilities": ["agent-ready-v1", "invocation-ack-v1"]}),
            }),
            Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-2".into(),
                latest_seq: 0,
                payload: second_payload.clone(),
            }),
        ]);
        let (second_receive_started, release_second) = socket.gate_receive_call(2);
        let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
        let (events, receiver) = mpsc::channel();
        let client = ChatroomClient::new(
            auth(
                Arc::new(RefreshTransport {
                    calls: AtomicUsize::new(0),
                }),
                Arc::new(MemoryStorage::default()),
            ),
            "wss://edu.example/ws".into(),
            connector,
            events,
        );
        client.start();
        client
            .command(ChatroomCommand::Subscribe {
                rooms: vec![
                    RoomCursor {
                        room_id: "room-1".into(),
                        after_seq: 0,
                    },
                    RoomCursor {
                        room_id: "room-2".into(),
                        after_seq: 0,
                    },
                ],
                device_id: "device-1".into(),
                capabilities: Some(vec![
                    super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
                    super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
                ]),
            })
            .unwrap();
        second_receive_started
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let generation = client.active_socket_generation();
        assert_ne!(generation, 0);
        let capabilities_before_second_snapshot = client.selected_capabilities();
        release_second.send(()).unwrap();
        assert_eq!(
            capabilities_before_second_snapshot,
            (generation, Vec::new())
        );
        let consistent_capabilities = second_payload
            .get("capabilities")
            .is_some_and(|value| value == &json!(["agent-ready-v1", "invocation-ack-v1"]));
        if consistent_capabilities {
            receive_until(
                &receiver,
                |event| matches!(event, ChatroomClientEvent::SocketEventAt { event: ChatroomEvent::RoomSnapshot { room_id, .. }, .. } if room_id == "room-2"),
            );
            assert_eq!(
                client.selected_capabilities(),
                (
                    generation,
                    vec![
                        super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
                        super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
                    ]
                )
            );
        } else {
            let deadline = Instant::now() + Duration::from_millis(500);
            while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::yield_now();
            }
            let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
            let observed = receiver.try_iter().collect::<Vec<_>>();
            assert!(closed_before_shutdown, "能力集合不一致必须关闭当前 socket");
            assert_eq!(client.selected_capabilities(), (generation, Vec::new()));
            assert!(
                !observed.iter().any(|event| matches!(
                    event,
                    ChatroomClientEvent::SocketEventAt {
                        event: ChatroomEvent::RoomSnapshot { room_id, .. },
                        ..
                    } if room_id == "room-2"
                )),
                "能力不一致的初始 snapshot 不得释放"
            );
            assert!(observed
                .iter()
                .any(|event| matches!(event, ChatroomClientEvent::Disconnected)));
        }
        client.shutdown();
    }
}

#[test]
fn given_multiroom_handshake_when_delta_and_terminal_arrive_before_last_snapshot_then_flush_fifo_after_snapshot(
) {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": [
                "agent-ready-v1",
                "invocation-ack-v1",
                "agent-delta-frame-id-v1",
            ]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "片段",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        }),
        Ok(ChatroomEvent::AgentCompleted {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "content": "完成",
                "mentionAgentIds": [],
                "attachmentIds": [],
                "clientMessageId": "message-1",
            }),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities": [
                "agent-ready-v1",
                "invocation-ack-v1",
                "agent-delta-frame-id-v1",
            ]}),
        }),
    ]);
    let (last_snapshot_started, release_last_snapshot) = socket.gate_receive_call(4);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
                super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    last_snapshot_started
        .recv_timeout(Duration::from_secs(1))
        .expect("应在第二个初始 snapshot 前停住");
    let before_selection = receiver.try_iter().collect::<Vec<_>>();
    let generation = client.active_socket_generation();
    assert_eq!(
        client.selected_capabilities(),
        (generation, Vec::new()),
        "HTTP 广告与单个 room snapshot 都不能提前选择 socket 能力"
    );
    release_last_snapshot.send(()).unwrap();
    assert!(before_selection.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::RoomSnapshot { room_id, .. },
            ..
        } if room_id == "room-1"
    )));
    assert!(!before_selection.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. } | ChatroomEvent::AgentCompleted { .. },
            ..
        }
    )));
    let mut observed = Vec::new();
    while observed.len() < 3 {
        let event = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("一致 snapshot 后应释放缓冲事件");
        if let ChatroomClientEvent::SocketEventAt { event, .. } = event {
            observed.push(event);
        }
    }
    assert!(matches!(
        &observed[0],
        ChatroomEvent::RoomSnapshot { room_id, .. } if room_id == "room-2"
    ));
    assert!(matches!(
        &observed[1],
        ChatroomEvent::AgentDelta { payload, .. }
            if payload.get("frameId").and_then(serde_json::Value::as_str)
                == Some("0123456789abcdef0123456789abcdef")
    ));
    assert!(matches!(
        &observed[2],
        ChatroomEvent::AgentCompleted { payload, .. }
            if payload.get("invocationId").and_then(serde_json::Value::as_str) == Some("inv-1")
    ));
    assert_eq!(
        client.selected_capabilities().1,
        vec![
            super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
            super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
            super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
        ]
    );
    client.shutdown();
}

#[test]
fn given_selected_delta_frame_identity_when_mixed_frames_arrive_then_preserve_legacy_duplicates_and_final_reply(
) {
    let frame_a = "0123456789abcdef0123456789abcdef";
    let frame_b = "fedcba9876543210fedcba9876543210";
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": [
                "agent-ready-v1",
                "invocation-ack-v1",
                "agent-delta-frame-id-v1",
            ]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","delta":"same","frameId":frame_a}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","delta":"same","frameId":frame_a}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","delta":"same","frameId":frame_b}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","delta":"same"}),
        }),
        Ok(ChatroomEvent::AgentCompleted {
            room_id: "room-1".into(),
            payload: json!({"invocationId":"inv-1","content":"full reply","mentionAgentIds":[],"attachmentIds":[],"clientMessageId":"reply-1"}),
        }),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
                super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    let mut observed = Vec::new();
    while observed.len() < 6 {
        if let ChatroomClientEvent::SocketEventAt { event, .. } =
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()
        {
            observed.push(event);
        }
    }
    assert_eq!(
        client.selected_capabilities().1,
        vec![
            super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
            super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
            super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
        ]
    );
    let deltas = observed
        .iter()
        .filter_map(|event| match event {
            ChatroomEvent::AgentDelta { payload, .. } => Some(payload),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        deltas.len(),
        4,
        "Native receiver preserves frames for Renderer identity handling"
    );
    assert_eq!(deltas[0]["frameId"], frame_a);
    assert_eq!(deltas[1]["frameId"], frame_a);
    assert_eq!(deltas[2]["frameId"], frame_b);
    assert!(
        deltas[3].get("frameId").is_none(),
        "legacy wire shape stays identifiable"
    );
    assert!(
        matches!(&observed[5], ChatroomEvent::AgentCompleted { payload, .. } if payload["content"] == "full reply")
    );
    let sent = socket.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(matches!(
        sent.first(),
        Some(ChatroomCommand::Subscribe { .. })
    ));
    assert!(!sent
        .iter()
        .any(|command| matches!(command, ChatroomCommand::ConfirmedLifecycle { .. })));
    drop(sent);
    client.shutdown();
}

#[test]
fn given_mismatching_multiroom_snapshot_when_delta_is_buffered_then_close_without_releasing_it() {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "part",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities": []}),
        }),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_millis(500);
    while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::yield_now();
    }
    let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
    let observed = receiver.try_iter().collect::<Vec<_>>();
    client.shutdown();
    assert!(closed_before_shutdown, "能力回显不一致必须关闭当前 socket");
    assert!(
        !observed.iter().any(|event| matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-2"
        )),
        "导致能力不一致的初始 snapshot 不得释放"
    );
    assert!(!observed.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));
}

#[test]
fn given_invalid_initial_snapshot_capabilities_when_delta_is_buffered_then_close_without_releasing_it(
) {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "part",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities": null}),
        }),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_millis(500);
    while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::yield_now();
    }
    let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
    let observed = receiver.try_iter().collect::<Vec<_>>();
    client.shutdown();
    assert!(closed_before_shutdown, "非法能力快照必须关闭当前 socket");
    assert!(
        !observed.iter().any(|event| matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-2"
        )),
        "包含非法能力的初始 snapshot 不得释放"
    );
    assert!(!observed.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));
}

#[test]
fn given_unknown_room_snapshot_while_initial_snapshot_gate_pending_then_close_without_releasing_it_or_buffered_delta(
) {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": "part",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-outside-subscription".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
    ]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_millis(500);
    while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::yield_now();
    }
    let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
    let observed = receiver.try_iter().collect::<Vec<_>>();
    client.shutdown();
    assert!(
        closed_before_shutdown,
        "待握手期间收到订阅外房间 snapshot 必须关闭当前 socket"
    );
    assert!(observed
        .iter()
        .any(|event| matches!(event, ChatroomClientEvent::Disconnected)));
    assert!(
        !observed.iter().any(|event| matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-outside-subscription"
        )),
        "订阅外房间的初始 snapshot 不得释放"
    );
    assert!(
        !observed.iter().any(|event| matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::AgentDelta { .. },
                ..
            }
        )),
        "握手失败时不得释放缓存中的 delta"
    );
}

#[test]
fn given_invalid_or_mismatching_duplicate_snapshot_while_initial_gate_pending_then_close_without_releasing_it_or_delta(
) {
    for duplicate_payload in [
        json!({"capabilities": ["future-capability-v9"]}),
        json!({"capabilities": []}),
    ] {
        let socket = FakeSocket::new(vec![
            Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 0,
                payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
            }),
            Ok(ChatroomEvent::AgentDelta {
                room_id: "room-1".into(),
                payload: json!({
                    "invocationId": "inv-1",
                    "delta": "part",
                    "frameId": "0123456789abcdef0123456789abcdef",
                }),
            }),
            Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-1".into(),
                latest_seq: 1,
                payload: duplicate_payload,
            }),
            Ok(ChatroomEvent::RoomSnapshot {
                room_id: "room-2".into(),
                latest_seq: 0,
                payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
            }),
        ]);
        let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
        let (events, receiver) = mpsc::channel();
        let client = ChatroomClient::new_with_backoff(
            auth(
                Arc::new(RefreshTransport {
                    calls: AtomicUsize::new(0),
                }),
                Arc::new(MemoryStorage::default()),
            ),
            "wss://edu.example/ws".into(),
            connector,
            events,
            FakeBackoff::new(),
        );
        client.start();
        client
            .command(ChatroomCommand::Subscribe {
                rooms: vec![
                    RoomCursor {
                        room_id: "room-1".into(),
                        after_seq: 0,
                    },
                    RoomCursor {
                        room_id: "room-2".into(),
                        after_seq: 0,
                    },
                ],
                device_id: "device-1".into(),
                capabilities: Some(vec![
                    super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
                ]),
            })
            .unwrap();

        let deadline = Instant::now() + Duration::from_millis(500);
        while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::yield_now();
        }
        let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
        let observed = receiver.try_iter().collect::<Vec<_>>();
        client.shutdown();
        assert!(
            closed_before_shutdown,
            "初始握手期间重复 snapshot 的能力非法或不一致必须关闭 socket"
        );
        assert_eq!(client.selected_capabilities().1, Vec::new());
        assert!(observed
            .iter()
            .any(|event| matches!(event, ChatroomClientEvent::Disconnected)));
        assert!(
            !observed.iter().any(|event| matches!(
                event,
                ChatroomClientEvent::SocketEventAt {
                    event: ChatroomEvent::RoomSnapshot { room_id, latest_seq: 1, .. },
                    ..
                } if room_id == "room-1"
            )),
            "能力非法或不一致的重复 snapshot 不得释放"
        );
        assert!(
            !observed.iter().any(|event| matches!(
                event,
                ChatroomClientEvent::SocketEventAt {
                    event: ChatroomEvent::AgentDelta { .. },
                    ..
                }
            )),
            "重复 snapshot 握手失败时不得释放缓存 delta"
        );
    }
}

#[test]
fn given_same_capability_duplicate_snapshot_while_initial_gate_pending_then_keep_legacy_delivery() {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 1,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
    ]);
    let (third_receive_started, release_third) = socket.gate_receive_call(3);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();

    third_receive_started
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(
        !socket.closed.load(Ordering::SeqCst),
        "一致能力的重复 snapshot 不应关闭连接"
    );
    assert_eq!(client.selected_capabilities().1, Vec::new());
    assert!(
        receiver.try_iter().any(|event| matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, latest_seq: 1, .. },
                ..
            } if room_id == "room-1"
        )),
        "能力一致的重复 snapshot 仍可在握手完成前释放"
    );

    release_third.send(()).unwrap();
    receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-2"
        )
    });
    assert_eq!(
        client.selected_capabilities().1,
        vec![super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1]
    );
    client.shutdown();
}

#[test]
fn given_generation_replacement_during_multiroom_handshake_when_new_socket_selects_then_never_flush_old_delta(
) {
    let socket_a = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "old-invocation",
                "delta": "old",
                "frameId": "0123456789abcdef0123456789abcdef",
            }),
        }),
    ]);
    let (old_socket_read_started, release_old_socket) = socket_a.gate_receive_call(3);
    let socket_b = FakeSocket::new(vec![Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-3".into(),
        latest_seq: 0,
        payload: json!({"capabilities": ["agent-delta-frame-id-v1"]}),
    })]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(socket_a),
        ConnectResult::Socket(socket_b),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();
    old_socket_read_started
        .recv_timeout(Duration::from_secs(1))
        .expect("socket A 应在初始 snapshot 未收齐时等待");
    let before_replacement = receiver.try_iter().collect::<Vec<_>>();
    assert!(!before_replacement.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));

    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-3".into(),
                after_seq: 0,
            }],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1,
            ]),
        })
        .unwrap();
    release_old_socket.send(()).unwrap();
    let second_snapshot = receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                socket_generation: 2,
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-3"
        )
    });
    assert!(matches!(
        second_snapshot,
        ChatroomClientEvent::SocketEventAt { .. }
    ));
    assert_eq!(
        client.selected_capabilities(),
        (
            2,
            vec![super::chatroom_protocol::ChatroomCapability::AgentDeltaFrameIdV1]
        )
    );
    let remaining = receiver.try_iter().collect::<Vec<_>>();
    assert!(!remaining.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { payload, .. },
            ..
        } if payload.get("invocationId").and_then(serde_json::Value::as_str) == Some("old-invocation")
    )));
    client.shutdown();
}

#[test]
fn given_handshake_event_buffer_overflow_when_more_than_256_events_arrive_then_close_without_flush()
{
    let mut frames = vec![Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"capabilities": []}),
    })];
    frames.extend((0..257).map(|index| {
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": index.to_string(),
            }),
        })
    }));
    frames.push(Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-2".into(),
        latest_seq: 0,
        payload: json!({"capabilities": []}),
    }));
    let socket = FakeSocket::new(frames);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_millis(500);
    while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::yield_now();
    }
    let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
    let observed = receiver.try_iter().collect::<Vec<_>>();
    client.shutdown();
    assert!(
        closed_before_shutdown,
        "缓冲达到事件数量上限时必须关闭 socket"
    );
    assert!(!observed.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));
}

#[test]
fn given_handshake_raw_json_buffer_overflow_when_bytes_exceed_one_mib_then_close_without_flush() {
    let large_delta = "x".repeat(64_000);
    let mut frames = vec![Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"capabilities": []}),
    })];
    frames.extend((0..17).map(|_| {
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({
                "invocationId": "inv-1",
                "delta": large_delta.clone(),
            }),
        })
    }));
    frames.push(Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-2".into(),
        latest_seq: 0,
        payload: json!({"capabilities": []}),
    }));
    let socket = FakeSocket::new(frames);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_millis(500);
    while !socket.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::yield_now();
    }
    let closed_before_shutdown = socket.closed.load(Ordering::SeqCst);
    let observed = receiver.try_iter().collect::<Vec<_>>();
    client.shutdown();
    assert!(closed_before_shutdown, "缓冲超过一 MiB 时必须关闭 socket");
    assert!(!observed.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));
}

#[test]
fn given_legacy_multroom_snapshots_without_capabilities_when_delta_waits_then_release_after_all_snapshots(
) {
    let socket = FakeSocket::new(vec![
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-1".into(),
            latest_seq: 0,
            payload: json!({"messages": []}),
        }),
        Ok(ChatroomEvent::AgentDelta {
            room_id: "room-1".into(),
            payload: json!({"invocationId": "inv-1", "delta": "legacy"}),
        }),
        Ok(ChatroomEvent::RoomSnapshot {
            room_id: "room-2".into(),
            latest_seq: 0,
            payload: json!({"messages": []}),
        }),
    ]);
    let (last_snapshot_started, release_last_snapshot) = socket.gate_receive_call(3);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![
                RoomCursor {
                    room_id: "room-1".into(),
                    after_seq: 0,
                },
                RoomCursor {
                    room_id: "room-2".into(),
                    after_seq: 0,
                },
            ],
            device_id: "device-1".into(),
            capabilities: None,
        })
        .unwrap();

    last_snapshot_started
        .recv_timeout(Duration::from_secs(1))
        .expect("应在 legacy 第二个初始 snapshot 前停住");
    let before_selection = receiver.try_iter().collect::<Vec<_>>();
    release_last_snapshot.send(()).unwrap();
    assert!(!before_selection.iter().any(|event| matches!(
        event,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { .. },
            ..
        }
    )));
    let second_snapshot = receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { room_id, .. },
                ..
            } if room_id == "room-2"
        )
    });
    let legacy_delta = receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("legacy delta 应在所有初始 snapshot 后释放");
    assert!(matches!(
        second_snapshot,
        ChatroomClientEvent::SocketEventAt { .. }
    ));
    assert!(matches!(
        legacy_delta,
        ChatroomClientEvent::SocketEventAt {
            event: ChatroomEvent::AgentDelta { payload, .. },
            ..
        } if payload.get("delta").and_then(serde_json::Value::as_str) == Some("legacy")
            && payload.get("frameId").is_none()
    ));
    assert!(client.selected_capabilities().1.is_empty());
    client.shutdown();
}

#[test]
fn given_legacy_initial_snapshot_without_capabilities_then_selected_set_is_empty_for_current_socket(
) {
    let socket = FakeSocket::new(vec![Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"messages": []}),
    })]);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
            ]),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(
            event,
            ChatroomClientEvent::SocketEventAt {
                event: ChatroomEvent::RoomSnapshot { .. },
                ..
            }
        )
    });
    let generation = client.active_socket_generation();
    assert_ne!(generation, 0);
    assert_eq!(client.selected_capabilities(), (generation, Vec::new()));
    client.shutdown();
}

#[test]
fn given_automatic_reconnect_when_socket_b_snapshot_arrives_then_old_snapshot_capabilities_are_not_retained(
) {
    let old_snapshot = ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"capabilities": ["agent-ready-v1"]}),
    };
    let late_old_snapshot = ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 1,
        payload: json!({"capabilities": ["agent-ready-v1"]}),
    };
    let socket_a = FakeSocket::new(vec![
        Ok(old_snapshot),
        Err(ChatroomClientError::new("disconnected", "socket A closed")),
        Ok(late_old_snapshot),
    ]);
    let socket_b = FakeSocket::new(vec![Ok(ChatroomEvent::RoomSnapshot {
        room_id: "room-1".into(),
        latest_seq: 0,
        payload: json!({"capabilities": ["invocation-ack-v1"]}),
    })]);
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(socket_a),
        ConnectResult::Socket(socket_b),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    );
    client.start();
    client
        .command(ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "device-1".into(),
            capabilities: Some(vec![
                super::chatroom_protocol::ChatroomCapability::AgentReadyV1,
                super::chatroom_protocol::ChatroomCapability::InvocationAckV1,
            ]),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline && client.active_socket_generation() != 2 {
        thread::yield_now();
    }
    assert_eq!(client.active_socket_generation(), 2);
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline && client.selected_capabilities().1.is_empty() {
        thread::yield_now();
    }
    assert_eq!(
        client.selected_capabilities(),
        (
            2,
            vec![super::chatroom_protocol::ChatroomCapability::InvocationAckV1]
        )
    );
    let socket_events = std::iter::from_fn(|| receiver.try_recv().ok())
        .filter_map(|event| match event {
            ChatroomClientEvent::SocketEventAt {
                generation,
                socket_generation,
                event: ChatroomEvent::RoomSnapshot { latest_seq: 0, .. },
            } => Some((generation, socket_generation)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(socket_events.iter().any(|(_, socket)| *socket == 1));
    assert!(socket_events.iter().any(|(_, socket)| *socket == 2));
    assert!(socket_events
        .iter()
        .all(|(connection, _)| *connection == socket_events[0].0));
    client.shutdown();
}

#[test]
fn given_ack_waiter_times_out_while_drain_is_gated_then_release_does_not_send_lifecycle() {
    let socket = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket.clone())]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let (loaded, release) = client.gate_connected_command_apply();
    let waiter_client = client.clone();
    let waiter = thread::spawn(move || {
        waiter_client.request_and_confirm_with_timeout(
            ChatroomCommand::Ready {
                room_id: "room-1".into(),
                request_id: "req-timeout-gate".into(),
                room_agent_id: "agent-1".into(),
            },
            "room-1",
            "req-timeout-gate",
            "agent.ready",
            None,
            Duration::from_millis(30),
        )
    });
    loaded.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(matches!(
        waiter.join().unwrap(),
        Err(super::chatroom_ack::AckError::Timeout)
    ));
    let ordinary_sent = socket.observe_non_subscribe_send();
    release.send(()).unwrap();
    client
        .command(ChatroomCommand::CursorAck {
            room_id: "room-1".into(),
            seq: 1,
        })
        .unwrap();
    ordinary_sent.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(!socket
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, ChatroomCommand::ConfirmedLifecycle { .. })));
    client.shutdown();
}

#[test]
fn given_socket_a_pauses_after_lifecycle_enqueue_then_same_id_on_socket_b_never_replays_a() {
    let socket_a = FakeSocket::new(Vec::new());
    let socket_b = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(socket_a.clone()),
        ConnectResult::Socket(socket_b.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let (loaded, release) = client.gate_connected_command_apply();
    let waiter_client = client.clone();
    let waiter = thread::spawn(move || {
        waiter_client.request_and_confirm_with_timeout(
            ChatroomCommand::Ready {
                room_id: "room-1".into(),
                request_id: "reuse".into(),
                room_agent_id: "agent-1".into(),
            },
            "room-1",
            "reuse",
            "agent.ready",
            None,
            Duration::from_secs(1),
        )
    });
    loaded.recv_timeout(Duration::from_secs(1)).unwrap();
    client.pause();
    release.send(()).unwrap();
    assert!(matches!(
        waiter.join().unwrap(),
        Err(super::chatroom_ack::AckError::Disconnected)
    ));
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::Disconnected)
    });
    client.resume();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(
        client.selected_capabilities().0,
        client.active_socket_generation()
    );
    let confirmed = client
        .request_and_confirm_with_timeout(
            ChatroomCommand::Ready {
                room_id: "room-1".into(),
                request_id: "reuse".into(),
                room_agent_id: "agent-1".into(),
            },
            "room-1",
            "reuse",
            "agent.ready",
            None,
            Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(confirmed.generation, client.active_socket_generation());
    assert!(!socket_a
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, ChatroomCommand::ConfirmedLifecycle { .. })));
    assert_eq!(
        socket_b
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|command| matches!(command, ChatroomCommand::ConfirmedLifecycle { .. }))
            .count(),
        1
    );
    client.shutdown();
}

#[test]
fn given_socket_a_disconnects_before_drain_then_reconnect_b_never_sends_a_lifecycle_command() {
    let socket_a = FakeSocket::new(Vec::new());
    socket_a.reject_after_close.store(true, Ordering::SeqCst);
    let socket_b = FakeSocket::new(Vec::new());
    let connector = FakeConnector::new(vec![
        ConnectResult::Socket(socket_a.clone()),
        ConnectResult::Socket(socket_b.clone()),
    ]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    let pause_epoch = client.pause_generation();
    let (loaded, release) = client.gate_connected_command_apply();
    let waiter_client = client.clone();
    let waiter = thread::spawn(move || {
        waiter_client.request_and_confirm_with_timeout(
            ChatroomCommand::Ready {
                room_id: "room-1".into(),
                request_id: "offline-id".into(),
                room_agent_id: "agent-1".into(),
            },
            "room-1",
            "offline-id",
            "agent.ready",
            None,
            Duration::from_secs(1),
        )
    });
    loaded.recv_timeout(Duration::from_secs(1)).unwrap();
    socket_a.close_during_test();
    release.send(()).unwrap();
    assert!(matches!(
        waiter.join().unwrap(),
        Err(super::chatroom_ack::AckError::Disconnected)
    ));
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert_eq!(pause_epoch, client.pause_generation());
    assert_eq!(client.active_socket_generation(), 2);
    assert!(!socket_b
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, ChatroomCommand::ConfirmedLifecycle { .. })));
    client.shutdown();
}

#[test]
fn given_worker_receives_negative_ack_then_returns_rejection_and_mismatched_ack_fields_timeout() {
    let socket = FakeSocket::new(Vec::new());
    socket.ack_ok.store(false, Ordering::SeqCst);
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = ChatroomClient::new(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
    );
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    assert!(matches!(client.request_and_confirm_with_timeout(
        ChatroomCommand::Ready { room_id: "room-1".into(), request_id: "negative".into(), room_agent_id: "agent-1".into() },
        "room-1", "negative", "agent.ready", None, Duration::from_millis(100),
    ), Err(super::chatroom_ack::AckError::Rejected(code)) if code == "forbidden"));
    client.shutdown();

    for mismatch in ["room", "command", "invocation"] {
        let socket = FakeSocket::new(Vec::new());
        match mismatch {
            "room" => *socket.ack_room_override.lock().unwrap() = Some("room-2".into()),
            "command" => *socket.ack_command_override.lock().unwrap() = Some("agent.failed".into()),
            _ => *socket.ack_invocation_override.lock().unwrap() = Some("inv-2".into()),
        }
        let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
        let (events, receiver) = mpsc::channel();
        let client = ChatroomClient::new(
            auth(
                Arc::new(RefreshTransport {
                    calls: AtomicUsize::new(0),
                }),
                Arc::new(MemoryStorage::default()),
            ),
            "wss://edu.example/ws".into(),
            connector,
            events,
        );
        client.start();
        client.command(subscribe()).unwrap();
        receive_until(&receiver, |event| {
            matches!(event, ChatroomClientEvent::ConnectedAt { .. })
        });
        let command = ChatroomCommand::AgentAccepted {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            agent_id: "agent-1".into(),
            device_id: "device-1".into(),
        };
        assert!(matches!(
            client.request_and_confirm_with_timeout(
                command,
                "room-1",
                "mismatch",
                "agent.accepted",
                Some("inv-1"),
                Duration::from_millis(25)
            ),
            Err(super::chatroom_ack::AckError::Timeout)
        ));
        assert_eq!(client.pending_ack_count(), 0);
        client.shutdown();
    }
}

#[test]
fn given_multiple_pending_ack_waiters_when_socket_disconnects_then_all_return_disconnected() {
    let (socket, started, release) = FakeSocket::gated_disconnect_with_start();
    let connector = FakeConnector::new(vec![ConnectResult::Socket(socket)]);
    let (events, receiver) = mpsc::channel();
    let client = Arc::new(ChatroomClient::new_with_backoff(
        auth(
            Arc::new(RefreshTransport {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(MemoryStorage::default()),
        ),
        "wss://edu.example/ws".into(),
        connector,
        events,
        FakeBackoff::new(),
    ));
    client.start();
    client.command(subscribe()).unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::ConnectedAt { .. })
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    let requests = ["waiter-1", "waiter-2"].map(|request_id| {
        let client = client.clone();
        thread::spawn(move || {
            client.request_and_confirm_with_timeout(
                ChatroomCommand::Ready {
                    room_id: "room-1".into(),
                    request_id: request_id.into(),
                    room_agent_id: "agent-1".into(),
                },
                "room-1",
                request_id,
                "agent.ready",
                None,
                Duration::from_secs(1),
            )
        })
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline && client.pending_ack_count() != 2 {
        thread::yield_now();
    }
    assert_eq!(client.pending_ack_count(), 2);
    release.send(()).unwrap();
    for request in requests {
        assert!(matches!(
            request.join().unwrap(),
            Err(super::chatroom_ack::AckError::Disconnected)
        ));
    }
    assert_eq!(client.pending_ack_count(), 0);
    client.shutdown();
}
