use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::Value;

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

pub fn agent_session_id(path: &str) -> Option<String> {
    let mut segments = path.split('/');
    if segments.next()? != ""
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
        }
    }

    pub fn start(&self, session_id: &str, mut config: Value) -> Result<PiWorkerRun, String> {
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
                "未找到打包的 Copis runtime。请重新安装或重新构建应用后再启动 Agent。"
                    .to_string(),
            );
        }
        let require_external_runtime = !has_compiled_executable && !use_system_runtime;
        // 自包含 Bun Worker 不需要探测旧的 Node/Git runtime 目录；这也避免坏掉的
        // 外部 runtime 在 Windows 上拖慢每次 Agent 启动。
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
            external_runtime.inject_pi_config(&mut config, require_node, true)?;
        }
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
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
        let mut child = command
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

#[cfg(test)]
mod tests {
    use super::{resolve_worker_launch, worker_requires_node, WorkerLaunch};
    use std::path::PathBuf;

    #[test]
    fn packaged_worker_prefers_compiled_executable() {
        assert_eq!(
            resolve_worker_launch(
                Some("C:\\Copis\\resources\\bin\\copis.exe".to_string()),
                Some(
                    "C:\\Copis\\resources\\app.asar.unpacked\\dist\\pi-rpc-worker.cjs".to_string()
                ),
                None,
                Some(PathBuf::from("C:\\runtime\\node.exe")),
                false,
            )
            .unwrap(),
            WorkerLaunch {
                program: PathBuf::from("C:\\Copis\\resources\\bin\\copis.exe"),
                args: vec!["__pi-worker".to_string()],
            }
        );
    }

    #[test]
    fn development_worker_uses_node_script() {
        assert_eq!(
            resolve_worker_launch(
                None,
                Some("/repo/apps/electron/dist/pi-rpc-worker.cjs".to_string()),
                None,
                Some(PathBuf::from("/runtime/node")),
                false,
            )
            .unwrap(),
            WorkerLaunch {
                program: PathBuf::from("/runtime/node"),
                args: vec!["/repo/apps/electron/dist/pi-rpc-worker.cjs".to_string()],
            }
        );
    }

    #[test]
    fn worker_launch_requires_executable_or_script() {
        let error = resolve_worker_launch(
            None,
            None,
            None,
            Some(PathBuf::from("/runtime/node")),
            false,
        )
        .unwrap_err();
        assert_eq!(error, "Pi worker 启动入口未配置");
    }

    #[test]
    fn compiled_worker_does_not_require_node_runtime() {
        assert!(!worker_requires_node(
            Some("C:\\Copis\\resources\\bin\\copis.exe"),
            None,
            false,
        ));
    }

    #[test]
    fn javascript_worker_requires_node_runtime() {
        assert!(worker_requires_node(None, None, false));
        assert!(worker_requires_node(Some("  "), None, false));
    }

    #[test]
    fn development_worker_uses_explicit_bun_runtime() {
        assert_eq!(
            resolve_worker_launch(
                None,
                Some("/repo/apps/electron/src/main/pi-rpc-worker.ts".to_string()),
                Some("/Users/test/.bun/bin/bun".to_string()),
                None,
                true,
            )
            .unwrap(),
            WorkerLaunch {
                program: PathBuf::from("/Users/test/.bun/bin/bun"),
                args: vec!["/repo/apps/electron/src/main/pi-rpc-worker.ts".to_string()],
            }
        );
        assert!(!worker_requires_node(
            None,
            Some("/Users/test/.bun/bin/bun"),
            true,
        ));
    }

    #[test]
    fn development_worker_does_not_fallback_to_node_when_bun_is_missing() {
        let error = resolve_worker_launch(
            None,
            Some("/repo/apps/electron/dist/pi-rpc-worker.cjs".to_string()),
            None,
            Some(PathBuf::from("/runtime/node")),
            true,
        )
        .expect_err("开发模式不能回退到托管 Node runtime");
        assert_eq!(error, "开发 Bun runtime 未配置");
    }
}
