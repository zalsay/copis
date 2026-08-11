use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod agent_files;
mod alipay_bot;
mod expert_teams;
mod memory;
mod payment_capability;
mod payment_workspace;
mod pi_rpc;
mod runtime;
mod skill_market;
mod working_payment;
mod workspace_dev;
mod workspace_mcp;
mod workspace_skills;

use expert_teams::{ExpertTeamError, ExpertTeamStore};
use memory::{
    MemoryCaptureBatchInput, MemoryCaptureInput, MemoryContextInput, MemoryError,
    MemoryExportInput, MemoryKind, MemoryMaintenanceApplyInput, MemoryRestoreInput,
    MemoryRewriteInput, MemoryScope, MemoryStore, DEFAULT_LIST_LIMIT, DEFAULT_RECALL_LIMIT,
};
use payment_capability::PAYMENT_CAPABILITY_TOKEN_HEADER;
use payment_workspace::PaymentWorkspace;
use pi_rpc::{
    agent_session_id, is_agent_messages_route, is_agent_queue_route, is_agent_status_route,
    is_agent_stop_route, is_agent_workers_status_route, is_agent_workers_stop_all_route,
    parse_worker_frame, sse_headers_with_origin, PiWorkerManager,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use skill_market::{handle_request as handle_skill_market_request, SkillMarketState};
use working_payment::{handle_request as handle_working_payment_request, WorkingPaymentState};
use workspace_dev::{WorkspaceDevActionInput, WorkspaceDevError, WorkspaceDevStore};
use workspace_mcp::{WorkspaceMcpError, WorkspaceMcpStore};
use workspace_skills::{WorkspaceSkillsError, WorkspaceSkillsStore};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 51730;
// 文件写入接口允许 50 MB 内容，额外预留 JSON/path/sessionId 等请求字段空间。
const MAX_REQUEST_BODY_BYTES: usize = 50 * 1024 * 1024 + 256 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_RECORDING_LINE_BYTES: usize = 256 * 1024;
const MAX_RECORDING_FILE_BYTES: u64 = 8 * 1024 * 1024;
const INTERNAL_TOKEN_HEADER: &str = "x-copis-internal-token";
const WEB_TOKEN_HEADER: &str = "x-copis-web-token";
const AGENT_FILE_TOKEN_HEADER: &str = "x-copis-agent-file-token";
const INTERNAL_RECORDING_PREFIX: &str = "/internal/browser-workflows/recordings/";
const INTERNAL_WORKING_AUTH_PATH: &str = "/internal/working-auth/token";
const INTERNAL_AGENT_FILES_PREFIX: &str = "/api/internal/agent/files/";
const INTERNAL_AGENT_SHELL_PATH: &str = "/api/internal/agent/shell";
const INTERNAL_AGENT_ALIPAY_BOT_PATH: &str = "/api/internal/agent/alipay-bot";
const VITE_DEV_ORIGINS: [&str; 2] = ["http://127.0.0.1:5174", "http://localhost:5174"];
// 业务桥请求等待 Electron 响应的上限，超时后清理 pending 避免线程永久挂起。
const BRIDGE_REQUEST_TIMEOUT_SECS: u64 = 60;
const BRIDGE_TIMEOUT_MESSAGE: &str = "HTTP API 业务桥响应超时";
// 慢速/半开连接在读取请求时占用线程，设置读超时避免长期占用（slowloris 防护）。
const CONNECTION_READ_TIMEOUT_SECS: u64 = 30;
const MAX_CONCURRENT_CONNECTIONS: usize = 64;

fn bridge_request_timeout() -> Duration {
    let millis = std::env::var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(BRIDGE_REQUEST_TIMEOUT_SECS * 1000);
    Duration::from_millis(millis)
}

fn connection_read_timeout() -> Duration {
    let millis = std::env::var("COPIS_HTTP_API_READ_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(CONNECTION_READ_TIMEOUT_SECS * 1000);
    Duration::from_millis(millis)
}

struct BridgeResponse {
    status: u16,
    body: Option<String>,
}

struct Bridge {
    next_id: AtomicU64,
    available: AtomicBool,
    writer: Mutex<BufWriter<io::Stdout>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<BridgeResponse, String>>>>,
    recording_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Bridge {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            available: AtomicBool::new(true),
            writer: Mutex::new(BufWriter::new(io::stdout())),
            pending: Mutex::new(HashMap::new()),
            recording_locks: Mutex::new(HashMap::new()),
        }
    }

    fn send_request(&self, request: &HttpRequest) -> Result<BridgeResponse, String> {
        if !self.available.load(Ordering::Acquire) {
            return Err("HTTP API 业务桥不可用".to_string());
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);

        let body_hex = encode_hex(&request.body);
        let line = format!(
            "{}\t{}\t{}\t{}\n",
            id,
            encode_hex(request.method.as_bytes()),
            encode_hex(request.target.as_bytes()),
            body_hex,
        );
        let write_result = {
            let mut writer = self.writer.lock().unwrap();
            writer
                .write_all(line.as_bytes())
                .and_then(|_| writer.flush())
        };
        if let Err(error) = write_result {
            self.pending.lock().unwrap().remove(&id);
            self.available.store(false, Ordering::Release);
            return Err(format!("HTTP API 业务桥写入失败: {}", error));
        }

        match receiver.recv_timeout(bridge_request_timeout()) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(BRIDGE_TIMEOUT_MESSAGE.to_string())
            }
            Err(_) => Err("HTTP API 业务桥未返回响应".to_string()),
        }
    }

    fn fail_all(&self, message: &str) {
        self.available.store(false, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for (_, sender) in pending {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

struct HttpRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct BufferedReader<'a> {
    stream: &'a mut TcpStream,
    buffer: Vec<u8>,
}

impl<'a> BufferedReader<'a> {
    fn new(stream: &'a mut TcpStream) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
        }
    }

    fn read_until(&mut self, delimiter: &[u8], max_bytes: usize) -> io::Result<Vec<u8>> {
        loop {
            if let Some(position) = find_subslice(&self.buffer, delimiter) {
                let end = position + delimiter.len();
                let result = self.buffer[..position].to_vec();
                self.buffer.drain(..end);
                return Ok(result);
            }
            if self.buffer.len() > max_bytes {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "请求头或行过大"));
            }

            let mut chunk = [0_u8; 8192];
            let read = self.stream.read(&mut chunk)?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "请求提前结束"));
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }

    fn read_exact_bytes(&mut self, length: usize) -> io::Result<Vec<u8>> {
        while self.buffer.len() < length {
            let mut chunk = [0_u8; 8192];
            let read = self.stream.read(&mut chunk)?;
            if read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "请求体提前结束",
                ));
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }

        let result = self.buffer[..length].to_vec();
        self.buffer.drain(..length);
        Ok(result)
    }
}

