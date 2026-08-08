use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::workspace_mcp::is_safe_workspace_slug;

const CONFIG_FILE: &str = "workspace-dev-servers.json";
const CONFIG_VERSION: u8 = 1;
const DEFAULT_VITE_PORT: u16 = 5175;
const LAST_VITE_PORT: u16 = 6174;
const MAX_DISCOVERY_DEPTH: usize = 3;
const IGNORED_DIRECTORIES: &[&str] = &["node_modules", ".git", "dist", "build", ".copis", "coverage"];

#[derive(Debug)]
pub enum WorkspaceDevError {
    InvalidWorkspace,
    InvalidProject,
    NotFound(String),
    Io(String),
    Spawn(String),
}

impl fmt::Display for WorkspaceDevError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWorkspace => formatter.write_str("工作区 slug 不正确"),
            Self::InvalidProject => formatter.write_str("项目路径不正确"),
            Self::NotFound(message) | Self::Io(message) | Self::Spawn(message) => {
                formatter.write_str(message)
            }
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDevActionInput {
    pub project_path: String,
}

#[derive(Default, Deserialize)]
struct DevServerConfig {
    #[serde(default)]
    ports: HashMap<String, u16>,
}

struct ManagedDevServer {
    child: Child,
    port: u16,
}

#[derive(Clone)]
struct ViteProject {
    relative_path: String,
    display_name: String,
    directory: PathBuf,
}

/// 工作区项目开发服务：仅管理工作区 project/ 下的 Vite 项目。
///
/// 端口配置保存在 Copis 配置根目录，进程状态仅在当前 Rust 服务生命周期内保存；
/// 服务重启后不会接管历史 npm 进程，避免误杀用户手动启动的开发服务。
pub struct WorkspaceDevStore {
    config_dir: PathBuf,
    config_lock: Mutex<()>,
    processes: Mutex<HashMap<String, ManagedDevServer>>,
}

