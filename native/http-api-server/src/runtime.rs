use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Windows 外部 Node/Git 首次启动可能受 Defender 或磁盘冷启动影响，不能用过短超时误判。
// 仍保留硬超时，避免异常 runtime 阻塞 Pi 请求。
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const RUNTIME_CACHE_TTL: Duration = Duration::from_secs(30);
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

const NODE_CANDIDATES: &[&str] = &[
    "node/node.exe",
    "node/bin/node.exe",
    "bin/node.exe",
    "node/node",
    "node/bin/node",
    "bin/node",
];

const GIT_CANDIDATES: &[&str] = &["git/cmd/git.exe", "git/bin/git.exe", "git/bin/git"];

const BASH_CANDIDATES: &[&str] = &[
    "git/bin/bash.exe",
    "git/usr/bin/bash.exe",
    "git/bin/bash",
    "git/usr/bin/bash",
];

#[derive(Clone, Debug)]
pub struct ExternalRuntime {
    pub(crate) runtime_root: PathBuf,
    pub(crate) active_dir: PathBuf,
    pub(crate) node_path: Option<PathBuf>,
    pub(crate) git_path: Option<PathBuf>,
    pub(crate) bash_path: Option<PathBuf>,
    node_version: Option<String>,
    git_version: Option<String>,
    bash_version: Option<String>,
    node_error: Option<String>,
    git_error: Option<String>,
    bash_error: Option<String>,
}

impl ExternalRuntime {
    pub fn node_path(&self) -> Option<&Path> {
        self.node_path.as_deref()
    }

    pub fn path_value(&self) -> String {
        runtime_path(&self.active_dir)
    }

    pub fn validate_for_worker(
        &self,
        require_node: bool,
        require_external_runtime: bool,
    ) -> Result<(), String> {
        if !require_external_runtime {
            return Ok(());
        }
        if require_node && self.node_path.is_none() {
            return Err(format!(
                "外部 Node.js runtime 不可用：{}",
                self.node_error
                    .as_deref()
                    .unwrap_or("未找到 node 可执行文件")
            ));
        }
        if self.git_path.is_none() {
            return Err(format!(
                "外部 Git runtime 不可用：{}",
                self.git_error.as_deref().unwrap_or("未找到 git 可执行文件")
            ));
        }
        if cfg!(windows) && self.bash_path.is_none() {
            return Err(format!(
                "外部 Git Bash runtime 不可用：{}",
                self.bash_error
                    .as_deref()
                    .unwrap_or("未找到 bash 可执行文件")
            ));
        }
        Ok(())
    }

    pub fn inject_pi_config(
        &self,
        config: &mut Value,
        require_node: bool,
        require_external_runtime: bool,
    ) -> Result<(), String> {
        self.validate_for_worker(require_node, require_external_runtime)?;

        let query = config
            .get_mut("query")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Pi worker 配置缺少 query 对象".to_string())?;
        let runtime_env = ensure_object(query, "runtimeEnv");
        let env = ensure_object(runtime_env, "env");

        env.insert("PATH".to_string(), Value::String(self.path_value()));
        env.insert(
            "COPIS_RUNTIME_ROOT".to_string(),
            Value::String(self.runtime_root.to_string_lossy().into_owned()),
        );
        env.insert(
            "COPIS_RUNTIME_DIR".to_string(),
            Value::String(self.active_dir.to_string_lossy().into_owned()),
        );
        if let Some(python_root) = python_runtime_root() {
            let python_root = python_root.to_string_lossy().into_owned();
            env.insert(
                "COPIS_PYTHON_RUNTIME_ROOT".to_string(),
                Value::String(python_root.clone()),
            );
            env.insert("PYTHONHOME".to_string(), Value::String(python_root));
        }
        if let Some(path) = &self.node_path {
            env.insert(
                "COPIS_NODE_PATH".to_string(),
                Value::String(path.to_string_lossy().into_owned()),
            );
        }
        if let Some(path) = &self.git_path {
            env.insert(
                "COPIS_GIT_PATH".to_string(),
                Value::String(path.to_string_lossy().into_owned()),
            );
        }
        if let Some(path) = &self.bash_path {
            let path = path.to_string_lossy().into_owned();
            env.insert(
                "COPIS_GIT_BASH_PATH".to_string(),
                Value::String(path.clone()),
            );
            env.insert(
                "COPIS_WINDOWS_SHELL".to_string(),
                Value::String("git-bash".to_string()),
            );
            env.insert("SHELL".to_string(), Value::String(path.clone()));
            runtime_env.insert(
                "shellKind".to_string(),
                Value::String("git-bash".to_string()),
            );
            runtime_env.insert("shellPath".to_string(), Value::String(path));
            runtime_env.remove("wslCommand");
            runtime_env.remove("wslDistro");
        }

        Ok(())
    }

