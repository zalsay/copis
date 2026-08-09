use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use getrandom::getrandom;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 120_000;
const MAX_COMMAND_TIMEOUT_MS: u64 = 600_000;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub struct AgentFileError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl AgentFileError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "invalid_request",
            message: message.into(),
        }
    }

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 403,
            code,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            code: "file_not_found",
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: 409,
            code: "write_conflict",
            message: message.into(),
        }
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self {
            status: 413,
            code: "file_too_large",
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "file_operation_failed",
            message: message.into(),
        }
    }
}

pub fn is_supported_permission_mode(permission_mode: &str) -> bool {
    matches!(permission_mode, "bypassPermissions" | "plan")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileAccessPolicy {
    read_roots: Vec<PathBuf>,
    read_files: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
    base_dir: PathBuf,
    permission_mode: String,
    worker_token: String,
}

#[derive(Default)]
pub struct AgentFilePolicyStore {
    policies: Mutex<HashMap<String, FileAccessPolicy>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRequest {
    session_id: String,
    path: String,
    mode: Option<String>,
    content: Option<String>,
    expected_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellRequest {
    session_id: String,
    command: String,
    cwd: String,
    timeout_ms: Option<u64>,
}

struct CapturedCommandOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

impl AgentFilePolicyStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从 Electron 的 prepare 配置中取走策略。取走后，传给 Pi Worker 的 JSON 中不再含有策略。
    pub fn register_from_query(
        &self,
        session_id: &str,
        query: &mut Map<String, Value>,
    ) -> Result<String, String> {
        let use_rust_file_api = match query.get("useRustFileApi") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| "useRustFileApi 必须是布尔值".to_string())?,
        };
        let Some(value) = query.remove("fileAccessPolicy") else {
            if use_rust_file_api {
                return Err("Rust 文件 API 缺少会话权限策略".to_string());
            }
            return Ok(String::new());
        };
        if !use_rust_file_api {
            return Err("Rust 文件权限策略未启用 Rust 文件 API".to_string());
        }
        let mut policy = FileAccessPolicy::from_value(&value, query.get("cwd"))
            .map_err(|error| error.message)?;
        let worker_token = generate_worker_token()?;
        policy.worker_token = worker_token.clone();
        let mut policies = self.policies.lock().unwrap();
        if policies.contains_key(session_id) {
            return Err("该 Agent 会话已有文件权限策略".to_string());
        }
        policies.insert(session_id.to_string(), policy);
        Ok(worker_token)
    }

    pub fn remove(&self, session_id: &str) {
        self.policies.lock().unwrap().remove(session_id);
    }

    #[cfg(test)]
    pub fn contains(&self, session_id: &str) -> bool {
        self.policies.lock().unwrap().contains_key(session_id)
    }

    pub fn permission_mode(&self, session_id: &str) -> Option<String> {
        self.policies
            .lock()
            .unwrap()
            .get(session_id)
            .map(|policy| policy.permission_mode.clone())
    }

    pub fn update_permission_mode(
        &self,
        session_id: &str,
        permission_mode: &str,
    ) -> Result<(), AgentFileError> {
        if !is_supported_permission_mode(permission_mode) {
            return Err(AgentFileError::bad_request("权限模式不正确"));
        }
        let mut policies = self.policies.lock().unwrap();
        let policy = policies.get_mut(session_id).ok_or_else(|| {
            AgentFileError::forbidden("agent_policy_not_found", "Agent 文件权限策略不存在")
        })?;
        policy.permission_mode = permission_mode.to_string();
        Ok(())
    }

    pub fn handle_with_worker_token(
        &self,
        action: &str,
        method: &str,
        worker_token: &str,
        body: &[u8],
    ) -> Result<Option<Value>, AgentFileError> {
        let request: FileRequest = serde_json::from_slice(body)
            .map_err(|_| AgentFileError::bad_request("文件请求体不是有效的 JSON"))?;
        if request.session_id.trim().is_empty() {
            return Err(AgentFileError::bad_request("文件请求缺少 sessionId"));
        }
        self.ensure_worker_token(&request.session_id, worker_token)?;
        self.handle(action, method, body)
    }

    /// Bash 命令由 Rust 执行，Pi Worker 只有当前会话的能力令牌，不能获取授权目录。
    pub fn handle_shell_with_worker_token(
        &self,
        worker_token: &str,
        body: &[u8],
    ) -> Result<Value, AgentFileError> {
        let request: ShellRequest = serde_json::from_slice(body)
            .map_err(|_| AgentFileError::bad_request("命令请求体不是有效的 JSON"))?;
        if request.session_id.trim().is_empty()
            || request.command.trim().is_empty()
            || request.cwd.trim().is_empty()
        {
            return Err(AgentFileError::bad_request(
                "命令请求缺少 sessionId、command 或 cwd",
            ));
        }
        self.ensure_worker_token(&request.session_id, worker_token)?;
        let policy = self
            .policies
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| {
                AgentFileError::forbidden("agent_policy_not_found", "Agent 文件权限策略不存在")
            })?;
        policy.execute_project_command(&request)
    }

    fn ensure_worker_token(
        &self,
        session_id: &str,
        worker_token: &str,
    ) -> Result<(), AgentFileError> {
        let policies = self.policies.lock().unwrap();
        let policy = policies.get(session_id).ok_or_else(|| {
            AgentFileError::forbidden("agent_policy_not_found", "Agent 文件权限策略不存在")
        })?;
        if tokens_equal(&policy.worker_token, worker_token) {
            Ok(())
        } else {
            Err(AgentFileError::forbidden(
                "agent_file_token_invalid",
                "Agent 文件能力令牌无效",
            ))
        }
    }

    pub fn handle(
        &self,
        action: &str,
        method: &str,
        body: &[u8],
    ) -> Result<Option<Value>, AgentFileError> {
        let request: FileRequest = serde_json::from_slice(body)
            .map_err(|_| AgentFileError::bad_request("文件请求体不是有效的 JSON"))?;
        if request.session_id.trim().is_empty() || request.path.trim().is_empty() {
            return Err(AgentFileError::bad_request(
                "文件请求缺少 sessionId 或 path",
            ));
        }
        let value: Value = serde_json::from_slice(body)
            .map_err(|_| AgentFileError::bad_request("文件请求体不是有效的 JSON"))?;
        if let Some(object) = value.as_object() {
            if ["readRoots", "readFiles", "writeRoots"]
                .iter()
                .any(|key| object.contains_key(*key))
            {
                return Err(AgentFileError::bad_request("客户端不能提交文件权限根目录"));
            }
        }
        let policy = self
            .policies
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| {
                AgentFileError::forbidden("agent_policy_not_found", "Agent 文件权限策略不存在")
            })?;

        match (action, method.to_ascii_uppercase().as_str()) {
            ("access", "POST") => {
                let mode = request.mode.as_deref().unwrap_or("read");
                let target =
                    policy.resolve(&request.path, mode == "write" || mode == "readWrite")?;
                match mode {
                    "read" => policy.ensure_read(&target)?,
                    "write" => policy.ensure_write(&target)?,
                    "readWrite" => {
                        policy.ensure_read(&target)?;
                        policy.ensure_write(&target)?;
                    }
                    _ => return Err(AgentFileError::bad_request("文件访问 mode 不正确")),
                }
                Ok(Some(json!({ "allowed": true })))
            }
            ("read", "POST") => {
                let target = policy.resolve(&request.path, false)?;
                policy.ensure_read(&target)?;
                let metadata = fs::metadata(&target).map_err(io_error)?;
                if !metadata.is_file() {
                    return Err(AgentFileError::forbidden("not_a_file", "目标不是文件"));
                }
                let content = read_limited(&target, metadata.len())?;
                let revision = revision_for_bytes(&content);
                Ok(Some(json!({
                    "contentBase64": encode_base64(&content),
                    "revision": revision,
                })))
            }
            ("write", "PUT") => {
                let content = request
                    .content
                    .ok_or_else(|| AgentFileError::bad_request("文件写入缺少 content"))?;
                if content.len() as u64 > MAX_FILE_BYTES {
                    return Err(AgentFileError::too_large("文件写入不能超过 50 MB"));
                }
                let target = policy.resolve(&request.path, true)?;
                policy.ensure_write(&target)?;
                let current = match fs::symlink_metadata(&target) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() {
                            return Err(AgentFileError::forbidden(
                                "symlink_not_allowed",
                                "不允许通过符号链接写入文件",
                            ));
                        }
                        if metadata.is_dir() {
                            return Err(AgentFileError::forbidden("not_a_file", "目标是目录"));
                        }
                        Some(fs::read(&target).map_err(io_error)?)
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(io_error(error)),
                };
                if let Some(expected) = request.expected_revision.as_deref() {
                    let actual = current.as_deref().map(revision_for_bytes);
                    if actual.as_deref() != Some(expected) {
                        return Err(AgentFileError::conflict("文件已被其他操作修改"));
                    }
                }
                let parent = target
                    .parent()
                    .ok_or_else(|| AgentFileError::bad_request("文件路径没有父目录"))?;
                fs::create_dir_all(parent).map_err(io_error)?;
                let verified_target = policy.resolve(&request.path, true)?;
                if verified_target != target {
                    return Err(AgentFileError::forbidden(
                        "symlink_not_allowed",
                        "文件路径包含符号链接",
                    ));
                }
                atomic_write(&target, content.as_bytes())?;
                Ok(Some(
                    json!({ "revision": revision_for_bytes(content.as_bytes()) }),
                ))
            }
            ("stat", "POST") => {
                let target = policy.resolve(&request.path, false)?;
                policy.ensure_read(&target)?;
                let metadata = fs::metadata(&target).map_err(io_error)?;
                Ok(Some(json!({ "isDirectory": metadata.is_dir() })))
            }
            ("list", "POST") => {
                let target = policy.resolve(&request.path, false)?;
                policy.ensure_read(&target)?;
                let metadata = fs::metadata(&target).map_err(io_error)?;
                if !metadata.is_dir() {
                    return Err(AgentFileError::forbidden("not_a_directory", "目标不是目录"));
                }
                let mut entries = fs::read_dir(&target)
                    .map_err(io_error)?
                    .map(|entry| {
                        entry
                            .map(|entry| entry.file_name().to_string_lossy().into_owned())
                            .map_err(io_error)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                entries.sort();
                Ok(Some(json!({ "entries": entries })))
            }
            _ => Err(AgentFileError {
                status: 404,
                code: "route_not_found",
                message: "文件权限接口不存在".to_string(),
            }),
        }
    }
}

