use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_PENDING_AGENT_STARTUPS: usize = 32;

use getrandom::getrandom;
use serde_json::Value;

use crate::agent_files::{is_supported_permission_mode, AgentFileError, AgentFilePolicyStore};
use crate::automation::{issue_worker_capability, revoke_worker_capability_if};
use crate::payment_capability::PaymentCapabilityStore;
use crate::payment_workspace::PaymentWorkspace;
use crate::runtime;
use crate::working_model_proxy::{
    WorkingModelCapability, WorkingModelError, WorkingModelProxy, WorkingModelResponse,
    WorkingModelStreamResponse,
};

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
        .map(|_| "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, x-copis-web-token\r\n".to_string())
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
    session_id: String,
    writer: Mutex<BufWriter<std::process::ChildStdin>>,
    child: Arc<Mutex<Child>>,
    owner_token: u64,
    owner_id: Option<String>,
    is_chatroom: bool,
    file_api_token: String,
    worker_capability_token: Option<String>,
    working_model_capability_token: Option<String>,
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
    startup_reservations: Mutex<StartupReservations>,
    workers: Mutex<HashMap<String, Arc<WorkerControl>>>,
    worker_statuses: Mutex<HashMap<String, PiWorkerStatusSnapshot>>,
    file_policies: Arc<AgentFilePolicyStore>,
    payment_capabilities: Arc<PaymentCapabilityStore>,
    working_model_proxy: Mutex<Option<Arc<WorkingModelProxy>>>,
    chatroom_execution: Arc<super::chatroom_execution::ChatroomExecutionRegistry>,
}

struct StartupReservations {
    next_token: u64,
    by_session: HashMap<String, StartupOwner>,
}

struct StartupOwner {
    token: u64,
    owner_id: Option<String>,
    file_api_token: Option<String>,
    worker_capability_token: Option<String>,
    working_model_capability_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentStartupReservation {
    session_id: String,
    token: u64,
    owner_id: Option<String>,
}

struct StartupCapabilityCleanup<'a> {
    manager: &'a PiWorkerManager,
    session_id: String,
    file_api_token: String,
    worker_capability_token: Option<String>,
    working_model_capability_token: Option<String>,
    armed: bool,
}

impl StartupCapabilityCleanup<'_> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartupCapabilityCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.manager.cleanup_run_capabilities(
                &self.session_id,
                &self.file_api_token,
                self.worker_capability_token.as_deref(),
                self.working_model_capability_token.as_deref(),
            );
        }
    }
}

pub struct PiWorkerRun {
    pub session_id: String,
    owner_token: u64,
    control: Arc<WorkerControl>,
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

fn is_copis_working_channel_id(channel_id: &str) -> bool {
    channel_id.starts_with("copis-working")
}

pub fn is_supported_permission_mode_for_profile(mode: &str, profile: Option<&str>) -> bool {
    is_supported_permission_mode(mode) || (mode == "default" && profile == Some("chatroom"))
}

impl PiWorkerManager {
    pub fn new() -> Self {
        Self {
            startup_reservations: Mutex::new(StartupReservations {
                next_token: 1,
                by_session: HashMap::new(),
            }),
            workers: Mutex::new(HashMap::new()),
            worker_statuses: Mutex::new(HashMap::new()),
            file_policies: Arc::new(AgentFilePolicyStore::new()),
            payment_capabilities: Arc::new(PaymentCapabilityStore::new()),
            working_model_proxy: Mutex::new(None),
            chatroom_execution: Arc::new(
                super::chatroom_execution::ChatroomExecutionRegistry::default(),
            ),
        }
    }

    pub fn chatroom_execution_registry(
        &self,
    ) -> Arc<super::chatroom_execution::ChatroomExecutionRegistry> {
        Arc::clone(&self.chatroom_execution)
    }

    pub fn file_policies(&self) -> Arc<AgentFilePolicyStore> {
        Arc::clone(&self.file_policies)
    }