enum RequestError {
    BadRequest(&'static str, &'static str),
    TooLarge,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, RequestError> {
    let mut reader = BufferedReader::new(stream);
    let header_bytes = reader
        .read_until(b"\r\n\r\n", MAX_HEADER_BYTES)
        .map_err(|_| RequestError::BadRequest("请求头不正确", "invalid_http_request"))?;
    let header_text = String::from_utf8_lossy(&header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or(RequestError::BadRequest(
        "请求行不正确",
        "invalid_http_request",
    ))?;
    let request_parts: Vec<&str> = request_line.split_whitespace().collect();
    if request_parts.len() != 3 || !request_parts[2].starts_with("HTTP/") {
        return Err(RequestError::BadRequest(
            "请求行不正确",
            "invalid_http_request",
        ));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(RequestError::BadRequest(
                "请求头不正确",
                "invalid_http_request",
            ));
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }

    let body = if headers
        .get("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        read_chunked_body(&mut reader)?
    } else if let Some(content_length) = headers.get("content-length") {
        let length = content_length
            .parse::<usize>()
            .map_err(|_| RequestError::BadRequest("请求体长度不正确", "invalid_content_length"))?;
        if length > MAX_REQUEST_BODY_BYTES {
            return Err(RequestError::TooLarge);
        }
        reader
            .read_exact_bytes(length)
            .map_err(|_| RequestError::BadRequest("请求体不完整", "invalid_http_request"))?
    } else {
        Vec::new()
    };

    Ok(HttpRequest {
        method: request_parts[0].to_string(),
        target: request_parts[1].to_string(),
        headers,
        body,
    })
}

fn read_chunked_body(reader: &mut BufferedReader) -> Result<Vec<u8>, RequestError> {
    let mut body = Vec::new();
    loop {
        let line = reader
            .read_until(b"\r\n", MAX_LINE_BYTES)
            .map_err(|_| RequestError::BadRequest("分块请求体不正确", "invalid_http_request"))?;
        let size_text = String::from_utf8_lossy(&line);
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| RequestError::BadRequest("分块请求体不正确", "invalid_http_request"))?;
        if size == 0 {
            loop {
                let trailer = reader.read_until(b"\r\n", MAX_LINE_BYTES).map_err(|_| {
                    RequestError::BadRequest("分块请求体不正确", "invalid_http_request")
                })?;
                if trailer.is_empty() {
                    break;
                }
            }
            break;
        }
        if body.len().saturating_add(size) > MAX_REQUEST_BODY_BYTES {
            return Err(RequestError::TooLarge);
        }
        body.extend_from_slice(
            &reader
                .read_exact_bytes(size)
                .map_err(|_| RequestError::BadRequest("请求体不完整", "invalid_http_request"))?,
        );
        let terminator = reader
            .read_exact_bytes(2)
            .map_err(|_| RequestError::BadRequest("分块请求体不完整", "invalid_http_request"))?;
        if terminator != b"\r\n" {
            return Err(RequestError::BadRequest(
                "分块请求体不正确",
                "invalid_http_request",
            ));
        }
    }
    Ok(body)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMemoryRecallRequest {
    workspace_slug: Option<String>,
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMemoryCaptureRequest {
    workspace_slug: String,
    kind: MemoryKind,
    title: String,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMemoryRewriteRequest {
    workspace_slug: String,
    title: Option<String>,
    content: Option<String>,
    tags: Option<Vec<String>>,
    expected_revision: u64,
}

fn handle_memory_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &MemoryStore,
) {
    let (path, _) = request
        .target
        .split_once('?')
        .unwrap_or((request.target.as_str(), ""));
    let query = match parse_query_parameters(&request.target) {
        Ok(query) => query,
        Err(message) => {
            send_memory_bad_request(stream, &message, origin);
            return;
        }
    };

    if request.method == "GET" && path == "/api/memory" {
        let workspace_slug = query.get("workspaceSlug").map(String::as_str);
        let options = match parse_memory_list_options(&query) {
            Ok(options) => options,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        let result = store.list(
            workspace_slug,
            query.get("q").map(String::as_str),
            options.0,
            options.1,
            options.2,
            options.3,
        );
        send_memory_result(stream, result, origin);
        return;
    }

    if request.method == "POST" && path == "/api/memory" {
        let input = match parse_memory_body::<MemoryCaptureInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.capture(input), origin);
        return;
    }

    if request.method == "POST" && path == "/api/memory/export" {
        let input = match parse_memory_body::<MemoryExportInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.export(input), origin);
        return;
    }

    let parts = match memory_path_parts(path) {
        Ok(parts) => parts,
        Err(message) => {
            send_memory_bad_request(stream, &message, origin);
            return;
        }
    };

    if request.method == "GET" && parts.as_slice() == ["stats"] {
        let result = store.stats(query.get("workspaceSlug").map(String::as_str));
        send_memory_result(stream, result, origin);
        return;
    }

    if request.method == "POST" && parts.as_slice() == ["recall"] {
        let input = match parse_memory_body::<AgentMemoryRecallRequest>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        let result = store.recall(
            input.workspace_slug.as_deref(),
            &input.query,
            input.limit.unwrap_or(DEFAULT_RECALL_LIMIT),
        );
        send_memory_result(stream, result, origin);
        return;
    }

    if request.method == "POST" && parts.as_slice() == ["context"] {
        let input = match parse_memory_body::<MemoryContextInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.context(input), origin);
        return;
    }

    if request.method == "POST" && parts.as_slice() == ["capture-batch"] {
        let input = match parse_memory_body::<MemoryCaptureBatchInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.capture_batch(input), origin);
        return;
    }

    if request.method == "GET" && parts.as_slice() == ["maintenance"] {
        let Some(workspace_slug) = query.get("workspaceSlug") else {
            send_memory_error(
                stream,
                MemoryError::Validation("workspaceSlug 参数不正确".to_string()),
                origin,
            );
            return;
        };
        send_memory_result(stream, store.maintenance_state(workspace_slug), origin);
        return;
    }

    if request.method == "POST" && parts.as_slice() == ["maintenance", "apply"] {
        let input = match parse_memory_body::<MemoryMaintenanceApplyInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.apply_maintenance(input), origin);
        return;
    }

    if request.method == "POST" && parts.as_slice() == ["capture"] {
        let input = match parse_memory_body::<AgentMemoryCaptureRequest>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        let input = MemoryCaptureInput {
            workspace_slug: Some(input.workspace_slug),
            scope: MemoryScope::Workspace,
            kind: input.kind,
            title: input.title,
            content: input.content,
            tags: input.tags,
            source: memory::MemorySource::Agent,
        };
        send_memory_result(stream, store.capture(input), origin);
        return;
    }

    if parts.is_empty() {
        send_memory_not_found(stream, origin);
        return;
    }
    let id = &parts[0];
    let workspace_slug = query.get("workspaceSlug").map(String::as_str);

    if parts.len() == 1 && request.method == "GET" {
        send_memory_result(stream, store.get(id, workspace_slug), origin);
        return;
    }

    if parts.len() == 2 && parts[1] == "read" && request.method == "GET" {
        send_memory_result(stream, store.get(id, workspace_slug), origin);
        return;
    }

    if parts.len() == 2 && parts[1] == "history" && request.method == "GET" {
        let result = store
            .history(id, workspace_slug)
            .map(|revisions| json!({ "revisions": revisions }));
        send_memory_result(stream, result, origin);
        return;
    }

    if parts.len() == 2 && parts[1] == "rewrite" && request.method == "PATCH" {
        let input = match parse_memory_body::<AgentMemoryRewriteRequest>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        let input = MemoryRewriteInput {
            workspace_slug: Some(input.workspace_slug),
            title: input.title,
            content: input.content,
            kind: None,
            tags: input.tags,
            expected_revision: input.expected_revision,
        };
        send_memory_result(stream, store.rewrite(id, input), origin);
        return;
    }

    if parts.len() == 2 && parts[1] == "restore" && request.method == "POST" {
        let input = match parse_memory_body::<MemoryRestoreInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.restore(id, input), origin);
        return;
    }

    if parts.len() == 1 && request.method == "PATCH" {
        let input = match parse_memory_body::<MemoryRewriteInput>(request) {
            Ok(input) => input,
            Err(error) => {
                send_memory_error(stream, error, origin);
                return;
            }
        };
        send_memory_result(stream, store.rewrite(id, input), origin);
        return;
    }

    if parts.len() == 1 && request.method == "DELETE" {
        send_memory_result(stream, store.archive(id, workspace_slug), origin);
        return;
    }

    send_memory_not_found(stream, origin);
}

fn parse_memory_body<T: DeserializeOwned>(request: &HttpRequest) -> Result<T, MemoryError> {
    serde_json::from_slice(&request.body)
        .map_err(|_| MemoryError::Validation("请求体不是有效的 Memory JSON".to_string()))
}

fn memory_path_parts(path: &str) -> Result<Vec<String>, String> {
    let prefix = "/api/memory/";
    let Some(rest) = path.strip_prefix(prefix) else {
        return Err("Memory 路径不正确".to_string());
    };
    if rest.is_empty() {
        return Err("Memory 路径不正确".to_string());
    }
    rest.split('/')
        .map(|part| decode_url_component(part, false))
        .collect()
}

fn parse_query_parameters(target: &str) -> Result<HashMap<String, String>, String> {
    let Some((_, query)) = target.split_once('?') else {
        return Ok(HashMap::new());
    };
    let mut parameters = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        parameters.insert(
            decode_url_component(key, true)?,
            decode_url_component(value, true)?,
        );
    }
    Ok(parameters)
}

fn decode_url_component(value: &str, plus_as_space: bool) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let high =
                    hex_digit(bytes[index + 1]).ok_or_else(|| "URL 参数编码不正确".to_string())?;
                let low =
                    hex_digit(bytes[index + 2]).ok_or_else(|| "URL 参数编码不正确".to_string())?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            b'%' => return Err("URL 参数编码不正确".to_string()),
            b'+' if plus_as_space => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| "URL 参数不是有效 UTF-8".to_string())
}

fn parse_memory_list_options(
    query: &HashMap<String, String>,
) -> Result<(Option<MemoryScope>, Option<MemoryKind>, bool, usize), MemoryError> {
    let scope = match query.get("scope").map(String::as_str) {
        None => None,
        Some("user") => Some(MemoryScope::User),
        Some("workspace") => Some(MemoryScope::Workspace),
        Some(_) => return Err(MemoryError::Validation("scope 参数不正确".to_string())),
    };
    let kind = match query.get("kind").map(String::as_str) {
        None => None,
        Some("fact") => Some(MemoryKind::Fact),
        Some("preference") => Some(MemoryKind::Preference),
        Some("decision") => Some(MemoryKind::Decision),
        Some("project") => Some(MemoryKind::Project),
        Some("scratch") => Some(MemoryKind::Scratch),
        Some(_) => return Err(MemoryError::Validation("kind 参数不正确".to_string())),
    };
    let include_archived = match query.get("includeArchived").map(String::as_str) {
        None => false,
        Some("true") | Some("1") => true,
        Some("false") | Some("0") => false,
        Some(_) => {
            return Err(MemoryError::Validation(
                "includeArchived 参数不正确".to_string(),
            ))
        }
    };
    let limit = match query.get("limit") {
        None => DEFAULT_LIST_LIMIT,
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| MemoryError::Validation("limit 参数不正确".to_string()))?,
    };
    Ok((scope, kind, include_archived, limit))
}

