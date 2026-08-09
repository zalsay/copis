use super::{
    dev_server_is_listening, ensure_project_dependencies, normalize_relative_project_path,
    resolve_npm_executable_from, DevServerConfig, WorkspaceDevStore,
};
use std::collections::HashMap;
use std::fs;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn temporary_config_dir(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "copis-workspace-dev-test-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn given_workspace_project_when_listing_then_only_vite_projects_are_returned() {
    let config_dir = temporary_config_dir("list");
    let root = config_dir
        .join("agent-workspaces")
        .join("demo")
        .join("workspace-files")
        .join("project");
    let vite = root.join("landing");
    let ignored = root.join("node_modules").join("ignored");
    fs::create_dir_all(&vite).unwrap();
    fs::create_dir_all(&ignored).unwrap();
    fs::write(
        vite.join("package.json"),
        r#"{"name":"landing-page","scripts":{"dev":"vite"}}"#,
    )
    .unwrap();
    fs::write(
        ignored.join("package.json"),
        r#"{"name":"ignored","scripts":{"dev":"vite"}}"#,
    )
    .unwrap();
    fs::write(
        config_dir.join("agent-workspaces.json"),
        r#"{"workspaces":[{"slug":"demo"}]}"#,
    )
    .unwrap();

    let store = WorkspaceDevStore::open(config_dir.clone());
    let projects = store.list_projects("demo").unwrap();
    let items = projects.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["projectPath"], "landing");
    assert_eq!(items[0]["name"], "landing-page");
    assert_eq!(items[0]["status"], "stopped");

    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_untrusted_project_path_when_normalizing_then_rejects_escape_and_absolute_paths() {
    assert_eq!(
        normalize_relative_project_path("frontend").unwrap(),
        "frontend"
    );
    assert_eq!(normalize_relative_project_path(".").unwrap(), ".");
    assert!(normalize_relative_project_path("../outside").is_err());
    assert!(normalize_relative_project_path("/outside").is_err());
}

#[test]
fn given_saved_port_mapping_when_reopening_store_then_mapping_is_preserved() {
    let config_dir = temporary_config_dir("ports");
    let store = WorkspaceDevStore::open(config_dir.clone());
    let mut ports = HashMap::new();
    ports.insert("demo:landing".to_string(), 5175);

    store.write_config(&DevServerConfig { ports }).unwrap();
    let saved = store.read_config().unwrap();

    assert_eq!(saved.ports.get("demo:landing"), Some(&5175));
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_listening_vite_port_when_checking_readiness_then_reports_available() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(dev_server_is_listening(listener.local_addr().unwrap()));
}

#[test]
fn given_explicit_npm_path_when_resolving_then_it_has_priority() {
    let root = temporary_config_dir("npm-explicit");
    let explicit = root.join("custom-npm");
    let sibling = root.join("bin").join("npm");
    fs::create_dir_all(sibling.parent().unwrap()).unwrap();
    fs::write(&explicit, "").unwrap();
    fs::write(&sibling, "").unwrap();

    let resolved = resolve_npm_executable_from(
        Some(&explicit),
        Some(&root.join("bin").join("node")),
        None,
        &[],
    );

    assert_eq!(resolved.as_deref(), Some(explicit.as_path()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn given_node_runtime_when_resolving_npm_then_use_its_sibling() {
    let root = temporary_config_dir("npm-node");
    let node = root.join("runtime").join("bin").join("node");
    let npm = node.parent().unwrap().join("npm");
    fs::create_dir_all(node.parent().unwrap()).unwrap();
    fs::write(&node, "").unwrap();
    fs::write(&npm, "").unwrap();

    let resolved = resolve_npm_executable_from(None, Some(&node), None, &[]);

    assert_eq!(resolved.as_deref(), Some(npm.as_path()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn given_nvm_installations_when_resolving_npm_then_use_the_newest_version() {
    let root = temporary_config_dir("npm-nvm");
    let older = root.join(".nvm/versions/node/v20.19.0/bin/npm");
    let newer = root.join(".nvm/versions/node/v22.21.1/bin/npm");
    fs::create_dir_all(older.parent().unwrap()).unwrap();
    fs::create_dir_all(newer.parent().unwrap()).unwrap();
    fs::write(&older, "").unwrap();
    fs::write(&newer, "").unwrap();

    let resolved = resolve_npm_executable_from(None, None, Some(&root), &[]);

    assert_eq!(resolved.as_deref(), Some(newer.as_path()));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
fn fake_npm(root: &std::path::Path, behavior: &str) -> std::path::PathBuf {
    let npm = root.join("fake-npm");
    fs::write(
        &npm,
        format!(
            "#!/bin/sh\nprintf '%s' \"$*\" > command.args\n{}\n",
            behavior
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&npm).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&npm, permissions).unwrap();
    npm
}

#[cfg(unix)]
#[test]
fn given_missing_node_modules_when_starting_project_dependencies_then_install_once() {
    let root = temporary_config_dir("install-missing");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let npm = fake_npm(
        &root,
        "if [ \"$1\" = \"install\" ]; then mkdir -p node_modules; exit 0; fi; exit 1",
    );
    let runtime = crate::runtime::resolve_runtime();

    ensure_project_dependencies(&project, &npm, &runtime).unwrap();

    assert!(project.join("node_modules").is_dir());
    assert_eq!(
        fs::read_to_string(project.join("command.args")).unwrap(),
        "install --no-audit --no-fund"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn given_existing_node_modules_when_starting_project_dependencies_then_skip_install() {
    let root = temporary_config_dir("install-existing");
    let project = root.join("project");
    fs::create_dir_all(project.join("node_modules")).unwrap();
    let npm = fake_npm(&root, "touch should-not-run; exit 1");
    let runtime = crate::runtime::resolve_runtime();

    ensure_project_dependencies(&project, &npm, &runtime).unwrap();

    assert!(!project.join("should-not-run").exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn given_npm_install_failure_when_starting_project_dependencies_then_return_output() {
    let root = temporary_config_dir("install-failure");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let npm = fake_npm(&root, "printf '依赖下载失败: vite\n' >&2; exit 17");
    let runtime = crate::runtime::resolve_runtime();

    let error = ensure_project_dependencies(&project, &npm, &runtime).unwrap_err();
    let message = error.to_string();

    assert!(message.contains("npm install 已退出（状态: 17）"));
    assert!(message.contains("依赖下载失败: vite"));
    let _ = fs::remove_dir_all(root);
}
