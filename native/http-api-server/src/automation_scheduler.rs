use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::automation::{AutomationError, AutomationRunInput, AutomationStore};
use crate::pi_rpc::{parse_worker_frame, PiWorkerManager};
use crate::{
    ensure_internal_success, ensure_internal_success_with_body, finalize_worker_run,
    persist_worker_event, persist_worker_frame, send_internal_request, Bridge,
};

const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// 定时任务的运行入口只在 Rust 进程内决定 Worker 生命周期。Electron 仅经业务桥提供
/// 会话配置、事件分发与通知，不拥有调度计时器或 Pi Worker 控制权。
pub struct AutomationScheduler {
    store: Arc<AutomationStore>,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
    running: Mutex<HashSet<String>>,
}

impl AutomationScheduler {
    pub fn new(
        store: Arc<AutomationStore>,
        bridge: Arc<Bridge>,
        workers: Arc<PiWorkerManager>,
    ) -> Self {
        Self {
            store,
            bridge,
            workers,
            running: Mutex::new(HashSet::new()),
        }
    }

    pub fn start(self: &Arc<Self>) {
        if let Err(error) = self.store.defer_overdue_recurring(now_millis()) {
            eprintln!("[定时任务] Rust 恢复过期任务失败: {}", error);
        }
        let scheduler = Arc::clone(self);
        thread::spawn(move || loop {
            scheduler.tick_once();
            thread::sleep(TICK_INTERVAL);
        });
    }

    pub fn tick_once(self: &Arc<Self>) {
        let now = now_millis();
        let automations = match self.store.due_automations(now) {
            Ok(automations) => automations,
            Err(error) => {
                eprintln!("[定时任务] Rust 扫描到期任务失败: {}", error);
                return;
            }
        };
        for automation in automations {
            let _ = self.start_automation(automation, now);
        }
    }

    pub fn run_now(self: &Arc<Self>, id: &str) -> Result<bool, AutomationError> {
        let automation = self.store.get(id)?.ok_or(AutomationError::NotFound)?;
        if !is_runnable(&automation) {
            return Err(AutomationError::Validation(
                "请先为该任务配置模型与项目".to_string(),
            ));
        }
        self.start_automation(automation, now_millis())
    }

    pub(crate) fn try_reserve(&self, id: &str) -> bool {
        self.running.lock().unwrap().insert(id.to_string())
    }

    pub(crate) fn release(&self, id: &str) {
        self.running.lock().unwrap().remove(id);
    }

