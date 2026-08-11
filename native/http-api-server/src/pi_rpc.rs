use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use getrandom::getrandom;
use serde_json::Value;

use crate::agent_files::{is_supported_permission_mode, AgentFileError, AgentFilePolicyStore};
use crate::payment_capability::PaymentCapabilityStore;
use crate::payment_workspace::PaymentWorkspace;
use crate::runtime;

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

pub fn is_agent_queue_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && path.starts_with("/api/agent/sessions/")
        && path.ends_with("/queue")
        && path.matches('/').count() == 5
}

pub fn is_agent_status_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("GET")
        && path.starts_with("/api/agent/sessions/")
        && path.ends_with("/status")
        && path.matches('/').count() == 5
}

pub fn is_agent_workers_status_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("GET") && path == "/api/agent/workers/status"
}

pub fn is_agent_workers_stop_all_route(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST") && path == "/api/agent/workers/stop-all"
}

pub fn agent_session_id(path: &str) -> Option<String> {
    let mut segments = path.split('/');
    if !segments.next()?.is_empty()
        || segments.next()? != "api"
        || segments.next()? != "agent"
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
                "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, x-copis-web-token\r\n",
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PiWorkerRunState {
    Running,
    Stopping,
}

impl PiWorkerRunState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PiWorkerStatusSnapshot {
    pub session_id: String,
    pub state: PiWorkerRunState,
    pub permission_mode: String,
}

pub struct PiWorkerManager {
    workers: Mutex<HashMap<String, Arc<WorkerControl>>>,
    worker_statuses: Mutex<HashMap<String, PiWorkerStatusSnapshot>>,
    file_policies: Arc<AgentFilePolicyStore>,
    payment_capabilities: Arc<PaymentCapabilityStore>,
}

pub struct PiWorkerRun {
    pub session_id: String,
    child: Child,
    stdout: BufReader<ChildStdout>,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentWorkerAction {
    WalletCheck,
    WalletApply,
    WalletBind,
    PaymentStart,
    PaymentCheck,
}

impl PaymentWorkerAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::WalletCheck => "wallet.check",
            Self::WalletApply => "wallet.apply",
            Self::WalletBind => "wallet.bind",
            Self::PaymentStart => "payment.start",
            Self::PaymentCheck => "payment.check",
        }
    }
}

#[derive(Debug, PartialEq)]
struct WorkerLaunch {
    program: PathBuf,
    args: Vec<String>,
}

fn resolve_worker_launch(
    executable_path: Option<String>,
    worker_path: Option<String>,
    runtime_path: Option<String>,
    node_path: Option<PathBuf>,
    use_system_runtime: bool,
) -> Result<WorkerLaunch, String> {
    if let Some(path) = executable_path.filter(|path| !path.trim().is_empty()) {
        return Ok(WorkerLaunch {
            program: PathBuf::from(path),
            args: vec!["__pi-worker".to_string()],
        });
    }

    let worker_path = worker_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "Pi worker 启动入口未配置".to_string())?;
    let runtime_path = runtime_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
    let runtime_path = if use_system_runtime {
        runtime_path.ok_or_else(|| "开发 Bun runtime 未配置".to_string())?
    } else {
        runtime_path
            .or(node_path)
            .ok_or_else(|| "Pi worker script runtime 未配置".to_string())?
    };
    Ok(WorkerLaunch {
        program: runtime_path,
        args: vec![worker_path],
    })
}

fn worker_requires_node(
    executable_path: Option<&str>,
    runtime_path: Option<&str>,
    use_system_runtime: bool,
) -> bool {
    executable_path
        .filter(|path| !path.trim().is_empty())
        .is_none()
        && runtime_path
            .filter(|path| !path.trim().is_empty())
            .is_none()
        && !use_system_runtime
}

