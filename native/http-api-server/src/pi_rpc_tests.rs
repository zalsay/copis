use super::{
    configure_payment_worker_capability, configure_worker_file_capability,
    is_copis_working_channel_id, parse_payment_worker_result, payment_worker_command,
    permission_mode_command, resolve_worker_launch, stop_command, worker_requires_node,
    PaymentWorkerAction, PiWorkerManager, PiWorkerRunState, PiWorkerStatusSnapshot, WorkerLaunch,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant};

static NEXT_FAKE_WORKER_DIR: AtomicUsize = AtomicUsize::new(0);

#[cfg(unix)]
fn fake_worker_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "copis-pi-fake-worker-{}-{}",
        std::process::id(),
        NEXT_FAKE_WORKER_DIR.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[cfg(unix)]
fn fake_worker_config(
    session_id: &str,
    root: &std::path::Path,
    padding_bytes: usize,
) -> serde_json::Value {
    json!({
        "sessionId": session_id,
        "padding": "x".repeat(padding_bytes),
        "query": {
            "sessionId": session_id,
            "cwd": root,
            "channelId": "fake-provider",
            "model": "no-model-call",
            "permissionMode": "bypassPermissions",
            "triggeredBy": "user",
            "automationEnabled": true,
            "useRustFileApi": true,
            "fileAccessPolicy": {
                "readRoots": [root],
                "readFiles": [],
                "writeRoots": [root],
                "permissionMode": "bypassPermissions"
            }
        }
    })
}

#[cfg(unix)]
fn fake_ordinary_worker_config(session_id: &str, root: &std::path::Path) -> serde_json::Value {
    fake_worker_config(session_id, root, 0)
}

#[cfg(unix)]
fn fake_sleep_launch() -> WorkerLaunch {
    WorkerLaunch {
        program: PathBuf::from("/bin/sleep"),
        args: vec!["30".to_string()],
    }
}

#[cfg(unix)]
fn fake_short_nonreader_launch() -> WorkerLaunch {
    WorkerLaunch {
        program: PathBuf::from("/bin/sleep"),
        args: vec!["0.8".to_string()],
    }
}

