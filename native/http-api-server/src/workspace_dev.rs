use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::fs;
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::workspace_mcp::is_safe_workspace_slug;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const CONFIG_FILE: &str = "workspace-dev-servers.json";
const CONFIG_VERSION: u8 = 1;
const DEFAULT_VITE_PORT: u16 = 5175;
const LAST_VITE_PORT: u16 = 6174;
const DEV_SERVER_START_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROCESS_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_DISCOVERY_DEPTH: usize = 3;
const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".copis",
    "coverage",
];

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

type SharedProcessOutput = Arc<Mutex<ProcessOutput>>;

#[derive(Default)]
struct ProcessOutput {
    stdout: String,
    stderr: String,
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

    pub fn start_project(
        &self,
        slug: &str,
        relative_path: &str,
    ) -> Result<Value, WorkspaceDevError> {
        let project = self.find_project(slug, relative_path)?;
        let key = project_key(slug, &project.relative_path);
        let mut processes = self.processes.lock().unwrap();
        prune_stopped_processes(&mut processes);
        if let Some(server) = processes.get(&key) {
            return Ok(project_response(&project, server.port, "running"));
        }

        let mut config = self.read_config()?;
        let port = self.allocate_port(&key, &mut config, &processes)?;
        let runtime = crate::runtime::resolve_runtime();
        let npm = resolve_npm_executable(&runtime)?;
        ensure_project_dependencies(&project.directory, &npm, &runtime)?;
        let mut command = Command::new(&npm);
        command
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
            .env("PATH", runtime.path_value())
            .env("COPIS_RUNTIME_ROOT", &runtime.runtime_root)
            .env("COPIS_RUNTIME_DIR", &runtime.active_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_dev_server_process(&mut command);
        let mut child = command.spawn().map_err(|error| {
            WorkspaceDevError::Spawn(format!(
                "无法启动 npm run dev（{}）: {}",
                npm.display(),
                error
            ))
        })?;

        let (output, mut readers) = capture_process_output(&mut child)?;
        wait_for_dev_server(&mut child, port, &output, &mut readers)?;
        config.ports.insert(key.clone(), port);
        self.write_config(&config)?;
        processes.insert(key, ManagedDevServer { child, port });
        Ok(project_response(&project, port, "running"))
    }

    pub fn stop_project(
        &self,
        slug: &str,
        relative_path: &str,
    ) -> Result<Value, WorkspaceDevError> {
        let project = self.find_project(slug, relative_path)?;
        let key = project_key(slug, &project.relative_path);
        let mut processes = self.processes.lock().unwrap();
        prune_stopped_processes(&mut processes);
        let port = if let Some(mut server) = processes.remove(&key) {
            stop_dev_server_process(&mut server.child)?;
            server.port
        } else {
            self.read_config()?
                .ports
                .get(&key)
                .copied()
                .unwrap_or(DEFAULT_VITE_PORT)
        };
        Ok(project_response(&project, port, "stopped"))
    }

    fn find_project(
        &self,
        slug: &str,
        relative_path: &str,
    ) -> Result<ViteProject, WorkspaceDevError> {
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
        let root = root
            .canonicalize()
            .map_err(|error| WorkspaceDevError::Io(format!("解析项目开发目录失败: {}", error)))?;
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
        let index: Value = serde_json::from_str(&content)
            .map_err(|_| WorkspaceDevError::Io("工作区索引不是合法 JSON".to_string()))?;
        let workspace = index
            .get("workspaces")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("slug").and_then(Value::as_str) == Some(slug))
            })
            .ok_or_else(|| WorkspaceDevError::NotFound("工作区不存在".to_string()))?;

        if let Some(project_path) = workspace.get("projectPath").and_then(Value::as_str) {
            return Ok(PathBuf::from(project_path));
        }
        if let Some(source_root) = workspace.get("projectRootPath").and_then(Value::as_str) {
            return Ok(PathBuf::from(source_root).join("project"));
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
        Err(WorkspaceDevError::Io(
            "没有可用的 Vite 开发端口".to_string(),
        ))
    }

    fn read_config(&self) -> Result<DevServerConfig, WorkspaceDevError> {
        let _guard = self.config_lock.lock().unwrap();
        let path = self.config_dir.join(CONFIG_FILE);
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content)
                .map_err(|_| WorkspaceDevError::Io("开发服务端口配置不是合法 JSON".to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DevServerConfig {
                ports: HashMap::new(),
            }),
            Err(error) => Err(WorkspaceDevError::Io(format!(
                "读取开发服务端口配置失败: {}",
                error
            ))),
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
        fs::rename(&temporary, &path)
            .map_err(|error| WorkspaceDevError::Io(format!("更新开发服务端口配置失败: {}", error)))
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
        Err(error) => {
            return Err(WorkspaceDevError::Io(format!(
                "读取项目目录失败: {}",
                error
            )))
        }
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
        .is_some_and(|script| {
            script
                .split_whitespace()
                .any(|token| token == "vite" || token.ends_with("/vite"))
        })
}