impl PiWorkerManager {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
            worker_statuses: Mutex::new(HashMap::new()),
            file_policies: Arc::new(AgentFilePolicyStore::new()),
            payment_capabilities: Arc::new(PaymentCapabilityStore::new()),
        }
    }

    pub fn file_policies(&self) -> Arc<AgentFilePolicyStore> {
        Arc::clone(&self.file_policies)
    }

    pub fn payment_capabilities(&self) -> Arc<PaymentCapabilityStore> {
        Arc::clone(&self.payment_capabilities)
    }

    pub fn session_status(&self, session_id: &str) -> Option<PiWorkerStatusSnapshot> {
        self.worker_statuses
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
    }

    #[cfg(test)]
    pub fn status_snapshot(&self) -> Vec<PiWorkerStatusSnapshot> {
        let mut statuses = self
            .worker_statuses
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        statuses
    }

    pub fn start(&self, session_id: &str, mut config: Value) -> Result<PiWorkerRun, String> {
        let query = config
            .get_mut("query")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Pi worker 配置缺少 query".to_string())?;
        let permission_mode = query
            .get("permissionMode")
            .and_then(Value::as_str)
            .filter(|mode| is_supported_permission_mode(mode))
            .ok_or_else(|| "Pi worker 配置缺少有效 permissionMode".to_string())?
            .to_string();
        let file_api_token = self.file_policies.register_from_query(session_id, query)?;
        if file_api_token.is_empty() {
            return Err("Pi Worker 未收到 Rust 文件能力令牌".to_string());
        }
        if self.file_policies.permission_mode(session_id).as_deref()
            != Some(permission_mode.as_str())
        {
            self.file_policies.remove(session_id);
            return Err("Pi Worker 权限模式与 Rust 文件策略不一致".to_string());
        }
        let executable_path = std::env::var("COPIS_PI_RPC_EXECUTABLE").ok();
        let worker_path = std::env::var("COPIS_PI_RPC_WORKER").ok();
        let runtime_path = std::env::var("COPIS_PI_RPC_RUNTIME").ok();
        let use_system_runtime = std::env::var("COPIS_PI_RPC_USE_SYSTEM_RUNTIME")
            .ok()
            .as_deref()
            == Some("1");
        let require_compiled_runtime = std::env::var("COPIS_PI_RPC_COMPILED_RUNTIME")
            .ok()
            .as_deref()
            == Some("1");
        let has_compiled_executable = executable_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty());
        if require_compiled_runtime && !has_compiled_executable {
            self.file_policies.remove(session_id);
            return Err(
                "未找到打包的 Copis runtime。请重新安装或重新构建应用后再启动 Agent。".to_string(),
            );
        }
        let require_external_runtime = !has_compiled_executable && !use_system_runtime;
        // 自包含 Bun Worker 不需要探测旧的 Node/Git runtime 目录；这也避免坏掉的
        // 外部 runtime 在 Windows 上拖慢每次 Agent 启动。
        let external_runtime = require_external_runtime.then(runtime::resolve_runtime);
        let launch = match resolve_worker_launch(
            executable_path.clone(),
            worker_path,
            runtime_path.clone(),
            external_runtime
                .as_ref()
                .and_then(|runtime| runtime.node_path().map(PathBuf::from)),
            use_system_runtime,
        ) {
            Ok(launch) => launch,
            Err(error) => {
                self.file_policies.remove(session_id);
                return Err(error);
            }
        };
        let require_node = worker_requires_node(
            executable_path.as_deref(),
            runtime_path.as_deref(),
            use_system_runtime,
        );
        if let Some(external_runtime) = external_runtime.as_ref() {
            if let Err(error) = external_runtime.validate_for_worker(require_node, true) {
                self.file_policies.remove(session_id);
                return Err(error);
            }
            if let Err(error) = external_runtime.inject_pi_config(&mut config, require_node, true) {
                self.file_policies.remove(session_id);
                return Err(error);
            }
        }
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        configure_worker_file_capability(&mut command, &file_api_token);
        if let Some(external_runtime) = external_runtime.as_ref() {
            command.env("PATH", external_runtime.path_value());
            command.env("COPIS_RUNTIME_ROOT", &external_runtime.runtime_root);
            command.env("COPIS_RUNTIME_DIR", &external_runtime.active_dir);
        }
        command.env_remove("ELECTRON_RUN_AS_NODE");
        if let Some(external_runtime) = external_runtime.as_ref() {
            if let Some(path) = external_runtime.node_path() {
                command.env("COPIS_NODE_PATH", path);
            }
            if let Some(path) = external_runtime.git_path.as_deref() {
                command.env("COPIS_GIT_PATH", path);
            }
            if let Some(path) = external_runtime.bash_path.as_deref() {
                command.env("COPIS_GIT_BASH_PATH", path);
                command.env("COPIS_WINDOWS_SHELL", "git-bash");
                command.env("SHELL", path);
            }
        }
        let mut child = match command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                self.file_policies.remove(session_id);
                return Err(format!("Pi worker 启动失败: {}", error));
            }
        };

        let stdin = child.stdin.take().ok_or_else(|| {
            self.file_policies.remove(session_id);
            let _ = child.kill();
            "Pi worker stdin 不可用".to_string()
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            self.file_policies.remove(session_id);
            let _ = child.kill();
            "Pi worker stdout 不可用".to_string()
        })?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_reader(stderr);
        }

        let control = Arc::new(WorkerControl {
            writer: Mutex::new(BufWriter::new(stdin)),
        });
        {
            let mut workers = self.workers.lock().unwrap();
            if workers.contains_key(session_id) {
                self.file_policies.remove(session_id);
                let _ = child.kill();
                return Err("该 Agent 会话已有运行中的 Pi worker".to_string());
            }
            workers.insert(session_id.to_string(), Arc::clone(&control));
        }
        self.worker_statuses.lock().unwrap().insert(
            session_id.to_string(),
            PiWorkerStatusSnapshot {
                session_id: session_id.to_string(),
                state: PiWorkerRunState::Running,
                permission_mode,
            },
        );

        let command = serde_json::json!({
            "type": "run",
            "requestId": session_id,
            "config": config,
        });
        if let Err(error) = write_json_line(&control, &command) {
            self.workers.lock().unwrap().remove(session_id);
            self.worker_statuses.lock().unwrap().remove(session_id);
            self.file_policies.remove(session_id);
            let _ = child.kill();
            return Err(format!("Pi worker run 命令发送失败: {}", error));
        }

        Ok(PiWorkerRun {
            session_id: session_id.to_string(),
            child,
            stdout: BufReader::new(stdout),
        })
    }

    /// 支付 Worker 是一次性、无模型的本机 capability，不加入普通 Agent 的会话或状态表。
    #[allow(dead_code)]
    pub fn execute_payment(
        &self,
        workspace: &PaymentWorkspace,
        server_account_id: &str,
        action: PaymentWorkerAction,
        request: Value,
    ) -> Result<Value, String> {
        if !request.is_object() {
            return Err("Pi 支付请求不正确".to_string());
        }
        let account_home = workspace
            .ensure_account_home(server_account_id)
            .map_err(|_| "默认支付工作区不可用".to_string())?;
        let session_id = payment_worker_session_id()?;
        let token = self
            .payment_capabilities
            .register(&session_id, &account_home, action.as_str())
            .map_err(|_| "Pi 支付能力不可用".to_string())?;

        let result = self.execute_payment_worker(
            workspace,
            &account_home,
            &session_id,
            &token,
            action,
            request,
        );
        self.payment_capabilities.remove(&session_id);
        result
    }

    #[allow(dead_code)]
    fn execute_payment_worker(
        &self,
        workspace: &PaymentWorkspace,
        account_home: &std::path::Path,
        session_id: &str,
        capability_token: &str,
        action: PaymentWorkerAction,
        request: Value,
    ) -> Result<Value, String> {
        let executable_path = std::env::var("COPIS_PI_RPC_EXECUTABLE").ok();
        let worker_path = std::env::var("COPIS_PI_RPC_WORKER").ok();
        let runtime_path = std::env::var("COPIS_PI_RPC_RUNTIME").ok();
        let use_system_runtime = std::env::var("COPIS_PI_RPC_USE_SYSTEM_RUNTIME")
            .ok()
            .as_deref()
            == Some("1");
        let require_compiled_runtime = std::env::var("COPIS_PI_RPC_COMPILED_RUNTIME")
            .ok()
            .as_deref()
            == Some("1");
        let has_compiled_executable = executable_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty());
        if require_compiled_runtime && !has_compiled_executable {
            return Err(
                "未找到打包的 Copis runtime。请重新安装或重新构建应用后再启动支付。".to_string(),
            );
        }
        let require_external_runtime = !has_compiled_executable && !use_system_runtime;
        let external_runtime = require_external_runtime.then(runtime::resolve_runtime);
        let launch = resolve_worker_launch(
            executable_path.clone(),
            worker_path,
            runtime_path.clone(),
            external_runtime
                .as_ref()
                .and_then(|runtime| runtime.node_path().map(PathBuf::from)),
            use_system_runtime,
        )?;
        let require_node = worker_requires_node(
            executable_path.as_deref(),
            runtime_path.as_deref(),
            use_system_runtime,
        );
        if let Some(external_runtime) = external_runtime.as_ref() {
            external_runtime.validate_for_worker(require_node, true)?;
        }

        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        command.current_dir(workspace.cwd());
        configure_payment_worker_capability(&mut command, capability_token);
        command.env("HOME", account_home);
        command.env("USERPROFILE", account_home);
        command.env_remove("ELECTRON_RUN_AS_NODE");
        if let Some(external_runtime) = external_runtime.as_ref() {
            command.env("PATH", external_runtime.path_value());
            command.env("COPIS_RUNTIME_ROOT", &external_runtime.runtime_root);
            command.env("COPIS_RUNTIME_DIR", &external_runtime.active_dir);
            if let Some(path) = external_runtime.node_path() {
                command.env("COPIS_NODE_PATH", path);
            }
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Pi 支付 Worker 启动失败".to_string())?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Pi 支付 Worker stdin 不可用".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_reader(stderr);
        }
        let worker_command = payment_worker_command(session_id, action, request);
        serde_json::to_writer(&mut stdin, &worker_command)
            .map_err(|_| "Pi 支付 Worker 请求编码失败".to_string())?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|_| "Pi 支付 Worker 请求发送失败".to_string())?;
        drop(stdin);

        let output = child
            .wait_with_output()
            .map_err(|_| "Pi 支付 Worker 执行失败".to_string())?;
        parse_payment_worker_result(&output.stdout, session_id)
    }

    pub fn stop(&self, session_id: &str) -> Result<bool, String> {
        let control = self.workers.lock().unwrap().get(session_id).cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        write_json_line(&control, &stop_command(session_id))
            .map_err(|error| format!("Pi worker 停止命令发送失败: {}", error))?;
        self.mark_stopping(session_id);
        Ok(true)
    }

    #[cfg(test)]
    pub fn is_active(&self, session_id: &str) -> bool {
        self.worker_statuses
            .lock()
            .unwrap()
            .contains_key(session_id)
    }

    pub fn active_session_ids(&self) -> Vec<String> {
        let mut session_ids = self
            .worker_statuses
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        session_ids.sort();
        session_ids
    }

    pub fn stop_all(&self) -> Result<usize, String> {
        let workers = self
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(session_id, control)| (session_id.clone(), Arc::clone(control)))
            .collect::<Vec<_>>();
        let mut stopped = 0;
        let mut errors = Vec::new();
        for (session_id, control) in &workers {
            match write_json_line(control, &stop_command(session_id)) {
                Ok(()) => {
                    self.mark_stopping(session_id);
                    stopped += 1;
                }
                Err(error) => errors.push(format!("{}: {}", session_id, error)),
            }
        }
        if errors.is_empty() {
            Ok(stopped)
        } else {
            Err(format!(
                "Pi worker 批量停止命令发送失败: {}",
                errors.join("; ")
            ))
        }
    }

    /// 权限模式由 Rust 的文件策略实际执行；Worker 仅接收状态同步命令并输出 UI 事件。
    pub fn set_permission_mode(
        &self,
        session_id: &str,
        permission_mode: &str,
    ) -> Result<bool, AgentFileError> {
        if !is_supported_permission_mode(permission_mode) {
            return Err(AgentFileError::bad_request("权限模式不正确"));
        }
        let control = self.workers.lock().unwrap().get(session_id).cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        write_json_line(
            &control,
            &permission_mode_command(session_id, permission_mode),
        )
        .map_err(|error| {
            AgentFileError::internal(format!("Pi worker 权限模式命令发送失败: {}", error))
        })?;
        self.file_policies
            .update_permission_mode(session_id, permission_mode)?;
        if let Some(status) = self.worker_statuses.lock().unwrap().get_mut(session_id) {
            status.permission_mode = permission_mode.to_string();
        }
        Ok(true)
    }

    pub fn queue(&self, session_id: &str, config: Value) -> Result<bool, String> {
        let configured_session_id = config
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Pi worker queue 配置缺少 sessionId".to_string())?;
        if configured_session_id != session_id {
            return Err("Pi worker queue 会话不匹配".to_string());
        }
        let request_id = config
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Pi worker queue 配置缺少 uuid".to_string())?;
        let control = self.workers.lock().unwrap().get(session_id).cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        let command = serde_json::json!({
            "type": "queue",
            "requestId": request_id,
            "config": config,
        });
        write_json_line(&control, &command)
            .map_err(|error| format!("Pi worker queue 命令发送失败: {}", error))?;
        Ok(true)
    }

    pub fn finish(&self, mut run: PiWorkerRun) {
        self.workers.lock().unwrap().remove(&run.session_id);
        self.worker_statuses.lock().unwrap().remove(&run.session_id);
        self.file_policies.remove(&run.session_id);
        if run.child.try_wait().ok().flatten().is_none() {
            let _ = run.child.kill();
        }
        let _ = run.child.wait();
    }

    fn mark_stopping(&self, session_id: &str) {
        if let Some(status) = self.worker_statuses.lock().unwrap().get_mut(session_id) {
            status.state = PiWorkerRunState::Stopping;
        }
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

fn stop_command(session_id: &str) -> Value {
    serde_json::json!({
        "type": "stop",
        "sessionId": session_id,
    })
}

fn permission_mode_command(session_id: &str, permission_mode: &str) -> Value {
    serde_json::json!({
        "type": "set_permission_mode",
        "sessionId": session_id,
        "mode": permission_mode,
    })
}

#[allow(dead_code)]
pub fn payment_worker_command(
    session_id: &str,
    action: PaymentWorkerAction,
    mut request: Value,
) -> Value {
    let request_object = request.as_object_mut().expect("支付 Worker 请求必须是对象");
    request_object.insert(
        "action".to_string(),
        Value::String(action.as_str().to_string()),
    );
    serde_json::json!({
        "type": "payment",
        "requestId": session_id,
        "config": {
            "sessionId": session_id,
            "request": request,
        },
    })
}

#[allow(dead_code)]
fn payment_worker_session_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| "无法创建 Pi 支付会话".to_string())?;
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("payment-{token}"))
}

