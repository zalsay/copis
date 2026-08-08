use super::{normalize_relative_project_path, DevServerConfig, WorkspaceDevStore};
use std::collections::HashMap;
use std::fs;

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
    let root = config_dir.join("agent-workspaces").join("demo").join("workspace-files").join("project");
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
    assert_eq!(normalize_relative_project_path("frontend").unwrap(), "frontend");
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