fn package_display_name(path: &Path, fallback: &str) -> String {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|package| {
            package
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            if fallback == "." {
                "项目根目录".to_string()
            } else {
                fallback.to_string()
            }
        })
}

fn normalize_relative_project_path(value: &str) -> Result<String, WorkspaceDevError> {
    if value.trim().is_empty() {
        return Err(WorkspaceDevError::InvalidProject);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(WorkspaceDevError::InvalidProject);
    }
    let normalized = path.to_string_lossy().replace('\\', "/");
    Ok(if normalized == "" {
        ".".to_string()
    } else {
        normalized
    })
}

fn project_key(slug: &str, relative_path: &str) -> String {
    format!("{}:{}", slug, relative_path)
}

/// GUI 进程通常不会加载用户 shell 的 nvm 初始化脚本，因此不能只依赖 PATH 查找 npm。
fn resolve_npm_executable(
    runtime: &crate::runtime::ExternalRuntime,
) -> Result<PathBuf, WorkspaceDevError> {
    let path_directories = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let explicit = env::var_os("COPIS_NPM_PATH").map(PathBuf::from);
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from);

    resolve_npm_executable_from(
        explicit.as_deref(),
        runtime.node_path(),
        home.as_deref(),
        &path_directories,
    )
    .ok_or_else(|| {
        WorkspaceDevError::Spawn(
            "未找到 npm。请安装 Node.js，或在环境变量中配置 COPIS_NPM_PATH 指向 npm 可执行文件"
                .to_string(),
        )
    })
}

fn ensure_project_dependencies(
    project_directory: &Path,
    npm: &Path,
    runtime: &crate::runtime::ExternalRuntime,
) -> Result<(), WorkspaceDevError> {
    if project_directory.join("node_modules").is_dir() {
        return Ok(());
    }

    let mut command = Command::new(npm);
    command
        .current_dir(project_directory)
        .args(["install", "--no-audit", "--no-fund"])
        .env("PATH", runtime.path_value())
        .env("COPIS_RUNTIME_ROOT", &runtime.runtime_root)
        .env("COPIS_RUNTIME_DIR", &runtime.active_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output().map_err(|error| {
        WorkspaceDevError::Spawn(format!(
            "无法执行 npm install（{}）: {}",
            npm.display(),
            error
        ))
    })?;

    if !output.status.success() {
        return Err(WorkspaceDevError::Spawn(format_command_failure(
            "npm install",
            output.status.code(),
            &output.stdout,
            &output.stderr,
        )));
    }
    if !project_directory.join("node_modules").is_dir() {
        return Err(WorkspaceDevError::Spawn(
            "npm install 已完成，但项目没有生成 node_modules 目录".to_string(),
        ));
    }
    Ok(())
}

fn resolve_npm_executable_from(
    explicit: Option<&Path>,
    node_path: Option<&Path>,
    home: Option<&Path>,
    path_directories: &[PathBuf],
) -> Option<PathBuf> {
    explicit
        .filter(|path| path.is_file())
        .map(Path::to_path_buf)
        .or_else(|| node_path.and_then(npm_beside_node))
        .or_else(|| home.and_then(find_nvm_npm))
        .or_else(|| find_npm_in_directories(path_directories))
}

fn npm_beside_node(node_path: &Path) -> Option<PathBuf> {
    let directory = node_path.parent()?;
    npm_candidates(directory)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn find_nvm_npm(home: &Path) -> Option<PathBuf> {
    let versions_root = home.join(".nvm").join("versions").join("node");
    let entries = fs::read_dir(versions_root).ok()?;
    let mut versions = entries
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            file_type.is_dir().then_some(entry.path())
        })
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| {
        nvm_version_key(right.file_name().and_then(|name| name.to_str())).cmp(&nvm_version_key(
            left.file_name().and_then(|name| name.to_str()),
        ))
    });

    versions.into_iter().find_map(|version| {
        npm_candidates(&version.join("bin"))
            .into_iter()
            .find(|candidate| candidate.is_file())
    })
}

fn nvm_version_key(version: Option<&str>) -> Vec<u32> {
    version
        .unwrap_or_default()
        .trim_start_matches('v')
        .split('.')
        .map(|segment| segment.parse::<u32>().unwrap_or(0))
        .collect()
}

fn find_npm_in_directories(directories: &[PathBuf]) -> Option<PathBuf> {
    directories.iter().find_map(|directory| {
        npm_candidates(directory)
            .into_iter()
            .find(|candidate| candidate.is_file())
    })
}

fn npm_candidates(directory: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        vec![directory.join("npm.cmd"), directory.join("npm")]
    } else {
        vec![directory.join("npm")]
    }
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// npm 会再启动 shell 和 Vite 子进程；单独结束 npm 会留下监听端口的 Vite。
/// Unix 使用独立进程组，Windows 使用 taskkill 的子进程树回收。
fn configure_dev_server_process(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
}

