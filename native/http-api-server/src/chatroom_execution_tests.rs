use super::chatroom_execution::{
    ChatroomExecutionBinding, ChatroomExecutionRegistry, ChatroomOrigin,
};

fn origin(client: u64, socket: u64, auth: u64) -> ChatroomOrigin {
    ChatroomOrigin {
        client_generation: client,
        socket_generation: socket,
        auth_epoch: auth,
    }
}

fn binding(origin: ChatroomOrigin, worker_run_id: &str) -> ChatroomExecutionBinding {
    ChatroomExecutionBinding {
        room_id: "room-a".into(),
        invocation_id: "inv-a".into(),
        target_agent_id: "agent-a".into(),
        session_id: "session-a".into(),
        worker_run_id: worker_run_id.into(),
        origin,
    }
}

#[test]
fn source_must_be_recorded_before_exact_idempotent_execution_binding() {
    let registry = ChatroomExecutionRegistry::default();
    let a = origin(1, 2, 3);
    let owner_a = binding(a, "run-a");

    assert!(!registry.bind(owner_a.clone()));
    assert!(registry.record_source("room-a", "inv-a", "agent-a", a));
    assert!(!registry.record_source("room-a", "inv-a", "agent-a", a));
    assert!(registry.bind(owner_a.clone()));
    assert!(registry.bind(owner_a.clone()));
    assert!(!registry.bind(binding(a, "run-b")));
    assert_eq!(registry.binding("room-a", "inv-a"), Some(owner_a));
}

#[test]
fn first_client_generation_zero_is_valid_for_source_and_exact_execution_binding() {
    let registry = ChatroomExecutionRegistry::default();
    let first_origin = origin(0, 1, 0);
    let mut owner = binding(first_origin, "run-first-origin");
    owner.room_id = "room-a".into();
    owner.invocation_id = "inv-first-origin".into();

    assert!(registry.record_source("room-a", "inv-first-origin", "agent-a", first_origin));
    assert!(registry.bind(owner.clone()));
    assert_eq!(registry.binding("room-a", "inv-first-origin"), Some(owner));
    assert!(!registry.record_source("room-a", "inv-first-origin", "agent-a", first_origin));
    assert!(!registry.record_source("room-b", "inv-zero-socket", "agent-a", origin(0, 0, 0)));
}

#[test]
fn revoke_before_start_blocks_late_start_and_old_release_cannot_clear_new_owner() {
    let registry = ChatroomExecutionRegistry::default();
    let a = origin(1, 2, 3);
    let b = origin(1, 4, 3);
    assert!(registry.record_source("room-a", "inv-a", "agent-a", a));
    assert!(registry.bind(binding(a, "run-a")));
    let revoked = registry.revoke_invocation("room-a", "inv-a").unwrap();
    assert_eq!(revoked.worker_run_id, "run-a");
    assert_eq!(
        registry.with_live_binding("room-a", "inv-a", "session-a", "run-a", || true),
        None
    );

    assert!(registry.record_source("room-a", "inv-b", "agent-a", b));
    let mut owner_b = binding(b, "run-b");
    owner_b.invocation_id = "inv-b".into();
    assert!(registry.bind(owner_b.clone()));
    let old_release = binding(a, "run-a");
    assert!(registry.release(&old_release));
    assert!(!registry.release(&old_release));
    assert_eq!(registry.binding("room-a", "inv-a"), None);
    assert_eq!(
        registry.with_live_binding("room-a", "inv-b", "session-a", "run-b", || true),
        Some(true)
    );
}

#[test]
fn bounded_registry_fails_closed_without_evicting_live_owners() {
    let registry = ChatroomExecutionRegistry::default();
    for index in 0..32 {
        let room = format!("room-{index}");
        let invocation = format!("inv-{index}");
        let source = origin(index + 1, index + 1, 1);
        assert!(registry.record_source(&room, &invocation, "agent-a", source));
        assert!(registry.bind(ChatroomExecutionBinding {
            room_id: room,
            invocation_id: invocation,
            target_agent_id: "agent-a".into(),
            session_id: format!("session-{index}"),
            worker_run_id: format!("run-{index}"),
            origin: source,
        }));
    }
    assert!(registry.record_source(
        "room-overflow",
        "inv-overflow",
        "agent-a",
        origin(90, 90, 1)
    ));
    assert!(!registry.bind(binding(origin(90, 90, 1), "overflow")));
    assert!(registry.binding("room-0", "inv-0").is_some());
}

#[test]
fn normal_release_cleans_source_without_clearing_same_session_replacement() {
    let registry = ChatroomExecutionRegistry::default();
    let a = origin(2, 3, 0);
    let b = origin(2, 4, 0);
    let owner_a = binding(a, "run-a");
    assert!(registry.record_source("room-a", "inv-a", "agent-a", a));
    assert!(registry.bind(owner_a.clone()));
    assert!(registry.release(&owner_a));
    assert!(registry.record_source("room-a", "inv-a", "agent-a", b));
    let owner_b = binding(b, "run-b");
    assert!(registry.bind(owner_b.clone()));
    assert_eq!(
        registry.with_live_binding("room-a", "inv-a", "session-a", "run-b", || true),
        Some(true)
    );
    assert!(!registry.release(&owner_a));
    assert_eq!(registry.binding("room-a", "inv-a"), Some(owner_b));
}