impl FileAccessPolicy {
    fn execute_project_command(&self, request: &ShellRequest) -> Result<Value, AgentFileError> {
        if self.permission_mode == "plan" {
            return Err(AgentFileError::forbidden(
                "plan_command_not_allowed",
                "计划模式下不能执行项目命令",
            ));
        }
        validate_project_command(&request.command)?;
        let cwd = self.resolve(&request.cwd, false)?;
        self.ensure_read(&cwd)?;
        self.ensure_write(&cwd)?;
        if !fs::metadata(&cwd).map_err(io_error)?.is_dir() {
            return Err(AgentFileError::forbidden(
                "not_a_directory",
                "命令工作目录不是目录",
            ));
        }
        let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS);
        if timeout_ms == 0 || timeout_ms > MAX_COMMAND_TIMEOUT_MS {
            return Err(AgentFileError::bad_request(
                "命令 timeoutMs 必须在 1 到 600000 之间",
            ));
        }
        run_project_command(&request.command, &cwd, Duration::from_millis(timeout_ms))
    }

    fn from_value(value: &Value, cwd: Option<&Value>) -> Result<Self, AgentFileError> {
        let object = value
            .as_object()
            .ok_or_else(|| AgentFileError::bad_request("fileAccessPolicy 必须是对象"))?;
        let permission_mode = object
            .get("permissionMode")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentFileError::bad_request("fileAccessPolicy.permissionMode 不正确"))?;
        if !is_supported_permission_mode(permission_mode) {
            return Err(AgentFileError::bad_request(
                "fileAccessPolicy.permissionMode 不正确",
            ));
        }
        let base_dir = cwd
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let base_dir = absolute_without_parent(&base_dir, None)?;
        Ok(Self {
            read_roots: parse_roots(object, "readRoots", &base_dir, true)?,
            read_files: parse_roots(object, "readFiles", &base_dir, false)?,
            write_roots: parse_roots(object, "writeRoots", &base_dir, true)?,
            base_dir,
            permission_mode: permission_mode.to_string(),
            worker_token: String::new(),
        })
    }

    fn resolve(&self, input: &str, allow_missing: bool) -> Result<PathBuf, AgentFileError> {
        let path = absolute_without_parent(Path::new(input), Some(&self.base_dir))?;
        if fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(AgentFileError::forbidden(
                "symlink_not_allowed",
                "文件路径包含符号链接",
            ));
        }
        if has_symlink_component_below_roots(&path, self) {
            return Err(AgentFileError::forbidden(
                "symlink_not_allowed",
                "文件路径包含符号链接",
            ));
        }
        if !allow_missing && fs::symlink_metadata(&path).is_err() {
            return Err(AgentFileError::not_found("文件不存在"));
        }
        if fs::symlink_metadata(&path).is_ok() {
            return fs::canonicalize(&path).map_err(io_error);
        }
        let mut existing = path.clone();
        let mut missing = Vec::new();
        while fs::symlink_metadata(&existing).is_err() {
            let name = existing
                .file_name()
                .ok_or_else(|| AgentFileError::not_found("文件路径不存在"))?
                .to_os_string();
            missing.push(name);
            existing.pop();
        }
        let canonical = fs::canonicalize(&existing).map_err(io_error)?;
        let mut result = canonical;
        for name in missing.iter().rev() {
            result.push(name);
        }
        Ok(result)
    }

    fn ensure_read(&self, target: &Path) -> Result<(), AgentFileError> {
        if self
            .read_roots
            .iter()
            .any(|root| target == root || target.starts_with(root))
            || self.read_files.iter().any(|file| target == file)
        {
            Ok(())
        } else {
            Err(AgentFileError::forbidden(
                "read_not_allowed",
                "当前工作区不允许读取该路径",
            ))
        }
    }

    fn ensure_write(&self, target: &Path) -> Result<(), AgentFileError> {
        if self.permission_mode == "plan"
            && target.extension().and_then(|extension| extension.to_str()) != Some("md")
        {
            return Err(AgentFileError::forbidden(
                "plan_write_not_allowed",
                "计划模式下只能写入 Markdown 计划文档",
            ));
        }
        if self
            .write_roots
            .iter()
            .any(|root| target == root || target.starts_with(root))
        {
            Ok(())
        } else {
            Err(AgentFileError::forbidden(
                "write_not_allowed",
                "当前工作区不允许写入该路径",
            ))
        }
    }
}