impl WorkspaceDevStore {
    pub fn open(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            config_lock: Mutex::new(()),
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_projects(&self, slug: &str) -> Result<Value, WorkspaceDevError> {
        let projects = self.discover_projects(slug)?;
        let config = self.read_config()?;
        let mut processes = self.processes.lock().unwrap();
        prune_stopped_processes(&mut processes);

        let items = projects
            .into_iter()
            .map(|project| {
                let key = project_key(slug, &project.relative_path);
                let running = processes.contains_key(&key);
                let port = processes
                    .get(&key)
                    .map(|entry| entry.port)
                    .or_else(|| config.ports.get(&key).copied());
                json!({
                    "projectPath": project.relative_path,
                    "name": project.display_name,
                    "kind": "vite",
                    "port": port,
                    "status": if running { "running" } else { "stopped" },
                    "url": if running { port.map(|value| format!("http://127.0.0.1:{}", value)) } else { None::<String> },
                })
            })
            .collect::<Vec<_>>();
        Ok(Value::Array(items))
    }

    pub fn start_project(&self, slug: &str, relative_path: &str) -> Result<Value, WorkspaceDevError> {
        let project = self.find_project(slug, relative_path)?;
        let key = project_key(slug, &project.relative_path);
        let mut processes = self.processes.lock().unwrap();
        prune_stopped_processes(&mut processes);
        if let Some(server) = processes.get(&key) {
            return Ok(project_response(&project, server.port, "running"));
        }

        let mut config = self.read_config()?;
        let port = self.allocate_port(&key, &mut config, &processes)?;
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let child = Command::new(npm)
            .current_dir(&project.directory)
            .args([
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--strictPort",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| WorkspaceDevError::Spawn(format!("无法启动 npm run dev: {}", error)))?;

        config.ports.insert(key.clone(), port);
        self.write_config(&config)?;
        processes.insert(key, ManagedDevServer { child, port });
        Ok(project_response(&project, port, "running"))
    }

    pub fn stop_project(&self, slug: &str, relative_path: &str) -> Result<Value, WorkspaceDevError> {
        let project = self.find_project(slug, relative_path)?;
        let key = project_key(slug, &project.relative_path);
        let mut processes = self.processes.lock().unwrap();
        prune_stopped_processes(&mut processes);
        let port = if let Some(mut server) = processes.remove(&key) {
            server
                .child
                .kill()
                .map_err(|error| WorkspaceDevError::Io(format!("停止开发服务失败: {}", error)))?;
            let _ = server.child.wait();
            server.port
        } else {
            self.read_config()?.ports.get(&key).copied().unwrap_or(DEFAULT_VITE_PORT)
        };
        Ok(project_response(&project, port, "stopped"))
    }

    fn find_project(&self, slug: &str, relative_path: &str) -> Result<ViteProject, WorkspaceDevError> {
        let normalized = normalize_relative_project_path(relative_path)?;
        self.discover_projects(slug)?
            .into_iter()
            .find(|project| project.relative_path == normalized)
            .ok_or_else(|| WorkspaceDevError::NotFound("未找到可启动的 Vite 项目".to_string()))
    }

    fn discover_projects(&self, slug: &str) -> Result<Vec<ViteProject>, WorkspaceDevError> {
        let root = self.workspace_project_root(slug)?;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let root = root.canonicalize().map_err(|error| {
            WorkspaceDevError::Io(format!("解析项目开发目录失败: {}", error))
        })?;
        let mut projects = Vec::new();
        discover_vite_projects(&root, &root, 0, &mut projects)?;
        projects.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(projects)
    }

    fn workspace_project_root(&self, slug: &str) -> Result<PathBuf, WorkspaceDevError> {
        if !is_safe_workspace_slug(slug) {
            return Err(WorkspaceDevError::InvalidWorkspace);
        }
        let index_path = self.config_dir.join("agent-workspaces.json");
        let content = fs::read_to_string(&index_path).map_err(|_| {
            WorkspaceDevError::NotFound("工作区索引不存在，无法读取项目列表".to_string())
        })?;
        let index: Value = serde_json::from_str(&content).map_err(|_| {
            WorkspaceDevError::Io("工作区索引不是合法 JSON".to_string())
        })?;
        let workspace = index
            .get("workspaces")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item.get("slug").and_then(Value::as_str) == Some(slug)))
            .ok_or_else(|| WorkspaceDevError::NotFound("工作区不存在".to_string()))?;

        if let Some(project_path) = workspace.get("projectPath").and_then(Value::as_str) {
            return Ok(PathBuf::from(project_path));
        }
        if let Some(source_root) = workspace.get("projectRootPath").and_then(Value::as_str) {
            let source_root = PathBuf::from(source_root);
            return Ok(if workspace.get("allowWorkspaceWrite").and_then(Value::as_bool) == Some(false) {
                source_root.join("copis").join("project")
            } else {
                source_root.join("project")
            });
        }
        Ok(self
            .config_dir
            .join("agent-workspaces")
            .join(slug)
            .join("workspace-files")
            .join("project"))
    }

    fn allocate_port(
        &self,
        key: &str,
        config: &mut DevServerConfig,
        processes: &HashMap<String, ManagedDevServer>,
    ) -> Result<u16, WorkspaceDevError> {
        if let Some(port) = config.ports.get(key).copied() {
            if port_is_available(port) {
                return Ok(port);
            }
        }
        let reserved = config
            .ports
            .iter()
            .filter_map(|(stored_key, port)| (stored_key != key).then_some(*port))
            .chain(processes.values().map(|server| server.port))
            .collect::<HashSet<_>>();
        for port in DEFAULT_VITE_PORT..=LAST_VITE_PORT {
            if !reserved.contains(&port) && port_is_available(port) {
                return Ok(port);
            }
        }
        Err(WorkspaceDevError::Io("没有可用的 Vite 开发端口".to_string()))
    }

    fn read_config(&self) -> Result<DevServerConfig, WorkspaceDevError> {
        let _guard = self.config_lock.lock().unwrap();
        let path = self.config_dir.join(CONFIG_FILE);
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content).map_err(|_| {
                WorkspaceDevError::Io("开发服务端口配置不是合法 JSON".to_string())
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DevServerConfig {
                ports: HashMap::new(),
            }),
            Err(error) => Err(WorkspaceDevError::Io(format!("读取开发服务端口配置失败: {}", error))),
        }
    }