#[test]
fn agent_stop_cancels_startup_reserved_before_prepare_returns() {
    let manager = Arc::new(PiWorkerManager::new());
    let reservation = manager.reserve_startup("prepare-session").unwrap();
    let (prepared_tx, prepared_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let start_manager = Arc::clone(&manager);
    let late_reservation = reservation.clone();

    let late_start = thread::spawn(move || {
        prepared_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        start_manager.start_reserved(&late_reservation, json!({}))
    });

    prepared_rx.recv().unwrap();
    assert!(manager.stop("prepare-session").unwrap());
    release_tx.send(()).unwrap();
    let start_result = late_start.join().unwrap();

    let error = match start_result {
        Ok(_) => panic!("已撤销的 prepare 不得启动 Worker"),
        Err(error) => error,
    };
    assert!(error.contains("startup 已取消"));
    assert!(!manager.is_active("prepare-session"));
    let replacement = manager.reserve_startup("prepare-session").unwrap();
    manager.abandon_startup(&reservation);
    assert!(manager.start_reserved(&reservation, json!({})).is_err());
    assert!(manager.startup_is_current(&replacement));
    manager.abandon_startup(&replacement);
}

#[test]
fn stop_all_cancels_only_the_current_bounded_pending_startups() {
    let manager = PiWorkerManager::new();
    let first = manager.reserve_startup("session-a").unwrap();
    let second = manager.reserve_startup("session-b").unwrap();

    assert_eq!(manager.stop_all().unwrap(), 2);
    assert!(manager.start_reserved(&first, json!({})).is_err());
    assert!(manager.start_reserved(&second, json!({})).is_err());
    assert_eq!(manager.stop_all().unwrap(), 0);
}

#[test]
fn pending_startup_reservations_are_bounded() {
    let manager = PiWorkerManager::new();
    let reservations = (0..32)
        .map(|index| manager.reserve_startup(&format!("session-{index}")))
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(manager.reserve_startup("overflow-session").is_err());
    for reservation in reservations {
        manager.abandon_startup(&reservation);
    }
    assert!(manager.reserve_startup("after-release").is_ok());
}

#[test]
fn reserve_startup_rejects_session_with_active_worker_before_resource_setup() {
    let manager = PiWorkerManager::new();
    manager.worker_statuses.lock().unwrap().insert(
        "active-session".to_string(),
        PiWorkerStatusSnapshot {
            session_id: "active-session".to_string(),
            state: PiWorkerRunState::Running,
            permission_mode: "bypassPermissions".to_string(),
        },
    );

    assert!(manager.reserve_startup("active-session").is_err());
    assert!(manager
        .startup_reservations
        .lock()
        .unwrap()
        .by_session
        .is_empty());
}

#[cfg(unix)]
#[test]
fn stale_a_stop_and_finish_cannot_revoke_or_remove_same_session_worker_b() {
    let manager = PiWorkerManager::new();
    let root = fake_worker_root();
    let session_id = "same-session-a-b";
    let reservation_a = manager
        .reserve_startup_for(session_id, Some("run-a".to_string()))
        .unwrap();
    let run_a = manager
        .start_reserved_with_launch(
            &reservation_a,
            fake_ordinary_worker_config(session_id, &root),
            Some(fake_sleep_launch()),
        )
        .unwrap();
    let file_token_a = run_a.control.file_api_token.clone();
    let worker_token_a = run_a.control.worker_capability_token.clone().unwrap();
    assert!(manager
        .reserve_startup_for(session_id, Some("duplicate-run".to_string()))
        .is_err());
    assert!(manager
        .file_policies
        .contains_worker_token(session_id, &file_token_a));
    assert!(
        super::super::automation::worker_automation_context(session_id, &worker_token_a).is_ok()
    );

    let stopped_a = manager.stop_owned(session_id, Some("run-a")).unwrap();
    let active_after_stop_a = manager.is_active(session_id);
    let file_a_revoked = !manager
        .file_policies
        .contains_worker_token(session_id, &file_token_a);
    let automation_a_revoked =
        super::super::automation::worker_automation_context(session_id, &worker_token_a).is_err();

    let reservation_b = manager
        .reserve_startup_for(session_id, Some("run-b".to_string()))
        .unwrap();
    let run_b = manager
        .start_reserved_with_launch(
            &reservation_b,
            fake_ordinary_worker_config(session_id, &root),
            Some(fake_sleep_launch()),
        )
        .unwrap();
    let file_token_b = run_b.control.file_api_token.clone();
    let worker_token_b = run_b.control.worker_capability_token.clone().unwrap();
    assert_ne!(file_token_a, file_token_b);
    assert_ne!(worker_token_a, worker_token_b);

    let stale_stop_a = !manager.stop_owned(session_id, Some("run-a")).unwrap();
    manager.finish(run_a);

    let active_after_finish_a = manager.is_active(session_id);
    let file_b_retained = manager
        .file_policies
        .contains_worker_token(session_id, &file_token_b);
    let automation_b_retained =
        super::super::automation::worker_automation_context(session_id, &worker_token_b).is_ok();

    let stopped_b = manager.stop_owned(session_id, Some("run-b")).unwrap();
    let file_b_revoked = !manager
        .file_policies
        .contains_worker_token(session_id, &file_token_b);
    let automation_b_revoked =
        super::super::automation::worker_automation_context(session_id, &worker_token_b).is_err();
    manager.finish(run_b);
    fs::remove_dir_all(root).unwrap();

    assert!(stopped_a);
    assert!(!active_after_stop_a);
    assert!(file_a_revoked && automation_a_revoked);
    assert!(stale_stop_a);
    assert!(active_after_finish_a);
    assert!(file_b_retained && automation_b_retained);
    assert!(stopped_b);
    assert!(file_b_revoked && automation_b_revoked);
}

#[cfg(unix)]
#[test]
fn stop_of_nonreading_worker_does_not_wait_for_pipe_write_or_block_other_session() {
    let manager = Arc::new(PiWorkerManager::new());
    let root = fake_worker_root();
    let session_b = "small-worker-b";
    let reservation_b = manager
        .reserve_startup_for(session_b, Some("run-b".to_string()))
        .unwrap();
    let run_b = manager
        .start_reserved_with_launch(
            &reservation_b,
            fake_ordinary_worker_config(session_b, &root),
            Some(fake_sleep_launch()),
        )
        .unwrap();

    let session_a = "large-nonreader-a";
    let reservation_a = manager
        .reserve_startup_for(session_a, Some("large-run-a".to_string()))
        .unwrap();
    let start_manager = Arc::clone(&manager);
    let mut large_config = fake_ordinary_worker_config(session_a, &root);
    large_config["padding"] = json!("x".repeat(2 * 1024 * 1024));
    let (result_tx, result_rx) = mpsc::channel();
    let start_a = thread::spawn(move || {
        let result = start_manager.start_reserved_with_launch(
            &reservation_a,
            large_config,
            Some(fake_short_nonreader_launch()),
        );
        result_tx.send(result).unwrap();
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    while !manager.is_active(session_a) && Instant::now() < deadline {
        thread::yield_now();
    }
    assert!(
        manager.is_active(session_a),
        "fake Worker 未完成 active owner 登记"
    );
    thread::sleep(Duration::from_millis(50));
    assert!(
        matches!(result_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "大配置 pipe 应阻塞于不读取 stdin 的 fake Worker"
    );

    let stop_started = Instant::now();
    assert!(manager.stop_owned(session_b, Some("run-b")).unwrap());
    let stop_elapsed = stop_started.elapsed();
    let active_a_after_other_session_stop = manager.is_active(session_a);
    assert!(!manager.is_active(session_b));

    start_a.join().unwrap();
    match result_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
        Ok(run) => manager.finish(run),
        Err(_) => {}
    }
    assert!(
        stop_elapsed < Duration::from_millis(400),
        "其它 session 的 stop 被 A 的 pipe write 阻塞: {stop_elapsed:?}"
    );
    assert!(active_a_after_other_session_stop);
    assert!(!manager.is_active(session_a));
    manager.finish(run_b);
    assert!(!manager.is_active(session_a));
    assert!(!manager.is_active(session_b));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn ordinary_worker_session_stop_keeps_the_graceful_stop_command() {
    let manager = PiWorkerManager::new();
    let root = fake_worker_root();
    let session = "ordinary-graceful-stop";
    let reservation = manager
        .reserve_startup_for(session, Some("main-generated-ordinary-run".to_string()))
        .unwrap();
    let run = manager
        .start_reserved_with_fake_worker(&reservation, fake_ordinary_worker_config(session, &root))
        .unwrap();

    assert!(manager.stop(session).unwrap());
    assert!(manager.is_active(session));
    manager.finish(run);

    assert!(!manager.is_active(session));
    fs::remove_dir_all(root).unwrap();
}

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

#[test]
fn given_streaming_assistant_event_without_partial_flag_when_normalizing_then_injects_partial() {
    let mut frame = json!({
        "type": "event",
        "sessionId": "session-test",
        "payload": {
            "kind": "sdk_message",
            "message": {
                "type": "assistant",
                "uuid": "test-uuid-1",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "Thinking text" },
                        { "type": "text", "text": "Partial text" }
                    ],
                    "stop_reason": null
                }
            }
        }
    });

    crate::normalize_worker_event_frame(&mut frame);

    let partial = frame["payload"]["message"]["_partial"].as_bool();
    assert_eq!(partial, Some(true));
}

#[test]
fn given_completed_assistant_event_when_normalizing_then_preserves_without_partial() {
    let mut frame = json!({
        "type": "event",
        "sessionId": "session-test",
        "payload": {
            "kind": "sdk_message",
            "message": {
                "type": "assistant",
                "uuid": "test-uuid-2",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "Thinking text" },
                        { "type": "text", "text": "Final text" }
                    ],
                    "stop_reason": "stop"
                }
            }
        }
    });

    crate::normalize_worker_event_frame(&mut frame);

    assert!(frame["payload"]["message"].get("_partial").is_none());
}

