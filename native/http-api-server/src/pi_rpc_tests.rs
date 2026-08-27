use super::{
    configure_payment_worker_capability, configure_worker_file_capability,
    is_copis_working_channel_id, parse_payment_worker_result, payment_worker_command,
    permission_mode_command, resolve_worker_launch, stop_command, worker_requires_node,
    PaymentWorkerAction, PiWorkerManager, PiWorkerRunState, PiWorkerStatusSnapshot, WorkerLaunch,
};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn given_copis_working_channel_family_when_checking_working_model_then_match_prefix() {
    assert!(is_copis_working_channel_id("copis-working"));
    assert!(is_copis_working_channel_id("copis-working-deepseek"));
    assert!(is_copis_working_channel_id("copis-working-zhipu"));
    assert!(is_copis_working_channel_id("copis-working-custom"));
    assert!(!is_copis_working_channel_id("custom-copis-working"));
    assert!(!is_copis_working_channel_id("working"));
}

#[test]
fn worker_only_receives_session_file_capability() {
    let mut command = Command::new("copis");
    command.env("COPIS_HTTP_API_INTERNAL_TOKEN", "admin-token");

    configure_worker_file_capability(&mut command, "session-file-token");

    let variables = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(variables.get("COPIS_HTTP_API_INTERNAL_TOKEN"), Some(&None));
    assert_eq!(
        variables.get("COPIS_PI_FILE_API_TOKEN"),
        Some(&Some("session-file-token".to_string()))
    );
}

#[test]
fn payment_worker_only_receives_its_dedicated_capability() {
    let mut command = Command::new("copis");
    command.env("COPIS_HTTP_API_INTERNAL_TOKEN", "admin-token");
    command.env("COPIS_PI_FILE_API_TOKEN", "agent-file-token");

    configure_payment_worker_capability(&mut command, "payment-token");

    let variables = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(variables.get("COPIS_HTTP_API_INTERNAL_TOKEN"), Some(&None));
    assert_eq!(variables.get("COPIS_PI_FILE_API_TOKEN"), Some(&None));
    assert_eq!(
        variables.get("COPIS_PI_PAYMENT_CAPABILITY_TOKEN"),
        Some(&Some("payment-token".to_string()))
    );
}

#[test]
fn payment_worker_command_has_no_model_or_agent_session_configuration() {
    assert_eq!(
        payment_worker_command(
            "payment-session-1",
            PaymentWorkerAction::WalletCheck,
            json!({})
        ),
        json!({
            "type": "payment",
            "requestId": "payment-session-1",
            "config": {
                "sessionId": "payment-session-1",
                "request": { "action": "wallet.check" },
            },
        }),
    );
}

#[test]
fn payment_worker_result_only_accepts_its_own_structured_response() {
    let result = parse_payment_worker_result(
        b"{\"type\":\"event\",\"sessionId\":\"payment-session-1\"}\n{\"type\":\"payment_result\",\"sessionId\":\"payment-session-1\",\"requestId\":\"payment-session-1\",\"result\":{\"ok\":true,\"tradeNo\":\"trade-1\"}}\n",
        "payment-session-1",
    )
    .unwrap();

    assert_eq!(result, json!({ "ok": true, "tradeNo": "trade-1" }));
    assert!(parse_payment_worker_result(
        b"{\"type\":\"payment_result\",\"sessionId\":\"other-session\",\"result\":{\"ok\":true}}\n",
        "payment-session-1",
    )
    .is_err());
}

#[test]
fn packaged_worker_prefers_compiled_executable() {
    assert_eq!(
        resolve_worker_launch(
            Some("C:\\Copis\\resources\\bin\\copis.exe".to_string()),
            Some("C:\\Copis\\resources\\app.asar.unpacked\\dist\\pi-rpc-worker.cjs".to_string()),
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

#[test]
fn given_no_pi_workers_when_querying_lifecycle_then_rust_is_the_empty_authority() {
    let manager = PiWorkerManager::new();

    assert!(!manager.is_active("session-1"));
    assert!(manager.active_session_ids().is_empty());
    assert!(manager.session_status("session-1").is_none());
    assert!(manager.status_snapshot().is_empty());
    assert_eq!(manager.stop_all().unwrap(), 0);
    assert!(!manager.set_permission_mode("session-1", "plan").unwrap());
}

#[test]
fn given_active_statuses_when_listing_snapshot_then_results_are_sorted_and_observable() {
    let manager = PiWorkerManager::new();
    let mut statuses = manager.worker_statuses.lock().unwrap();
    statuses.insert(
        "session-b".to_string(),
        PiWorkerStatusSnapshot {
            session_id: "session-b".to_string(),
            state: PiWorkerRunState::Stopping,
            permission_mode: "plan".to_string(),
        },
    );
    statuses.insert(
        "session-a".to_string(),
        PiWorkerStatusSnapshot {
            session_id: "session-a".to_string(),
            state: PiWorkerRunState::Running,
            permission_mode: "bypassPermissions".to_string(),
        },
    );
    drop(statuses);

    assert_eq!(
        manager.status_snapshot(),
        vec![
            PiWorkerStatusSnapshot {
                session_id: "session-a".to_string(),
                state: PiWorkerRunState::Running,
                permission_mode: "bypassPermissions".to_string(),
            },
            PiWorkerStatusSnapshot {
                session_id: "session-b".to_string(),
                state: PiWorkerRunState::Stopping,
                permission_mode: "plan".to_string(),
            },
        ],
    );
}

#[test]
fn given_worker_control_operations_when_serializing_then_protocol_payloads_are_stable() {
    assert_eq!(
        stop_command("session-1"),
        json!({ "type": "stop", "sessionId": "session-1" }),
    );
    assert_eq!(
        permission_mode_command("session-1", "plan"),
        json!({
            "type": "set_permission_mode",
            "sessionId": "session-1",
            "mode": "plan",
        }),
    );
}

#[test]
fn given_invalid_permission_mode_when_switching_then_reject_before_worker_lookup() {
    let manager = PiWorkerManager::new();

    let error = manager
        .set_permission_mode("session-1", "unsafe")
        .unwrap_err();

    assert_eq!(error.code, "invalid_request");
}
