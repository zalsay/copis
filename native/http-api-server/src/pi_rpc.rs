use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::Value;

pub fn is_agent_messages_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && path.starts_with("/api/agent/sessions/")
        && path.ends_with("/messages")
        && path.matches('/').count() == 5
}

pub fn is_agent_stop_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && path.starts_with("/api/agent/sessions/")
        && path.ends_with("/stop")
        && path.matches('/').count() == 5
}

pub fn agent_session_id(path: &str) -> Option<String> {
    let mut segments = path.split('/');
    if segments.next()? != "" || segments.next()? != "api" || segments.next()? != "agent"
        || segments.next()? != "sessions"
    {
        return None;
    }
    let session_id = segments.next()?.trim();
    (!session_id.is_empty()).then(|| session_id.to_string())
}

#[cfg(test)]
pub fn sse_headers(status: u16) -> String {
    sse_headers_with_origin(status, None)
}

pub fn sse_headers_with_origin(status: u16, origin: Option<&str>) -> String {
    let cors = origin
        .filter(|value| super::is_allowed_origin(value))
        .map(|value| {
            format!(
                "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n",
                value
            )
        })
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {}\r\nVary: Origin\r\n{}Content-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n",
        status, cors
    )
}

pub fn format_sse_event(json: &str) -> String {
    format!("data: {}\n\n", json)
}

pub fn parse_worker_frame(line: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    value.is_object().then_some(value)
}

struct WorkerControl {
    writer: Mutex<BufWriter<std::process::ChildStdin>>,
}

pub struct PiWorkerManager {
    workers: Mutex<HashMap<String, Arc<WorkerControl>>>,
}

pub struct PiWorkerRun {
    pub session_id: String,
    child: Child,
    stdout: BufReader<ChildStdout>,
}

impl PiWorkerManager {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(
        &self,
        session_id: &str,
        config: Value,
    ) -> Result<PiWorkerRun, String> {
        let runtime = std::env::var("COPIS_PI_RPC_RUNTIME").ok();
        let worker_path = std::env::var("COPIS_PI_RPC_WORKER")
            .map_err(|_| "Pi worker 路径未配置".to_string())?;
        if worker_path.trim().is_empty() {
            return Err("Pi worker 路径为空".to_string());
        }

        let mut command = if let Some(runtime_path) = runtime.filter(|value| !value.trim().is_empty()) {
            let mut command = Command::new(runtime_path);
            command.arg(&worker_path);
            command
        } else {
            Command::new(&worker_path)
        };
        let mut child = command
            .env("ELECTRON_RUN_AS_NODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Pi worker 启动失败: {}", error))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Pi worker stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Pi worker stdout 不可用".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_reader(stderr);
        }

        let control = Arc::new(WorkerControl {
            writer: Mutex::new(BufWriter::new(stdin)),
        });
        {
            let mut workers = self.workers.lock().unwrap();
            if workers.contains_key(session_id) {
                let _ = child.kill();
                return Err("该 Agent 会话已有运行中的 Pi worker".to_string());
            }
            workers.insert(session_id.to_string(), Arc::clone(&control));
        }

        let command = serde_json::json!({
            "type": "run",
            "requestId": session_id,
            "config": config,
        });
        if let Err(error) = write_json_line(&control, &command) {
            self.workers.lock().unwrap().remove(session_id);
            let _ = child.kill();
            return Err(format!("Pi worker run 命令发送失败: {}", error));
        }

        Ok(PiWorkerRun {
            session_id: session_id.to_string(),
            child,
            stdout: BufReader::new(stdout),
        })
    }

    pub fn stop(&self, session_id: &str) -> Result<bool, String> {
        let control = self.workers.lock().unwrap().get(session_id).cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        let command = serde_json::json!({
            "type": "stop",
            "sessionId": session_id,
        });
        write_json_line(&control, &command)
            .map_err(|error| format!("Pi worker 停止命令发送失败: {}", error))?;
        Ok(true)
    }

    pub fn finish(&self, mut run: PiWorkerRun) {
        self.workers.lock().unwrap().remove(&run.session_id);
        if run.child.try_wait().ok().flatten().is_none() {
            let _ = run.child.kill();
        }
        let _ = run.child.wait();
    }
}

impl PiWorkerRun {
    pub fn read_line(&mut self, line: &mut String) -> io::Result<usize> {
        self.stdout.read_line(line)
    }
}

fn write_json_line(control: &WorkerControl, value: &Value) -> io::Result<()> {
    let mut writer = control.writer.lock().unwrap();
    writer.write_all(value.to_string().as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn spawn_stderr_reader(stderr: ChildStderr) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                eprintln!("[Pi Worker] {}", line);
            }
        }
    });
}