struct PaymentModelAuthStorage;

impl crate::auth_session::AuthStorage for PaymentModelAuthStorage {
    fn load(
        &self,
    ) -> Result<Option<crate::auth_session::PersistedAuth>, crate::auth_session::AuthError> {
        Ok(Some(crate::auth_session::PersistedAuth {
            access_token: "payment-model-access".to_string(),
            refresh_token: Some("payment-model-refresh".to_string()),
            provider: "legacy".to_string(),
            user: Some(json!({"ID": 7})),
            expires_at: Some(4_000_000_000),
        }))
    }

    fn save(
        &self,
        _auth: &crate::auth_session::PersistedAuth,
    ) -> Result<(), crate::auth_session::AuthError> {
        Ok(())
    }

    fn clear(&self) -> Result<(), crate::auth_session::AuthError> {
        Ok(())
    }
}

#[derive(Default)]
struct PaymentModelAuthTransport {
    calls: std::sync::Mutex<Vec<crate::edu_api_client::EduApiRequest>>,
}

impl crate::edu_api_client::EduApiTransport for PaymentModelAuthTransport {
    fn send(
        &self,
        request: crate::edu_api_client::EduApiRequest,
    ) -> Result<crate::edu_api_client::EduApiResponse, crate::edu_api_client::EduApiError> {
        let body = match request.path.as_str() {
            "/api/internal/working-desktop/payment-capabilities" => {
                br#"{"data":{"capability":"wdpc_payment_model_test"}}"#.to_vec()
            }
            "/api/auth/refresh" => {
                br#"{"token":"payment-model-refreshed","refresh_token":"payment-model-refresh"}"#
                    .to_vec()
            }
            _ => br#"{"id":"response-payment","usage":{"input_tokens":10,"output_tokens":5}}"#
                .to_vec(),
        };
        self.calls.lock().unwrap().push(request);
        Ok(crate::edu_api_client::EduApiResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body,
        })
    }
}

