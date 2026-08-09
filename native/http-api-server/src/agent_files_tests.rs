use super::*;
use std::ffi::OsStr;
use std::fs;
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("copis-agent-files-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn store_for(root: &Path, write_root: &Path) -> (AgentFilePolicyStore, String) {
    let store = AgentFilePolicyStore::new();
    let mut query = Map::new();
    query.insert(
        "cwd".to_string(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    query.insert("useRustFileApi".to_string(), Value::Bool(true));
    query.insert(
        "fileAccessPolicy".to_string(),
        json!({
            "readRoots": [root], "readFiles": [], "writeRoots": [write_root],
            "permissionMode": "bypassPermissions"
        }),
    );
    store.register_from_query("session-1", &mut query).unwrap();
    assert!(!query.contains_key("fileAccessPolicy"));
    (store, "session-1".to_string())
}

fn store_for_plan(root: &Path, write_root: &Path) -> (AgentFilePolicyStore, String) {
    let store = AgentFilePolicyStore::new();
    let mut query = Map::new();
    query.insert(
        "cwd".to_string(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    query.insert("useRustFileApi".to_string(), Value::Bool(true));
    query.insert(
        "fileAccessPolicy".to_string(),
        json!({
            "readRoots": [root], "readFiles": [], "writeRoots": [write_root],
            "permissionMode": "plan"
        }),
    );
    store
        .register_from_query("session-plan", &mut query)
        .unwrap();
    (store, "session-plan".to_string())
}

fn body(session: &str, path: &Path) -> Vec<u8> {
    serde_json::to_vec(&json!({ "sessionId": session, "path": path })).unwrap()
}

#[test]
fn rejects_rust_file_api_without_policy() {
    let store = AgentFilePolicyStore::new();
    let mut query = Map::new();
    query.insert("useRustFileApi".to_string(), Value::Bool(true));

    let error = store
        .register_from_query("session-missing-policy", &mut query)
        .unwrap_err();

    assert_eq!(error, "Rust 文件 API 缺少会话权限策略");
}

#[test]
fn rejects_client_policy_roots_in_file_requests() {
    let root = temp_dir("client-policy");
    let (store, session) = store_for(&root, &root);
    let request = serde_json::to_vec(&json!({
        "sessionId": session,
        "path": root.join("allowed.txt"),
        "readRoots": ["/"],
        "readFiles": ["/etc/passwd"],
        "writeRoots": ["/"]
    }))
    .unwrap();

    let error = store.handle("access", "POST", &request).unwrap_err();

    assert_eq!(error.code, "invalid_request");
    assert_eq!(error.message, "客户端不能提交文件权限根目录");
}

#[test]
fn readonly_workspace_can_read_but_only_copis_root_can_write() {
    let root = temp_dir("readonly");
    let copis = root.join("copis");
    fs::create_dir_all(&copis).unwrap();
    let project_file = root.join("project.txt");
    fs::write(&project_file, "project").unwrap();
    let (store, session) = store_for(&root, &copis);
    assert!(store
        .handle("read", "POST", &body(&session, &project_file))
        .is_ok());
    let project_write =
        serde_json::to_vec(&json!({ "sessionId": session, "path": project_file, "content": "no" }))
            .unwrap();
    assert_eq!(
        store
            .handle("write", "PUT", &project_write)
            .unwrap_err()
            .code,
        "write_not_allowed"
    );
    let copis_file = copis.join("nested/out.txt");
    let copis_write = serde_json::to_vec(
        &json!({ "sessionId": "session-1", "path": copis_file, "content": "yes" }),
    )
    .unwrap();
    assert!(store.handle("write", "PUT", &copis_write).is_ok());
}

#[test]
fn rejects_traversal_and_symlink() {
    let root = temp_dir("symlink");
    let outside = temp_dir("outside");
    fs::write(outside.join("secret.txt"), "secret").unwrap();
    let link = root.join("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&outside, &link).unwrap();
    let (store, session) = store_for(&root, &root);
    let traversal = serde_json::to_vec(
        &json!({ "sessionId": session, "path": root.join(".."), "content": "x" }),
    )
    .unwrap();
    assert_eq!(
        store.handle("write", "PUT", &traversal).unwrap_err().code,
        "path_traversal"
    );
    let linked = body("session-1", &link.join("secret.txt"));
    assert_eq!(
        store.handle("read", "POST", &linked).unwrap_err().code,
        "symlink_not_allowed"
    );
}

#[test]
fn finish_cleanup_removes_private_policy() {
    let root = temp_dir("cleanup");
    let (store, _) = store_for(&root, &root);
    assert!(store.contains("session-1"));
    store.remove("session-1");
    assert!(!store.contains("session-1"));
    let request = body("session-1", &root);
    assert_eq!(
        store.handle("stat", "POST", &request).unwrap_err().code,
        "agent_policy_not_found"
    );
}

#[test]
fn plan_mode_only_allows_markdown_writes_inside_authorized_root() {
    let root = temp_dir("plan");
    let copis = root.join("copis");
    fs::create_dir_all(&copis).unwrap();
    let (store, session) = store_for_plan(&root, &copis);
    let code_file = copis.join("main.ts");
    let code_body =
        serde_json::to_vec(&json!({ "sessionId": session, "path": code_file, "content": "no" }))
            .unwrap();
    assert_eq!(
        store.handle("write", "PUT", &code_body).unwrap_err().code,
        "plan_write_not_allowed"
    );
    let plan_file = copis.join("plan.md");
    let plan_body = serde_json::to_vec(
        &json!({ "sessionId": "session-plan", "path": plan_file, "content": "yes" }),
    )
    .unwrap();
    assert!(store.handle("write", "PUT", &plan_body).is_ok());
}

#[test]
fn running_session_permission_switch_is_enforced_by_rust() {
    let root = temp_dir("permission-switch");
    let copis = root.join("copis");
    fs::create_dir_all(&copis).unwrap();
    let (store, session) = store_for(&root, &copis);
    let code_file = copis.join("main.ts");
    let write_body = serde_json::to_vec(
        &json!({ "sessionId": session, "path": code_file, "content": "export {}" }),
    )
    .unwrap();
    assert!(store.handle("write", "PUT", &write_body).is_ok());

    store.update_permission_mode("session-1", "plan").unwrap();
    assert_eq!(
        store.handle("write", "PUT", &write_body).unwrap_err().code,
        "plan_write_not_allowed"
    );
}

#[test]
fn worker_file_token_cannot_access_another_session_policy() {
    let root = temp_dir("worker-token");
    let file = root.join("note.txt");
    fs::write(&file, "secret").unwrap();
    let store = AgentFilePolicyStore::new();
    let mut query = Map::new();
    query.insert(
        "cwd".to_string(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    query.insert("useRustFileApi".to_string(), Value::Bool(true));
    query.insert(
        "fileAccessPolicy".to_string(),
        json!({
            "readRoots": [root], "readFiles": [], "writeRoots": [root],
            "permissionMode": "bypassPermissions"
        }),
    );
    let token = store.register_from_query("session-1", &mut query).unwrap();
    let request = body("session-1", &file);

    assert_eq!(
        store
            .handle_with_worker_token("read", "POST", "not-the-worker-token", &request)
            .unwrap_err()
            .code,
        "agent_file_token_invalid"
    );
    assert!(store
        .handle_with_worker_token("read", "POST", &token, &request)
        .is_ok());
}

#[test]
fn project_shell_requires_writable_mode_and_authorized_cwd() {
    let root = temp_dir("shell-policy");
    let copis = root.join("copis");
    fs::create_dir_all(&copis).unwrap();
    let store = AgentFilePolicyStore::new();
    let mut query = Map::new();
    query.insert(
        "cwd".to_string(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    query.insert("useRustFileApi".to_string(), Value::Bool(true));
    query.insert(
        "fileAccessPolicy".to_string(),
        json!({
            "readRoots": [root], "readFiles": [], "writeRoots": [copis],
            "permissionMode": "plan"
        }),
    );
    let token = store
        .register_from_query("shell-session", &mut query)
        .unwrap();
    let request = serde_json::to_vec(&json!({
        "sessionId": "shell-session", "command": "npm install", "cwd": copis,
    }))
    .unwrap();
    assert_eq!(
        store
            .handle_shell_with_worker_token(&token, &request)
            .unwrap_err()
            .code,
        "plan_command_not_allowed"
    );

    store
        .update_permission_mode("shell-session", "bypassPermissions")
        .unwrap();
    let outside_cwd = serde_json::to_vec(&json!({
        "sessionId": "shell-session", "command": "npm install", "cwd": root,
    }))
    .unwrap();
    assert_eq!(
        store
            .handle_shell_with_worker_token(&token, &outside_cwd)
            .unwrap_err()
            .code,
        "write_not_allowed"
    );
}

#[test]
fn project_shell_rejects_composition_and_global_package_targets() {
    assert_eq!(
        validate_project_command("npm install && npm run build")
            .unwrap_err()
            .code,
        "command_syntax_not_allowed"
    );
    assert_eq!(
        validate_project_command("npm install --global vite")
            .unwrap_err()
            .code,
        "command_scope_not_allowed"
    );
    assert!(validate_project_command("npm install").is_ok());
    assert!(validate_project_command("npm run build").is_ok());
    assert!(validate_project_command("python3 -m pip install -r requirements.txt").is_ok());
}

#[test]
fn project_command_environment_uses_copis_runtime_path() {
    let mut command = Command::new("sh");
    configure_project_command_environment(&mut command);
    let expected = crate::runtime::resolve_runtime().path_value();
    let configured = command
        .get_envs()
        .find(|(key, _)| *key == OsStr::new("PATH"))
        .and_then(|(_, value)| value)
        .and_then(OsStr::to_str);

    assert_eq!(configured, Some(expected.as_str()));
}
