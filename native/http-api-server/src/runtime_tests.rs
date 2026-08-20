use super::{
    active_runtime_dir, inject_python_runtime_config_for_root, is_safe_version, runtime_path,
    runtime_roots, ExternalRuntime,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn runtime_without_node() -> ExternalRuntime {
    ExternalRuntime {
        runtime_root: PathBuf::from("/runtime"),
        active_dir: PathBuf::from("/runtime/current"),
        node_path: None,
        git_path: Some(PathBuf::from("/runtime/git")),
        bash_path: if cfg!(windows) {
            Some(PathBuf::from("/runtime/git/bash.exe"))
        } else {
            None
        },
        node_version: None,
        git_version: Some("2.0.0".to_string()),
        bash_version: if cfg!(windows) {
            Some("GNU bash".to_string())
        } else {
            None
        },
        node_error: Some("未找到 node 可执行文件".to_string()),
        git_error: None,
        bash_error: None,
    }
}

#[test]
fn compiled_worker_does_not_require_node_runtime() {
    assert!(runtime_without_node()
        .validate_for_worker(false, false)
        .is_ok());
}

#[test]
fn javascript_worker_still_requires_node_runtime() {
    let error = runtime_without_node()
        .validate_for_worker(true, true)
        .expect_err("JS Worker 必须要求 Node.js runtime");
    assert!(error.contains("Node.js"));
}

#[test]
fn development_bun_worker_can_use_system_runtime() {
    assert!(runtime_without_node()
        .validate_for_worker(false, false)
        .is_ok());
}

#[test]
fn compiled_worker_injects_runtime_config_without_node_path() {
    let runtime = runtime_without_node();
    let mut config = json!({ "query": {} });

    runtime
        .inject_pi_config(&mut config, false, false)
        .expect("编译 Worker 不应因为缺少 Node.js 失败");

    let env = &config["query"]["runtimeEnv"]["env"];
    assert_eq!(env["COPIS_RUNTIME_ROOT"], "/runtime");
    assert!(env["COPIS_NODE_PATH"].is_null());
}

#[test]
fn rejects_unsafe_runtime_version() {
    assert!(!is_safe_version("../other"));
    assert!(!is_safe_version("versions\\other"));
    assert!(is_safe_version("2026.08.04.1"));
}

#[test]
fn resolves_current_version_before_current_directory() {
    let root = std::env::temp_dir().join(format!("copis-runtime-test-{}", std::process::id()));
    let version_dir = root.join("versions").join("test");
    fs::create_dir_all(version_dir.join("node")).expect("create version runtime");
    fs::create_dir_all(root.join("current")).expect("create current runtime");
    fs::write(root.join("current-version.txt"), "test\n").expect("write current version");

    assert_eq!(active_runtime_dir(&root), version_dir);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn resolves_current_version_with_utf8_bom() {
    let root = std::env::temp_dir().join(format!("copis-runtime-bom-test-{}", std::process::id()));
    let version_dir = root.join("versions").join("test");
    fs::create_dir_all(version_dir.join("node")).expect("create version runtime");
    fs::write(root.join("current-version.txt"), "\u{feff}test\r\n").expect("write current version");

    assert_eq!(active_runtime_dir(&root), version_dir);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prepends_external_runtime_directories_to_path() {
    let root = std::env::temp_dir().join(format!("copis-runtime-path-test-{}", std::process::id()));
    fs::create_dir_all(root.join("node")).expect("create node directory");
    fs::create_dir_all(root.join("git").join("cmd")).expect("create git directory");
    let path = runtime_path(&root);
    assert!(path.starts_with(&root.join("node").to_string_lossy().to_string()));
    assert!(path.contains(&root.join("git").join("cmd").to_string_lossy().to_string()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prepends_python_runtime_directories_to_path() {
    let root = std::env::temp_dir().join(format!(
        "copis-python-runtime-path-test-{}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("bin")).expect("create python bin directory");
    fs::create_dir_all(root.join("lib")).expect("create python lib directory");
    let path =
        super::runtime_path_with_python(PathBuf::from("/runtime/current").as_path(), Some(&root));
    let entries = std::env::split_paths(&path).collect::<Vec<_>>();
    assert_eq!(entries.first(), Some(&root.join("bin")));
    assert!(entries.contains(&root));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn injects_python_runtime_into_compiled_worker_config() {
    let root = std::env::temp_dir().join(format!(
        "copis-python-runtime-config-test-{}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("bin")).expect("create python bin directory");
    fs::create_dir_all(root.join("lib")).expect("create python lib directory");
    let mut config = json!({
        "query": {
            "runtimeEnv": {
                "env": { "PATH": "/system/bin:/usr/local/bin" }
            }
        }
    });

    inject_python_runtime_config_for_root(&mut config, &root).expect("inject Python runtime");

    let env = &config["query"]["runtimeEnv"]["env"];
    let path = env["PATH"].as_str().expect("Python PATH");
    let entries = std::env::split_paths(std::ffi::OsStr::new(path)).collect::<Vec<_>>();
    assert_eq!(entries.first(), Some(&root.join("bin")));
    assert!(entries.contains(&PathBuf::from("/system/bin")));
    assert_eq!(
        env["COPIS_PYTHON_RUNTIME_ROOT"],
        root.to_string_lossy().as_ref()
    );
    assert_eq!(env["PYTHONHOME"], root.to_string_lossy().as_ref());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn includes_ai_education_appdata_runtime_root() {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return;
    };
    let expected = std::path::PathBuf::from(app_data)
        .join("com.ai-education.app")
        .join("runtime");
    assert!(runtime_roots().contains(&expected));
}

#[test]
fn probes_configured_external_runtime_when_requested() {
    let Some(root) = std::env::var_os("COPIS_RUNTIME_ROOT") else {
        return;
    };
    let runtime = super::resolve_runtime();
    assert_eq!(runtime.runtime_root, std::path::PathBuf::from(root));
    assert!(
        runtime.node_version.is_some(),
        "外部 Node.js runtime 探测失败: root={}, active={}, path={:?}, error={:?}",
        runtime.runtime_root.display(),
        runtime.active_dir.display(),
        runtime.node_path,
        runtime.node_error
    );
    assert!(
        runtime.git_version.is_some(),
        "外部 Git runtime 探测失败: root={}, active={}, path={:?}, error={:?}",
        runtime.runtime_root.display(),
        runtime.active_dir.display(),
        runtime.git_path,
        runtime.git_error
    );
    if cfg!(windows) {
        assert!(
            runtime.bash_version.is_some(),
            "外部 Git Bash runtime 探测失败"
        );
    }
}