fn payment_model_fixture(
    model_base_url: Option<&str>,
) -> (PiWorkerManager, Arc<PaymentModelAuthTransport>) {
    let transport = Arc::new(PaymentModelAuthTransport::default());
    let client = Arc::new(
        crate::edu_api_client::EduApiClient::new(
            "https://payment-model.example.test",
            transport.clone(),
            4,
        )
        .unwrap(),
    );
    let auth = Arc::new(
        crate::auth_session::AuthSession::new(client, Arc::new(PaymentModelAuthStorage)).unwrap(),
    );
    let proxy = match model_base_url {
        Some(base) => crate::working_model_proxy::WorkingModelProxy::with_model_client(
            auth,
            crate::model_request_client::ModelRequestClient::new(base, 5).unwrap(),
        ),
        None => crate::working_model_proxy::WorkingModelProxy::new(auth).unwrap(),
    };
    let manager = PiWorkerManager::new();
    manager.set_working_model_proxy(Arc::new(proxy));
    (manager, transport)
}

#[test]
fn given_payment_conversation_when_preparing_model_then_server_grant_stays_out_of_worker_config() {
    for flow in ["diamond", "vip"] {
        let (base_url, probe) = payment_model_probe_server(true);
        let (manager, transport) = payment_model_fixture(Some(&base_url));
        let mut config = json!({"query": {
            "channelId": "copis-working", "model": "fast", "workingPaymentFlow": flow
        }});

        let capability = manager
            .prepare_working_model_config("payment-conversation", &mut config)
            .unwrap()
            .unwrap();
        let response = manager
            .working_model_request(
                "payment-conversation",
                &capability.capability,
                br#"{"model":"fast"}"#,
            )
            .unwrap();

        assert_eq!(response.status, 200);
        assert!(capability.capability.starts_with("cwm_pay_"));
        assert_eq!(capability.capability.len(), 72);
        probe.join().unwrap();
        assert!(!config.to_string().contains("wdpc_payment_model_test"));
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].path,
            "/api/internal/working-desktop/payment-capabilities"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(calls[0].body.as_ref().unwrap()).unwrap(),
            json!({"flow_kind": flow})
        );
        assert!(calls[1].headers.contains(&(
            "X-Working-Model-Source-Type".to_string(),
            "copis-payment-model".to_string()
        )));
        assert!(calls[1].headers.contains(&(
            "X-Working-Payment-Capability".to_string(),
            "wdpc_payment_model_test".to_string()
        )));
    }
}