fn send_memory_result<T: Serialize>(
    stream: &mut TcpStream,
    result: Result<T, MemoryError>,
    origin: Option<&str>,
) {
    match result {
        Ok(value) => match serde_json::to_string(&value) {
            Ok(body) => send_json_response(stream, 200, &body, origin),
            Err(error) => {
                send_memory_error(stream, MemoryError::Storage(error.to_string()), origin)
            }
        },
        Err(error) => send_memory_error(stream, error, origin),
    }
}

fn send_memory_error(stream: &mut TcpStream, error: MemoryError, origin: Option<&str>) {
    let (status, code, body) = match error {
        MemoryError::Validation(message) => (
            400,
            "invalid_memory_request",
            json!({ "error": message, "code": "invalid_memory_request" }),
        ),
        MemoryError::NotFound => (
            404,
            "memory_not_found",
            json!({ "error": "记忆条目不存在或不在当前可见范围", "code": "memory_not_found" }),
        ),
        MemoryError::Conflict(entry) => (
            409,
            "revision_conflict",
            json!({ "error": "记忆 revision 冲突", "code": "revision_conflict", "current": entry }),
        ),
        MemoryError::MaintenanceConflict(state) => (
            409,
            "maintenance_conflict",
            json!({ "error": "记忆维护状态已变化", "code": "maintenance_conflict", "current": state }),
        ),
        MemoryError::Storage(message) => (
            500,
            "memory_storage_error",
            json!({ "error": message, "code": "memory_storage_error" }),
        ),
    };
    let body = serde_json::to_string(&body)
        .unwrap_or_else(|_| format!(r#"{{"error":"Memory {}","code":"{}"}}"#, status, code));
    send_json_response(stream, status, &body, origin);
}

fn send_memory_bad_request(stream: &mut TcpStream, message: &str, origin: Option<&str>) {
    send_json_response(
        stream,
        400,
        &serde_json::to_string(&json!({ "error": message, "code": "invalid_memory_request" }))
            .unwrap(),
        origin,
    );
}

fn send_memory_not_found(stream: &mut TcpStream, origin: Option<&str>) {
    send_json_response(
        stream,
        404,
        r#"{"error":"Memory 路由不存在","code":"memory_route_not_found"}"#,
        origin,
    );
}

fn read_bridge_responses(bridge: Arc<Bridge>) {
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    for line_result in reader.lines() {
        let Ok(line) = line_result else {
            break;
        };
        if let Some((id, response)) = parse_bridge_response(&line) {
            if let Some(sender) = bridge.pending.lock().unwrap().remove(&id) {
                let _ = sender.send(Ok(response));
            }
        } else if !line.trim().is_empty() {
            eprintln!("[HTTP API] 收到无法解析的 Electron 响应");
        }
    }
    bridge.fail_all("Electron HTTP API 业务桥已关闭");
    process::exit(0);
}

fn parse_bridge_response(line: &str) -> Option<(u64, BridgeResponse)> {
    let mut fields = line.splitn(3, '\t');
    let id = fields.next()?.parse::<u64>().ok()?;
    let status = fields.next()?.parse::<u16>().ok()?;
    let body_hex = fields.next().unwrap_or("");
    let body = if body_hex.is_empty() {
        None
    } else {
        Some(String::from_utf8(decode_hex(body_hex)?).ok()?)
    };
    Some((id, BridgeResponse { status, body }))
}

struct InternalRecordingResponse {
    status: u16,
    body: Option<String>,
    json: bool,
}

struct InternalRecordingRoute<'a> {
    workspace: &'a str,
    recording_id: &'a str,
    action: &'a str,
}

fn parse_internal_recording_route(target: &str) -> Option<InternalRecordingRoute<'_>> {
    let path = target.split('?').next()?;
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 7
        || parts[1] != "internal"
        || parts[2] != "browser-workflows"
        || parts[3] != "recordings"
    {
        return None;
    }

    if !is_safe_path_component(parts[4]) || !is_safe_path_component(parts[5]) {
        return None;
    }

    Some(InternalRecordingRoute {
        workspace: parts[4],
        recording_id: parts[5],
        action: parts[6],
    })
}

fn is_safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn recording_path(workspace: &str, recording_id: &str) -> Result<PathBuf, &'static str> {
    if !is_safe_path_component(workspace) || !is_safe_path_component(recording_id) {
        return Err("录制路径参数不正确");
    }

    let config_dir = std::env::var("COPIS_CONFIG_DIR").map_err(|_| "Copis 配置目录未设置")?;
    Ok(PathBuf::from(config_dir)
        .join("agent-workspaces")
        .join(workspace)
        .join("browser-recordings")
        .join(format!("{}.jsonl", recording_id)))
}

fn recording_lock(bridge: &Bridge, path: &Path) -> Arc<Mutex<()>> {
    let key = path.to_string_lossy().into_owned();
    let mut locks = bridge.recording_locks.lock().unwrap();
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn append_recording_line(
    bridge: &Bridge,
    path: &PathBuf,
    line: &[u8],
    create: bool,
) -> Result<(), &'static str> {
    if line.is_empty()
        || line.len() > MAX_RECORDING_LINE_BYTES
        || line.first() != Some(&b'{')
        || line.last() != Some(&b'}')
        || line.contains(&b'\n')
        || line.contains(&b'\r')
    {
        return Err("录制 JSONL 行不正确");
    }

    let lock = recording_lock(bridge, path);
    let _guard = lock.lock().unwrap();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "创建录制目录失败")?;
    }

    let current_len = if create {
        0
    } else {
        fs::metadata(path)
            .map_err(|_| "打开录制 JSONL 文件失败")?
            .len()
    };
    let next_len = current_len
        .saturating_add(line.len() as u64)
        .saturating_add(1);
    if next_len > MAX_RECORDING_FILE_BYTES {
        return Err("录制 JSONL 过大");
    }

    let mut file = if create {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "创建录制 JSONL 文件失败")?
    } else {
        OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|_| "打开录制 JSONL 文件失败")?
    };
    file.write_all(line).map_err(|_| "写入录制 JSONL 失败")?;
    file.write_all(b"\n")
        .map_err(|_| "写入录制 JSONL 换行失败")?;
    file.flush().map_err(|_| "刷新录制 JSONL 失败")
}