/// 仅开放项目依赖、构建与本地开发所需的包管理命令；通用 Shell 语法会绕过路径策略。
fn validate_project_command(command: &str) -> Result<(), AgentFileError> {
    let command = command.trim();
    if command.is_empty() || command.len() > 16 * 1024 {
        return Err(AgentFileError::bad_request(
            "项目命令不能为空且不能超过 16 KB",
        ));
    }
    if command.contains([';', '|', '&', '>', '<', '\n', '\r', '`']) || command.contains("$(") {
        return Err(AgentFileError::forbidden(
            "command_syntax_not_allowed",
            "项目命令不允许使用重定向、管道或串联语法",
        ));
    }
    let arguments = command.split_whitespace().collect::<Vec<_>>();
    let Some(executable) = arguments.first() else {
        return Err(AgentFileError::bad_request("项目命令不能为空"));
    };
    if arguments.iter().skip(1).any(|argument| {
        matches!(
            *argument,
            "-g" | "--global" | "--prefix" | "--cache" | "--userconfig" | "--target" | "--user"
        ) || argument.starts_with("--prefix=")
            || argument.starts_with("--cache=")
            || argument.starts_with("--userconfig=")
            || argument.starts_with("--target=")
    }) {
        return Err(AgentFileError::forbidden(
            "command_scope_not_allowed",
            "项目命令不能修改全局环境或指定工作区外的目录",
        ));
    }
    let operation = arguments.get(1).copied().unwrap_or_default();
    let allowed = match *executable {
        "npm" => matches!(
            operation,
            "install" | "ci" | "run" | "test" | "exec" | "create"
        ),
        "pnpm" => matches!(operation, "install" | "run" | "test" | "exec" | "create"),
        "yarn" => matches!(operation, "install" | "run" | "test" | "create"),
        "bun" => matches!(operation, "install" | "run" | "test" | "x" | "create"),
        "npx" => matches!(operation, "vite" | "create-vite" | "create-vite@latest"),
        "python" | "python3" => operation == "-m",
        "pip" | "pip3" => operation == "install",
        "uv" => matches!(operation, "sync" | "run" | "pip"),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(AgentFileError::forbidden(
            "command_not_allowed",
            "仅支持工作区内的依赖安装、构建、测试和本地开发命令",
        ))
    }
}