#[test]
fn given_invalid_payment_flow_or_model_when_preparing_worker_then_reject_before_authorizing() {
    for (flow, channel, model) in [
        ("other", "copis-working", "fast"),
        ("diamond", "custom-provider", "fast"),
        ("diamond", "copis-working", "expert"),
    ] {
        let (manager, transport) = payment_model_fixture(None);
        let mut config = json!({"query": {
            "channelId": channel, "model": model, "workingPaymentFlow": flow
        }});

        assert!(manager
            .prepare_working_model_config("payment-conversation", &mut config)
            .is_err());
        assert!(transport.calls.lock().unwrap().is_empty());
    }
}

fn payment_model_probe_server(supported: bool) -> (String, thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut header = Vec::new();
        let mut byte = [0u8; 1];
        while !header.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
        }
        assert!(String::from_utf8(header)
            .unwrap()
            .starts_with("GET /config?alias=fast HTTP/1.1"));
        let body = json!({"data":{"alias":"fast"},"capabilities":{"copis_payment_billing_exempt":supported}}).to_string();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    (base, server)
}

#[test]
fn given_old_model_service_when_starting_payment_conversation_then_never_fall_back_to_billing() {
    let (base, probe) = payment_model_probe_server(false);
    let (manager, transport) = payment_model_fixture(Some(&base));
    let mut config = json!({"query": {
        "channelId": "copis-working", "model": "fast", "workingPaymentFlow": "diamond"
    }});

    let result = manager.prepare_working_model_config("payment-conversation", &mut config);

    assert!(result.is_err());
    probe.join().unwrap();
    assert!(transport.calls.lock().unwrap().is_empty());
}

#[test]
fn given_payment_model_stream_when_access_token_refreshes_then_exemption_and_idempotency_are_preserved(
) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, content_type, body) in [
            ("200 OK", "application/json", r#"{"capabilities":{"copis_payment_billing_exempt":true}}"#),
            ("401 Unauthorized", "application/json", r#"{"error":"expired"}"#),
            ("200 OK", "text/event-stream", "event: response.completed\ndata: {\"response\":{\"id\":\"payment-response\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n"),
        ] {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut header = Vec::new();
            let mut byte = [0u8; 1];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let length = header.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
            }).unwrap_or(0);
            let mut payload = vec![0u8; length];
            socket.read_exact(&mut payload).unwrap();
            requests.push(header.to_lowercase());
            write!(socket, "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, content_type, body.len(), body).unwrap();
        }
        requests
    });
    let (manager, transport) = payment_model_fixture(Some(&base));
    let mut config = json!({"query": {
        "channelId": "copis-working", "model": "fast", "workingPaymentFlow": "diamond"
    }});
    let capability = manager
        .prepare_working_model_config("payment-stream", &mut config)
        .unwrap()
        .unwrap();

    let mut response = manager
        .working_model_stream_request(
            Some(&capability.capability),
            false,
            br#"{"model":"fast","stream":true}"#,
            Some("payment-request-00000001"),
        )
        .unwrap();
    let mut body = String::new();
    response.body.read_to_string(&mut body).unwrap();

    assert_eq!(response.status, 200);
    assert!(body.contains("payment-response"));
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("get /config?alias=fast "));
    for request in &requests[1..] {
        assert!(request.starts_with("post /v1/responses "));
        assert!(request.contains("x-working-model-source-type: copis-payment-model\r\n"));
        assert!(request.contains("x-working-payment-capability: wdpc_payment_model_test\r\n"));
        assert!(request.contains("idempotency-key: payment-request-00000001\r\n"));
    }
    assert!(requests[1].contains("authorization: bearer payment-model-access\r\n"));
    assert!(requests[2].contains("authorization: bearer payment-model-refreshed\r\n"));
    assert_eq!(transport.calls.lock().unwrap().len(), 2);
}

#[test]
fn given_normal_conversation_with_payment_text_when_requesting_model_then_billing_source_is_unchanged(
) {
    let (manager, transport) = payment_model_fixture(None);
    let mut config = json!({"query": {"channelId":"copis-working","model":"fast"}});
    let capability = manager
        .prepare_working_model_config("normal-conversation", &mut config)
        .unwrap()
        .unwrap();

    manager
        .working_model_request(
            "normal-conversation",
            &capability.capability,
            r#"{"model":"fast","input":"购买钻石","workingPaymentFlow":"diamond"}"#.as_bytes(),
        )
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].headers,
        vec![(
            "X-Working-Model-Source-Type".to_string(),
            "copis-agent-model".to_string()
        )]
    );
}