    pub fn status_json(&self) -> Value {
        let node_available = self.node_version.is_some();
        let git_available = self.git_version.is_some();
        let bash_available = self.bash_version.is_some();
        let runtime_error = if self.runtime_root.exists() {
            None
        } else {
            Some("未找到外部 runtime 目录".to_string())
        };

        json!({
            "node": {
                "available": node_available,
                "version": self.node_version,
                "path": self.node_path.as_deref().map(path_string),
                "error": if node_available { Value::Null } else { Value::String(self.node_error.clone().unwrap_or_else(|| "Node.js 版本探测失败".to_string())) },
            },
            "bun": {
                "available": false,
                "path": Value::Null,
                "version": Value::Null,
                "source": Value::Null,
                "error": "Pi runtime 不依赖 Bun",
            },
            "git": {
                "available": git_available,
                "version": self.git_version,
                "path": self.git_path.as_deref().map(path_string),
                "error": if git_available { Value::Null } else { Value::String(self.git_error.clone().unwrap_or_else(|| "Git 版本探测失败".to_string())) },
            },
            "shell": {
                "gitBash": {
                    "available": bash_available,
                    "path": self.bash_path.as_deref().map(path_string),
                    "version": self.bash_version,
                    "error": if bash_available { Value::Null } else { Value::String(self.bash_error.clone().unwrap_or_else(|| "Git Bash 版本探测失败".to_string())) },
                },
                "wsl": {
                    "available": false,
                    "version": Value::Null,
                    "defaultDistro": Value::Null,
                    "distros": [],
                    "error": "Pi runtime 使用外部 Git Bash，不使用 WSL",
                },
                "recommended": if bash_available {
                    Value::String("git-bash".to_string())
                } else {
                    Value::Null
                },
            },
            "envLoaded": runtime_error.is_none(),
            "initializedAt": unix_time_millis(),
            "runtimeRoot": self.runtime_root.to_string_lossy(),
            "activeRuntimeDir": self.active_dir.to_string_lossy(),
            "runtimeError": runtime_error,
        })
    }
}

pub fn resolve_runtime() -> ExternalRuntime {
    resolve_runtime_with_cache(false)
}

pub fn refresh_runtime() -> ExternalRuntime {
    resolve_runtime_with_cache(true)
}

struct RuntimeCacheEntry {
    explicit_root: Option<PathBuf>,
    expires_at: Instant,
    runtime: ExternalRuntime,
}

static RUNTIME_CACHE: OnceLock<Mutex<Option<RuntimeCacheEntry>>> = OnceLock::new();

fn resolve_runtime_with_cache(force: bool) -> ExternalRuntime {
    let explicit_root = env::var_os("COPIS_RUNTIME_ROOT").map(PathBuf::from);
    let cache = RUNTIME_CACHE.get_or_init(|| Mutex::new(None));

    if !force {
        if let Ok(guard) = cache.lock() {
            if let Some(entry) = guard.as_ref() {
                if entry.explicit_root == explicit_root && Instant::now() < entry.expires_at {
                    return entry.runtime.clone();
                }
            }
        }
    }

    let runtime = resolve_runtime_uncached();
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(RuntimeCacheEntry {
            explicit_root,
            expires_at: Instant::now() + RUNTIME_CACHE_TTL,
            runtime: runtime.clone(),
        });
    }
    runtime
}

fn resolve_runtime_uncached() -> ExternalRuntime {
    let (runtime_root, active_dir) = select_runtime_directory();
    let (node, git, bash) = thread::scope(|scope| {
        let node = scope.spawn(|| probe_executable(&active_dir, NODE_CANDIDATES, &["--version"]));
        let git = scope.spawn(|| probe_executable(&active_dir, GIT_CANDIDATES, &["--version"]));
        let bash = scope.spawn(|| probe_executable(&active_dir, BASH_CANDIDATES, &["--version"]));

        (
            node.join()
                .unwrap_or_else(|_| probe_panic_result("Node.js")),
            git.join().unwrap_or_else(|_| probe_panic_result("Git")),
            bash.join()
                .unwrap_or_else(|_| probe_panic_result("Git Bash")),
        )
    });

    ExternalRuntime {
        runtime_root,
        active_dir,
        node_path: node.path,
        git_path: git.path,
        bash_path: bash.path,
        node_version: node.version.map(|value| normalize_node_version(&value)),
        git_version: git.version.map(|value| normalize_git_version(&value)),
        bash_version: bash.version.map(|value| value.trim().to_string()),
        node_error: node.error,
        git_error: git.error,
        bash_error: bash.error,
    }
}

