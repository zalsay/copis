use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

mod memory;
mod pi_rpc;

use memory::{
    MemoryCaptureBatchInput, MemoryCaptureInput, MemoryContextInput, MemoryError, MemoryKind,
    MemoryMaintenanceApplyInput, MemoryRestoreInput, MemoryRewriteInput, MemoryScope, MemoryStore,
    DEFAULT_LIST_LIMIT, DEFAULT_RECALL_LIMIT,
};
use pi_rpc::{
    agent_session_id, is_agent_messages_route, is_agent_stop_route, parse_worker_frame,
    sse_headers_with_origin, PiWorkerManager,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 51730;
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_RECORDING_LINE_BYTES: usize = 256 * 1024;
const MAX_RECORDING_FILE_BYTES: u64 = 8 * 1024 * 1024;
const INTERNAL_TOKEN_HEADER: &str = "x-copis-internal-token";
const INTERNAL_RECORDING_PREFIX: &str = "/internal/browser-workflows/recordings/";

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

        match receiver.recv() {
            Ok(result) => result,
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

    if parts.len() < 1 {
        send_memory_not_found(stream, origin);
        return;
    }
    let id = &parts[0];
    let workspace_slug = query.get("workspaceSlug").map(String::as_str);

    if parts.len() == 1 && request.method == "GET" {
        send_memory_result(stream, store.get(id, workspace_slug), origin);
        return;
    }

    if parts.len() == 2 && parts[0] == *id && parts[1] == "read" && request.method == "GET" {
        send_memory_result(stream, store.get(id, workspace_slug), origin);
        return;
    }

    if parts.len() == 2 && parts[0] == *id && parts[1] == "history" && request.method == "GET" {
        let result = store
            .history(id, workspace_slug)
            .map(|revisions| json!({ "revisions": revisions }));
        send_memory_result(stream, result, origin);
        return;
    }

    if parts.len() == 2 && parts[0] == *id && parts[1] == "rewrite" && request.method == "PATCH" {
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

    if parts.len() == 2 && parts[0] == *id && parts[1] == "restore" && request.method == "POST" {
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

fn recording_lock(bridge: &Bridge, path: &PathBuf) -> Arc<Mutex<()>> {
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
    let next_len = current_len.saturating_add(line.len() as u64).saturating_add(1);
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
            .map(|received| received == &expected)
            .unwrap_or(false)
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
) {
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
    if request.method == "GET" && path == "/api/health" {
        let memory_available = memory_store.integrity_check().is_ok();
        let health_body = format!(
            r#"{{"ok":true,"service":"copis-http-api","port":{},"memory":{{"available":{},"backend":"sqlite","schemaVersion":1}}}}"#,
            configured_port(),
            memory_available,
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
            Ok(false) => send_json_response(
                &mut stream,
                404,
                r#"{"error":"Agent 会话没有运行中的 Pi worker","code":"agent_worker_not_found"}"#,
                origin,
            ),
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

    if is_agent_messages_route(&request.method, path) {
        handle_agent_stream(&mut stream, &request, path, origin, bridge, workers);
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
            send_json_response(
                &mut stream,
                503,
                r#"{"error":"HTTP API 业务桥不可用","code":"bridge_unavailable"}"#,
                origin,
            );
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
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
    loop {
        line.clear();
        let read = match worker.read_line(&mut line) {
            Ok(read) => read,
            Err(error) => {
                eprintln!("[HTTP API] 读取 Pi worker 输出失败: {}", error);
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
                let _ = send_sse_frame(stream, &frame);
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
                let _ = send_sse_frame(stream, &frame);
            }
            _ => {}
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
    let body = serde_json::to_vec(&body)
        .map_err(|error| format!("Agent 完成帧序列化失败: {}", error))?;
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
        response.push_str("Access-Control-Allow-Headers: Content-Type\r\n");
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
    let response_bridge = Arc::clone(&bridge);
    thread::spawn(move || read_bridge_responses(response_bridge));

    eprintln!("[HTTP API] Rust 服务监听 http://{}:{}", HOST, port);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let connection_bridge = Arc::clone(&bridge);
                let connection_workers = Arc::clone(&workers);
                let connection_memory = Arc::clone(&memory_store);
                thread::spawn(move || {
                    handle_connection(
                        stream,
                        connection_bridge,
                        connection_workers,
                        connection_memory,
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
mod tests {
    use super::pi_rpc::{
        format_sse_event, is_agent_messages_route, is_agent_stop_route, parse_worker_frame,
        sse_headers,
    };
    use super::{
        append_recording_line, decode_hex, encode_hex, find_subslice, is_allowed_origin,
        is_safe_path_component, parse_internal_recording_route, recording_marker, Bridge,
    };

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
        let marker =
            String::from_utf8(recording_marker("recording-1", "recording_finished")).unwrap();
        assert!(marker.ends_with('}'));
        assert!(!marker.contains('\n'));
        assert!(marker.contains("recording-1"));
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
    fn only_allows_vite_origins() {
        assert!(is_allowed_origin("http://127.0.0.1:5174"));
        assert!(is_allowed_origin("http://localhost:5174"));
        assert!(!is_allowed_origin("http://example.com"));
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
}
