use chrono::{Datelike, Local, TimeZone};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const INDEX_VERSION: u64 = 2;
const MAX_HISTORY: usize = 20;
const WORKER_CAPABILITY_TTL_MS: u64 = 30 * 60 * 1000;

static WORKER_CAPABILITIES: LazyLock<Mutex<std::collections::HashMap<String, WorkerCapability>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Clone)]
struct WorkerCapability {
    token: String,
    triggered_by: String,
    expires_at: u64,
    channel_id: String,
    model_id: Option<String>,
    workspace_id: Option<String>,
    source_automation_id: Option<String>,
}

#[derive(Debug)]
pub enum AutomationError {
    Validation(String),
    NotFound,
    Storage(String),
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) | Self::Storage(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("定时任务不存在"),
        }
    }
}

impl std::error::Error for AutomationError {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreateInput {
    pub name: String,
    pub prompt: String,
    pub schedule_type: String,
    pub interval_minutes: Option<u64>,
    pub time_of_day: Option<String>,
    pub day_of_week: Option<u64>,
    pub day_of_month: Option<u64>,
    pub scheduled_at: Option<u64>,
    pub max_runs: Option<u64>,
    pub channel_id: String,
    pub model_id: Option<String>,
    pub workspace_id: Option<String>,
    pub permission_mode: Option<String>,
    pub session_mode: Option<String>,
    pub notification_targets: Option<Value>,
    pub source_session_id: Option<String>,
    pub active: Option<bool>,
    pub agent_runtime: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpdateInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule_type: Option<String>,
    pub interval_minutes: Option<u64>,
    pub time_of_day: Option<String>,
    pub day_of_week: Option<u64>,
    pub day_of_month: Option<u64>,
    pub scheduled_at: Option<u64>,
    pub max_runs: Option<u64>,
    pub channel_id: Option<String>,
    pub model_id: Option<String>,
    pub workspace_id: Option<String>,
    pub permission_mode: Option<String>,
    pub session_mode: Option<String>,
    pub notification_targets: Option<Value>,
    pub active: Option<bool>,
    pub agent_runtime: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunInput {
    pub run_at: u64,
    pub session_id: String,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub skip_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWorkerCapability {
    pub endpoint: String,
    pub token: String,
}

pub fn issue_worker_capability(session_id: &str, triggered_by: &str, channel_id: String, model_id: Option<String>, workspace_id: Option<String>, source_automation_id: Option<String>) -> AutomationWorkerCapability {
    let token = generate_id();
    WORKER_CAPABILITIES.lock().unwrap().insert(
        session_id.to_string(),
        WorkerCapability {
            token: token.clone(),
            triggered_by: triggered_by.to_string(),
            expires_at: now_millis().saturating_add(WORKER_CAPABILITY_TTL_MS),
            channel_id,
            model_id,
            workspace_id,
            source_automation_id,
        },
    );
    AutomationWorkerCapability {
        endpoint: "/api/internal/agent/automation-tool".to_string(),
        token,
    }
}

pub fn revoke_worker_capability(session_id: &str) {
    WORKER_CAPABILITIES.lock().unwrap().remove(session_id);
}

pub struct WorkerAutomationContext {
    pub triggered_by: String,
    pub channel_id: String,
    pub model_id: Option<String>,
    pub workspace_id: Option<String>,
    pub source_automation_id: Option<String>,
}

pub fn worker_automation_context(session_id: &str, token: &str) -> Result<WorkerAutomationContext, AutomationError> {
    let mut capabilities = WORKER_CAPABILITIES.lock().unwrap();
    let Some(capability) = capabilities.get(session_id).cloned() else {
        return Err(AutomationError::Validation("定时任务 capability 已失效".to_string()));
    };
    if capability.expires_at <= now_millis() {
        capabilities.remove(session_id);
        return Err(AutomationError::Validation("定时任务 capability 已过期".to_string()));
    }
    if capability.token != token {
        return Err(AutomationError::Validation("定时任务 capability 不正确".to_string()));
    }
    Ok(WorkerAutomationContext {
        triggered_by: capability.triggered_by,
        channel_id: capability.channel_id,
        model_id: capability.model_id,
        workspace_id: capability.workspace_id,
        source_automation_id: capability.source_automation_id,
    })
}

#[derive(Default)]
struct AutomationIndex {
    version: u64,
    automations: Vec<Value>,
}

pub struct AutomationStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AutomationStore {
    pub fn open(config_dir: PathBuf) -> Self {
        Self {
            path: config_dir.join("automations.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn list(&self) -> Result<Vec<Value>, AutomationError> {
        let _guard = self.lock.lock().unwrap();
        let index = self.read_index()?;
        let mut automations = index.automations;
        automations.sort_by_key(created_at);
        Ok(automations)
    }

    pub fn get(&self, id: &str) -> Result<Option<Value>, AutomationError> {
        let _guard = self.lock.lock().unwrap();
        Ok(self.read_index()?.automations.into_iter().find(|item| item_id(item) == Some(id)))
    }

    pub fn create(&self, input: AutomationCreateInput) -> Result<Value, AutomationError> {
        self.create_for_session(input, "user")
    }

    pub fn create_for_session(&self, input: AutomationCreateInput, triggered_by: &str) -> Result<Value, AutomationError> {
        if triggered_by == "automation" {
            return Err(AutomationError::Validation("当前是定时任务自动执行，禁止递归创建新的定时任务".to_string()));
        }
        validate_create(&input)?;
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        let now = now_millis();
        let active = input.active.unwrap_or(true) && runnable(&input.channel_id, input.workspace_id.as_deref());
        let interval_minutes = input.interval_minutes.unwrap_or(10);
        let max_runs = input.max_runs.filter(|value| *value > 0);
        let next_run_at = next_run_at(&input.schedule_type, interval_minutes, input.time_of_day.as_deref(), input.day_of_week, input.day_of_month, input.scheduled_at, now);
        let mut automation = json!({
            "id": generate_id(),
            "name": input.name.trim(),
            "prompt": input.prompt.trim(),
            "active": active,
            "scheduleType": input.schedule_type,
            "intervalMinutes": interval_minutes,
            "timeOfDay": input.time_of_day,
            "dayOfWeek": input.day_of_week,
            "dayOfMonth": input.day_of_month,
            "scheduledAt": input.scheduled_at,
            "maxRuns": max_runs,
            "agentRuntime": "pi",
            "channelId": input.channel_id,
            "modelId": input.model_id,
            "workspaceId": input.workspace_id,
            "permissionMode": "bypassPermissions",
            "sessionMode": input.session_mode.unwrap_or_else(|| "daily".to_string()),
            "notificationTargets": input.notification_targets,
            "sourceSessionId": input.source_session_id,
            "createdAt": now,
            "updatedAt": now,
            "nextRunAt": next_run_at,
            "runCount": 0,
            "consecutiveFailures": 0,
            "runHistory": [],
        });
        for (key, present) in [
            ("timeOfDay", input.time_of_day.is_some()),
            ("dayOfWeek", input.day_of_week.is_some()),
            ("dayOfMonth", input.day_of_month.is_some()),
            ("scheduledAt", input.scheduled_at.is_some()),
            ("maxRuns", max_runs.is_some()),
            ("modelId", input.model_id.is_some()),
            ("workspaceId", input.workspace_id.is_some()),
            ("notificationTargets", input.notification_targets.is_some()),
            ("sourceSessionId", input.source_session_id.is_some()),
        ] {
            if !present { remove_key(&mut automation, key); }
        }
        index.automations.push(automation.clone());
        self.write_index(&index)?;
        Ok(automation)
    }

    pub fn update(&self, id: &str, input: AutomationUpdateInput) -> Result<Value, AutomationError> {
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        let target = index.automations.iter_mut().find(|item| item_id(item) == Some(id)).ok_or(AutomationError::NotFound)?;
        validate_update(target, &input)?;
        let previous_max_runs = target.get("maxRuns").and_then(Value::as_u64);
        let previous_active = target.get("active").and_then(Value::as_bool).unwrap_or(false);
        let schedule_changed = input.schedule_type.as_deref() != None && input.schedule_type.as_deref() != value_string(target, "scheduleType")
            || input.interval_minutes.is_some_and(|value| Some(value) != target.get("intervalMinutes").and_then(Value::as_u64))
            || input.time_of_day.as_deref() != None && input.time_of_day.as_deref() != value_string(target, "timeOfDay")
            || input.day_of_week.is_some_and(|value| Some(value) != target.get("dayOfWeek").and_then(Value::as_u64))
            || input.day_of_month.is_some_and(|value| Some(value) != target.get("dayOfMonth").and_then(Value::as_u64))
            || input.scheduled_at.is_some_and(|value| Some(value) != target.get("scheduledAt").and_then(Value::as_u64));
        apply_update(target, input);
        if previous_max_runs != target.get("maxRuns").and_then(Value::as_u64) {
            set_number(target, "runCount", 0);
            remove_key(target, "completedAt");
        }
        if !runnable(value_string(target, "channelId").unwrap_or(""), value_string(target, "workspaceId")) {
            set_bool(target, "active", false);
        }
        let active = target.get("active").and_then(Value::as_bool) == Some(true);
        if schedule_changed || (!previous_active && active) {
            let schedule_type = value_string(target, "scheduleType").unwrap_or("interval");
            let interval = target.get("intervalMinutes").and_then(Value::as_u64).unwrap_or(10);
            let time_of_day = value_string(target, "timeOfDay");
            let day_of_week = target.get("dayOfWeek").and_then(Value::as_u64);
            let day_of_month = target.get("dayOfMonth").and_then(Value::as_u64);
            let scheduled_at = target.get("scheduledAt").and_then(Value::as_u64);
            set_number(target, "nextRunAt", next_run_at(schedule_type, interval, time_of_day, day_of_week, day_of_month, scheduled_at, now_millis()));
        }
        if !previous_active && active {
            set_number(target, "consecutiveFailures", 0);
            set_number(target, "runCount", 0);
            remove_key(target, "completedAt");
        }
        set_number(target, "updatedAt", now_millis());
        let result = target.clone();
        self.write_index(&index)?;
        Ok(result)
    }

    pub fn delete(&self, id: &str) -> Result<bool, AutomationError> {
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        let before = index.automations.len();
        index.automations.retain(|item| item_id(item) != Some(id));
        let deleted = index.automations.len() != before;
        if deleted {
            self.write_index(&index)?;
        }
        Ok(deleted)
    }

    pub fn append_run(&self, id: &str, run: AutomationRunInput) -> Result<Value, AutomationError> {
        if !matches!(run.status.as_str(), "success" | "error" | "skipped") {
            return Err(AutomationError::Validation("运行状态不正确".to_string()));
        }
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        let target = index.automations.iter_mut().find(|item| item_id(item) == Some(id)).ok_or(AutomationError::NotFound)?;
        let mut history = target.get("runHistory").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut entry = Map::new();
        entry.insert("runAt".to_string(), json!(run.run_at));
        entry.insert("sessionId".to_string(), json!(run.session_id));
        entry.insert("status".to_string(), json!(run.status));
        if let Some(duration_ms) = run.duration_ms { entry.insert("durationMs".to_string(), json!(duration_ms)); }
        if let Some(error) = run.error { entry.insert("error".to_string(), json!(error)); }
        if let Some(skip_reason) = run.skip_reason { entry.insert("skipReason".to_string(), json!(skip_reason)); }
        history.insert(0, Value::Object(entry));
        history.truncate(MAX_HISTORY);
        set_value(target, "runHistory", Value::Array(history));
        if target.get("runHistory").and_then(Value::as_array).is_some() && target.get("runHistory").is_some() {
            if run.status != "skipped" {
                let run_count = target.get("runCount").and_then(Value::as_u64).unwrap_or(0).saturating_add(1);
                set_number(target, "runCount", run_count);
                set_number(target, "lastRunAt", run.run_at);
                if run.status == "error" {
                    let failures = target.get("consecutiveFailures").and_then(Value::as_u64).unwrap_or(0).saturating_add(1);
                    set_number(target, "consecutiveFailures", failures);
                } else {
                    set_number(target, "consecutiveFailures", 0);
                }
                let complete = target.get("scheduleType").and_then(Value::as_str) == Some("once")
                    || target.get("maxRuns").and_then(Value::as_u64).map(|maximum| run_count >= maximum).unwrap_or(false);
                if complete {
                    set_bool(target, "active", false);
                    set_number(target, "completedAt", now_millis());
                } else {
                    let schedule_type = value_string(target, "scheduleType").unwrap_or("interval").to_string();
                    let interval = target.get("intervalMinutes").and_then(Value::as_u64).unwrap_or(10);
                    let time_of_day = value_string(target, "timeOfDay");
                    let day_of_week = target.get("dayOfWeek").and_then(Value::as_u64);
                    let day_of_month = target.get("dayOfMonth").and_then(Value::as_u64);
                    let scheduled_at = target.get("scheduledAt").and_then(Value::as_u64);
                    set_number(target, "nextRunAt", next_run_at(&schedule_type, interval, time_of_day, day_of_week, day_of_month, scheduled_at, run.run_at));
                }
            }
        }
        set_number(target, "updatedAt", now_millis());
        let result = target.clone();
        self.write_index(&index)?;
        Ok(result)
    }

    pub fn set_next_run_at(&self, id: &str, next_run_at: u64) -> Result<(), AutomationError> {
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        if let Some(target) = index.automations.iter_mut().find(|item| item_id(item) == Some(id)) {
            set_number(target, "nextRunAt", next_run_at);
            set_number(target, "updatedAt", now_millis());
            self.write_index(&index)?;
        }
        Ok(())
    }

    pub fn set_last_session_id(&self, id: &str, session_id: &str) -> Result<(), AutomationError> {
        let _guard = self.lock.lock().unwrap();
        let mut index = self.read_index()?;
        if let Some(target) = index.automations.iter_mut().find(|item| item_id(item) == Some(id)) {
            set_value(target, "lastSessionId", json!(session_id));
            set_number(target, "updatedAt", now_millis());
            self.write_index(&index)?;
        }
        Ok(())
    }

    fn read_index(&self) -> Result<AutomationIndex, AutomationError> {
        if !self.path.exists() {
            return Ok(AutomationIndex { version: INDEX_VERSION, automations: Vec::new() });
        }
        let raw = fs::read_to_string(&self.path).map_err(storage_error)?;
        let value: Value = serde_json::from_str(&raw).map_err(|_| AutomationError::Storage("定时任务索引不是合法 JSON".to_string()))?;
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(INDEX_VERSION);
        let mut automations = value.get("automations").and_then(Value::as_array).cloned().unwrap_or_default();
        for automation in &mut automations { migrate_legacy_fields(automation); }
        Ok(AutomationIndex { version: version.max(INDEX_VERSION), automations })
    }

    fn write_index(&self, index: &AutomationIndex) -> Result<(), AutomationError> {
        let parent = self.path.parent().ok_or_else(|| AutomationError::Storage("定时任务配置目录不正确".to_string()))?;
        fs::create_dir_all(parent).map_err(storage_error)?;
        let temporary = parent.join("automations.json.tmp");
        let payload = json!({ "version": index.version.max(INDEX_VERSION), "automations": index.automations });
        fs::write(&temporary, serde_json::to_vec_pretty(&payload).map_err(|error| AutomationError::Storage(error.to_string()))?).map_err(storage_error)?;
        fs::rename(temporary, &self.path).map_err(storage_error)
    }
}

fn validate_create(input: &AutomationCreateInput) -> Result<(), AutomationError> {
    if input.name.trim().is_empty() { return Err(AutomationError::Validation("name 必填".to_string())); }
    if input.prompt.trim().is_empty() { return Err(AutomationError::Validation("prompt 必填".to_string())); }
    validate_schedule(&input.schedule_type, input.interval_minutes.unwrap_or(10), input.time_of_day.as_deref(), input.day_of_week, input.day_of_month, input.scheduled_at)?;
    if input.agent_runtime.as_deref().is_some_and(|value| value != "pi") { return Err(AutomationError::Validation("仅支持 Pi Agent runtime".to_string())); }
    if input.permission_mode.as_deref().is_some_and(|value| value != "bypassPermissions") { return Err(AutomationError::Validation("permissionMode 不正确".to_string())); }
    if input.session_mode.as_deref().is_some_and(|value| value != "daily" && value != "reuse") { return Err(AutomationError::Validation("sessionMode 不正确".to_string())); }
    Ok(())
}

fn validate_update(target: &Value, input: &AutomationUpdateInput) -> Result<(), AutomationError> {
    if input.name.as_deref().is_some_and(|value| value.trim().is_empty()) { return Err(AutomationError::Validation("name 不能为空".to_string())); }
    if input.prompt.as_deref().is_some_and(|value| value.trim().is_empty()) { return Err(AutomationError::Validation("prompt 不能为空".to_string())); }
    if input.agent_runtime.as_deref().is_some_and(|value| value != "pi") { return Err(AutomationError::Validation("仅支持 Pi Agent runtime".to_string())); }
    if input.permission_mode.as_deref().is_some_and(|value| value != "bypassPermissions") { return Err(AutomationError::Validation("permissionMode 不正确".to_string())); }
    if input.session_mode.as_deref().is_some_and(|value| value != "daily" && value != "reuse") { return Err(AutomationError::Validation("sessionMode 不正确".to_string())); }
    let schedule_type = input.schedule_type.as_deref().unwrap_or(value_string(target, "scheduleType").unwrap_or("interval"));
    let interval = input.interval_minutes.unwrap_or_else(|| target.get("intervalMinutes").and_then(Value::as_u64).unwrap_or(10));
    let time_of_day = input.time_of_day.as_deref().or_else(|| value_string(target, "timeOfDay"));
    let day_of_week = input.day_of_week.or_else(|| target.get("dayOfWeek").and_then(Value::as_u64));
    let day_of_month = input.day_of_month.or_else(|| target.get("dayOfMonth").and_then(Value::as_u64));
    let scheduled_at = input.scheduled_at.or_else(|| target.get("scheduledAt").and_then(Value::as_u64));
    validate_schedule(schedule_type, interval, time_of_day, day_of_week, day_of_month, scheduled_at)
}

fn validate_schedule(schedule_type: &str, interval: u64, time_of_day: Option<&str>, day_of_week: Option<u64>, day_of_month: Option<u64>, scheduled_at: Option<u64>) -> Result<(), AutomationError> {
    if !matches!(schedule_type, "interval" | "daily" | "weekly" | "monthly" | "once") { return Err(AutomationError::Validation("scheduleType 不正确".to_string())); }
    if interval == 0 { return Err(AutomationError::Validation("intervalMinutes 必须大于 0".to_string())); }
    if matches!(schedule_type, "daily" | "weekly" | "monthly") && !valid_time(time_of_day) { return Err(AutomationError::Validation("scheduleType=daily/weekly/monthly 时 timeOfDay 必填".to_string())); }
    if schedule_type == "weekly" && day_of_week.filter(|value| *value <= 6).is_none() { return Err(AutomationError::Validation("scheduleType=weekly 时 dayOfWeek 必填".to_string())); }
    if schedule_type == "monthly" && day_of_month.filter(|value| (1..=31).contains(value)).is_none() { return Err(AutomationError::Validation("scheduleType=monthly 时 dayOfMonth 必填".to_string())); }
    if schedule_type == "once" && scheduled_at.filter(|value| *value > 0).is_none() { return Err(AutomationError::Validation("scheduleType=once 时 scheduledAt 必填".to_string())); }
    Ok(())
}

fn valid_time(value: Option<&str>) -> bool {
    let Some(value) = value else { return false; };
    let mut parts = value.split(':');
    let hours = parts.next().and_then(|part| part.parse::<u8>().ok());
    let minutes = parts.next().and_then(|part| part.parse::<u8>().ok());
    parts.next().is_none() && hours.is_some_and(|hour| hour < 24) && minutes.is_some_and(|minute| minute < 60)
}

fn apply_update(target: &mut Value, input: AutomationUpdateInput) {
    let object = target.as_object_mut().expect("automation 必须是对象");
    macro_rules! set_optional { ($field:literal, $value:expr) => { if let Some(value) = $value { object.insert($field.to_string(), json!(value)); } }; }
    set_optional!("name", input.name.map(|value| value.trim().to_string()));
    set_optional!("prompt", input.prompt.map(|value| value.trim().to_string()));
    set_optional!("scheduleType", input.schedule_type);
    set_optional!("intervalMinutes", input.interval_minutes);
    set_optional!("timeOfDay", input.time_of_day);
    set_optional!("dayOfWeek", input.day_of_week);
    set_optional!("dayOfMonth", input.day_of_month);
    set_optional!("scheduledAt", input.scheduled_at);
    if let Some(max_runs) = input.max_runs {
        if max_runs == 0 { object.remove("maxRuns"); } else { object.insert("maxRuns".to_string(), json!(max_runs)); }
    }
    set_optional!("channelId", input.channel_id);
    set_optional!("modelId", input.model_id);
    set_optional!("workspaceId", input.workspace_id);
    set_optional!("permissionMode", input.permission_mode);
    set_optional!("sessionMode", input.session_mode);
    set_optional!("notificationTargets", input.notification_targets);
    set_optional!("active", input.active);
    object.insert("agentRuntime".to_string(), json!("pi"));
}

fn migrate_legacy_fields(automation: &mut Value) {
    let Some(object) = automation.as_object_mut() else { return; };
    object.insert("agentRuntime".to_string(), json!("pi"));
    if object.get("sessionMode").and_then(Value::as_str) == Some("new") { object.insert("sessionMode".to_string(), json!("daily")); }
    if object.get("permissionMode").and_then(Value::as_str).is_some_and(|value| value != "bypassPermissions") { object.insert("permissionMode".to_string(), json!("bypassPermissions")); }
    object.entry("runHistory".to_string()).or_insert_with(|| json!([]));
    object.entry("runCount".to_string()).or_insert_with(|| json!(0));
    object.entry("consecutiveFailures".to_string()).or_insert_with(|| json!(0));
}

fn next_run_at(schedule_type: &str, interval_minutes: u64, time_of_day: Option<&str>, day_of_week: Option<u64>, day_of_month: Option<u64>, scheduled_at: Option<u64>, from: u64) -> u64 {
    if schedule_type == "once" { return scheduled_at.unwrap_or(from.saturating_add(600_000)); }
    if schedule_type == "interval" { return from.saturating_add(interval_minutes.max(1).saturating_mul(60_000)); }
    let (hours, minutes) = parse_time_of_day(time_of_day).unwrap_or((9, 0));
    let Some(mut next) = Local.timestamp_millis_opt(from as i64).single() else { return from.saturating_add(600_000); };
    let mut year = next.year();
    let mut month = next.month();
    let mut day = next.day();
    if schedule_type == "monthly" {
        let target_day = day_of_month.unwrap_or(1).clamp(1, 31) as u32;
        day = target_day.min(days_in_month(year, month));
    }
    next = local_datetime(year, month, day, hours, minutes).unwrap_or(next);
    if schedule_type == "daily" {
        if next.timestamp_millis() <= from as i64 { next += chrono::Duration::days(1); }
    } else if schedule_type == "weekly" {
        let target = day_of_week.unwrap_or(1).min(6) as i64;
        let mut difference = (target - next.weekday().num_days_from_sunday() as i64 + 7) % 7;
        if difference == 0 && next.timestamp_millis() <= from as i64 { difference = 7; }
        next += chrono::Duration::days(difference);
    } else if schedule_type == "monthly" && next.timestamp_millis() <= from as i64 {
        if month == 12 { year += 1; month = 1; } else { month += 1; }
        let target_day = day_of_month.unwrap_or(1).clamp(1, 31) as u32;
        next = local_datetime(year, month, target_day.min(days_in_month(year, month)), hours, minutes).unwrap_or(next + chrono::Duration::days(31));
    }
    next.timestamp_millis().max(1) as u64
}

fn parse_time_of_day(value: Option<&str>) -> Option<(u32, u32)> {
    let value = value?;
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<u32>().ok()?;
    let minutes = parts.next()?.parse::<u32>().ok()?;
    (parts.next().is_none() && hours < 24 && minutes < 60).then_some((hours, minutes))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next_month = if month == 12 { Local.with_ymd_and_hms(year + 1, 1, 1, 0, 0, 0) } else { Local.with_ymd_and_hms(year, month + 1, 1, 0, 0, 0) };
    next_month.single().map(|value| (value - chrono::Duration::days(1)).day()).unwrap_or(28)
}

fn local_datetime(year: i32, month: u32, day: u32, hours: u32, minutes: u32) -> Option<chrono::DateTime<Local>> {
    Local.with_ymd_and_hms(year, month, day, hours, minutes, 0).earliest()
}

fn runnable(channel_id: &str, workspace_id: Option<&str>) -> bool { !channel_id.trim().is_empty() && workspace_id.is_some_and(|value| !value.trim().is_empty()) }
fn item_id(value: &Value) -> Option<&str> { value.get("id").and_then(Value::as_str) }
fn created_at(value: &Value) -> u64 { value.get("createdAt").and_then(Value::as_u64).unwrap_or(0) }
fn value_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> { value.get(key).and_then(Value::as_str) }
fn set_value(value: &mut Value, key: &str, next: Value) { if let Some(object) = value.as_object_mut() { object.insert(key.to_string(), next); } }
fn set_number(value: &mut Value, key: &str, number: u64) { set_value(value, key, json!(number)); }
fn set_bool(value: &mut Value, key: &str, state: bool) { set_value(value, key, json!(state)); }
fn remove_key(value: &mut Value, key: &str) { if let Some(object) = value.as_object_mut() { object.remove(key); } }
fn now_millis() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn storage_error(error: std::io::Error) -> AutomationError { AutomationError::Storage(format!("定时任务存储失败: {}", error)) }

fn generate_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom(&mut bytes).is_err() { bytes[..8].copy_from_slice(&now_millis().to_le_bytes()); }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
}