    fn start_automation(
        self: &Arc<Self>,
        automation: Value,
        run_at: u64,
    ) -> Result<bool, AutomationError> {
        let id = automation
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AutomationError::Validation("定时任务 id 不正确".to_string()))?
            .to_string();
        if !is_runnable(&automation) {
            return Ok(false);
        }
        if !self.try_reserve(&id) {
            return Ok(false);
        }
        if automation
            .get("sourceSessionId")
            .and_then(Value::as_str)
            .is_some_and(|session_id| self.workers.is_active(session_id))
        {
            self.finish_skipped(&automation, run_at, "来源会话正在运行");
            self.release(&id);
            return Ok(false);
        }
        let scheduler = Arc::clone(self);
        thread::spawn(move || {
            scheduler.execute(automation, run_at);
            scheduler.release(&id);
        });
        Ok(true)
    }

    fn execute(&self, automation: Value, run_at: u64) {
        let automation_id = automation
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let prepared = self.prepare_run(&automation, run_at);
        let (session_id, config) = match prepared {
            Ok(value) => value,
            Err(error) => {
                self.finish_error(&automation, run_at, "", error);
                return;
            }
        };
        if self.workers.is_active(&session_id) {
            self.finish_skipped(&automation, run_at, "目标会话正在运行");
            return;
        }
        if let Err(error) = self.store.set_last_session_id(automation_id, &session_id) {
            self.finish_error(&automation, run_at, &session_id, error.to_string());
            return;
        }

        let mut worker = match self.workers.start(&session_id, config) {
            Ok(worker) => worker,
            Err(error) => {
                self.finish_error(&automation, run_at, &session_id, error);
                return;
            }
        };
        let mut completed = false;
        let mut failure: Option<String> = None;
        let mut line = String::new();
        loop {
            line.clear();
            let read = match worker.read_line(&mut line) {
                Ok(read) => read,
                Err(error) => {
                    failure = Some(format!("读取 Pi worker 输出失败: {}", error));
                    break;
                }
            };
            if read == 0 {
                break;
            }
            let Some(frame) = parse_worker_frame(line.trim_end_matches(['\r', '\n'])) else {
                continue;
            };
            match frame.get("type").and_then(Value::as_str) {
                Some("event") => {
                    if let Err(error) = persist_worker_event(&self.bridge, &frame) {
                        eprintln!("[定时任务] Agent SDK 消息持久化失败: {}", error);
                    }
                    self.forward_event(&frame);
                }
                Some("meta") => {
                    if let Err(error) =
                        persist_worker_frame(&self.bridge, "/api/internal/agent/meta", &frame)
                    {
                        eprintln!("[定时任务] Agent 会话元数据持久化失败: {}", error);
                    }
                }
                Some("credential") => {
                    if let Err(error) =
                        persist_worker_frame(&self.bridge, "/api/internal/agent/credential", &frame)
                    {
                        eprintln!("[定时任务] Agent OAuth 凭据持久化失败: {}", error);
                    }
                }
                Some("complete") => {
                    if let Err(error) = finalize_worker_run(&self.bridge, &frame) {
                        eprintln!("[定时任务] Agent 完成状态持久化失败: {}", error);
                    }
                    if let Some(errors) = frame.get("resultErrors").and_then(Value::as_array) {
                        let messages = errors.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                        if !messages.is_empty() {
                            failure = Some(messages.join("；"));
                        }
                    }
                    completed = true;
                    break;
                }
                Some("error") | Some("fatal") => {
                    failure = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| Some("Pi worker 执行失败".to_string()));
                    self.forward_event(&frame);
                }
                _ => {}
            }
        }
        self.workers.finish(worker);
        if completed && failure.is_none() {
            self.finish_run(&automation, run_at, &session_id, "success", None, None);
        } else {
            self.finish_error(
                &automation,
                run_at,
                &session_id,
                failure.unwrap_or_else(|| "Pi worker 已提前退出".to_string()),
            );
        }
    }

    fn prepare_run(&self, automation: &Value, run_at: u64) -> Result<(String, Value), String> {
        let body = serde_json::to_vec(&json!({ "automation": automation, "runAt": run_at }))
            .map_err(|error| format!("定时任务准备请求序列化失败: {}", error))?;
        let response =
            send_internal_request(&self.bridge, "/api/internal/automation/prepare-run", body)?;
        let body = ensure_internal_success_with_body(response)?
            .ok_or_else(|| "Electron 未返回定时任务 Pi 配置".to_string())?;
        let value = serde_json::from_str::<Value>(&body)
            .map_err(|_| "Electron 定时任务 Pi 配置不正确".to_string())?;
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Electron 定时任务缺少会话 ID".to_string())?
            .to_string();
        let config = value
            .get("config")
            .cloned()
            .filter(Value::is_object)
            .ok_or_else(|| "Electron 定时任务缺少 Pi 配置".to_string())?;
        Ok((session_id, config))
    }

    fn finish_skipped(&self, automation: &Value, run_at: u64, reason: &str) {
        self.finish_run(
            automation,
            run_at,
            "",
            "skipped",
            None,
            Some(reason.to_string()),
        );
    }

    fn finish_error(&self, automation: &Value, run_at: u64, session_id: &str, error: String) {
        self.finish_run(automation, run_at, session_id, "error", Some(error), None);
    }

    fn finish_run(
        &self,
        automation: &Value,
        run_at: u64,
        session_id: &str,
        status: &str,
        error: Option<String>,
        skip_reason: Option<String>,
    ) {
        let Some(id) = automation.get("id").and_then(Value::as_str) else {
            return;
        };
        let run = AutomationRunInput {
            run_at,
            session_id: session_id.to_string(),
            status: status.to_string(),
            duration_ms: Some(now_millis().saturating_sub(run_at)),
            error,
            skip_reason,
        };
        let updated = match self.store.append_run(id, run) {
            Ok(updated) => updated,
            Err(error) => {
                eprintln!("[定时任务] Rust 写入运行结果失败: {}", error);
                return;
            }
        };
        let run = updated
            .get("runHistory")
            .and_then(Value::as_array)
            .and_then(|history| history.first())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let _ = serde_json::to_vec(&json!({ "automation": updated, "run": run }))
            .map_err(|error| error.to_string())
            .and_then(|body| {
                send_internal_request(&self.bridge, "/api/internal/automation/run-finished", body)
            })
            .and_then(ensure_internal_success)
            .map_err(|error| eprintln!("[定时任务] Electron 通知运行结果失败: {}", error));
    }

    fn forward_event(&self, frame: &Value) {
        let _ = serde_json::to_vec(frame)
            .map_err(|error| error.to_string())
            .and_then(|body| {
                send_internal_request(&self.bridge, "/api/internal/automation/event", body)
            })
            .and_then(ensure_internal_success)
            .map_err(|error| eprintln!("[定时任务] Electron 转发运行事件失败: {}", error));
    }
}

fn is_runnable(automation: &Value) -> bool {
    automation
        .get("channelId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && automation
            .get("workspaceId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