pub fn status_json() -> Value {
    resolve_runtime().status_json()
}

pub fn refresh_status_json() -> Value {
    refresh_runtime().status_json()
}

fn ensure_object<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .expect("runtime object was just created")
}

fn select_runtime_directory() -> (PathBuf, PathBuf) {
    let roots = runtime_roots();
    let explicit = env::var_os("COPIS_RUNTIME_ROOT").map(PathBuf::from);

    for root in roots {
        let active = active_runtime_dir(&root);
        if explicit.is_some() || runtime_has_modules(&active) {
            return (root, active);
        }
    }

    let fallback = explicit.unwrap_or_else(|| {
        home_dir()
            .map(|home| home.join(".copis").join("runtime"))
            .unwrap_or_else(|| PathBuf::from("runtime"))
    });
    let active = active_runtime_dir(&fallback);
    (fallback, active)
}

fn runtime_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env::var_os("COPIS_RUNTIME_ROOT") {
        roots.push(PathBuf::from(root));
    }

    if let Some(home) = home_dir() {
        roots.push(home.join(".copis").join("runtime"));
        roots.push(home.join(".copis-dev").join("runtime"));
    }

    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        roots.push(local_app_data.join("Copis").join("runtime"));
        roots.push(local_app_data.join("@copis").join("runtime"));
        roots.push(local_app_data.join("com.ai-education.app").join("runtime"));
        roots.push(local_app_data.join("ai-education").join("runtime"));
    }

    // 父项目 ai-education 将外部 Node/Git 模块存放在 AppData 的 runtime 目录，
    // Copis 直接复用该目录，不复制二进制，也不依赖系统 PATH。
    if let Some(app_data) = env::var_os("APPDATA") {
        let app_data = PathBuf::from(app_data);
        roots.push(app_data.join("Copis").join("runtime"));
        roots.push(app_data.join("@copis").join("runtime"));
        roots.push(app_data.join("com.ai-education.app").join("runtime"));
        roots.push(app_data.join("ai-education").join("runtime"));
    }

    let mut unique_roots = Vec::with_capacity(roots.len());
    for root in roots {
        if !unique_roots
            .iter()
            .any(|existing: &PathBuf| existing == &root)
        {
            unique_roots.push(root);
        }
    }
    unique_roots
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn active_runtime_dir(root: &Path) -> PathBuf {
    if root.join("node").is_dir() || root.join("git").is_dir() {
        return root.to_path_buf();
    }

    if let Ok(version) = fs::read_to_string(root.join("current-version.txt")) {
        let version = version.trim().trim_start_matches('\u{feff}');
        if is_safe_version(version) {
            let version_dir = root.join("versions").join(version);
            if version_dir.is_dir() {
                return version_dir;
            }
        }
    }

    let current = root.join("current");
    if current.is_dir() {
        return current;
    }

    root.to_path_buf()
}

fn is_safe_version(version: &str) -> bool {
    !version.is_empty()
        && version != "."
        && version != ".."
        && !version.contains('/')
        && !version.contains('\\')
}

fn runtime_has_modules(active_dir: &Path) -> bool {
    active_dir.join("node").is_dir()
        || active_dir.join("git").is_dir()
        || find_executable(active_dir, NODE_CANDIDATES).is_some()
        || find_executable(active_dir, GIT_CANDIDATES).is_some()
}

fn find_executable(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|path| path.is_file())
}

struct ProbeResult {
    path: Option<PathBuf>,
    version: Option<String>,
    error: Option<String>,
}

fn probe_panic_result(name: &str) -> ProbeResult {
    ProbeResult {
        path: None,
        version: None,
        error: Some(format!("{name} runtime 探测线程异常退出")),
    }
}

fn probe_executable(root: &Path, candidates: &[&str], args: &[&str]) -> ProbeResult {
    let Some(path) = find_executable(root, candidates) else {
        return ProbeResult {
            path: None,
            version: None,
            error: Some(format!("未找到外部 runtime 可执行文件：{}", candidates[0])),
        };
    };

    match run_version_command(&path, args) {
        Ok(version) => ProbeResult {
            path: Some(path),
            version: Some(version),
            error: None,
        },
        Err(error) => ProbeResult {
            path: Some(path),
            version: None,
            error: Some(error),
        },
    }
}

