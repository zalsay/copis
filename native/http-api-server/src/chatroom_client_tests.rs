use super::auth_session::{AuthError, AuthSession, AuthStorage, PersistedAuth};
use super::chatroom_client::{
    decode_message, websocket_connect_config, BackoffWaiter, ChatroomClient, ChatroomClientError,
    ChatroomClientEvent, ChatroomHostResolver, ChatroomSocket, ChatroomSocketConnector,
    TungsteniteConnector,
};
use super::chatroom_protocol::{ChatroomCommand, ChatroomEvent, RoomCursor};
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
    sent: Mutex<Vec<ChatroomCommand>>,
    on_subscribe: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    closed: AtomicBool,
    send_count: AtomicUsize,
    fail_on_send: AtomicUsize,
    fail_connected_ordinary: AtomicBool,
    fail_first_ordinary: AtomicBool,
    ordinary_send_count: AtomicUsize,
}

impl FakeSocket {
    fn new(events: Vec<Result<ChatroomEvent, ChatroomClientError>>) -> Arc<Self> {
        Arc::new(Self {
            received: Mutex::new(events.into()),
            receive_release: Mutex::new(None),
            receive_started: Mutex::new(None),
            sent: Mutex::new(Vec::new()),
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
}

impl ChatroomSocket for Arc<FakeSocket> {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
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
        if matches!(command, ChatroomCommand::Subscribe { .. }) {
            if let Some(callback) = self.on_subscribe.lock().unwrap().clone() {
                callback();
            }
        }
        Ok(())
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
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
    let socket = FakeSocket::new(vec![Ok(ChatroomEvent::MessageCreated {
        room_id: "room-1".into(),
        seq: 2,
        payload: json!({"messageId":"m-1"}),
    })]);
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
        matches!(event, ChatroomClientEvent::EventAt { .. })
    });
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(matches!(
        event,
        ChatroomClientEvent::EventAt {
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
        matches!(&second_sent[0], ChatroomCommand::Subscribe { rooms, device_id } if rooms[0].room_id == "room-2" && device_id == "device-2")
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
    receive_until(
        &receiver,
        |event| matches!(event, ChatroomClientEvent::Status { code, .. } if code == "realtime_unavailable"),
    );
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