    #[cfg(test)]
    pub fn active_file_token_for_test(&self, session_id: &str) -> Option<String> {
        self.workers
            .lock()
            .unwrap()
            .get(session_id)
            .map(|worker| worker.file_api_token.clone())
    }

    pub fn payment_capabilities(&self) -> Arc<PaymentCapabilityStore> {
        Arc::clone(&self.payment_capabilities)
    }
    pub fn set_working_model_proxy(&self, proxy: Arc<WorkingModelProxy>) {
        *self.working_model_proxy.lock().unwrap() = Some(proxy);
    }

    /// 在任何异步 prepare 前占用有限启动槽；token 只在本机 Main RPC 生命周期内有效。
    pub fn reserve_startup(&self, session_id: &str) -> Result<AgentStartupReservation, String> {
        self.reserve_startup_for(session_id, None)
    }

    pub fn reserve_startup_for(
        &self,
        session_id: &str,
        owner_id: Option<String>,
    ) -> Result<AgentStartupReservation, String> {
        if session_id.trim().is_empty() {
            return Err("Pi worker sessionId 不能为空".to_string());
        }
        let reserve = || {
            let mut startups = self.startup_reservations.lock().unwrap();
            if startups.by_session.contains_key(session_id) {
                return Err("该 Agent 会话已有待启动的 Pi worker".to_string());
            }
            if self.workers.lock().unwrap().contains_key(session_id)
                || self
                    .worker_statuses
                    .lock()
                    .unwrap()
                    .contains_key(session_id)
            {
                return Err("该 Agent 会话已有运行中的 Pi worker".to_string());
            }
            if startups.by_session.len() >= MAX_PENDING_AGENT_STARTUPS {
                return Err("Pi worker 待启动容量已满".to_string());
            }
            let token = startups.next_token;
            startups.next_token = startups.next_token.wrapping_add(1).max(1);
            startups.by_session.insert(
                session_id.to_string(),
                StartupOwner {
                    token,
                    owner_id: owner_id.clone(),
                    file_api_token: None,
                    worker_capability_token: None,
                    working_model_capability_token: None,
                },
            );
            Ok(AgentStartupReservation {
                session_id: session_id.to_string(),
                token,
                owner_id: owner_id.clone(),
            })
        };
        if let Some(owner) = owner_id.as_deref() {
            if self.chatroom_execution.owner_is_revoked(session_id, owner) {
                return Err("聊天室执行已撤销".to_string());
            }
            if let Some(binding) = self.chatroom_execution.binding_for_owner(session_id, owner) {
                return self
                    .chatroom_execution
                    .with_live_binding(
                        &binding.room_id,
                        &binding.invocation_id,
                        session_id,
                        owner,
                        reserve,
                    )
                    .unwrap_or_else(|| Err("聊天室执行已撤销".to_string()));
            }
        }
        reserve()
    }

    pub fn abandon_startup(&self, reservation: &AgentStartupReservation) {
        let mut startups = self.startup_reservations.lock().unwrap();
        if startups
            .by_session
            .get(&reservation.session_id)
            .is_some_and(|owner| owner.token == reservation.token)
        {
            if let Some(owner) = startups.by_session.remove(&reservation.session_id) {
                self.cleanup_startup_capabilities(&reservation.session_id, &owner);
            }
        }
    }

    fn startup_is_current(&self, reservation: &AgentStartupReservation) -> bool {
        self.startup_reservations
            .lock()
            .unwrap()
            .by_session
            .get(&reservation.session_id)
            .is_some_and(|owner| owner.token == reservation.token)
    }

    pub fn revoke_chatroom_binding(
        &self,
        binding: &super::chatroom_execution::ChatroomExecutionBinding,
    ) -> Result<bool, String> {
        self.stop_owned(&binding.session_id, Some(&binding.worker_run_id))
    }

