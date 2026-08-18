use super::{
    backend_env_test_lock, civil_date_from_days, extract_skill_archive, handle_request,
    parse_skill_market_route, validate_skill_slug, SkillMarketError, SkillMarketRoute,
    SkillMarketState, WorkingBackend, MARKET_SOURCE_FILE,
};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[test]
fn parses_list_install_and_uninstall_routes() {
    assert_eq!(
        parse_skill_market_route("GET", "/api/working/skill-market?workspaceSlug=demo").unwrap(),
        SkillMarketRoute::List {
            workspace_slug: "demo".to_string(),
        },
    );
    assert_eq!(
        parse_skill_market_route(
            "POST",
            "/api/working/skill-market/12/install?workspaceSlug=demo",
        )
        .unwrap(),
        SkillMarketRoute::Install {
            workspace_slug: "demo".to_string(),
            skill_id: "12".to_string(),
        },
    );
    assert_eq!(
        parse_skill_market_route(
            "DELETE",
            "/api/working/skill-market/12/install?workspaceSlug=demo",
        )
        .unwrap(),
        SkillMarketRoute::Uninstall {
            workspace_slug: "demo".to_string(),
            skill_id: "12".to_string(),
        },
    );
}

#[test]
fn rejects_invalid_skill_slugs() {
    assert!(validate_skill_slug("weekly-report").is_ok());
    assert!(validate_skill_slug("../escape").is_err());
    assert!(validate_skill_slug("contains space").is_err());
    assert!(validate_skill_slug("a/child").is_err());
}

#[test]
fn converts_epoch_days_to_utc_calendar_dates() {
    assert_eq!(civil_date_from_days(0), (1970, 1, 1));
    assert_eq!(civil_date_from_days(20_000), (2024, 10, 4));
}

#[test]
fn extracts_a_skill_archive_inside_the_destination() {
    let mut archive = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut archive);
        writer
            .start_file("weekly-report/SKILL.md", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(b"---\nname: weekly-report\n---\n")
            .unwrap();
        writer.finish().unwrap();
    }
    let destination =
        std::env::temp_dir().join(format!("copis-skill-market-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&destination);
    let root = extract_skill_archive(archive.get_ref(), &destination).unwrap();
    assert!(root.starts_with(&destination));
    assert!(root.join("SKILL.md").is_file());
    let _ = fs::remove_dir_all(&destination);
}

#[test]
fn rejects_zip_slip_paths_before_writing_outside_the_destination() {
    let mut archive = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut archive);
        writer
            .start_file("../escape/SKILL.md", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"unsafe").unwrap();
        writer.finish().unwrap();
    }
    let destination =
        std::env::temp_dir().join(format!("copis-skill-market-slip-{}", std::process::id()));
    let _ = fs::remove_dir_all(&destination);
    assert!(extract_skill_archive(archive.get_ref(), &destination).is_err());
    assert!(!destination.parent().unwrap().join("escape").exists());
    let _ = fs::remove_dir_all(&destination);
}