fn run_project_command(
    command: &str,
    cwd: &Path,
    timeout: Duration,
) -> Result<Value, AgentFileError> {
    let mut process = if cfg!(windows) {
        let mut command_process = Command::new("cmd");
        command_process.args(["/C", command]);
        command_process
    } else {
        let mut command_process = Command::new("/bin/sh");
        command_process.args(["-lc", command]);
        command_process
    };
    process
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_project_command_environment(&mut process);
    let mut child = process
        .spawn()
        .map_err(|error| AgentFileError::internal(format!("无法启动项目命令: {}", error)))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentFileError::internal("项目命令标准输出不可用"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentFileError::internal("项目命令错误输出不可用"))?;
    let stdout_reader = thread::spawn(move || read_command_output(stdout));
    let stderr_reader = thread::spawn(move || read_command_output(stderr));
    let started_at = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(io_error)? {
            Some(status) => break status,
            None if started_at.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().map_err(io_error)?;
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| AgentFileError::internal("读取项目命令标准输出失败"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| AgentFileError::internal("读取项目命令错误输出失败"))?;
    let mut output = String::from_utf8_lossy(&stdout.bytes).into_owned();
    if !stderr.bytes.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&String::from_utf8_lossy(&stderr.bytes));
    }
    Ok(json!({
        "output": output,
        "outputTruncated": stdout.truncated || stderr.truncated,
        "exitCode": if timed_out { Value::Null } else { status.code().map_or(Value::Null, Value::from) },
        "timedOut": timed_out,
    }))
}