fn stop_dev_server_process(child: &mut Child) -> Result<(), WorkspaceDevError> {
    #[cfg(unix)]
    {
        terminate_unix_process_group(child.id())
            .or_else(|group_error| {
                child.kill().map_err(|kill_error| {
                    std::io::Error::new(
                        kill_error.kind(),
                        format!(
                            "进程组终止失败: {}; 主进程终止失败: {}",
                            group_error, kill_error
                        ),
                    )
                })
            })
            .map_err(|error| WorkspaceDevError::Io(format!("停止开发服务失败: {}", error)))?;
    }

    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) if status.success() => {}
            Ok(status) => child.kill().map_err(|error| {
                WorkspaceDevError::Io(format!(
                    "taskkill 停止开发服务失败（状态: {}）且无法结束主进程: {}",
                    status, error
                ))
            })?,
            Err(error) => child.kill().map_err(|kill_error| {
                WorkspaceDevError::Io(format!(
                    "无法执行 taskkill（{}）且无法结束主进程: {}",
                    error, kill_error
                ))
            })?,
        }
    }

    #[cfg(not(any(unix, windows)))]
    child
        .kill()
        .map_err(|error| WorkspaceDevError::Io(format!("停止开发服务失败: {}", error)))?;

    child
        .wait()
        .map_err(|error| WorkspaceDevError::Io(format!("等待开发服务退出失败: {}", error)))?;
    Ok(())
}

#[cfg(unix)]
fn terminate_unix_process_group(pid: u32) -> std::io::Result<()> {
    let pid = i32::try_from(pid).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "开发服务进程 ID 超出范围")
    })?;
    // 负 PID 仅向 npm 所在的独立进程组发送 SIGTERM，不影响 Copis 主进程。
    let result = unsafe { kill(-pid, 15) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

fn capture_process_output(
    child: &mut Child,
) -> Result<(SharedProcessOutput, Vec<JoinHandle<()>>), WorkspaceDevError> {
    let output = Arc::new(Mutex::new(ProcessOutput::default()));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorkspaceDevError::Spawn("无法读取 npm run dev 标准输出".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| WorkspaceDevError::Spawn("无法读取 npm run dev 错误输出".to_string()))?;
    let readers = vec![
        spawn_output_reader(stdout, Arc::clone(&output), false),
        spawn_output_reader(stderr, Arc::clone(&output), true),
    ];
    Ok((output, readers))
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    output: SharedProcessOutput,
    is_stderr: bool,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if reader.read_to_end(&mut bytes).is_err() {
            return;
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut output = output.lock().unwrap();
        let target = if is_stderr {
            &mut output.stderr
        } else {
            &mut output.stdout
        };
        target.push_str(&text);
        truncate_output(target);
    })
}

fn join_process_output(readers: &mut Vec<JoinHandle<()>>) {
    for reader in readers.drain(..) {
        let _ = reader.join();
    }
}

fn process_output_message(output: &SharedProcessOutput) -> String {
    let output = output.lock().unwrap();
    let mut details = String::new();
    if !output.stdout.trim().is_empty() {
        details.push_str("\n标准输出:\n");
        details.push_str(output.stdout.trim());
    }
    if !output.stderr.trim().is_empty() {
        details.push_str("\n错误输出:\n");
        details.push_str(output.stderr.trim());
    }
    details
}

fn truncate_output(value: &mut String) {
    if value.len() <= MAX_PROCESS_OUTPUT_BYTES {
        return;
    }
    let suffix = value
        .chars()
        .rev()
        .take(MAX_PROCESS_OUTPUT_BYTES)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    *value = format!("...(输出过长，已截取末尾)\n{}", suffix);
}

fn format_command_failure(
    command_name: &str,
    exit_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> String {
    let mut message = format!(
        "{} 已退出（状态: {}）",
        command_name,
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "未知".to_string())
    );
    let mut output = ProcessOutput {
        stdout: String::from_utf8_lossy(stdout).into_owned(),
        stderr: String::from_utf8_lossy(stderr).into_owned(),
    };
    truncate_output(&mut output.stdout);
    truncate_output(&mut output.stderr);
    if !output.stdout.trim().is_empty() {
        message.push_str("\n标准输出:\n");
        message.push_str(output.stdout.trim());
    }
    if !output.stderr.trim().is_empty() {
        message.push_str("\n错误输出:\n");
        message.push_str(output.stderr.trim());
    }
    message
}

/// 仅在 Vite 已开始监听时返回成功，避免浏览器页签过早打开后停在连接失败页。
fn wait_for_dev_server(
    child: &mut Child,
    port: u16,
    output: &SharedProcessOutput,
    readers: &mut Vec<JoinHandle<()>>,
) -> Result<(), WorkspaceDevError> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + DEV_SERVER_START_TIMEOUT;
    loop {
        if dev_server_is_listening(address) {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                join_process_output(readers);
                return Err(WorkspaceDevError::Spawn(format!(
                    "npm run dev 已退出（状态: {}），请检查项目依赖和 Vite 配置{}",
                    status,
                    process_output_message(output)
                )));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(WorkspaceDevError::Spawn(format!(
                    "检查开发服务状态失败: {}",
                    error
                )));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            join_process_output(readers);
            return Err(WorkspaceDevError::Spawn(format!(
                "等待 Vite 开发服务启动超时{}",
                process_output_message(output)
            )));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn dev_server_is_listening(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
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