    fn write_config(&self, config: &DevServerConfig) -> Result<(), WorkspaceDevError> {
        let _guard = self.config_lock.lock().unwrap();
        fs::create_dir_all(&self.config_dir).map_err(|error| {
            WorkspaceDevError::Io(format!("创建 Copis 配置目录失败: {}", error))
        })?;
        let path = self.config_dir.join(CONFIG_FILE);
        let temporary = self.config_dir.join(format!("{}.tmp", CONFIG_FILE));
        let content = serde_json::to_string_pretty(&json!({
            "version": CONFIG_VERSION,
            "ports": config.ports,
        }))
        .map_err(|_| WorkspaceDevError::Io("序列化开发服务端口配置失败".to_string()))?;
        fs::write(&temporary, format!("{}\n", content)).map_err(|error| {
            WorkspaceDevError::Io(format!("写入开发服务端口配置失败: {}", error))
        })?;
        fs::rename(&temporary, &path).map_err(|error| {
            WorkspaceDevError::Io(format!("更新开发服务端口配置失败: {}", error))
        })
    }
}

fn discover_vite_projects(
    root: &Path,
    directory: &Path,
    depth: usize,
    projects: &mut Vec<ViteProject>,
) -> Result<(), WorkspaceDevError> {
    let package_path = directory.join("package.json");
    if is_vite_package(&package_path) {
        let relative_path = directory
            .strip_prefix(root)
            .map_err(|_| WorkspaceDevError::Io("项目目录超出工作区范围".to_string()))?;
        let relative_path = if relative_path.as_os_str().is_empty() {
            ".".to_string()
        } else {
            relative_path.to_string_lossy().replace('\\', "/")
        };
        projects.push(ViteProject {
            display_name: package_display_name(&package_path, &relative_path),
            relative_path,
            directory: directory.to_path_buf(),
        });
    }
    if depth >= MAX_DISCOVERY_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => return Err(WorkspaceDevError::Io(format!("读取项目目录失败: {}", error))),
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        if IGNORED_DIRECTORIES.iter().any(|ignored| name == *ignored) {
            continue;
        }
        discover_vite_projects(root, &entry.path(), depth + 1, projects)?;
    }
    Ok(())
}

fn is_vite_package(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(package) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    package
        .get("scripts")
        .and_then(Value::as_object)
        .and_then(|scripts| scripts.get("dev"))
        .and_then(Value::as_str)
        .is_some_and(|script| script.split_whitespace().any(|token| token == "vite" || token.ends_with("/vite")))
}

fn package_display_name(path: &Path, fallback: &str) -> String {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|package| package.get("name").and_then(Value::as_str).map(str::trim).map(str::to_string))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| if fallback == "." { "项目根目录".to_string() } else { fallback.to_string() })
}

fn normalize_relative_project_path(value: &str) -> Result<String, WorkspaceDevError> {
    if value.trim().is_empty() {
        return Err(WorkspaceDevError::InvalidProject);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err(WorkspaceDevError::InvalidProject);
    }
    let normalized = path.to_string_lossy().replace('\\', "/");
    Ok(if normalized == "" { ".".to_string() } else { normalized })
}

fn project_key(slug: &str, relative_path: &str) -> String {
    format!("{}:{}", slug, relative_path)
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn prune_stopped_processes(processes: &mut HashMap<String, ManagedDevServer>) {
    processes.retain(|_, server| server.child.try_wait().ok().flatten().is_none());
}

fn project_response(project: &ViteProject, port: u16, status: &str) -> Value {
    json!({
        "projectPath": project.relative_path,
        "name": project.display_name,
        "kind": "vite",
        "port": port,
        "status": status,
        "url": if status == "running" { Some(format!("http://127.0.0.1:{}", port)) } else { None::<String> },
    })
}

#[cfg(test)]
#[path = "workspace_dev_tests.rs"]
mod tests;