#[test]
fn handles_market_list_install_and_uninstall_without_electron_bridge() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let suffix = format!("{}-{}", std::process::id(), super::unique_suffix());
    let config_dir = std::env::temp_dir().join(format!("copis-skill-market-e2e-{}", suffix));
    let workspace_dir = config_dir.join("agent-workspaces").join("demo");
    fs::create_dir_all(&workspace_dir).unwrap();
    fs::write(
        config_dir.join("agent-workspaces.json"),
        r#"{"version":2,"workspaces":[{"slug":"demo"}]}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready_tx, ready_rx) = mpsc::channel();
    let backend = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        for _ in 0..5 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request_text = String::from_utf8_lossy(&request);
            let path = request_text.split_whitespace().nth(1).unwrap_or_default();
            let method = request_text.split_whitespace().next().unwrap_or_default();
            let body = match (method, path.split('?').next().unwrap_or(path)) {
                ("GET", "/api/working/expert-skills") => {
                    r#"[{"id":12,"slug":"weekly-report","name":"周报","description":"整理周报","version":"1.2.0","installed":false,"sourceProvider":"skillhub"}]"#
                }
                ("POST", "/api/working/expert-skills/12/install") => {
                    r#"{"id":12,"slug":"weekly-report","name":"周报","description":"整理周报","version":"1.2.0","installed":true,"sourceProvider":"skillhub"}"#
                }
                ("GET", "/api/working/expert-skills/runtime") => {
                    r#"[{"slug":"weekly-report","name":"周报","description":"整理周报","version":"1.2.0","instructions":"生成周报"}]"#
                }
                ("DELETE", "/api/working/expert-skills/12/install") => "{}",
                _ => panic!("unexpected backend request: {} {}", method, path),
            };
            let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    ready_rx.recv().unwrap();

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    let previous_config = std::env::var("COPIS_CONFIG_DIR").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    std::env::set_var("COPIS_CONFIG_DIR", &config_dir);
    let state = SkillMarketState::new(Some("market-token".to_string()));

    let listed = handle_request(
        &state,
        "GET",
        "/api/working/skill-market?workspaceSlug=demo",
        &[],
    )
    .unwrap();
    assert_eq!(listed.status, 200);
    assert_eq!(listed.body.unwrap()[0]["localInstalled"], false);

    let installed = handle_request(
        &state,
        "POST",
        "/api/working/skill-market/12/install?workspaceSlug=demo",
        b"{}",
    )
    .unwrap();
    assert_eq!(installed.status, 200);
    assert!(workspace_dir
        .join(".agents/skills/weekly-report/SKILL.md")
        .is_file());
    assert!(workspace_dir
        .join(".agents/skills/weekly-report/.market.json")
        .is_file());
    let market_source =
        fs::read_to_string(workspace_dir.join(".agents/skills/weekly-report/.market.json"))
            .unwrap();
    assert!(market_source.contains("\"installedAt\": \"20"));
    assert!(market_source.contains('T'));

    let listed_after_install = handle_request(
        &state,
        "GET",
        "/api/working/skill-market?workspaceSlug=demo",
        &[],
    )
    .unwrap();
    assert_eq!(
        listed_after_install.body.unwrap()[0]["localInstalled"],
        true
    );

    let removed = handle_request(
        &state,
        "DELETE",
        "/api/working/skill-market/12/install?workspaceSlug=demo",
        &[],
    )
    .unwrap();
    assert_eq!(removed.status, 204);
    assert!(!workspace_dir.join(".agents/skills/weekly-report").exists());

    backend.join().unwrap();
    match previous_backend {
        Some(value) => std::env::set_var("COPIS_BACKEND_URL", value),
        None => std::env::remove_var("COPIS_BACKEND_URL"),
    }
    match previous_config {
        Some(value) => std::env::set_var("COPIS_CONFIG_DIR", value),
        None => std::env::remove_var("COPIS_CONFIG_DIR"),
    }
    let _ = fs::remove_dir_all(config_dir);
}

fn spawn_market_mock_backend(
    listener: TcpListener,
    delete_flag: Arc<AtomicUsize>,
) -> (
    mpsc::Receiver<()>,
    Arc<AtomicBool>,
    std::thread::JoinHandle<()>,
) {
    let (ready_tx, ready_rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let backend = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        listener.set_nonblocking(true).unwrap();
        while !stop_flag.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            };
            let _ = stream.set_nonblocking(false);
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request_text = String::from_utf8_lossy(&request);
            let path = request_text.split_whitespace().nth(1).unwrap_or_default();
            let method = request_text.split_whitespace().next().unwrap_or_default();
            let body = match (method, path.split('?').next().unwrap_or(path)) {
                ("POST", "/api/working/expert-skills/12/install") => {
                    r#"{"id":12,"slug":"weekly-report","name":"周报","version":"1.2.0","installed":true}"#
                }
                ("GET", "/api/working/expert-skills/runtime") => {
                    // 缺少 instructions 且无下载地址，本地安装必然失败
                    r#"[{"slug":"weekly-report","name":"周报","version":"1.2.0"}]"#
                }
                ("DELETE", "/api/working/expert-skills/12/install") => {
                    delete_flag.fetch_add(1, Ordering::SeqCst);
                    "{}"
                }
                _ => panic!("unexpected backend request: {} {}", method, path),
            };
            let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (ready_rx, stop, backend)
}