    #[cfg(test)]
    pub fn pending_startup_owner_for_test(&self, session_id: &str) -> Option<Option<String>> {
        self.startup_reservations
            .lock()
            .unwrap()
            .by_session
            .get(session_id)
            .map(|owner| owner.owner_id.clone())
    }

    fn with_current_startup<T>(
        &self,
        reservation: &AgentStartupReservation,
        operation: impl FnOnce(&mut StartupOwner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut startups = self.startup_reservations.lock().unwrap();
        let owner = startups
            .by_session
            .get_mut(&reservation.session_id)
            .filter(|owner| owner.token == reservation.token)
            .ok_or_else(|| "Pi worker startup 已取消".to_string())?;
        operation(owner)
    }

    fn cleanup_startup_capabilities(&self, session_id: &str, owner: &StartupOwner) {
        self.cleanup_run_capabilities(
            session_id,
            owner.file_api_token.as_deref().unwrap_or_default(),
            owner.worker_capability_token.as_deref(),
            owner.working_model_capability_token.as_deref(),
        );
    }

    fn cleanup_control_capabilities(&self, control: &WorkerControl) {
        self.cleanup_run_capabilities(
            &control.session_id,
            &control.file_api_token,
            control.worker_capability_token.as_deref(),
            control.working_model_capability_token.as_deref(),
        );
    }

    pub fn working_model_request(
        &self,
        _session_id: &str,
        capability: &str,
        request_body: &[u8],
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        let proxy = self
            .working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or(WorkingModelError::Unauthorized)?;
        proxy.proxy_with_capability(capability, request_body)
    }

    pub fn working_model_internal_request(
        &self,
        request_body: &[u8],
    ) -> Result<WorkingModelResponse, WorkingModelError> {
        let proxy = self
            .working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or(WorkingModelError::Unauthorized)?;
        proxy.proxy_internal(request_body)
    }

    pub fn working_model_stream_request(
        &self,
        capability: Option<&str>,
        internal: bool,
        request_body: &[u8],
        idempotency_key: Option<&str>,
    ) -> Result<WorkingModelStreamResponse, WorkingModelError> {
        let proxy = self
            .working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or(WorkingModelError::Unauthorized)?;
        if internal {
            proxy.proxy_stream_internal(request_body, idempotency_key)
        } else {
            proxy.proxy_stream_with_capability(
                capability.ok_or(WorkingModelError::Unauthorized)?,
                request_body,
                idempotency_key,
            )
        }
    }

    pub fn working_model_json_get(&self, path: &str) -> Result<Value, WorkingModelError> {
        self.working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or(WorkingModelError::Unauthorized)?
            .model_json_get(path)
    }

    /// 为 DSH 进程签发长期的本机 Working 模型 capability。
    pub fn issue_dsh_working_model_capability(
        &self,
        reasoning_effort: Option<&str>,
    ) -> Result<String, WorkingModelError> {
        let proxy = self
            .working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or(WorkingModelError::Unauthorized)?;
        proxy.issue_dsh_capability(reasoning_effort)
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

    fn prepare_working_model_config(
        &self,
        session_id: &str,
        config: &mut Value,
    ) -> Result<Option<WorkingModelCapability>, String> {
        let query = config
            .get_mut("query")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Pi worker 配置缺少 query".to_string())?;
        let channel_id = query
            .get("channelId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payment_flow = match query.get("workingPaymentFlow") {
            None | Some(Value::Null) => None,
            Some(Value::String(flow)) if matches!(flow.as_str(), "diamond" | "vip") => {
                Some(flow.as_str())
            }
            _ => return Err("支付会话类型不正确".to_string()),
        };
        if !is_copis_working_channel_id(channel_id) {
            if payment_flow.is_some() {
                return Err("支付会话必须使用 Copis 内置快速模型".to_string());
            }
            return Ok(None);
        }
        let model_id = query
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Working Pi worker 配置缺少 model".to_string())?;
        let proxy = self
            .working_model_proxy
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Working 模型代理尚未初始化".to_string())?;
        let capability = match payment_flow {
            Some(flow) => proxy.issue_payment(session_id, model_id, flow),
            None => proxy.issue(session_id, model_id),
        }
        .map_err(|error| format!("Working 模型 capability 创建失败: {}", error))?;
        query.insert(
            "apiKey".to_string(),
            Value::String(capability.capability.clone()),
        );
        query.insert(
            "workingModelCapability".to_string(),
            Value::String(capability.capability.clone()),
        );
        Ok(Some(capability))
    }

    fn revoke_working_model_capability_if(&self, session_id: &str, capability: Option<&str>) {
        if let (Some(proxy), Some(capability)) =
            (self.working_model_proxy.lock().unwrap().clone(), capability)
        {
            proxy.revoke_if(session_id, capability);
        }
    }

    fn cleanup_run_capabilities(
        &self,
        session_id: &str,
        file_api_token: &str,
        worker_capability_token: Option<&str>,
        working_model_capability_token: Option<&str>,
    ) {
        if !file_api_token.is_empty() {
            self.file_policies
                .remove_if_worker_token(session_id, file_api_token);
        }
        if let Some(token) = worker_capability_token {
            revoke_worker_capability_if(session_id, token);
        }
        self.revoke_working_model_capability_if(session_id, working_model_capability_token);
    }

    pub fn start(&self, session_id: &str, config: Value) -> Result<PiWorkerRun, String> {
        let reservation = self.reserve_startup(session_id)?;
        let result = self.start_reserved(&reservation, config);
        self.abandon_startup(&reservation);
        result
    }

    pub fn start_reserved(
        &self,
        reservation: &AgentStartupReservation,
        config: Value,
    ) -> Result<PiWorkerRun, String> {
        self.start_reserved_with_launch(reservation, config, None)
    }

    #[cfg(test)]
    pub fn start_reserved_with_fake_worker(
        &self,
        reservation: &AgentStartupReservation,
        config: Value,
    ) -> Result<PiWorkerRun, String> {
        self.start_reserved_with_launch(
            reservation,
            config,
            Some(WorkerLaunch {
                program: PathBuf::from("/bin/sleep"),
                args: vec!["30".to_string()],
            }),
        )
    }

    fn start_reserved_with_launch(
        &self,
        reservation: &AgentStartupReservation,
        mut config: Value,
        launch_override: Option<WorkerLaunch>,
    ) -> Result<PiWorkerRun, String> {
        let session_id = reservation.session_id.as_str();
        if !self.startup_is_current(reservation) {
            return Err("Pi worker startup 已取消".to_string());
        }
        let (permission_mode, triggered_by, automation_enabled, is_chatroom, file_api_token) = {
            let query = config
                .get_mut("query")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "Pi worker 配置缺少 query".to_string())?;
            let capability_profile = query.get("capabilityProfile").and_then(Value::as_str);
            let permission_mode = query
                .get("permissionMode")
                .and_then(Value::as_str)
                .filter(|mode| is_supported_permission_mode_for_profile(mode, capability_profile))
                .ok_or_else(|| "Pi worker 配置缺少有效 permissionMode".to_string())?
                .to_string();
            let triggered_by = query
                .get("triggeredBy")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "user" | "automation" | "delegation"))
                .unwrap_or("user")
                .to_string();
            let automation_enabled =
                query.get("automationEnabled").and_then(Value::as_bool) != Some(false);
            let is_chatroom =
                query.get("capabilityProfile").and_then(Value::as_str) == Some("chatroom");
            let mut register_file_capability = || {
                self.with_current_startup(reservation, |owner| {
                    let token = self.file_policies.register_from_query(session_id, query)?;
                    if !token.is_empty() {
                        owner.file_api_token = Some(token.clone());
                    }
                    Ok(token)
                })
            };
            let file_api_token = if is_chatroom {
                let binding = reservation
                    .owner_id
                    .as_deref()
                    .and_then(|owner| self.chatroom_execution.binding_for_owner(session_id, owner))
                    .ok_or_else(|| "聊天室运行缺少 Native execution binding".to_string())?;
                self.chatroom_execution
                    .with_live_binding(
                        &binding.room_id,
                        &binding.invocation_id,
                        session_id,
                        &binding.worker_run_id,
                        register_file_capability,
                    )
                    .ok_or_else(|| "聊天室执行已撤销".to_string())??
            } else {
                register_file_capability()?
            };
            (
                permission_mode,
                triggered_by,
                automation_enabled,
                is_chatroom,
                file_api_token,
            )
        };
        if file_api_token.is_empty() {
            return Err("Pi Worker 未收到 Rust 文件能力令牌".to_string());
        }
        let mut capability_cleanup = StartupCapabilityCleanup {
            manager: self,
            session_id: session_id.to_string(),
            file_api_token: file_api_token.clone(),
            worker_capability_token: None,
            working_model_capability_token: None,
            armed: true,
        };
        if !self
            .file_policies
            .contains_worker_token(session_id, &file_api_token)
            || self.file_policies.permission_mode(session_id).as_deref()
                != Some(permission_mode.as_str())
        {
            return Err("Pi Worker 权限模式与 Rust 文件策略不一致".to_string());
        }
        let executable_path = if launch_override.is_none() {
            std::env::var("COPIS_PI_RPC_EXECUTABLE").ok()
        } else {
            None
        };
        let worker_path = if launch_override.is_none() {
            std::env::var("COPIS_PI_RPC_WORKER").ok()
        } else {
            None
        };
        let runtime_path = if launch_override.is_none() {
            std::env::var("COPIS_PI_RPC_RUNTIME").ok()
        } else {
            None
        };
        let use_system_runtime = std::env::var("COPIS_PI_RPC_USE_SYSTEM_RUNTIME")
            .ok()
            .as_deref()
            == Some("1");
        let require_compiled_runtime = launch_override.is_none()
            && std::env::var("COPIS_PI_RPC_COMPILED_RUNTIME")
                .ok()
                .as_deref()
                == Some("1");
        let has_compiled_executable = executable_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty());
        if require_compiled_runtime && !has_compiled_executable {
            return Err(
                "未找到打包的 Copis runtime。请重新安装或重新构建应用后再启动 Agent。".to_string(),
            );
        }
        let require_external_runtime =
            launch_override.is_none() && !has_compiled_executable && !use_system_runtime;
        // 自包含 Bun Worker 不需要探测旧的 Node/Git runtime 目录；这也避免坏掉的
        // 外部 runtime 在 Windows 上拖慢每次 Agent 启动。
        let external_runtime = require_external_runtime.then(runtime::resolve_runtime);
        let launch = match launch_override {
            Some(launch) => launch,
            None => match resolve_worker_launch(
                executable_path.clone(),
                worker_path,
                runtime_path.clone(),
                external_runtime
                    .as_ref()
                    .and_then(|runtime| runtime.node_path().map(PathBuf::from)),
                use_system_runtime,
            ) {
                Ok(launch) => launch,
                Err(error) => return Err(error),
            },
        };
        let require_node = worker_requires_node(
            executable_path.as_deref(),
            runtime_path.as_deref(),
            use_system_runtime,
        );
        if let Some(external_runtime) = external_runtime.as_ref() {
            if let Err(error) = external_runtime.validate_for_worker(require_node, true) {
                return Err(error);
            }
            if let Err(error) = external_runtime.inject_pi_config(&mut config, require_node, true) {
                return Err(error);
            }
        }
        // Python runtime 与 Pi Worker 的 Bun/Node 启动方式无关，必须在所有分支注入。
        // 编译 Worker 和开发 Bun 不会创建 external_runtime，不能因此回退到系统 Python。
        if let Err(error) = runtime::inject_python_runtime_config(&mut config) {
            return Err(error);
        }
        let mut worker_capability_token = None;
        if automation_enabled {
            let query = config
                .get_mut("query")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "Pi worker 配置缺少 query".to_string())?;
            let automation_capability = self.with_current_startup(reservation, |owner| {
                let capability = issue_worker_capability(
                    session_id,
                    &triggered_by,
                    query
                        .get("channelId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    query
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    query
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    query
                        .get("sourceAutomationId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                );
                owner.worker_capability_token = Some(capability.token.clone());
                Ok(capability)
            })?;
            worker_capability_token = Some(automation_capability.token.clone());
            capability_cleanup.worker_capability_token = worker_capability_token.clone();
            query.insert(
                "automationControl".to_string(),
                serde_json::to_value(automation_capability)
                    .map_err(|_| "定时任务 capability 编码失败".to_string())?,
            );
        }
        let working_model_capability = self.with_current_startup(reservation, |owner| {
            let capability = self.prepare_working_model_config(session_id, &mut config)?;
            owner.working_model_capability_token =
                capability.as_ref().map(|item| item.capability.clone());
            Ok(capability)
        })?;
        let working_model_capability_token = working_model_capability
            .as_ref()
            .map(|capability| capability.capability.clone());
        capability_cleanup.working_model_capability_token = working_model_capability_token.clone();
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        configure_worker_file_capability(&mut command, &file_api_token);
        if let Some(external_runtime) = external_runtime.as_ref() {
            command.env("PATH", external_runtime.path_value());
            command.env("COPIS_RUNTIME_ROOT", &external_runtime.runtime_root);
            command.env("COPIS_RUNTIME_DIR", &external_runtime.active_dir);
        }
        if let Some(python_root) = runtime::python_runtime_root() {
            let base_path = external_runtime
                .as_ref()
                .map(|runtime| runtime.path_value())
                .or_else(|| std::env::var("PATH").ok());
            if let Some(path) = runtime::prepend_python_runtime_path(base_path.as_deref()) {
                command.env("PATH", path);
            }
            command.env("COPIS_PYTHON_RUNTIME_ROOT", &python_root);
            command.env("PYTHONHOME", &python_root);
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
        if !self.startup_is_current(reservation) {
            return Err("Pi worker startup 已取消".to_string());
        }
        let mut spawned_child = match command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => return Err(format!("Pi worker 启动失败: {}", error)),
        };

        let stdin = match spawned_child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = spawned_child.kill();
                let _ = spawned_child.wait();
                return Err("Pi worker stdin 不可用".to_string());
            }
        };
        let stdout = match spawned_child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = spawned_child.kill();
                let _ = spawned_child.wait();
                return Err("Pi worker stdout 不可用".to_string());
            }
        };
        if let Some(stderr) = spawned_child.stderr.take() {
            spawn_stderr_reader(stderr);
        }
        let child = Arc::new(Mutex::new(spawned_child));
        let control = Arc::new(WorkerControl {
            session_id: session_id.to_string(),
            writer: Mutex::new(BufWriter::new(stdin)),
            child: Arc::clone(&child),
            owner_token: reservation.token,
            owner_id: reservation.owner_id.clone(),
            is_chatroom,
            file_api_token: file_api_token.clone(),
            worker_capability_token: worker_capability_token.clone(),
            working_model_capability_token: working_model_capability_token.clone(),
        });

        // Reservation 转成 Active Worker 和 stop 共享锁，IO 在释放锁之后执行。
        let activate_worker = || {
            let mut startups = self.startup_reservations.lock().unwrap();
            if !startups
                .by_session
                .get(session_id)
                .is_some_and(|owner| owner.token == reservation.token)
                || self.workers.lock().unwrap().contains_key(session_id)
            {
                return Err("Pi worker startup 已取消或 session 已占用".to_string());
            }
            self.workers
                .lock()
                .unwrap()
                .insert(session_id.to_string(), Arc::clone(&control));
            self.worker_statuses.lock().unwrap().insert(
                session_id.to_string(),
                PiWorkerStatusSnapshot {
                    session_id: session_id.to_string(),
                    state: PiWorkerRunState::Running,
                    permission_mode: permission_mode.clone(),
                },
            );
            startups.by_session.remove(session_id);
            Ok(())
        };
        let activated = if is_chatroom {
            let binding = reservation
                .owner_id
                .as_deref()
                .and_then(|owner| self.chatroom_execution.binding_for_owner(session_id, owner))
                .ok_or_else(|| "聊天室运行缺少 Native execution binding".to_string())?;
            self.chatroom_execution
                .with_live_binding(
                    &binding.room_id,
                    &binding.invocation_id,
                    session_id,
                    &binding.worker_run_id,
                    activate_worker,
                )
                .unwrap_or_else(|| Err("聊天室执行已撤销".to_string()))
        } else {
            activate_worker()
        };
        if let Err(error) = activated {
            let _ = terminate_child(&child);
            return Err(error);
        }
        capability_cleanup.disarm();

        let run = PiWorkerRun {
            session_id: session_id.to_string(),
            owner_token: reservation.token,
            control: Arc::clone(&control),
            stdout: BufReader::new(stdout),
        };
        let command = serde_json::json!({
            "type": "run",
            "requestId": session_id,
            "config": config,
        });
        if let Err(error) = write_json_line(&control, &command) {
            self.finish(run);
            return Err(format!("Pi worker run 命令发送失败: {}", error));
        }
        Ok(run)
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
        self.stop_owned(session_id, None)
    }

    pub fn stop_owned(&self, session_id: &str, owner_id: Option<&str>) -> Result<bool, String> {
        let mut startups = self.startup_reservations.lock().unwrap();
        let pending_matches = startups.by_session.get(session_id).is_some_and(|owner| {
            owner_id.is_none_or(|requested| owner.owner_id.as_deref() == Some(requested))
        });
        if pending_matches {
            if let Some(owner) = startups.by_session.remove(session_id) {
                self.cleanup_startup_capabilities(session_id, &owner);
            }
        }
        let control = self
            .workers
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .filter(|control| match owner_id {
                Some(requested) => control.owner_id.as_deref() == Some(requested),
                None => !control.is_chatroom,
            });
        if owner_id.is_some() || control.as_ref().is_some_and(|control| control.is_chatroom) {
            if let Some(control) = control.as_ref() {
                self.cleanup_control_capabilities(control);
            }
        }
        drop(startups);
        let Some(control) = control else {
            return Ok(pending_matches);
        };
        if owner_id.is_none()
            && write_json_line_bounded(
                &control,
                &stop_command(session_id),
                Duration::from_millis(100),
            )
            .unwrap_or(false)
        {
            if let Some(status) = self.worker_statuses.lock().unwrap().get_mut(session_id) {
                status.state = PiWorkerRunState::Stopping;
            }
            return Ok(true);
        }
        if owner_id.is_none() {
            self.cleanup_control_capabilities(&control);
        }
        terminate_child(&control.child)?;
        let _startups = self.startup_reservations.lock().unwrap();
        let mut workers = self.workers.lock().unwrap();
        if workers
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &control))
        {
            workers.remove(session_id);
            self.worker_statuses.lock().unwrap().remove(session_id);
        }
        Ok(true)
    }

    pub fn stop_run(&self, run: &PiWorkerRun) -> Result<bool, String> {
        let startups = self.startup_reservations.lock().unwrap();
        let control = self.workers.lock().unwrap().get(&run.session_id).cloned();
        let Some(control) = control.filter(|control| control.owner_token == run.owner_token) else {
            drop(startups);
            return Ok(false);
        };
        self.cleanup_control_capabilities(&control);
        drop(startups);
        terminate_child(&control.child)?;
        let _startups = self.startup_reservations.lock().unwrap();
        let mut workers = self.workers.lock().unwrap();
        if workers
            .get(&run.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &control))
        {
            workers.remove(&run.session_id);
            self.worker_statuses.lock().unwrap().remove(&run.session_id);
        }
        Ok(true)
    }

    pub fn owns_run(&self, run: &PiWorkerRun) -> bool {
        self.workers
            .lock()
            .unwrap()
            .get(&run.session_id)
            .is_some_and(|control| {
                Arc::ptr_eq(control, &run.control) && control.owner_token == run.owner_token
            })
    }

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
        let mut startups = self.startup_reservations.lock().unwrap();
        let startup_cancelled = startups.by_session.len();
        let pending = std::mem::take(&mut startups.by_session);
        for (session_id, owner) in &pending {
            self.cleanup_startup_capabilities(session_id, owner);
        }
        let workers = self
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(session_id, control)| (session_id.clone(), Arc::clone(control)))
            .collect::<Vec<_>>();
        for (_, control) in &workers {
            self.cleanup_control_capabilities(control);
        }
        drop(startups);
        let mut stopped = 0;
        let mut errors = Vec::new();
        for (session_id, control) in workers {
            match terminate_child(&control.child) {
                Ok(_) => {
                    let _startups = self.startup_reservations.lock().unwrap();
                    let mut active = self.workers.lock().unwrap();
                    if active
                        .get(&session_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &control))
                    {
                        active.remove(&session_id);
                        self.worker_statuses.lock().unwrap().remove(&session_id);
                    }
                    stopped += 1;
                }
                Err(error) => errors.push(format!("{}: {}", session_id, error)),
            }
        }
        if errors.is_empty() {
            Ok(stopped + startup_cancelled)
        } else {
            Err(format!("Pi worker 批量停止失败: {}", errors.join("; ")))
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

    pub fn finish(&self, run: PiWorkerRun) {
        let startups = self.startup_reservations.lock().unwrap();
        let is_owner = self
            .workers
            .lock()
            .unwrap()
            .get(&run.session_id)
            .is_some_and(|control| {
                Arc::ptr_eq(control, &run.control) && control.owner_token == run.owner_token
            });
        if is_owner {
            self.cleanup_control_capabilities(&run.control);
        }
        drop(startups);
        if terminate_child(&run.control.child).is_err() {
            // capability 已撤销但 Worker 退出未确认时保留 active 占位，不能放行同 session 新调用。
            return;
        }
        if is_owner {
            let _startups = self.startup_reservations.lock().unwrap();
            let mut workers = self.workers.lock().unwrap();
            if workers.get(&run.session_id).is_some_and(|control| {
                Arc::ptr_eq(control, &run.control) && control.owner_token == run.owner_token
            }) {
                workers.remove(&run.session_id);
                self.worker_statuses.lock().unwrap().remove(&run.session_id);
            }
        }
    }
}

fn terminate_child(child: &Arc<Mutex<Child>>) -> Result<bool, String> {
    let mut child = child.lock().unwrap();
    if child
        .try_wait()
        .map_err(|error| format!("Pi worker 状态读取失败: {}", error))?
        .is_some()
    {
        return Ok(false);
    }
    child
        .kill()
        .map_err(|error| format!("Pi worker 终止失败: {}", error))?;
    child
        .wait()
        .map_err(|error| format!("Pi worker 退出确认失败: {}", error))?;
    Ok(true)
}

fn write_json_line_bounded(
    control: &Arc<WorkerControl>,
    value: &Value,
    timeout: Duration,
) -> Result<bool, String> {
    let control = Arc::clone(control);
    let value = value.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(write_json_line(&control, &value).map_err(|error| error.to_string()));
    });
    match receiver.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(true),
        Ok(Err(error)) => Err(error),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(false),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("Pi worker stop 写入线程退出".to_string())
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
