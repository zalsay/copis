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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
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
    sent: Mutex<Vec<ChatroomCommand>>,
    closed: AtomicBool,
    send_count: AtomicUsize,
    fail_on_send: AtomicUsize,
}

impl FakeSocket {
    fn new(events: Vec<Result<ChatroomEvent, ChatroomClientError>>) -> Arc<Self> {
        Arc::new(Self {
            received: Mutex::new(events.into()),
            receive_release: Mutex::new(None),
            sent: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            send_count: AtomicUsize::new(0),
            fail_on_send: AtomicUsize::new(0),
        })
    }

    fn gated_disconnect() -> (Arc<Self>, mpsc::Sender<()>) {
        let (release, wait) = mpsc::channel();
        let socket = Self::new(vec![Err(ChatroomClientError::new(
            "disconnected",
            "测试立即断开",
        ))]);
        *socket.receive_release.lock().unwrap() = Some(wait);
        (socket, release)
    }

    fn with_send_failures(
        events: Vec<Result<ChatroomEvent, ChatroomClientError>>,
        failures: usize,
    ) -> Arc<Self> {
        let socket = Self::new(events);
        socket.fail_on_send.store(failures, Ordering::SeqCst);
        socket
    }
}

impl ChatroomSocket for Arc<FakeSocket> {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        let send_number = self.send_count.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_on_send.load(Ordering::SeqCst) == send_number {
            return Err(ChatroomClientError::new("send_failed", "测试写入失败"));
        }
        self.sent.lock().unwrap().push(command.clone());
        Ok(())
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
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

struct FakeConnector {
    results: Mutex<VecDeque<ConnectResult>>,
    authorizations: Mutex<Vec<String>>,
}

impl FakeConnector {
    fn new(results: Vec<ConnectResult>) -> Arc<Self> {
        Arc::new(Self {
            results: Mutex::new(results.into()),
            authorizations: Mutex::new(Vec::new()),
        })
    }
}

impl ChatroomSocketConnector for FakeConnector {
    fn connect(
        &self,
        _url: &str,
        authorization: &str,
        _stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        self.authorizations
            .lock()
            .unwrap()
            .push(authorization.to_string());
        match self
            .results
            .lock()
            .unwrap()
            .pop_front()
            .expect("测试连接结果不足")
        {
            ConnectResult::Socket(socket) => Ok(Box::new(socket)),
            ConnectResult::Error(error) => Err(error),
        }
    }
}

struct SlowResolver {
    started: Mutex<Option<mpsc::Sender<()>>>,
    calls: AtomicUsize,
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
        matches!(event, ChatroomClientEvent::Connected)
    });
    assert_eq!(
        connector.authorizations.lock().unwrap().as_slice(),
        ["Bearer old-token", "Bearer new-token"]
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
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
        matches!(event, ChatroomClientEvent::Connected)
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
        matches!(event, ChatroomClientEvent::Event(_))
    });
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(matches!(
        event,
        ChatroomClientEvent::Event(ChatroomEvent::MessageCreated { seq: 2, .. })
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
            matches!(event, ChatroomClientEvent::Connected)
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
        matches!(event, ChatroomClientEvent::Connected)
    });
    assert_eq!(connector.authorizations.lock().unwrap().len(), 9);
    client.shutdown();
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
        matches!(event, ChatroomClientEvent::Connected)
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
        matches!(event, ChatroomClientEvent::Connected)
    });
    client
        .command(ChatroomCommand::Unsubscribe {
            room_id: "room-1".into(),
        })
        .unwrap();
    receive_until(&receiver, |event| {
        matches!(event, ChatroomClientEvent::Connected)
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
        matches!(event, ChatroomClientEvent::Connected)
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
        matches!(event, ChatroomClientEvent::Connected)
    });
    drop(client);
    assert!(socket.closed.load(Ordering::SeqCst));
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