fn run_version_command(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", path.display()))?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = read_child_output(&mut child)?;
                if !status.success() {
                    return Err(format!(
                        "{} --version 退出码 {:?}",
                        path.display(),
                        status.code()
                    ));
                }
                let value = output
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or_default();
                if value.is_empty() {
                    return Err(format!("{} --version 没有输出", path.display()));
                }
                return Ok(value.to_string());
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} --version 超时", path.display()));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("检查 {} 失败：{error}", path.display()));
            }
        }
    }
}

fn read_child_output(child: &mut Child) -> Result<String, String> {
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.as_mut() {
        stdout
            .read_to_end(&mut output)
            .map_err(|error| format!("读取 runtime 输出失败：{error}"))?;
    }
    if output.is_empty() {
        if let Some(stderr) = child.stderr.as_mut() {
            stderr
                .read_to_end(&mut output)
                .map_err(|error| format!("读取 runtime 错误输出失败：{error}"))?;
        }
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn runtime_path(active_dir: &Path) -> String {
    let python_root = env::var_os("COPIS_PYTHON_RUNTIME_ROOT").map(PathBuf::from);
    runtime_path_with_python(active_dir, python_root.as_deref())
}

fn runtime_path_with_python(active_dir: &Path, python_root: Option<&Path>) -> String {
    let prefixes = [
        active_dir.join("bin"),
        active_dir.join("node"),
        active_dir.join("node").join("bin"),
        active_dir.join("git").join("cmd"),
        active_dir.join("git").join("bin"),
        active_dir.join("git").join("usr").join("bin"),
        active_dir.join("git").join("mingw64").join("bin"),
    ];
    let mut values: Vec<String> = prefixes
        .iter()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    append_python_runtime_paths(&mut values, python_root);
    append_path_entries(&mut values, env::var_os("PATH").as_deref());
    values.join(&PATH_SEPARATOR.to_string())
}

fn append_python_runtime_paths(values: &mut Vec<String>, root: Option<&Path>) {
    let Some(root) = root else { return };
    for path in [root.join("bin"), root.join("Scripts"), root.to_path_buf()] {
        if path.is_dir() {
            append_path_entry(values, path);
        }
    }
}

fn append_path_entries(values: &mut Vec<String>, raw: Option<&std::ffi::OsStr>) {
    let Some(raw) = raw else { return };
    for path in env::split_paths(raw) {
        append_path_entry(values, path);
    }
}

fn append_path_entry(values: &mut Vec<String>, path: PathBuf) {
    let value = path.to_string_lossy().into_owned();
    if !value.is_empty() && !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

pub(crate) fn python_runtime_root() -> Option<PathBuf> {
    env::var_os("COPIS_PYTHON_RUNTIME_ROOT")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

pub(crate) fn prepend_python_runtime_path(base_path: Option<&str>) -> Option<String> {
    let root = python_runtime_root()?;
    Some(prepend_python_runtime_path_for_root(&root, base_path))
}

fn prepend_python_runtime_path_for_root(root: &Path, base_path: Option<&str>) -> String {
    let mut values = Vec::new();
    append_python_runtime_paths(&mut values, Some(root));
    if let Some(base_path) = base_path {
        append_path_entries(&mut values, Some(std::ffi::OsStr::new(base_path)));
    } else {
        append_path_entries(&mut values, env::var_os("PATH").as_deref());
    }
    values.join(&PATH_SEPARATOR.to_string())
}

pub(crate) fn inject_python_runtime_config(config: &mut Value) -> Result<(), String> {
    let Some(root) = python_runtime_root() else {
        return Ok(());
    };
    inject_python_runtime_config_for_root(config, &root)
}

fn inject_python_runtime_config_for_root(config: &mut Value, root: &Path) -> Result<(), String> {
    let query = config
        .get_mut("query")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Pi worker 配置缺少 query 对象".to_string())?;
    let runtime_env = ensure_object(query, "runtimeEnv");
    let env = ensure_object(runtime_env, "env");
    let base_path = env.get("PATH").and_then(Value::as_str);
    let path = prepend_python_runtime_path_for_root(root, base_path);
    env.insert("PATH".to_string(), Value::String(path));
    let root = root.to_string_lossy().into_owned();
    env.insert(
        "COPIS_PYTHON_RUNTIME_ROOT".to_string(),
        Value::String(root.clone()),
    );
    env.insert("PYTHONHOME".to_string(), Value::String(root));
    Ok(())
}

fn normalize_node_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

fn normalize_git_version(value: &str) -> String {
    let mut words = value.split_whitespace();
    while let Some(word) = words.next() {
        if word == "version" {
            return words.next().unwrap_or(value.trim()).to_string();
        }
    }
    value.trim().to_string()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn apply_no_window(_command: &mut Command) {}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