#[test]
fn revoked_binding_remains_retrievable_for_stop_retry_until_native_confirms_exit() {
    let registry = ChatroomExecutionRegistry::default();
    let source = origin(9, 10, 0);
    let binding = binding(source, "run-retry");
    assert!(registry.record_source("room-a", "inv-a", "agent-a", source));
    assert!(registry.bind(binding.clone()));
    assert_eq!(
        registry.revoke_invocation("room-a", "inv-a"),
        Some(binding.clone())
    );
    assert_eq!(
        registry.revoke_invocation("room-a", "inv-a"),
        Some(binding.clone())
    );
    assert_eq!(
        registry.with_live_binding("room-a", "inv-a", "session-a", "run-retry", || true),
        None
    );
    assert!(registry.confirm_native_stop(&binding));
    assert_eq!(registry.revoke_invocation("room-a", "inv-a"), None);
}

#[test]
fn takeover_revokes_only_bindings_from_the_old_socket_origin() {
    let registry = ChatroomExecutionRegistry::default();
    let old = origin(4, 8, 1);
    let current = origin(4, 9, 1);
    assert!(registry.record_source("room-old", "inv-old", "agent-a", old));
    assert!(registry.record_source("room-current", "inv-current", "agent-b", current));
    let old_binding = ChatroomExecutionBinding {
        room_id: "room-old".into(),
        invocation_id: "inv-old".into(),
        target_agent_id: "agent-a".into(),
        session_id: "session-old".into(),
        worker_run_id: "run-old".into(),
        origin: old,
    };
    let current_binding = ChatroomExecutionBinding {
        room_id: "room-current".into(),
        invocation_id: "inv-current".into(),
        target_agent_id: "agent-b".into(),
        session_id: "session-current".into(),
        worker_run_id: "run-current".into(),
        origin: current,
    };
    assert!(registry.bind(old_binding.clone()));
    assert!(registry.bind(current_binding.clone()));
    assert_eq!(
        registry.revoke_stale_sources(4, 9),
        vec![old_binding.clone()]
    );
    assert_eq!(registry.binding("room-old", "inv-old"), None);
    assert_eq!(
        registry.binding("room-current", "inv-current"),
        Some(current_binding)
    );
    assert!(registry.confirm_native_stop(&old_binding));
}

#[test]
fn same_socket_can_complete_three_hundred_sequential_bindings_and_reuse_source_capacity() {
    let registry = ChatroomExecutionRegistry::default();
    let source = origin(22, 35, 4);
    for index in 0..300 {
        let room_id = "continuous-room";
        let invocation_id = format!("inv-{index}");
        let worker_run_id = format!("run-{index}");
        let binding = ChatroomExecutionBinding {
            room_id: room_id.into(),
            invocation_id: invocation_id.clone(),
            target_agent_id: "agent-a".into(),
            session_id: "continuous-session".into(),
            worker_run_id: worker_run_id.clone(),
            origin: source,
        };
        assert!(
            registry.record_source(room_id, &invocation_id, "agent-a", source),
            "source slot {index} should be reusable"
        );
        assert!(
            registry.bind(binding.clone()),
            "owner slot {index} should be reusable"
        );
        assert_eq!(
            registry.with_live_binding(
                room_id,
                &invocation_id,
                "continuous-session",
                &worker_run_id,
                || true
            ),
            Some(true)
        );
        assert!(
            registry.release(&binding),
            "completed owner {index} should release by exact key"
        );
        assert_eq!(registry.binding(room_id, &invocation_id), None);
        assert!(
            !registry.bind(binding),
            "a released Main binding cannot resurrect the same run owner"
        );
    }
}

#[test]
fn completed_bindings_across_socket_generations_reclaim_slots_without_evicting_live_binding() {
    let registry = ChatroomExecutionRegistry::default();
    let live_origin = origin(70, 90, 1);
    let live = ChatroomExecutionBinding {
        room_id: "live-room".into(),
        invocation_id: "live-inv".into(),
        target_agent_id: "agent-a".into(),
        session_id: "live-session".into(),
        worker_run_id: "live-run".into(),
        origin: live_origin,
    };
    assert!(registry.record_source("live-room", "live-inv", "agent-a", live_origin));
    assert!(registry.bind(live.clone()));
    for generation in 1..=300 {
        let source = origin(generation, generation + 1, 0);
        let invocation_id = format!("generation-{generation}");
        let binding = ChatroomExecutionBinding {
            room_id: "generation-room".into(),
            invocation_id: invocation_id.clone(),
            target_agent_id: "agent-a".into(),
            session_id: format!("session-{generation}"),
            worker_run_id: format!("run-{generation}"),
            origin: source,
        };
        assert!(registry.record_source("generation-room", &invocation_id, "agent-a", source));
        assert!(registry.bind(binding.clone()));
        assert!(registry.release(&binding));
    }
    assert_eq!(registry.binding("live-room", "live-inv"), Some(live));
}