fn read_command_output<R: Read>(mut reader: R) -> CapturedCommandOutput {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(bytes.len());
                if read > remaining {
                    bytes.extend_from_slice(&buffer[..remaining]);
                    truncated = true;
                } else {
                    bytes.extend_from_slice(&buffer[..read]);
                }
            }
        }
    }
    CapturedCommandOutput { bytes, truncated }
}

fn configure_project_command_environment(command: &mut Command) {
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }

    // 项目命令必须优先使用 Copis 管理的 Node.js/npm，不能依赖用户的系统 PATH。
    command.env("PATH", crate::runtime::resolve_runtime().path_value());
}

fn generate_worker_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom(&mut bytes).map_err(|error| format!("无法生成 Agent 文件能力令牌: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn tokens_equal(expected: &str, actual: &str) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    expected
        .bytes()
        .zip(actual.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn parse_roots(
    object: &Map<String, Value>,
    key: &str,
    base_dir: &Path,
    must_be_directory: bool,
) -> Result<Vec<PathBuf>, AgentFileError> {
    let values = object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AgentFileError::bad_request(format!("fileAccessPolicy.{key} 必须是数组")))?;
    values
        .iter()
        .map(|value| {
            let path = value
                .as_str()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| {
                    AgentFileError::bad_request(format!("fileAccessPolicy.{key} 包含无效路径"))
                })?;
            let path = absolute_without_parent(Path::new(path), Some(base_dir))?;
            let canonical = fs::canonicalize(&path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    AgentFileError::bad_request("权限策略路径不存在")
                } else {
                    io_error(error)
                }
            })?;
            if must_be_directory && !fs::metadata(&canonical).map_err(io_error)?.is_dir() {
                return Err(AgentFileError::bad_request("权限策略根目录不是目录"));
            }
            Ok(canonical)
        })
        .collect()
}

