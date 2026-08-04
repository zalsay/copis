use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

mod pi_rpc;

use pi_rpc::{
    agent_session_id, is_agent_messages_route, is_agent_stop_route, parse_worker_frame,
    sse_headers_with_origin, PiWorkerManager,
};
use serde_json::{json, Value};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 51730;
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;

struct BridgeResponse {
    status: u16,
    body: Option<String>,
}

struct Bridge {
    next_id: AtomicU64,
    available: AtomicBool,
    writer: Mutex<BufWriter<io::Stdout>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<BridgeResponse, String>>>>,
}

impl Bridge {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            available: AtomicBool::new(true),
            writer: Mutex::new(BufWriter::new(io::stdout())),
            pending: Mutex::new(HashMap::new()),
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

fn handle_connection(
    mut stream: TcpStream,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
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
        send_json_response(
            &mut stream,
            200,
            r#"{"ok":true,"service":"copis-http-api","port":51730}"#,
            origin,
        );
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
    matches!(origin, "http://127.0.0.1:5174" | "http://localhost:5174")
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
            let body = format!(r#"{{"error":"{}","code":"invalid_request"}}"#, escape_json_string(&error));
            send_json_response(stream, 400, &body, origin);
            return;
        }
    };
    let prepared = match send_internal_request(
        &bridge,
        "/api/internal/agent/prepare",
        prepare_body,
    ) {
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
    let config = match prepared.body.as_deref().and_then(|body| serde_json::from_str::<Value>(body).ok()) {
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
            let body = format!(r#"{{"error":"{}","code":"pi_worker_unavailable"}}"#, escape_json_string(&error));
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
                if let Err(error) = persist_worker_frame(&bridge, "/api/internal/agent/meta", &frame) {
                    eprintln!("[HTTP API] Agent session 元数据持久化失败: {}", error);
                }
            }
            Some("credential") => {
                if let Err(error) = persist_worker_frame(&bridge, "/api/internal/agent/credential", &frame) {
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
    object.insert("sessionId".to_string(), Value::String(session_id.to_string()));
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
    if payload.and_then(|value| value.get("kind")).and_then(Value::as_str) != Some("sdk_message") {
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
    ensure_internal_success(send_internal_request(bridge, "/api/internal/agent/message", body)?)
}

fn persist_worker_frame(bridge: &Arc<Bridge>, target: &str, frame: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(frame).map_err(|error| format!("Agent RPC 帧序列化失败: {}", error))?;
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
    let body = serde_json::to_vec(&json!({
        "sessionId": session_id,
        "stoppedByUser": stopped_by_user,
    }))
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
        .and_then(|body| body.get("title").and_then(Value::as_str).map(str::to_string));
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
    serde_json::to_string(value).unwrap_or_else(|_| "\"请求失败\"".to_string())
        .trim_matches('"')
        .to_string()
}

fn send_empty_response(stream: &mut TcpStream, status: u16, origin: Option<&str>) {
    send_response(stream, status, None, origin, false);
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

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn main() {
    let listener = match TcpListener::bind((HOST, PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[HTTP API] 无法监听 {}:{}: {}", HOST, PORT, error);
            process::exit(1);
        }
    };

    let bridge = Arc::new(Bridge::new());
    let workers = Arc::new(PiWorkerManager::new());
    let response_bridge = Arc::clone(&bridge);
    thread::spawn(move || read_bridge_responses(response_bridge));

    eprintln!("[HTTP API] Rust 服务监听 http://{}:{}", HOST, PORT);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let connection_bridge = Arc::clone(&bridge);
                let connection_workers = Arc::clone(&workers);
                thread::spawn(move || handle_connection(stream, connection_bridge, connection_workers));
            }
            Err(error) => {
                eprintln!("[HTTP API] 接受连接失败: {}", error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_hex, encode_hex, find_subslice, is_allowed_origin};
    use super::pi_rpc::{
        format_sse_event, is_agent_messages_route, is_agent_stop_route, parse_worker_frame,
        sse_headers,
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
        let frame = parse_worker_frame(r#"{"type":"event","sessionId":"s1"}"#)
            .expect("valid worker frame");
        assert_eq!(frame["type"], "event");
        assert!(parse_worker_frame("[]").is_none());
        assert!(parse_worker_frame("not-json").is_none());
    }
}
