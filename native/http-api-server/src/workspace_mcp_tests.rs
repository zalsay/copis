use super::*;
use std::fs;
use std::path::PathBuf;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "copis-workspace-mcp-test-{}-{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn store(directory: &TestDirectory) -> WorkspaceMcpStore {
    WorkspaceMcpStore::open(directory.0.clone())
}

#[test]
fn normalize_keeps_valid_types_and_infers_missing_type() {
    let config = json!({
        "servers": {
            "local": { "command": "npx", "enabled": true },
            "remote": { "url": "http://127.0.0.1:14242/mcp", "enabled": true },
            "alias": { "type": "streamableHttp", "url": "https://example.com/mcp", "enabled": false }
        }
    });
    let normalized = normalize_workspace_mcp_config(config);
    let servers = normalized["servers"].as_object().unwrap();
    assert_eq!(servers["local"]["type"], "stdio");
    assert_eq!(servers["remote"]["type"], "http");
    assert_eq!(servers["alias"]["type"], "http");
}

#[test]
fn normalize_filters_reserved_builtin_keys_and_non_object_entries() {
    let config = json!({
        "servers": {
            "automation": { "command": "npx", "enabled": true },
            "nano_banana": { "command": "npx", "enabled": true },
            "broken": "not-an-object"
        }
    });
    let normalized = normalize_workspace_mcp_config(config);
    let servers = normalized["servers"].as_object().unwrap();
    assert!(servers.is_empty());
}

#[test]
fn normalize_keeps_invalid_explicit_type_unchanged() {
    let config = json!({
        "servers": {
            "odd": { "type": "custom-transport", "command": "npx", "enabled": true }
        }
    });
    let normalized = normalize_workspace_mcp_config(config);
    let servers = normalized["servers"].as_object().unwrap();
    assert_eq!(servers["odd"]["type"], "custom-transport");
}

#[test]
fn save_and_load_round_trip_preserves_normalized_config() {
    let directory = TestDirectory::new();
    let store = store(&directory);
    let config = json!({
        "servers": {
            "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "enabled": true }
        }
    });
    let saved = store.save_config("project-a", config).unwrap();
    assert_eq!(saved["servers"]["filesystem"]["type"], "stdio");

    let loaded = store.get_config("project-a").unwrap();
    assert_eq!(loaded, saved);
    let raw = fs::read_to_string(
        directory
            .0
            .join("agent-workspaces")
            .join("project-a")
            .join("mcp.json"),
    )
    .unwrap();
    assert!(raw.ends_with('\n'));
}

#[test]
fn missing_config_returns_empty_servers() {
    let directory = TestDirectory::new();
    let store = store(&directory);
    let loaded = store.get_config("project-b").unwrap();
    assert_eq!(loaded, json!({ "servers": {} }));
}

#[test]
fn unsafe_slug_is_rejected() {
    let directory = TestDirectory::new();
    let store = store(&directory);
    assert!(matches!(
        store.get_config("../escape"),
        Err(WorkspaceMcpError::InvalidWorkspace)
    ));
    assert!(matches!(
        store.save_config("a/b", json!({ "servers": {} })),
        Err(WorkspaceMcpError::InvalidWorkspace)
    ));
}

#[test]
fn invalid_body_is_rejected() {
    let directory = TestDirectory::new();
    let store = store(&directory);
    assert!(matches!(
        store.save_config("project-c", json!(["not", "an", "object"])),
        Err(WorkspaceMcpError::InvalidConfig(_))
    ));
}
