use serde_json::{json, Map, Value};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 内置 MCP 占用的保留名（id + 运行时 name），与 Electron
/// `builtin-mcp/baseline.ts` 的 RESERVED_BUILTIN_KEYS 保持一致。
/// 工作区 mcp.json 不允许出现这些 key，保存时应剔除。
const RESERVED_BUILTIN_KEYS: &[&str] = &[
    "automation",
    "collaboration",
    "nano-banana",
    "nano_banana",
];

/// streamable http 的别名，规范化为 http，与共享层 mcp-transport 一致。
const STREAMABLE_HTTP_ALIASES: &[&str] = &["streamableHttp", "streamable-http", "streamable_http"];

#[derive(Debug)]
pub enum WorkspaceMcpError {
    InvalidWorkspace,
    InvalidConfig(String),
    Io(String),
}

impl fmt::Display for WorkspaceMcpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWorkspace => formatter.write_str("工作区 slug 不正确"),
            Self::InvalidConfig(message) => formatter.write_str(message),
            Self::Io(message) => formatter.write_str(message),
        }
    }
}

/// 工作区 MCP 配置存储：直接读写 `agent-workspaces/<slug>/mcp.json`。
///
/// 与 Electron 主进程共用同一配置文件（Agent 编排仍从该文件注入 MCP），
/// 渲染层通过 Rust HTTP API 访问，不再新增 MCP 相关 Electron IPC。
pub struct WorkspaceMcpStore {
    config_dir: PathBuf,
    write_lock: Mutex<()>,
}

impl WorkspaceMcpStore {
    pub fn open(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            write_lock: Mutex::new(()),
        }
    }

    fn workspace_mcp_path(&self, slug: &str) -> Result<PathBuf, WorkspaceMcpError> {
        if !is_safe_workspace_slug(slug) {
            return Err(WorkspaceMcpError::InvalidWorkspace);
        }
        Ok(self
            .config_dir
            .join("agent-workspaces")
            .join(slug)
            .join("mcp.json"))
    }

    /// 读取并规范化工作区 MCP 配置；文件不存在时返回空配置。
    pub fn get_config(&self, slug: &str) -> Result<Value, WorkspaceMcpError> {
        let path = self.workspace_mcp_path(slug)?;
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({ "servers": {} }));
            }
            Err(_) => {
                return Err(WorkspaceMcpError::Io(format!(
                    "读取 MCP 配置失败: {}",
                    path.display()
                )));
            }
        };
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|_| WorkspaceMcpError::InvalidConfig("MCP 配置不是合法 JSON".to_string()))?;
        Ok(normalize_workspace_mcp_config(parsed))
    }

    /// 规范化并原子写入工作区 MCP 配置，返回规范化后的配置。
    pub fn save_config(&self, slug: &str, config: Value) -> Result<Value, WorkspaceMcpError> {
        if !config.is_object() {
            return Err(WorkspaceMcpError::InvalidConfig(
                "MCP 配置必须是 JSON 对象".to_string(),
            ));
        }
        let normalized = normalize_workspace_mcp_config(config);
        let path = self.workspace_mcp_path(slug)?;

        let _guard = self.write_lock.lock().unwrap();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| {
                WorkspaceMcpError::Io(format!("创建工作区目录失败: {}", parent.display()))
            })?;
        }
        let mut pretty = serde_json::to_string_pretty(&normalized)
            .map_err(|_| WorkspaceMcpError::InvalidConfig("MCP 配置序列化失败".to_string()))?;
        pretty.push('\n');

        let temporary = path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&temporary).map_err(|_| {
                WorkspaceMcpError::Io(format!("创建临时配置失败: {}", temporary.display()))
            })?;
            file.write_all(pretty.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| {
                    WorkspaceMcpError::Io(format!("写入临时配置失败: {}", temporary.display()))
                })?;
        }
        fs::rename(&temporary, &path).map_err(|_| {
            WorkspaceMcpError::Io(format!("替换 MCP 配置失败: {}", path.display()))
        })?;
        Ok(normalized)
    }
}

pub(crate) fn is_safe_workspace_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// 规范化工作区 MCP 配置：
/// - 只保留对象类型的服务器条目；
/// - 剔除与内置 MCP 冲突的保留名；
/// - 规范化 transport type（别名归一、缺失时按 command/url 推断）。
pub fn normalize_workspace_mcp_config(config: Value) -> Value {
    let mut servers = Map::new();
    if let Some(raw_servers) = config.get("servers").and_then(Value::as_object) {
        for (name, raw_entry) in raw_servers {
            let Some(entry) = raw_entry.as_object() else {
                continue;
            };
            if RESERVED_BUILTIN_KEYS.contains(&name.as_str()) {
                continue;
            }
            let mut normalized_entry = entry.clone();
            normalize_entry_type(&mut normalized_entry);
            servers.insert(name.clone(), Value::Object(normalized_entry));
        }
    }
    json!({ "servers": Value::Object(servers) })
}

fn normalize_entry_type(entry: &mut Map<String, Value>) {
    let type_value = entry.get("type");
    match type_value.and_then(normalize_transport_type) {
        Some(normalized) => {
            entry.insert("type".to_string(), Value::String(normalized.to_string()));
        }
        None if type_value.is_none() || type_value == Some(&Value::Null) => {
            let inferred = infer_transport_type(entry);
            entry.insert("type".to_string(), Value::String(inferred.to_string()));
        }
        // 存在但无效的 type 保持原样，与 Electron 行为一致。
        None => {}
    }
}

fn normalize_transport_type(value: &Value) -> Option<&'static str> {
    match value.as_str() {
        Some("stdio") => Some("stdio"),
        Some("http") => Some("http"),
        Some("sse") => Some("sse"),
        Some(alias) if STREAMABLE_HTTP_ALIASES.contains(&alias) => Some("http"),
        _ => None,
    }
}

fn infer_transport_type(entry: &Map<String, Value>) -> &'static str {
    let has_command = entry
        .get("command")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if has_command {
        return "stdio";
    }
    let has_url = entry
        .get("url")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if has_url {
        return "http";
    }
    "stdio"
}

#[cfg(test)]
#[path = "workspace_mcp_tests.rs"]
mod tests;