fn absolute_without_parent(
    path: &Path,
    base_dir: Option<&Path>,
) -> Result<PathBuf, AgentFileError> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.unwrap_or(Path::new(".")).join(path)
    };
    let mut result = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AgentFileError::forbidden(
                    "path_traversal",
                    "文件路径不能包含 ..",
                ))
            }
            _ => result.push(component.as_os_str()),
        }
    }
    if result.is_absolute() {
        Ok(result)
    } else {
        Err(AgentFileError::bad_request("文件路径必须是绝对路径"))
    }
}

fn has_symlink_component_below_roots(path: &Path, policy: &FileAccessPolicy) -> bool {
    let mut current = PathBuf::new();
    let mut below_authorized_root = false;
    for component in path.components() {
        current.push(component.as_os_str());
        if !below_authorized_root {
            below_authorized_root = policy
                .read_roots
                .iter()
                .chain(policy.write_roots.iter())
                .any(|root| fs::canonicalize(&current).ok().as_deref() == Some(root.as_path()));
            continue;
        }
        if fs::symlink_metadata(&current)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn read_limited(path: &Path, size: u64) -> Result<Vec<u8>, AgentFileError> {
    if size > MAX_FILE_BYTES {
        return Err(AgentFileError::too_large("文件读取不能超过 50 MB"));
    }
    let mut file = File::open(path).map_err(io_error)?;
    let mut content = Vec::with_capacity(size as usize);
    file.read_to_end(&mut content).map_err(io_error)?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(AgentFileError::too_large("文件读取不能超过 50 MB"));
    }
    Ok(content)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), AgentFileError> {
    let parent = path
        .parent()
        .ok_or_else(|| AgentFileError::bad_request("文件路径没有父目录"))?;
    let name = path
        .file_name()
        .ok_or_else(|| AgentFileError::bad_request("文件名不正确"))?
        .to_string_lossy();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(".{name}.copis-{stamp}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    if let Err(error) = file
        .write_all(content)
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temporary, path))
    {
        let _ = fs::remove_file(&temporary);
        return Err(io_error(error));
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> AgentFileError {
    match error.kind() {
        std::io::ErrorKind::NotFound => AgentFileError::not_found("文件不存在"),
        std::io::ErrorKind::PermissionDenied => {
            AgentFileError::forbidden("filesystem_denied", "文件系统拒绝访问")
        }
        _ => AgentFileError::internal(error.to_string()),
    }
}

fn revision_for_bytes(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (first << 16) | (second << 8) | third;
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
#[path = "agent_files_tests.rs"]
mod tests;