#[test]
fn local_install_failure_rolls_back_remote_install() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let suffix = format!("{}-{}", std::process::id(), super::unique_suffix());
    let config_dir = std::env::temp_dir().join(format!("copis-skill-market-rollback-{}", suffix));
    let workspace_dir = config_dir.join("agent-workspaces").join("demo");
    fs::create_dir_all(&workspace_dir).unwrap();
    fs::write(
        config_dir.join("agent-workspaces.json"),
        r#"{"version":2,"workspaces":[{"slug":"demo"}]}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let delete_calls = Arc::new(AtomicUsize::new(0));
    let (ready_rx, stop, backend) = spawn_market_mock_backend(listener, Arc::clone(&delete_calls));
    ready_rx.recv().unwrap();

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    let previous_config = std::env::var("COPIS_CONFIG_DIR").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    std::env::set_var("COPIS_CONFIG_DIR", &config_dir);
    let state = SkillMarketState::new(Some("market-token".to_string()));

    let installed = handle_request(
        &state,
        "POST",
        "/api/working/skill-market/12/install?workspaceSlug=demo",
        b"{}",
    );
    assert!(installed.is_err());
    assert!(!workspace_dir.join(".agents/skills/weekly-report").exists());

    std::thread::sleep(Duration::from_millis(300));
    stop.store(true, Ordering::SeqCst);
    backend.join().unwrap();
    assert_eq!(
        delete_calls.load(Ordering::SeqCst),
        1,
        "本地安装失败后应回滚远端安装状态"
    );

    match previous_backend {
        Some(value) => std::env::set_var("COPIS_BACKEND_URL", value),
        None => std::env::remove_var("COPIS_BACKEND_URL"),
    }
    match previous_config {
        Some(value) => std::env::set_var("COPIS_CONFIG_DIR", value),
        None => std::env::remove_var("COPIS_CONFIG_DIR"),
    }
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn local_install_failure_keeps_remote_when_other_workspace_uses_skill() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let suffix = format!("{}-{}", std::process::id(), super::unique_suffix());
    let config_dir =
        std::env::temp_dir().join(format!("copis-skill-market-no-rollback-{}", suffix));
    let workspace_dir = config_dir.join("agent-workspaces").join("demo");
    let other_skill_dir = config_dir
        .join("agent-workspaces")
        .join("other")
        .join(".agents")
        .join("skills")
        .join("weekly-report");
    fs::create_dir_all(&workspace_dir).unwrap();
    fs::create_dir_all(&other_skill_dir).unwrap();
    fs::write(
        config_dir.join("agent-workspaces.json"),
        r#"{"version":2,"workspaces":[{"slug":"demo"},{"slug":"other"}]}"#,
    )
    .unwrap();
    fs::write(
        other_skill_dir.join(MARKET_SOURCE_FILE),
        r#"{"id":12,"slug":"weekly-report","version":"1.0.0","sourceProvider":"skillhub"}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let delete_calls = Arc::new(AtomicUsize::new(0));
    let (ready_rx, stop, backend) = spawn_market_mock_backend(listener, Arc::clone(&delete_calls));
    ready_rx.recv().unwrap();

    let previous_backend = std::env::var("COPIS_BACKEND_URL").ok();
    let previous_config = std::env::var("COPIS_CONFIG_DIR").ok();
    std::env::set_var("COPIS_BACKEND_URL", format!("http://127.0.0.1:{}", port));
    std::env::set_var("COPIS_CONFIG_DIR", &config_dir);
    let state = SkillMarketState::new(Some("market-token".to_string()));

    let installed = handle_request(
        &state,
        "POST",
        "/api/working/skill-market/12/install?workspaceSlug=demo",
        b"{}",
    );
    assert!(installed.is_err());

    std::thread::sleep(Duration::from_millis(300));
    stop.store(true, Ordering::SeqCst);
    backend.join().unwrap();
    assert_eq!(
        delete_calls.load(Ordering::SeqCst),
        0,
        "其他工作区仍在使用该 Skill 时不应回滚远端安装"
    );

    match previous_backend {
        Some(value) => std::env::set_var("COPIS_BACKEND_URL", value),
        None => std::env::remove_var("COPIS_BACKEND_URL"),
    }
    match previous_config {
        Some(value) => std::env::set_var("COPIS_CONFIG_DIR", value),
        None => std::env::remove_var("COPIS_CONFIG_DIR"),
    }
    let _ = fs::remove_dir_all(config_dir);
}

struct RecordingWorkingBackend {
    calls: Mutex<Vec<(String, String, Option<String>)>>,
}

impl RecordingWorkingBackend {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl WorkingBackend for RecordingWorkingBackend {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value, SkillMarketError> {
        self.calls.lock().unwrap().push((
            method.to_string(),
            path.to_string(),
            body.map(str::to_string),
        ));
        Ok(json!({
            "data": [{
                "id": 12,
                "slug": "weekly-report",
                "installed": false
            }]
        }))
    }
}

#[test]
fn production_backend_requests_working_data_without_user_credentials() {
    let _env_guard = backend_env_test_lock().lock().unwrap();
    let suffix = format!("{}-{}", std::process::id(), super::unique_suffix());
    let config_dir = std::env::temp_dir().join(format!("copis-skill-market-bridge-{}", suffix));
    let workspace_dir = config_dir.join("agent-workspaces").join("demo");
    fs::create_dir_all(&workspace_dir).unwrap();
    fs::write(
        config_dir.join("agent-workspaces.json"),
        r#"{"version":2,"workspaces":[{"slug":"demo"}]}"#,
    )
    .unwrap();

    let previous_config = std::env::var("COPIS_CONFIG_DIR").ok();
    std::env::set_var("COPIS_CONFIG_DIR", &config_dir);
    let backend = Arc::new(RecordingWorkingBackend::new());
    let state = SkillMarketState::production(backend.clone());

    let response = handle_request(
        &state,
        "GET",
        "/api/working/skill-market?workspaceSlug=demo",
        &[],
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(
        backend.calls.lock().unwrap().as_slice(),
        &[(
            "GET".to_string(),
            "/api/working/expert-skills".to_string(),
            None,
        )]
    );

    match previous_config {
        Some(value) => std::env::set_var("COPIS_CONFIG_DIR", value),
        None => std::env::remove_var("COPIS_CONFIG_DIR"),
    }
    let _ = fs::remove_dir_all(config_dir);
}