#[allow(dead_code)]
fn parse_payment_worker_result(output: &[u8], session_id: &str) -> Result<Value, String> {
    let text = String::from_utf8_lossy(output);
    for line in text.lines() {
        let Some(frame) = parse_worker_frame(line) else {
            continue;
        };
        if frame.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        match frame.get("type").and_then(Value::as_str) {
            Some("payment_result") => {
                let result = frame
                    .get("result")
                    .filter(|value| value.is_object())
                    .cloned()
                    .ok_or_else(|| "Pi 支付 Worker 响应不正确".to_string())?;
                return Ok(result);
            }
            Some("error") | Some("fatal") => return Err("Pi 支付能力调用失败".to_string()),
            _ => {}
        }
    }
    Err("Pi 支付 Worker 未返回结果".to_string())
}

/// Pi 只获得当前会话的文件 capability；全局内部管理令牌绝不能传给 Pi。
fn configure_worker_file_capability(command: &mut Command, file_api_token: &str) {
    command.env_remove("COPIS_HTTP_API_INTERNAL_TOKEN");
    command.env("COPIS_PI_FILE_API_TOKEN", file_api_token);
}

/// 设置页支付使用专用 capability，不能混入普通 Agent 的文件权限令牌。
#[allow(dead_code)]
fn configure_payment_worker_capability(command: &mut Command, payment_token: &str) {
    command.env_remove("COPIS_HTTP_API_INTERNAL_TOKEN");
    command.env_remove("COPIS_PI_FILE_API_TOKEN");
    command.env("COPIS_PI_PAYMENT_CAPABILITY_TOKEN", payment_token);
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

#[cfg(test)]
#[path = "pi_rpc_tests.rs"]
mod tests;