fn recording_marker(recording_id: &str, kind: &str) -> Vec<u8> {
    format!(
        "{{\"kind\":\"{}\",\"recordingId\":\"{}\",\"timestamp\":{}}}",
        kind,
        recording_id,
        unix_timestamp_millis(),
    )
    .into_bytes()
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn is_internal_token_valid(request: &HttpRequest) -> bool {
    let Ok(expected) = std::env::var("COPIS_HTTP_API_INTERNAL_TOKEN") else {
        return false;
    };
    !expected.is_empty()
        && request
            .headers
            .get(INTERNAL_TOKEN_HEADER)
            .map(|received| agent_files::tokens_equal(&expected, received))
            .unwrap_or(false)
}

fn is_web_token_valid(request: &HttpRequest) -> bool {
    if is_internal_token_valid(request) {
        return true;
    }
    let Ok(expected) = std::env::var("COPIS_HTTP_API_WEB_TOKEN") else {
        return false;
    };
    !expected.is_empty()
        && request
            .headers
            .get(WEB_TOKEN_HEADER)
            .map(|received| agent_files::tokens_equal(&expected, received))
            .unwrap_or(false)
}

fn is_vite_dev_origin(origin: &str) -> bool {
    VITE_DEV_ORIGINS.contains(&origin)
}

fn is_internal_path(path: &str) -> bool {
    path.starts_with("/internal/") || path.starts_with("/api/internal/")
}

fn is_internal_agent_shell_path(path: &str) -> bool {
    path == INTERNAL_AGENT_SHELL_PATH
}

fn is_internal_agent_alipay_bot_path(path: &str) -> bool {
    path == INTERNAL_AGENT_ALIPAY_BOT_PATH
}

/// 浏览器 Origin 请求必须携带 web 令牌；Vite 开发来源与无 Origin 的本地进程请求除外。
/// 内部路由与健康检查继续由各自逻辑放行，不在此处校验。
fn is_web_route_authorized(origin: Option<&str>, request: &HttpRequest, path: &str) -> bool {
    if is_internal_path(path) || path == "/api/health" {
        return true;
    }
    match origin {
        None => true,
        Some(value) if is_vite_dev_origin(value) => true,
        Some(_) => is_web_token_valid(request),
    }
}

fn handle_internal_recording_request(
    request: &HttpRequest,
    bridge: &Bridge,
) -> Result<InternalRecordingResponse, (u16, &'static str)> {
    let route =
        parse_internal_recording_route(&request.target).ok_or((404, "录制 API 路径不存在"))?;
    let path =
        recording_path(route.workspace, route.recording_id).map_err(|message| (400, message))?;

    match (request.method.as_str(), route.action) {
        ("POST", "start") => {
            let body = if request.body.is_empty() {
                return Err((400, "录制开始元数据不能为空"));
            } else {
                request.body.as_slice()
            };
            append_recording_line(bridge, &path, body, true).map_err(|message| (500, message))?;
            Ok(InternalRecordingResponse {
                status: 201,
                body: Some("{\"ok\":true}".to_string()),
                json: true,
            })
        }
        ("POST", "event") => {
            append_recording_line(bridge, &path, &request.body, false)
                .map_err(|message| (500, message))?;
            Ok(InternalRecordingResponse {
                status: 204,
                body: None,
                json: false,
            })
        }
        ("POST", "finish") => {
            let marker = recording_marker(route.recording_id, "recording_finished");
            append_recording_line(bridge, &path, &marker, false)
                .map_err(|message| (500, message))?;
            Ok(InternalRecordingResponse {
                status: 200,
                body: Some("{\"ok\":true}".to_string()),
                json: true,
            })
        }
        ("POST", "cancel") => {
            let marker = recording_marker(route.recording_id, "recording_cancelled");
            append_recording_line(bridge, &path, &marker, false)
                .map_err(|message| (500, message))?;
            Ok(InternalRecordingResponse {
                status: 200,
                body: Some("{\"ok\":true}".to_string()),
                json: true,
            })
        }
        ("GET", "content") => {
            let lock = recording_lock(bridge, &path);
            let _guard = lock.lock().unwrap();
            let metadata = fs::metadata(&path).map_err(|_| (404, "录制 JSONL 不存在"))?;
            if metadata.len() > MAX_RECORDING_FILE_BYTES {
                return Err((413, "录制 JSONL 过大"));
            }
            let content = fs::read_to_string(&path).map_err(|_| (500, "读取录制 JSONL 失败"))?;
            Ok(InternalRecordingResponse {
                status: 200,
                body: Some(content),
                json: false,
            })
        }
        _ => Err((405, "录制 API 方法不支持")),
    }
}

fn handle_connection(
    mut stream: TcpStream,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
    memory_store: Arc<MemoryStore>,
    expert_team_store: Arc<ExpertTeamStore>,
    skill_market_state: Arc<SkillMarketState>,
    working_payment_state: Arc<WorkingPaymentState>,
    payment_workspace: Arc<PaymentWorkspace>,
    workspace_mcp_store: Arc<WorkspaceMcpStore>,
    workspace_dev_store: Arc<WorkspaceDevStore>,
    workspace_skills_store: Arc<WorkspaceSkillsStore>,
) {
    let _ = stream.set_read_timeout(Some(connection_read_timeout()));
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(RequestError::TooLarge) => {
            send_json_response(
                &mut stream,
                413,
                r#"{"error":"请求体过大","code":"request_body_too_large"}"#,
                None,
            );
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        Err(RequestError::BadRequest(message, code)) => {
            let body = format!(r#"{{"error":"{}","code":"{}"}}"#, message, code);
            send_json_response(&mut stream, 400, &body, None);
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };

    let origin = request.headers.get("origin").map(String::as_str);
    if let Some(origin_value) = origin {
        if !is_allowed_origin(origin_value) {
            send_json_response(
                &mut stream,
                403,
                r#"{"error":"不允许的请求来源","code":"origin_not_allowed"}"#,
                Some(origin_value),
            );
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    }

    if request.method == "OPTIONS" {
        send_empty_response(&mut stream, 204, origin);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    let path = request
        .target
        .split('?')
        .next()
        .unwrap_or(request.target.as_str());
    if !is_web_route_authorized(origin, &request, path) {
        send_json_response(
            &mut stream,
            403,
            r#"{"error":"HTTP API 未授权","code":"web_token_required"}"#,
            origin,
        );
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    if request.method == "GET" && path == "/api/health" {
        let memory_available = memory_store.integrity_check().is_ok();
        let expert_teams_available = expert_team_store.integrity_check().is_ok();
        let health_body = format!(
            r#"{{"ok":true,"service":"copis-http-api","port":{},"memory":{{"available":{},"backend":"sqlite","schemaVersion":1}},"expertTeams":{{"available":{},"backend":"sqlite","schemaVersion":1,"execution":"pi-only"}}}}"#,
            configured_port(),
            memory_available,
            expert_teams_available,
        );
        send_json_response(&mut stream, 200, &health_body, origin);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path == "/api/memory" || path.starts_with("/api/memory/") {
        handle_memory_route(&mut stream, &request, origin, &memory_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path == "/api/expert-teams" || path.starts_with("/api/expert-teams/") {
        handle_expert_team_route(&mut stream, &request, origin, &expert_team_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path == "/api/internal/expert-teams" || path.starts_with("/api/internal/expert-teams/") {
        handle_internal_expert_team_route(&mut stream, &request, origin, &expert_team_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_workspace_mcp_route(&request.method, path) {
        handle_workspace_mcp_route(&mut stream, &request, origin, &workspace_mcp_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_workspace_dev_route(&request.method, path) {
        handle_workspace_dev_route(&mut stream, &request, origin, &workspace_dev_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_workspace_skills_route(&request.method, path) {
        handle_workspace_skills_route(&mut stream, &request, origin, &workspace_skills_store);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if (request.method == "GET" && path == "/api/runtime/status")
        || (request.method == "POST" && path == "/api/runtime/check")
    {
        let body = if request.method == "POST" {
            runtime::refresh_status_json()
        } else {
            runtime::status_json()
        }
        .to_string();
        send_json_response(&mut stream, 200, &body, origin);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_internal_agent_shell_path(path) {
        handle_internal_agent_shell(&mut stream, &request, origin, workers.as_ref());
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_internal_agent_alipay_bot_path(path) {
        handle_internal_agent_alipay_bot(&mut stream, &request, origin, workers.as_ref());
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path.starts_with(INTERNAL_AGENT_FILES_PREFIX) {
        handle_internal_agent_files(&mut stream, &request, path, origin, workers.as_ref());
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_workers_status_route(&request.method, path) {
        let body = json!({ "activeSessionIds": workers.active_session_ids() }).to_string();
        send_json_response(&mut stream, 200, &body, origin);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_workers_stop_all_route(&request.method, path) {
        match workers.stop_all() {
            Ok(stopped) => {
                let body = json!({ "stopped": stopped }).to_string();
                send_json_response(&mut stream, 200, &body, origin);
            }
            Err(error) => {
                eprintln!("[HTTP API] Pi worker 批量停止失败: {}", error);
                send_json_response(
                    &mut stream,
                    503,
                    r#"{"error":"Pi worker 不可用","code":"pi_worker_unavailable"}"#,
                    origin,
                );
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_status_route(&request.method, path) {
        let Some(session_id) = agent_session_id(path) else {
            send_json_response(
                &mut stream,
                400,
                r#"{"error":"Agent 会话路径不正确","code":"invalid_path"}"#,
                origin,
            );
            let _ = stream.shutdown(Shutdown::Both);
            return;
        };
        let body = match workers.session_status(&session_id) {
            Some(status) => json!({
                "active": true,
                "state": status.state.as_str(),
                "permissionMode": status.permission_mode,
            }),
            None => json!({ "active": false }),
        }
        .to_string();
        send_json_response(&mut stream, 200, &body, origin);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_stop_route(&request.method, path) {
        let Some(session_id) = agent_session_id(path) else {
            send_json_response(
                &mut stream,
                400,
                r#"{"error":"Agent 会话路径不正确","code":"invalid_path"}"#,
                origin,
            );
            let _ = stream.shutdown(Shutdown::Both);
            return;
        };
        match workers.stop(&session_id) {
            Ok(true) => send_empty_response(&mut stream, 204, origin),
            Ok(false) => send_empty_response(&mut stream, 204, origin),
            Err(error) => {
                eprintln!("[HTTP API] Pi worker 停止失败: {}", error);
                send_json_response(
                    &mut stream,
                    503,
                    r#"{"error":"Pi worker 不可用","code":"pi_worker_unavailable"}"#,
                    origin,
                );
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_queue_route(&request.method, path) {
        handle_agent_queue(&mut stream, &request, path, origin, bridge, workers);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_agent_messages_route(&request.method, path) {
        handle_agent_stream(&mut stream, &request, path, origin, bridge, workers);
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path == INTERNAL_WORKING_AUTH_PATH {
        if !is_internal_token_valid(&request) {
            send_json_response(
                &mut stream,
                403,
                r#"{"error":"内部 Working 认证接口未授权","code":"internal_token_required"}"#,
                None,
            );
        } else {
            match serde_json::from_slice::<Value>(&request.body) {
                Ok(value)
                    if value
                        .get("token")
                        .map(|token| token.is_null() || token.is_string())
                        .unwrap_or(false) =>
                {
                    let token = value
                        .get("token")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    skill_market_state.set_access_token(token);
                    send_empty_response(&mut stream, 204, origin);
                }
                _ => send_json_response(
                    &mut stream,
                    400,
                    r#"{"error":"Working token 请求格式不正确","code":"invalid_request"}"#,
                    origin,
                ),
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if path.starts_with(INTERNAL_RECORDING_PREFIX) {
        if !is_internal_token_valid(&request) {
            send_json_response(
                &mut stream,
                403,
                r#"{"error":"内部录制 API 未授权","code":"internal_token_required"}"#,
                None,
            );
        } else {
            match handle_internal_recording_request(&request, &bridge) {
                Ok(response) => {
                    if response.status == 204 {
                        send_empty_response(&mut stream, response.status, origin);
                    } else if let Some(body) = response.body {
                        if response.json {
                            send_json_response(&mut stream, response.status, &body, origin);
                        } else {
                            send_text_response(&mut stream, response.status, &body, origin);
                        }
                    } else {
                        send_empty_response(&mut stream, response.status, origin);
                    }
                }
                Err((status, message)) => {
                    let body = format!(
                        r#"{{"error":"{}","code":"browser_recording_error"}}"#,
                        message
                    );
                    send_json_response(&mut stream, status, &body, origin);
                }
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_skill_market_path(path) {
        match handle_skill_market_request(
            &skill_market_state,
            &request.method,
            &request.target,
            &request.body,
        ) {
            Ok(response) => {
                if response.status == 204 {
                    send_empty_response(&mut stream, 204, origin);
                } else if let Some(body) = response.body {
                    let body = serde_json::to_string(&body).unwrap_or_else(|_| "null".to_string());
                    send_json_response(&mut stream, response.status, &body, origin);
                } else {
                    send_empty_response(&mut stream, response.status, origin);
                }
            }
            Err(error) => {
                let body = json!({ "error": error.message, "code": error.code }).to_string();
                send_json_response(&mut stream, error.status, &body, origin);
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    if is_working_payment_path(path) {
        match handle_working_payment_request(
            &skill_market_state,
            &working_payment_state,
            workers.as_ref(),
            payment_workspace.as_ref(),
            &request.method,
            &request.target,
            &request.body,
        ) {
            Ok(response) => {
                if let Some(body) = response.body {
                    let body = serde_json::to_string(&body).unwrap_or_else(|_| "null".to_string());
                    send_json_response(&mut stream, response.status, &body, origin);
                } else {
                    send_empty_response(&mut stream, response.status, origin);
                }
            }
            Err(error) => {
                let body = json!({ "error": error.message, "code": error.code }).to_string();
                send_json_response(&mut stream, error.status, &body, origin);
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    match bridge.send_request(&request) {
        Ok(response) => {
            if response.status == 204 {
                send_empty_response(&mut stream, 204, origin);
            } else if let Some(body) = response.body {
                send_json_response(&mut stream, response.status, &body, origin);
            } else {
                send_empty_response(&mut stream, response.status, origin);
            }
        }
        Err(error) => {
            eprintln!("[HTTP API] 业务桥请求失败: {}", error);
            let (status, code, message) = if error == BRIDGE_TIMEOUT_MESSAGE {
                (504, "bridge_timeout", "HTTP API 业务桥响应超时")
            } else {
                (503, "bridge_unavailable", "HTTP API 业务桥不可用")
            };
            let body = json!({ "error": message, "code": code }).to_string();
            send_json_response(&mut stream, status, &body, origin);
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn is_skill_market_path(path: &str) -> bool {
    path == "/api/working/skill-market" || path.starts_with("/api/working/skill-market/")
}

fn is_working_payment_path(path: &str) -> bool {
    [
        "/api/working/diamond-packages",
        "/api/working/diamond-purchases",
        "/api/working/alipay/page-orders",
        "/api/working/vip/upgrade",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.starts_with(&format!("{}/", prefix)))
        || path
            .strip_prefix("/api/working/orders/")
            .map(|value| value.ends_with("/payment") && value.len() > "/payment".len())
            .unwrap_or(false)
}

fn is_workspace_mcp_route(method: &str, path: &str) -> bool {
    if method != "GET" && method != "PUT" {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == 5 && parts[1] == "api" && parts[2] == "workspaces" && parts[4] == "mcp"
}

fn is_workspace_skills_route(method: &str, path: &str) -> bool {
    if method != "GET" {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == 5 && parts[1] == "api" && parts[2] == "workspaces" && parts[4] == "skills"
}

fn is_workspace_dev_route(method: &str, path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    (method == "GET"
        && parts.len() == 5
        && parts[1] == "api"
        && parts[2] == "workspaces"
        && parts[4] == "dev-projects")
        || (method == "POST"
            && parts.len() == 6
            && parts[1] == "api"
            && parts[2] == "workspaces"
            && parts[4] == "dev-projects"
            && matches!(parts[5], "start" | "stop"))
}

fn handle_workspace_dev_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &WorkspaceDevStore,
) {
    let path = request.target.split('?').next().unwrap_or(&request.target);
    let parts: Vec<&str> = path.split('/').collect();
    let slug = parts[3];
    let result = match request.method.as_str() {
        "GET" => store.list_projects(slug),
        "POST" => match serde_json::from_slice::<WorkspaceDevActionInput>(&request.body) {
            Ok(input) if parts[5] == "start" => store.start_project(slug, &input.project_path),
            Ok(input) if parts[5] == "stop" => store.stop_project(slug, &input.project_path),
            Ok(_) => Err(WorkspaceDevError::NotFound(
                "开发服务路由不存在".to_string(),
            )),
            Err(_) => Err(WorkspaceDevError::InvalidProject),
        },
        _ => Err(WorkspaceDevError::NotFound(
            "开发服务路由不存在".to_string(),
        )),
    };
    match result {
        Ok(value) => send_json_response(stream, 200, &value.to_string(), origin),
        Err(error) => {
            let (status, code) = match error {
                WorkspaceDevError::InvalidWorkspace => (400, "invalid_workspace"),
                WorkspaceDevError::InvalidProject => (400, "invalid_project"),
                WorkspaceDevError::NotFound(_) => (404, "project_not_found"),
                WorkspaceDevError::Io(_) => (500, "workspace_dev_io_error"),
                WorkspaceDevError::Spawn(_) => (503, "dev_server_start_failed"),
            };
            let body = json!({ "error": error.to_string(), "code": code }).to_string();
            send_json_response(stream, status, &body, origin);
        }
    }
}

fn handle_workspace_skills_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &WorkspaceSkillsStore,
) {
    let path = request.target.split('?').next().unwrap_or(&request.target);
    let parts: Vec<&str> = path.split('/').collect();
    let slug = parts[3];
    match store.list_skills(slug) {
        Ok(skills) => {
            let body = serde_json::to_string(&skills).unwrap_or_else(|_| "[]".to_string());
            send_json_response(stream, 200, &body, origin);
        }
        Err(error) => {
            let (status, code) = match error {
                WorkspaceSkillsError::InvalidWorkspace => (400, "invalid_workspace"),
                WorkspaceSkillsError::Io(_) => (500, "workspace_skills_io_error"),
            };
            let body = json!({ "error": error.to_string(), "code": code }).to_string();
            send_json_response(stream, status, &body, origin);
        }
    }
}

fn handle_workspace_mcp_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &WorkspaceMcpStore,
) {
    let path = request.target.split('?').next().unwrap_or(&request.target);
    let parts: Vec<&str> = path.split('/').collect();
    let slug = parts[3];
    let result = match request.method.as_str() {
        "GET" => store.get_config(slug),
        "PUT" => match serde_json::from_slice::<Value>(&request.body) {
            Ok(config) => store.save_config(slug, config),
            Err(_) => Err(WorkspaceMcpError::InvalidConfig(
                "MCP 配置必须是合法 JSON".to_string(),
            )),
        },
        _ => {
            let body =
                json!({ "error": "MCP 方法不支持", "code": "method_not_allowed" }).to_string();
            send_json_response(stream, 405, &body, origin);
            return;
        }
    };

    match result {
        Ok(config) => {
            let body = config.to_string();
            send_json_response(stream, 200, &body, origin);
        }
        Err(error) => {
            let (status, code) = match error {
                WorkspaceMcpError::InvalidWorkspace => (400, "invalid_workspace"),
                WorkspaceMcpError::InvalidConfig(_) => (400, "invalid_config"),
                WorkspaceMcpError::Io(_) => (500, "storage_error"),
            };
            let body = json!({ "error": error.to_string(), "code": code }).to_string();
            send_json_response(stream, status, &body, origin);
        }
    }
}

fn handle_expert_team_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &ExpertTeamStore,
) {
    match expert_teams::handle_request(store, &request.method, &request.target, &request.body) {
        Ok(response) => {
            send_json_response(stream, response.status, &response.body.to_string(), origin)
        }
        Err(error) => send_expert_team_error(stream, error, origin),
    }
}

fn handle_internal_expert_team_route(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    store: &ExpertTeamStore,
) {
    if !is_internal_token_valid(request) {
        send_json_response(
            stream,
            403,
            r#"{"error":"内部专家团队执行接口未授权","code":"internal_token_required"}"#,
            None,
        );
        return;
    }
    let parts: Vec<&str> = request
        .target
        .split('?')
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 5 || parts[..3] != ["api", "internal", "expert-teams"] || parts[3] != "runs" {
        send_expert_team_error(
            stream,
            ExpertTeamError::NotFound("专家团队内部路由不存在".to_string()),
            origin,
        );
        return;
    }
    let run_id = parts[4];
    let result = match (
        request.method.as_str(),
        parts.get(5).copied(),
        parts.get(6).copied(),
    ) {
        ("POST", Some("claim"), None) => store.claim_run(run_id),
        ("POST", Some("events"), None) => {
            let value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::Validation("事件请求不是有效 JSON".to_string()),
                        origin,
                    );
                    return;
                }
            };
            let event_type = value
                .get("type")
                .or_else(|| value.get("eventType"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut payload = value.get("payload").cloned().unwrap_or_else(|| json!({}));
            if let Some(node_id) = value.get("nodeId") {
                if let Some(payload_object) = payload.as_object_mut() {
                    payload_object.insert("nodeId".to_string(), node_id.clone());
                }
            }
            store.append_run_event(run_id, event_type, payload)
        }
        ("POST", Some("nodes"), Some(node_id)) if parts.len() == 7 => {
            let value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::Validation("节点状态请求不是有效 JSON".to_string()),
                        origin,
                    );
                    return;
                }
            };
            store.update_run_node(run_id, node_id, value)
        }
        ("POST", Some("nodes"), Some(node_id)) if parts.len() == 8 => {
            let mut value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::Validation("节点状态请求不是有效 JSON".to_string()),
                        origin,
                    );
                    return;
                }
            };
            let Some(value_object) = value.as_object_mut() else {
                send_expert_team_error(
                    stream,
                    ExpertTeamError::Validation("节点状态请求必须是 JSON 对象".to_string()),
                    origin,
                );
                return;
            };
            let status = match parts[7] {
                "start" => "running",
                "complete" => "succeeded",
                "fail" => "failed",
                "cancel" => "cancelled",
                _ => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::NotFound("专家团队内部节点路由不存在".to_string()),
                        origin,
                    );
                    return;
                }
            };
            value_object.insert("status".to_string(), Value::String(status.to_string()));
            if status == "running" {
                value_object.insert(
                    "startedAt".to_string(),
                    json!(unix_timestamp_millis() as i64),
                );
            } else {
                value_object.insert(
                    "completedAt".to_string(),
                    json!(unix_timestamp_millis() as i64),
                );
            }
            store.update_run_node(run_id, node_id, value)
        }
        ("POST", Some("artifacts"), None) => {
            let value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::Validation("artifact 请求不是有效 JSON".to_string()),
                        origin,
                    );
                    return;
                }
            };
            store.add_artifact(run_id, value)
        }
        ("POST", Some("complete"), None) => {
            let value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    send_expert_team_error(
                        stream,
                        ExpertTeamError::Validation("run 完成请求不是有效 JSON".to_string()),
                        origin,
                    );
                    return;
                }
            };
            let status = value.get("status").and_then(Value::as_str).unwrap_or("");
            store.complete_run(run_id, status)
        }
        _ => Err(ExpertTeamError::NotFound(
            "专家团队内部路由不存在".to_string(),
        )),
    };
    match result {
        Ok(value) => send_json_response(stream, 200, &value.to_string(), origin),
        Err(error) => send_expert_team_error(stream, error, origin),
    }
}

fn send_expert_team_error(stream: &mut TcpStream, error: ExpertTeamError, origin: Option<&str>) {
    let (status, code) = match error {
        ExpertTeamError::Validation(_) => (400, "invalid_expert_team_request"),
        ExpertTeamError::NotFound(_) => (404, "expert_team_not_found"),
        ExpertTeamError::Conflict(_) => (409, "expert_team_conflict"),
        ExpertTeamError::Storage(_) => (500, "expert_team_storage_error"),
    };
    let body = json!({ "error": error.to_string(), "code": code });
    send_json_response(stream, status, &body.to_string(), origin);
}

fn is_allowed_origin(origin: &str) -> bool {
    // 打包后的 Electron renderer 使用 file://，Chromium 会发送 Origin: null。
    // 服务只监听 127.0.0.1，因此允许该来源不会扩大到远程站点。
    matches!(
        origin,
        "null" | "http://127.0.0.1:5174" | "http://localhost:5174"
    )
}

fn send_json_response(stream: &mut TcpStream, status: u16, body: &str, origin: Option<&str>) {
    send_response(stream, status, Some(body), origin, true);
}

fn handle_internal_agent_files(
    stream: &mut TcpStream,
    request: &HttpRequest,
    path: &str,
    origin: Option<&str>,
    workers: &PiWorkerManager,
) {
    let action = path
        .strip_prefix(INTERNAL_AGENT_FILES_PREFIX)
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .unwrap_or("");
    if action.is_empty() {
        send_json_response(
            stream,
            404,
            r#"{"error":"文件权限接口不存在","code":"route_not_found"}"#,
            origin,
        );
        return;
    }

    if action == "permission-mode" {
        if !request.method.eq_ignore_ascii_case("POST") {
            send_json_response(
                stream,
                404,
                r#"{"error":"文件权限接口不存在","code":"route_not_found"}"#,
                origin,
            );
            return;
        }
        if !is_internal_token_valid(request) {
            send_json_response(
                stream,
                403,
                r#"{"error":"内部 Agent 权限接口未授权","code":"internal_token_required"}"#,
                None,
            );
            return;
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PermissionModeRequest {
            session_id: String,
            permission_mode: String,
        }
        let parsed = serde_json::from_slice::<PermissionModeRequest>(&request.body);
        match parsed {
            Ok(input) if !input.session_id.trim().is_empty() => {
                match workers.set_permission_mode(&input.session_id, &input.permission_mode) {
                    Ok(updated) => {
                        let body = json!({ "updated": updated }).to_string();
                        send_json_response(stream, 200, &body, origin);
                    }
                    Err(error) => {
                        let body =
                            json!({ "error": error.message, "code": error.code }).to_string();
                        send_json_response(stream, error.status, &body, origin);
                    }
                }
            }
            _ => send_json_response(
                stream,
                400,
                r#"{"error":"权限模式请求不正确","code":"invalid_request"}"#,
                origin,
            ),
        }
        return;
    }

    let Some(worker_token) = request.headers.get(AGENT_FILE_TOKEN_HEADER) else {
        send_json_response(
            stream,
            403,
            r#"{"error":"Agent 文件能力令牌缺失","code":"agent_file_token_required"}"#,
            None,
        );
        return;
    };

    match workers.file_policies().handle_with_worker_token(
        action,
        &request.method,
        worker_token,
        &request.body,
    ) {
        Ok(Some(body)) => send_json_response(stream, 200, &body.to_string(), origin),
        Ok(None) => send_empty_response(stream, 204, origin),
        Err(error) => {
            let body = json!({ "error": error.message, "code": error.code }).to_string();
            send_json_response(stream, error.status, &body, origin);
        }
    }
}

fn handle_internal_agent_shell(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    workers: &PiWorkerManager,
) {
    if !request.method.eq_ignore_ascii_case("POST") {
        send_json_response(
            stream,
            405,
            r#"{"error":"Agent 命令接口只支持 POST","code":"method_not_allowed"}"#,
            origin,
        );
        return;
    }
    let Some(worker_token) = request.headers.get(AGENT_FILE_TOKEN_HEADER) else {
        send_json_response(
            stream,
            403,
            r#"{"error":"Agent 命令能力令牌缺失","code":"agent_file_token_required"}"#,
            None,
        );
        return;
    };
    match workers
        .file_policies()
        .handle_shell_with_worker_token(worker_token, &request.body)
    {
        Ok(body) => send_json_response(stream, 200, &body.to_string(), origin),
        Err(error) => {
            let body = json!({ "error": error.message, "code": error.code }).to_string();
            send_json_response(stream, error.status, &body, origin);
        }
    }
}

fn handle_internal_agent_alipay_bot(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    workers: &PiWorkerManager,
) {
    let agent_worker_token = request.headers.get(AGENT_FILE_TOKEN_HEADER);
    let payment_capability_token = request.headers.get(PAYMENT_CAPABILITY_TOKEN_HEADER);
    if agent_worker_token.is_none() && payment_capability_token.is_none() {
        send_json_response(
            stream,
            403,
            r#"{"error":"Agent 支付能力令牌缺失","code":"agent_file_token_required"}"#,
            None,
        );
        return;
    }

    match alipay_bot::handle_request(
        workers.file_policies().as_ref(),
        workers.payment_capabilities().as_ref(),
        &request.method,
        agent_worker_token.map(String::as_str),
        payment_capability_token.map(String::as_str),
        &request.body,
    ) {
        Ok(response) => {
            send_json_response(stream, response.status, &response.body.to_string(), origin)
        }
        Err(error) => {
            let body = json!({ "error": error.message, "code": error.code }).to_string();
            send_json_response(stream, error.status, &body, origin);
        }
    }
}

fn handle_agent_stream(
    stream: &mut TcpStream,
    request: &HttpRequest,
    path: &str,
    origin: Option<&str>,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
) {
    let Some(session_id) = agent_session_id(path) else {
        send_json_response(
            stream,
            400,
            r#"{"error":"Agent 会话路径不正确","code":"invalid_path"}"#,
            origin,
        );
        return;
    };

    let prepare_body = match build_prepare_body(request, &session_id) {
        Ok(body) => body,
        Err(error) => {
            let body = format!(
                r#"{{"error":"{}","code":"invalid_request"}}"#,
                escape_json_string(&error)
            );
            send_json_response(stream, 400, &body, origin);
            return;
        }
    };
    let prepared = match send_internal_request(&bridge, "/api/internal/agent/prepare", prepare_body)
    {
        Ok(response) if (200..300).contains(&response.status) => response,
        Ok(response) => {
            send_bridge_response(stream, response, origin);
            return;
        }
        Err(error) => {
            eprintln!("[HTTP API] Agent RPC 配置准备失败: {}", error);
            send_json_response(
                stream,
                503,
                r#"{"error":"Agent RPC 配置服务不可用","code":"agent_rpc_unavailable"}"#,
                origin,
            );
            return;
        }
    };
    let config = match prepared
        .body
        .as_deref()
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
    {
        Some(config) => config,
        None => {
            send_json_response(
                stream,
                502,
                r#"{"error":"Agent RPC 配置响应不正确","code":"invalid_agent_rpc_config"}"#,
                origin,
            );
            return;
        }
    };

    let mut worker = match workers.start(&session_id, config) {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("[HTTP API] {}", error);
            let body = format!(
                r#"{{"error":"{}","code":"pi_worker_unavailable"}}"#,
                escape_json_string(&error)
            );
            send_json_response(stream, 503, &body, origin);
            return;
        }
    };

    let headers = sse_headers_with_origin(200, origin);
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.flush();

    let mut line = String::new();
    let mut completed = false;
    let mut stop_worker = false;
    loop {
        line.clear();
        let read = match worker.read_line(&mut line) {
            Ok(read) => read,
            Err(error) => {
                eprintln!("[HTTP API] 读取 Pi worker 输出失败: {}", error);
                stop_worker = true;
                break;
            }
        };
        if read == 0 {
            break;
        }
        let Some(frame) = parse_worker_frame(line.trim_end_matches(['\r', '\n'])) else {
            if !line.trim().is_empty() {
                eprintln!("[HTTP API] 收到无法解析的 Pi worker 帧");
            }
            continue;
        };

        match frame.get("type").and_then(Value::as_str) {
            Some("event") => {
                if let Err(error) = persist_worker_event(&bridge, &frame) {
                    eprintln!("[HTTP API] Agent SDK 消息持久化失败: {}", error);
                }
                if let Err(error) = send_sse_frame(stream, &frame) {
                    eprintln!("[HTTP API] SSE 发送失败，客户端可能已断开: {}", error);
                    stop_worker = true;
                    break;
                }
            }
            Some("meta") => {
                if let Err(error) =
                    persist_worker_frame(&bridge, "/api/internal/agent/meta", &frame)
                {
                    eprintln!("[HTTP API] Agent session 元数据持久化失败: {}", error);
                }
            }
            Some("credential") => {
                if let Err(error) =
                    persist_worker_frame(&bridge, "/api/internal/agent/credential", &frame)
                {
                    eprintln!("[HTTP API] Agent OAuth 凭据持久化失败: {}", error);
                }
            }
            Some("complete") => {
                match finalize_worker_run(&bridge, &frame) {
                    Ok(Some(title)) => {
                        let title_frame = json!({
                            "type": "event",
                            "sessionId": session_id,
                            "payload": {
                                "kind": "copis_event",
                                "event": { "type": "title_updated", "title": title },
                            },
                        });
                        let _ = send_sse_frame(stream, &title_frame);
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!("[HTTP API] Agent 完成状态持久化失败: {}", error),
                }
                let _ = send_sse_frame(stream, &frame);
                completed = true;
                break;
            }
            Some("error") | Some("fatal") => {
                if let Err(error) = send_sse_frame(stream, &frame) {
                    eprintln!("[HTTP API] SSE 发送失败，客户端可能已断开: {}", error);
                    stop_worker = true;
                    break;
                }
            }
            _ => {}
        }
    }

    if stop_worker {
        if let Err(error) = workers.stop(&session_id) {
            eprintln!("[HTTP API] 停止 Pi worker 失败: {}", error);
        }
    }

    if !completed {
        let error_frame = json!({
            "type": "error",
            "sessionId": session_id,
            "error": "Pi worker 已提前退出",
        });
        let complete_frame = json!({
            "type": "complete",
            "sessionId": session_id,
            "stoppedByUser": false,
            "resultSubtype": "error_during_execution",
            "resultErrors": ["Pi worker 已提前退出"],
        });
        let _ = send_sse_frame(stream, &error_frame);
        let _ = send_sse_frame(stream, &complete_frame);
    }
    workers.finish(worker);
}

fn handle_agent_queue(
    stream: &mut TcpStream,
    request: &HttpRequest,
    path: &str,
    origin: Option<&str>,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
) {
    let Some(session_id) = agent_session_id(path) else {
        send_json_response(
            stream,
            400,
            r#"{"error":"Agent 会话路径不正确","code":"invalid_path"}"#,
            origin,
        );
        return;
    };

    let prepare_body = match build_prepare_body(request, &session_id) {
        Ok(body) => body,
        Err(error) => {
            let body = format!(
                r#"{{"error":"{}","code":"invalid_request"}}"#,
                escape_json_string(&error)
            );
            send_json_response(stream, 400, &body, origin);
            return;
        }
    };
    let prepared = match send_internal_request(&bridge, "/api/internal/agent/queue", prepare_body) {
        Ok(response) if (200..300).contains(&response.status) => response,
        Ok(response) => {
            send_bridge_response(stream, response, origin);
            return;
        }
        Err(error) => {
            eprintln!("[HTTP API] Agent queue 配置准备失败: {}", error);
            send_json_response(
                stream,
                503,
                r#"{"error":"Agent queue 配置服务不可用","code":"agent_rpc_unavailable"}"#,
                origin,
            );
            return;
        }
    };
    let config = match prepared
        .body
        .as_deref()
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
    {
        Some(config) => config,
        None => {
            send_json_response(
                stream,
                502,
                r#"{"error":"Agent queue 配置响应不正确","code":"invalid_agent_rpc_config"}"#,
                origin,
            );
            return;
        }
    };
    let uuid = match config.get("uuid").and_then(Value::as_str) {
        Some(uuid) if !uuid.trim().is_empty() => uuid.to_string(),
        _ => {
            send_json_response(
                stream,
                502,
                r#"{"error":"Agent queue 配置缺少 uuid","code":"invalid_agent_rpc_config"}"#,
                origin,
            );
            return;
        }
    };

    match workers.queue(&session_id, config) {
        Ok(true) => {
            let body = json!({ "accepted": true, "uuid": uuid }).to_string();
            send_json_response(stream, 202, &body, origin);
        }
        Ok(false) => send_json_response(
            stream,
            409,
            r#"{"error":"Agent 会话没有运行中的 Pi worker","code":"agent_worker_not_found"}"#,
            origin,
        ),
        Err(error) => {
            eprintln!("[HTTP API] Pi worker queue 失败: {}", error);
            let body = format!(
                r#"{{"error":"{}","code":"pi_worker_unavailable"}}"#,
                escape_json_string(&error)
            );
            send_json_response(stream, 503, &body, origin);
        }
    }
}

fn build_prepare_body(request: &HttpRequest, session_id: &str) -> Result<Vec<u8>, String> {
    let mut value = serde_json::from_slice::<Value>(&request.body)
        .map_err(|_| "请求体不是有效的 JSON".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())?;
    object.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    serde_json::to_vec(&value).map_err(|error| format!("请求体序列化失败: {}", error))
}

fn send_internal_request(
    bridge: &Arc<Bridge>,
    target: &str,
    body: Vec<u8>,
) -> Result<BridgeResponse, String> {
    bridge.send_request(&HttpRequest {
        method: "POST".to_string(),
        target: target.to_string(),
        headers: HashMap::new(),
        body,
    })
}

fn persist_worker_event(bridge: &Arc<Bridge>, frame: &Value) -> Result<(), String> {
    let payload = frame.get("payload").and_then(Value::as_object);
    if payload
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        != Some("sdk_message")
    {
        return Ok(());
    }
    let message = payload.and_then(|value| value.get("message"));
    let Some(message) = message else {
        return Ok(());
    };
    let partial = message
        .get("_partial")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let replay = message
        .get("isReplay")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if partial || replay {
        return Ok(());
    }
    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent SDK 消息缺少 sessionId".to_string())?;
    let body = serde_json::to_vec(&json!({ "sessionId": session_id, "message": message }))
        .map_err(|error| format!("Agent SDK 消息序列化失败: {}", error))?;
    ensure_internal_success(send_internal_request(
        bridge,
        "/api/internal/agent/message",
        body,
    )?)
}

fn persist_worker_frame(bridge: &Arc<Bridge>, target: &str, frame: &Value) -> Result<(), String> {
    let body =
        serde_json::to_vec(frame).map_err(|error| format!("Agent RPC 帧序列化失败: {}", error))?;
    ensure_internal_success(send_internal_request(bridge, target, body)?)
}

fn finalize_worker_run(bridge: &Arc<Bridge>, frame: &Value) -> Result<Option<String>, String> {
    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent 完成帧缺少 sessionId".to_string())?;
    let stopped_by_user = frame
        .get("stoppedByUser")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut body = json!({
        "sessionId": session_id,
        "stoppedByUser": stopped_by_user,
    });
    if let Some(result_subtype) = frame.get("resultSubtype").and_then(Value::as_str) {
        body["resultSubtype"] = Value::String(result_subtype.to_string());
    }
    if let Some(result_errors) = frame.get("resultErrors").and_then(Value::as_array) {
        body["resultErrors"] = Value::Array(
            result_errors
                .iter()
                .filter_map(Value::as_str)
                .map(|value| Value::String(value.to_string()))
                .collect(),
        );
    }
    let body =
        serde_json::to_vec(&body).map_err(|error| format!("Agent 完成帧序列化失败: {}", error))?;
    let response = send_internal_request(bridge, "/api/internal/agent/complete", body)?;
    ensure_internal_success_with_body(response)
}

fn ensure_internal_success(response: BridgeResponse) -> Result<(), String> {
    ensure_internal_success_with_body(response).map(|_| ())
}

fn ensure_internal_success_with_body(response: BridgeResponse) -> Result<Option<String>, String> {
    if !(200..300).contains(&response.status) {
        return Err(response
            .body
            .unwrap_or_else(|| format!("Electron 内部接口返回 {}", response.status)));
    }
    let title = response
        .body
        .as_deref()
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
        .and_then(|body| {
            body.get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Ok(title)
}

fn send_bridge_response(stream: &mut TcpStream, response: BridgeResponse, origin: Option<&str>) {
    if response.status == 204 {
        send_empty_response(stream, 204, origin);
    } else if let Some(body) = response.body {
        send_json_response(stream, response.status, &body, origin);
    } else {
        send_empty_response(stream, response.status, origin);
    }
}

fn send_sse_frame(stream: &mut TcpStream, frame: &Value) -> io::Result<()> {
    stream.write_all(pi_rpc::format_sse_event(&frame.to_string()).as_bytes())?;
    stream.flush()
}

fn escape_json_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"请求失败\"".to_string())
        .trim_matches('"')
        .to_string()
}

fn send_empty_response(stream: &mut TcpStream, status: u16, origin: Option<&str>) {
    send_response(stream, status, None, origin, false);
}

fn send_text_response(stream: &mut TcpStream, status: u16, body: &str, origin: Option<&str>) {
    send_response(stream, status, Some(body), origin, false);
}

fn send_response(
    stream: &mut TcpStream,
    status: u16,
    body: Option<&str>,
    origin: Option<&str>,
    json: bool,
) {
    let body_bytes = body.map(str::as_bytes).unwrap_or(&[]);
    let mut response = format!(
        "HTTP/1.1 {} {}\r\nVary: Origin\r\n",
        status,
        reason_phrase(status),
    );
    if let Some(origin_value) = origin.filter(|value| is_allowed_origin(value)) {
        response.push_str(&format!(
            "Access-Control-Allow-Origin: {}\r\n",
            origin_value
        ));
        response.push_str("Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS\r\n");
        response.push_str("Access-Control-Allow-Headers: Content-Type, x-copis-web-token\r\n");
        response.push_str("Access-Control-Max-Age: 600\r\n");
    }
    if json && !body_bytes.is_empty() {
        response.push_str("Content-Type: application/json; charset=utf-8\r\n");
    } else if !json && !body_bytes.is_empty() {
        response.push_str("Content-Type: application/x-ndjson; charset=utf-8\r\n");
    }
    response.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    ));
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body_bytes);
    let _ = stream.flush();
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "HTTP Response",
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let high = hex_digit(pair[0])?;
        let low = hex_digit(pair[1])?;
        result.push((high << 4) | low);
    }
    Some(result)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn resolve_memory_directory() -> PathBuf {
    if let Ok(directory) = std::env::var("COPIS_MEMORY_DIR") {
        if !directory.trim().is_empty() {
            return PathBuf::from(directory);
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".copis").join("memory")
}

fn resolve_config_directory() -> PathBuf {
    if let Ok(directory) = std::env::var("COPIS_CONFIG_DIR") {
        if !directory.trim().is_empty() {
            return PathBuf::from(directory);
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".copis")
}

fn resolve_expert_teams_directory() -> PathBuf {
    if let Ok(directory) = std::env::var("COPIS_EXPERT_TEAMS_DIR") {
        if !directory.trim().is_empty() {
            return PathBuf::from(directory);
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".copis").join("expert-teams")
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn configured_port() -> u16 {
    std::env::var("COPIS_HTTP_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT)
}

struct ConnectionCountGuard(Arc<AtomicUsize>);

impl Drop for ConnectionCountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

fn main() {
    let port = configured_port();
    let listener = match TcpListener::bind((HOST, port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[HTTP API] 无法监听 {}:{}: {}", HOST, port, error);
            process::exit(1);
        }
    };

    let bridge = Arc::new(Bridge::new());
    let workers = Arc::new(PiWorkerManager::new());
    let memory_store = match MemoryStore::open(resolve_memory_directory()) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            eprintln!("[HTTP API] Memory 存储初始化失败: {}", error);
            process::exit(1);
        }
    };
    let expert_team_store = match ExpertTeamStore::open(resolve_expert_teams_directory()) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            eprintln!("[HTTP API] Expert Teams 存储初始化失败: {}", error);
            process::exit(1);
        }
    };
    let skill_market_state = Arc::new(SkillMarketState::new(
        std::env::var("COPIS_WORKING_ACCESS_TOKEN").ok(),
    ));
    let working_payment_state = Arc::new(WorkingPaymentState::new());
    let payment_workspace = match PaymentWorkspace::from_environment() {
        Ok(workspace) => Arc::new(workspace),
        Err(error) => {
            eprintln!("[HTTP API] 默认支付工作区初始化失败: {}", error);
            process::exit(1);
        }
    };
    let workspace_mcp_store = Arc::new(WorkspaceMcpStore::open(resolve_config_directory()));
    let workspace_dev_store = Arc::new(WorkspaceDevStore::open(resolve_config_directory()));
    let workspace_skills_store = Arc::new(WorkspaceSkillsStore::open(resolve_config_directory()));
    let response_bridge = Arc::clone(&bridge);
    thread::spawn(move || read_bridge_responses(response_bridge));

    eprintln!("[HTTP API] Rust 服务监听 http://{}:{}", HOST, port);
    let active_connections = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if active_connections.load(Ordering::Acquire) >= MAX_CONCURRENT_CONNECTIONS {
                    eprintln!("[HTTP API] 并发连接数已达上限，拒绝新连接");
                    continue;
                }
                active_connections.fetch_add(1, Ordering::Relaxed);
                let connection_bridge = Arc::clone(&bridge);
                let connection_workers = Arc::clone(&workers);
                let connection_memory = Arc::clone(&memory_store);
                let connection_expert_teams = Arc::clone(&expert_team_store);
                let connection_skill_market = Arc::clone(&skill_market_state);
                let connection_working_payment = Arc::clone(&working_payment_state);
                let connection_payment_workspace = Arc::clone(&payment_workspace);
                let connection_workspace_mcp = Arc::clone(&workspace_mcp_store);
                let connection_workspace_dev = Arc::clone(&workspace_dev_store);
                let connection_workspace_skills = Arc::clone(&workspace_skills_store);
                let connection_active = Arc::clone(&active_connections);
                thread::spawn(move || {
                    let _guard = ConnectionCountGuard(connection_active);
                    handle_connection(
                        stream,
                        connection_bridge,
                        connection_workers,
                        connection_memory,
                        connection_expert_teams,
                        connection_skill_market,
                        connection_working_payment,
                        connection_payment_workspace,
                        connection_workspace_mcp,
                        connection_workspace_dev,
                        connection_workspace_skills,
                    )
                });
            }
            Err(error) => {
                eprintln!("[HTTP API] 接受连接失败: {}", error);
            }
        }
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
