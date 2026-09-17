use crate::auth_session::{AuthError, AuthSession};
use crate::chatroom_protocol::{ChatroomCommand, ChatroomEvent, RoomCursor};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::str;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::{client::ClientHandshake, HandshakeError};
use tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tungstenite::protocol::{Message, WebSocket, WebSocketConfig};
use tungstenite::stream::{MaybeTlsStream, Mode};

const MAX_MESSAGE_BYTES: usize = 128 * 1024;
pub(crate) const MAX_REDIRECTS: u8 = 0;
const MAX_CONNECT_RETRIES: usize = 8;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(1);
const READ_TIMEOUT: Duration = Duration::from_secs(1);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const DNS_TIMEOUT: Duration = Duration::from_secs(1);
const DNS_CACHE_TTL: Duration = Duration::from_secs(60);

pub trait ChatroomSocket: Send {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError>;
    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError>;
    fn close(&mut self);
}

pub trait ChatroomSocketConnector: Send + Sync {
    fn connect(
        &self,
        url: &str,
        authorization: &str,
        stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError>;
}

pub(crate) trait ChatroomHostResolver: Send + Sync {
    fn resolve(
        &self,
        host: &str,
        port: u16,
        stop: &AtomicBool,
    ) -> Result<Vec<SocketAddr>, ChatroomClientError>;
}

struct QueuedCommand {
    command: ChatroomCommand,
    wake_budget: bool,
}

#[cfg(test)]
struct CommandEnqueueGate {
    loaded: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatroomClientError {
    pub code: String,
    pub message: String,
}

impl ChatroomClientError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum ChatroomClientEvent {
    Connected,
    Disconnected,
    Event(ChatroomEvent),
    Status { code: String, message: String },
}

pub(crate) trait BackoffWaiter: Send + Sync {
    fn wait(&self, duration: Duration, stop: &AtomicBool) -> bool;
}

struct StandardBackoffWaiter;

impl BackoffWaiter for StandardBackoffWaiter {
    fn wait(&self, duration: Duration, stop: &AtomicBool) -> bool {
        let started = Instant::now();
        while started.elapsed() < duration {
            if stop.load(Ordering::Acquire) {
                return false;
            }
            thread::sleep(
                Duration::from_millis(50).min(duration.saturating_sub(started.elapsed())),
            );
        }
        !stop.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct RefreshAttempt {
    attempted: bool,
    failed: bool,
}

pub struct ChatroomClient {
    auth: Arc<AuthSession>,
    url: String,
    connector: Arc<dyn ChatroomSocketConnector>,
    events: Mutex<Option<mpsc::Sender<ChatroomClientEvent>>>,
    commands: Mutex<Option<mpsc::Sender<QueuedCommand>>>,
    stop: Arc<AtomicBool>,
    wake_on_ordinary: Arc<AtomicBool>,
    #[cfg(test)]
    command_gate: Mutex<Option<CommandEnqueueGate>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    backoff: Arc<dyn BackoffWaiter>,
}

impl ChatroomClient {
    pub fn new(
        auth: Arc<AuthSession>,
        url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        events: mpsc::Sender<ChatroomClientEvent>,
    ) -> Self {
        Self::new_with_backoff(
            auth,
            url,
            connector,
            events,
            Arc::new(StandardBackoffWaiter),
        )
    }

    pub(crate) fn new_with_backoff(
        auth: Arc<AuthSession>,
        url: String,
        connector: Arc<dyn ChatroomSocketConnector>,
        events: mpsc::Sender<ChatroomClientEvent>,
        backoff: Arc<dyn BackoffWaiter>,
    ) -> Self {
        Self {
            auth,
            url,
            connector,
            events: Mutex::new(Some(events)),
            commands: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
            wake_on_ordinary: Arc::new(AtomicBool::new(true)),
            #[cfg(test)]
            command_gate: Mutex::new(None),
            worker: Mutex::new(None),
            backoff,
        }
    }

    #[cfg(test)]
    pub(crate) fn gate_next_command(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (loaded, loaded_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *self.command_gate.lock().unwrap() = Some(CommandEnqueueGate {
            loaded,
            release: release_receiver,
        });
        (loaded_receiver, release)
    }

    pub fn start(&self) {
        let mut worker = self.worker.lock().unwrap();
        if worker.is_some() || self.stop.load(Ordering::Acquire) {
            return;
        }
        let (command_tx, command_rx) = mpsc::channel();
        *self.commands.lock().unwrap() = Some(command_tx);
        let auth = self.auth.clone();
        let url = self.url.clone();
        let connector = self.connector.clone();
        let events = self.events.lock().unwrap().take();
        let stop = self.stop.clone();
        let wake_on_ordinary = self.wake_on_ordinary.clone();
        let backoff = self.backoff.clone();
        *worker = Some(thread::spawn(move || {
            if let Some(events) = events {
                run_worker(
                    auth,
                    url,
                    connector,
                    command_rx,
                    events,
                    stop,
                    wake_on_ordinary,
                    backoff,
                );
            }
        }));
    }

    pub fn command(&self, command: ChatroomCommand) -> Result<(), ChatroomClientError> {
        if self.stop.load(Ordering::Acquire) {
            return Err(ChatroomClientError::new(
                "client_closed",
                "聊天室连接已关闭",
            ));
        }
        let wake_budget =
            is_ordinary_command(&command) && self.wake_on_ordinary.swap(false, Ordering::AcqRel);
        #[cfg(test)]
        let command_gate = self.command_gate.lock().unwrap().take();
        #[cfg(test)]
        if let Some(gate) = command_gate {
            let _ = gate.loaded.send(());
            gate.release
                .recv_timeout(Duration::from_secs(1))
                .expect("测试命令未收到放行信号");
        }
        self.commands
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| ChatroomClientError::new("client_not_started", "聊天室连接尚未启动"))?
            .send(QueuedCommand {
                command,
                wake_budget,
            })
            .map_err(|_| ChatroomClientError::new("client_closed", "聊天室连接已关闭"))
    }

    pub fn shutdown(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            if let Some(worker) = self.worker.lock().unwrap().take() {
                let _ = worker.join();
            }
            return;
        }
        if let Some(commands) = self.commands.lock().unwrap().as_ref() {
            let _ = commands.send(QueuedCommand {
                command: ChatroomCommand::Close,
                wake_budget: false,
            });
        }
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

impl Drop for ChatroomClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker(
    auth: Arc<AuthSession>,
    url: String,
    connector: Arc<dyn ChatroomSocketConnector>,
    command_rx: mpsc::Receiver<QueuedCommand>,
    events: mpsc::Sender<ChatroomClientEvent>,
    stop: Arc<AtomicBool>,
    wake_on_ordinary: Arc<AtomicBool>,
    backoff: Arc<dyn BackoffWaiter>,
) {
    let mut subscription: Option<(Vec<RoomCursor>, String)> = None;
    let mut pending = VecDeque::new();
    let mut retries = 0usize;
    let mut refresh = RefreshAttempt::default();
    let mut unavailable = false;

    loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        if unavailable || subscription.is_none() {
            match command_rx.recv() {
                Ok(queued) => {
                    if apply_command(
                        queued.command,
                        &mut subscription,
                        &mut pending,
                        &mut unavailable,
                        &mut retries,
                        &mut refresh,
                        queued.wake_budget,
                        &stop,
                        &wake_on_ordinary,
                    ) {
                        return;
                    }
                }
                Err(_) => return,
            }
            continue;
        }

        let token = match auth.current_access_token() {
            Ok(token) => token,
            Err(error) => {
                emit_auth_error(&events, error);
                return;
            }
        };
        let authorization = format!("Bearer {token}");
        let mut socket = match connector.connect(&url, &authorization, &stop) {
            Ok(socket) => socket,
            Err(_) if stop.load(Ordering::Acquire) => return,
            Err(error) if error.code == "unauthorized" => {
                if refresh.attempted {
                    if refresh.failed {
                        let _ = auth.logout();
                        emit_status(&events, "auth_expired", "聊天室认证已过期");
                        mark_unavailable(&mut unavailable, &wake_on_ordinary);
                        continue;
                    }
                    let _ = auth.logout();
                    emit_status(&events, "auth_expired", "聊天室认证已过期");
                    mark_unavailable(&mut unavailable, &wake_on_ordinary);
                    continue;
                }
                refresh.attempted = true;
                match auth.refresh_single_flight() {
                    Ok(_) => continue,
                    Err(AuthError::Upstream { status: 401, .. }) => {
                        emit_status(&events, "auth_expired", "聊天室认证已过期");
                        mark_unavailable(&mut unavailable, &wake_on_ordinary);
                        continue;
                    }
                    Err(_) => {
                        refresh.failed = true;
                        emit_status(&events, "auth_refresh_failed", "聊天室认证刷新暂时失败");
                        emit_disconnected(&events);
                        if !retry_after_failure(&events, &backoff, &stop, &mut retries) {
                            mark_unavailable(&mut unavailable, &wake_on_ordinary);
                        }
                        continue;
                    }
                }
            }
            Err(_) => {
                emit_disconnected(&events);
                if !retry_after_failure(&events, &backoff, &stop, &mut retries) {
                    mark_unavailable(&mut unavailable, &wake_on_ordinary);
                }
                continue;
            }
        };
        refresh.attempted = false;
        refresh.failed = false;

        if let Some((rooms, device_id)) = subscription.clone() {
            let initial = ChatroomCommand::Subscribe { rooms, device_id };
            if socket.send_json(&initial).is_err() {
                socket.close();
                emit_disconnected(&events);
                if !retry_after_failure(&events, &backoff, &stop, &mut retries) {
                    mark_unavailable(&mut unavailable, &wake_on_ordinary);
                }
                continue;
            }
        }
        if !flush_pending(&mut socket, &mut pending, &events) {
            socket.close();
            emit_disconnected(&events);
            if !retry_after_failure(&events, &backoff, &stop, &mut retries) {
                mark_unavailable(&mut unavailable, &wake_on_ordinary);
            }
            continue;
        }
        let _ = events.send(ChatroomClientEvent::Connected);

        let mut reconnect = false;
        loop {
            if stop.load(Ordering::Acquire) {
                socket.close();
                return;
            }
            while let Ok(queued) = command_rx.try_recv() {
                let changes_subscription = matches!(
                    &queued.command,
                    ChatroomCommand::Subscribe { .. } | ChatroomCommand::Unsubscribe { .. }
                );
                if apply_command(
                    queued.command,
                    &mut subscription,
                    &mut pending,
                    &mut unavailable,
                    &mut retries,
                    &mut refresh,
                    queued.wake_budget,
                    &stop,
                    &wake_on_ordinary,
                ) {
                    socket.close();
                    return;
                }
                if changes_subscription {
                    reconnect = true;
                    break;
                }
                if unavailable {
                    reconnect = true;
                    break;
                }
                if subscription.is_none() {
                    reconnect = true;
                    break;
                }
            }
            let pending_send_failed =
                !reconnect && !flush_pending(&mut socket, &mut pending, &events);
            if pending_send_failed {
                reconnect = true;
            }
            if reconnect {
                socket.close();
                emit_disconnected(&events);
                if pending_send_failed
                    && !retry_after_failure(&events, &backoff, &stop, &mut retries)
                {
                    mark_unavailable(&mut unavailable, &wake_on_ordinary);
                }
                break;
            }
            match socket.receive_json() {
                Ok(event) => {
                    retries = 0;
                    refresh.attempted = false;
                    refresh.failed = false;
                    let _ = events.send(ChatroomClientEvent::Event(event));
                }
                Err(error) if error.code == "read_timeout" => {
                    // 一个完整的读超时窗口表示连接已进入稳定空闲态。
                    retries = 0;
                    refresh.attempted = false;
                    refresh.failed = false;
                    continue;
                }
                Err(_) => {
                    socket.close();
                    emit_disconnected(&events);
                    if !retry_after_failure(&events, &backoff, &stop, &mut retries) {
                        mark_unavailable(&mut unavailable, &wake_on_ordinary);
                    }
                    break;
                }
            }
        }
    }
}

fn apply_command(
    command: ChatroomCommand,
    subscription: &mut Option<(Vec<RoomCursor>, String)>,
    pending: &mut VecDeque<ChatroomCommand>,
    unavailable: &mut bool,
    retries: &mut usize,
    refresh: &mut RefreshAttempt,
    wake_budget: bool,
    stop: &AtomicBool,
    wake_on_ordinary: &AtomicBool,
) -> bool {
    match command {
        ChatroomCommand::Close => {
            stop.store(true, Ordering::Release);
            true
        }
        ChatroomCommand::Subscribe { rooms, device_id } => {
            *subscription = Some((rooms, device_id));
            *unavailable = false;
            reset_retry_budget(retries, refresh);
            wake_on_ordinary.store(false, Ordering::Release);
            false
        }
        ChatroomCommand::Unsubscribe { room_id } => {
            if let Some((rooms, device_id)) = subscription.as_mut() {
                rooms.retain(|room| room.room_id != room_id);
                if rooms.is_empty() {
                    *subscription = None;
                } else {
                    *subscription = Some((rooms.clone(), device_id.clone()));
                }
            }
            *unavailable = false;
            reset_retry_budget(retries, refresh);
            wake_on_ordinary.store(subscription.is_none(), Ordering::Release);
            false
        }
        command => {
            if wake_budget {
                *unavailable = false;
                reset_retry_budget(retries, refresh);
                wake_on_ordinary.store(false, Ordering::Release);
            }
            pending.push_back(command);
            false
        }
    }
}

fn reset_retry_budget(retries: &mut usize, refresh: &mut RefreshAttempt) {
    *retries = 0;
    refresh.attempted = false;
    refresh.failed = false;
}

fn is_ordinary_command(command: &ChatroomCommand) -> bool {
    matches!(
        command,
        ChatroomCommand::SendMessage { .. }
            | ChatroomCommand::AgentAccepted { .. }
            | ChatroomCommand::AgentEvent { .. }
            | ChatroomCommand::RenewLease { .. }
            | ChatroomCommand::CursorAck { .. }
    )
}

fn mark_unavailable(unavailable: &mut bool, wake_on_ordinary: &AtomicBool) {
    *unavailable = true;
    wake_on_ordinary.store(true, Ordering::Release);
}

fn flush_pending(
    socket: &mut Box<dyn ChatroomSocket>,
    pending: &mut VecDeque<ChatroomCommand>,
    events: &mpsc::Sender<ChatroomClientEvent>,
) -> bool {
    while let Some(command) = pending.pop_front() {
        if socket.send_json(&command).is_err() {
            pending.push_front(command);
            emit_status(events, "send_failed", "聊天室命令发送失败");
            return false;
        }
    }
    true
}

fn retry_after_failure(
    events: &mpsc::Sender<ChatroomClientEvent>,
    backoff: &Arc<dyn BackoffWaiter>,
    stop: &Arc<AtomicBool>,
    retries: &mut usize,
) -> bool {
    if *retries >= MAX_CONNECT_RETRIES - 1 {
        emit_status(events, "realtime_unavailable", "聊天室实时连接暂不可用");
        return false;
    }
    let seconds = [1, 2, 4, 8, 16, 30][(*retries).min(5)];
    *retries += 1;
    backoff.wait(Duration::from_secs(seconds), stop)
}

fn emit_disconnected(events: &mpsc::Sender<ChatroomClientEvent>) {
    let _ = events.send(ChatroomClientEvent::Disconnected);
}

fn emit_status(events: &mpsc::Sender<ChatroomClientEvent>, code: &str, message: &str) {
    let _ = events.send(ChatroomClientEvent::Status {
        code: code.to_string(),
        message: message.to_string(),
    });
}

fn emit_auth_error(events: &mpsc::Sender<ChatroomClientEvent>, error: AuthError) {
    let message = match error {
        AuthError::NotAuthenticated => "聊天室认证不可用",
        _ => "聊天室认证请求失败",
    };
    emit_status(events, "auth_expired", message);
}

struct DnsRequest {
    host: String,
    port: u16,
    response: mpsc::SyncSender<Result<Vec<SocketAddr>, ()>>,
}

struct CachedResolution {
    addresses: Vec<SocketAddr>,
    expires_at: Instant,
}

struct SystemDnsResolver {
    requests: Option<mpsc::SyncSender<DnsRequest>>,
    cache: Mutex<HashMap<(String, u16), CachedResolution>>,
}

impl SystemDnsResolver {
    fn new() -> Self {
        let (request_tx, request_rx) = mpsc::sync_channel::<DnsRequest>(1);
        let requests = thread::Builder::new()
            .name("copis-chatroom-dns".to_string())
            .spawn(move || {
                while let Ok(request) = request_rx.recv() {
                    let result = (request.host.as_str(), request.port)
                        .to_socket_addrs()
                        .map(|addresses| addresses.collect::<Vec<_>>())
                        .map_err(|_| ());
                    let _ = request.response.send(result);
                }
            })
            .ok()
            .map(|_| request_tx);
        Self {
            requests,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl ChatroomHostResolver for SystemDnsResolver {
    fn resolve(
        &self,
        host: &str,
        port: u16,
        stop: &AtomicBool,
    ) -> Result<Vec<SocketAddr>, ChatroomClientError> {
        if stop.load(Ordering::Acquire) {
            return Err(ChatroomClientError::new(
                "client_closed",
                "聊天室连接已关闭",
            ));
        }
        let key = (host.to_string(), port);
        {
            let mut cache = self.cache.lock().unwrap();
            if let Some(cached) = cache.get(&key) {
                if cached.expires_at > Instant::now() {
                    return Ok(cached.addresses.clone());
                }
            }
            cache.remove(&key);
        }

        let requests = self.requests.as_ref().ok_or_else(|| {
            ChatroomClientError::new("connect_failed", "聊天室地址解析服务不可用")
        })?;
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        requests
            .try_send(DnsRequest {
                host: key.0.clone(),
                port,
                response: response_tx,
            })
            .map_err(|_| ChatroomClientError::new("connect_failed", "聊天室地址解析服务繁忙"))?;

        let deadline = Instant::now() + DNS_TIMEOUT;
        loop {
            if stop.load(Ordering::Acquire) {
                return Err(ChatroomClientError::new(
                    "client_closed",
                    "聊天室连接已关闭",
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ChatroomClientError::new(
                    "connect_failed",
                    "聊天室地址解析超时",
                ));
            }
            match response_rx.recv_timeout(Duration::from_millis(20).min(remaining)) {
                Ok(Ok(addresses)) if !addresses.is_empty() => {
                    self.cache.lock().unwrap().insert(
                        key,
                        CachedResolution {
                            addresses: addresses.clone(),
                            expires_at: Instant::now() + DNS_CACHE_TTL,
                        },
                    );
                    return Ok(addresses);
                }
                Ok(Ok(_)) | Ok(Err(())) => {
                    return Err(ChatroomClientError::new(
                        "connect_failed",
                        "聊天室地址解析失败",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ChatroomClientError::new(
                        "connect_failed",
                        "聊天室地址解析失败",
                    ));
                }
            }
        }
    }
}

fn default_chatroom_host_resolver() -> Arc<dyn ChatroomHostResolver> {
    static RESOLVER: OnceLock<Arc<SystemDnsResolver>> = OnceLock::new();
    RESOLVER
        .get_or_init(|| Arc::new(SystemDnsResolver::new()))
        .clone()
}

pub struct TungsteniteConnector {
    resolver: Arc<dyn ChatroomHostResolver>,
}

impl TungsteniteConnector {
    pub fn new() -> Self {
        Self {
            resolver: default_chatroom_host_resolver(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_resolver(resolver: Arc<dyn ChatroomHostResolver>) -> Self {
        Self { resolver }
    }
}

impl Default for TungsteniteConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatroomSocketConnector for TungsteniteConnector {
    fn connect(
        &self,
        url: &str,
        authorization: &str,
        stop: &AtomicBool,
    ) -> Result<Box<dyn ChatroomSocket>, ChatroomClientError> {
        if stop.load(Ordering::Acquire) {
            return Err(ChatroomClientError::new(
                "client_closed",
                "聊天室连接已关闭",
            ));
        }
        let mut request = url
            .into_client_request()
            .map_err(|_| ChatroomClientError::new("connect_failed", "聊天室连接地址无效"))?;
        let value = HeaderValue::from_str(authorization)
            .map_err(|_| ChatroomClientError::new("connect_failed", "聊天室认证请求头无效"))?;
        request.headers_mut().insert(AUTHORIZATION, value);
        let uri = request.uri().clone();
        let mode = tungstenite::client::uri_mode(&uri)
            .map_err(|_| ChatroomClientError::new("connect_failed", "聊天室连接地址无效"))?;
        if uri.query().is_some() {
            return Err(ChatroomClientError::new(
                "connect_failed",
                "聊天室连接地址无效",
            ));
        }
        let host = uri
            .host()
            .filter(|host| {
                !host.is_empty()
                    && !host
                        .chars()
                        .any(|character| character.is_control() || character.is_whitespace())
            })
            .ok_or_else(|| ChatroomClientError::new("connect_failed", "聊天室连接地址无效"))?;
        let port = uri.port_u16().unwrap_or(match mode {
            Mode::Plain => 80,
            Mode::Tls => 443,
        });
        if port == 0 {
            return Err(ChatroomClientError::new(
                "connect_failed",
                "聊天室连接端口无效",
            ));
        }
        let addresses = self.resolver.resolve(host, port, stop)?;
        let stream = connect_tcp_with_timeout(&addresses, stop)?;
        stream
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)))
            .and_then(|_| stream.set_nodelay(true))
            .map_err(|_| ChatroomClientError::new("connect_failed", "聊天室连接超时配置失败"))?;
        let (config, _) = websocket_connect_config();
        let connector = match mode {
            Mode::Plain => Some(tungstenite::Connector::Plain),
            Mode::Tls => None,
        };
        let (socket, _) =
            tungstenite::client_tls_with_config(request, stream, Some(config), connector)
                .map_err(map_tungstenite_handshake_error)?;
        if stop.load(Ordering::Acquire) {
            return Err(ChatroomClientError::new(
                "client_closed",
                "聊天室连接已关闭",
            ));
        }
        Ok(Box::new(TungsteniteSocket::new(socket)?))
    }
}

pub(crate) fn websocket_io_timeouts() -> (Duration, Duration, Duration) {
    (CONNECT_TIMEOUT, READ_TIMEOUT, WRITE_TIMEOUT)
}

pub(crate) fn websocket_handshake_timeout() -> Duration {
    HANDSHAKE_TIMEOUT
}

fn connect_tcp_with_timeout(
    addresses: &[SocketAddr],
    stop: &AtomicBool,
) -> Result<TcpStream, ChatroomClientError> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    for address in addresses.iter().copied() {
        if stop.load(Ordering::Acquire) {
            return Err(ChatroomClientError::new(
                "client_closed",
                "聊天室连接已关闭",
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(stream) = TcpStream::connect_timeout(&address, remaining) {
            return Ok(stream);
        }
    }
    if stop.load(Ordering::Acquire) {
        return Err(ChatroomClientError::new(
            "client_closed",
            "聊天室连接已关闭",
        ));
    }
    Err(ChatroomClientError::new("connect_failed", "聊天室连接超时"))
}

pub(crate) fn websocket_connect_config() -> (WebSocketConfig, u8) {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    (config, MAX_REDIRECTS)
}

fn map_tungstenite_connect_error(error: tungstenite::Error) -> ChatroomClientError {
    if let tungstenite::Error::Http(response) = &error {
        let status = response.status().as_u16();
        if status == 401 {
            return ChatroomClientError::new("unauthorized", "聊天室连接未授权");
        }
        if (300..400).contains(&status) {
            return ChatroomClientError::new("redirect_not_allowed", "聊天室连接不允许重定向");
        }
    }
    ChatroomClientError::new("connect_failed", "聊天室连接失败")
}

fn map_tungstenite_handshake_error<S: Read + Write>(
    error: HandshakeError<ClientHandshake<S>>,
) -> ChatroomClientError {
    match error {
        HandshakeError::Failure(error) => map_tungstenite_connect_error(error),
        HandshakeError::Interrupted(_) => {
            ChatroomClientError::new("connect_failed", "聊天室握手未完成")
        }
    }
}

struct TungsteniteSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
}

impl TungsteniteSocket {
    fn new(mut socket: WebSocket<MaybeTlsStream<TcpStream>>) -> Result<Self, ChatroomClientError> {
        match socket.get_mut() {
            MaybeTlsStream::Plain(stream) => stream
                .set_read_timeout(Some(READ_TIMEOUT))
                .and_then(|_| stream.set_write_timeout(Some(WRITE_TIMEOUT)))
                .map_err(|_| {
                    ChatroomClientError::new("connect_failed", "聊天室读取超时配置失败")
                })?,
            MaybeTlsStream::Rustls(stream) => stream
                .get_mut()
                .set_read_timeout(Some(READ_TIMEOUT))
                .and_then(|_| stream.get_mut().set_write_timeout(Some(WRITE_TIMEOUT)))
                .map_err(|_| {
                    ChatroomClientError::new("connect_failed", "聊天室读取超时配置失败")
                })?,
            _ => {
                return Err(ChatroomClientError::new(
                    "connect_failed",
                    "聊天室读取超时配置失败",
                ))
            }
        }
        Ok(Self { socket })
    }
}

impl ChatroomSocket for TungsteniteSocket {
    fn send_json(&mut self, command: &ChatroomCommand) -> Result<(), ChatroomClientError> {
        let text = serde_json::to_string(command)
            .map_err(|_| ChatroomClientError::new("protocol_invalid", "聊天室命令格式无效"))?;
        if text.len() > MAX_MESSAGE_BYTES {
            return Err(ChatroomClientError::new(
                "payload_too_large",
                "聊天室命令过大",
            ));
        }
        self.socket
            .send(Message::Text(text.into()))
            .map_err(map_send_error)
    }

    fn receive_json(&mut self) -> Result<ChatroomEvent, ChatroomClientError> {
        loop {
            match self.socket.read() {
                Ok(message) => match decode_message(message) {
                    Ok(Some(event)) => return Ok(event),
                    Ok(None) => continue,
                    Err(error) => return Err(error),
                },
                Err(error) => return Err(map_socket_error(error)),
            }
        }
    }

    fn close(&mut self) {
        let _ = self.socket.close(None);
    }
}

pub(crate) fn decode_message(
    message: Message,
) -> Result<Option<ChatroomEvent>, ChatroomClientError> {
    match message {
        Message::Text(text) => parse_event(text.as_bytes()).map(Some),
        Message::Binary(bytes) => {
            let text = str::from_utf8(&bytes).map_err(|_| {
                ChatroomClientError::new("protocol_invalid", "聊天室二进制帧不是 UTF-8")
            })?;
            parse_event(text.as_bytes()).map(Some)
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
        Message::Close(_) => Err(ChatroomClientError::new("disconnected", "聊天室连接已关闭")),
    }
}

fn parse_event(bytes: &[u8]) -> Result<ChatroomEvent, ChatroomClientError> {
    crate::chatroom_protocol::parse_event(bytes)
        .map_err(|error| ChatroomClientError::new(error.code, error.message))
}

fn map_socket_error(error: tungstenite::Error) -> ChatroomClientError {
    match error {
        tungstenite::Error::Io(error)
            if error.kind() == io::ErrorKind::TimedOut
                || error.kind() == io::ErrorKind::WouldBlock =>
        {
            ChatroomClientError::new("read_timeout", "聊天室读取超时")
        }
        tungstenite::Error::Capacity(_) => {
            ChatroomClientError::new("payload_too_large", "聊天室帧过大")
        }
        tungstenite::Error::Utf8(_) => {
            ChatroomClientError::new("protocol_invalid", "聊天室帧不是 UTF-8")
        }
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            ChatroomClientError::new("disconnected", "聊天室连接已关闭")
        }
        _ => ChatroomClientError::new("socket_error", "聊天室连接读写失败"),
    }
}

fn map_send_error(error: tungstenite::Error) -> ChatroomClientError {
    match error {
        tungstenite::Error::Capacity(_) => {
            ChatroomClientError::new("payload_too_large", "聊天室命令过大")
        }
        tungstenite::Error::Io(error)
            if error.kind() == io::ErrorKind::TimedOut
                || error.kind() == io::ErrorKind::WouldBlock =>
        {
            ChatroomClientError::new("send_failed", "聊天室命令发送超时")
        }
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            ChatroomClientError::new("send_failed", "聊天室连接已关闭")
        }
        _ => ChatroomClientError::new("send_failed", "聊天室命令发送失败"),
    }
}
