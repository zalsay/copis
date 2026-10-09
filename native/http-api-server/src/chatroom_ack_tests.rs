use crate::chatroom_ack::{AckError, PendingCommandAcks};
use crate::chatroom_protocol::PrivateCommandAck;
use std::time::Duration;

fn ack(request_id: &str, ok: bool) -> PrivateCommandAck {
    PrivateCommandAck {
        room_id: "room-1".into(),
        request_id: request_id.into(),
        command: "agent.completed".into(),
        ok,
        invocation_id: Some("inv-1".into()),
        status: Some("completed".into()),
        error_code: (!ok).then(|| "forbidden".into()),
    }
}

#[test]
fn ack_is_bound_to_request_room_command_invocation_and_generation() {
    let pending = PendingCommandAcks::default();
    let receiver = pending
        .register(7, "room-1", "req-1", "agent.completed", Some("inv-1"))
        .unwrap();
    assert_eq!(
        pending.resolve(6, ack("req-1", true)),
        Err(AckError::MismatchedAck)
    );
    assert_eq!(pending.pending_len(), 1);
    pending.resolve(7, ack("req-1", true)).unwrap();
    let confirmed = pending
        .wait("req-1", 7, receiver, Duration::from_millis(10))
        .unwrap();
    assert_eq!(confirmed.invocation_id.as_deref(), Some("inv-1"));
    assert_eq!(confirmed.status.as_deref(), Some("completed"));
    assert_eq!(confirmed.generation, 7);
    assert_eq!(pending.pending_len(), 0);
}

#[test]
fn timeout_cleans_pending_and_negative_ack_is_an_error() {
    let pending = PendingCommandAcks::default();
    let receiver = pending
        .register(3, "room-1", "req-timeout", "agent.completed", Some("inv-1"))
        .unwrap();
    assert_eq!(
        pending.wait("req-timeout", 3, receiver, Duration::from_millis(1)),
        Err(AckError::Timeout)
    );
    assert_eq!(pending.pending_len(), 0);

    let receiver = pending
        .register(3, "room-1", "req-denied", "agent.completed", Some("inv-1"))
        .unwrap();
    pending.resolve(3, ack("req-denied", false)).unwrap();
    assert_eq!(
        pending.wait("req-denied", 3, receiver, Duration::from_millis(10)),
        Err(AckError::Rejected("forbidden".into()))
    );
}

#[test]
fn disconnect_invalidates_only_its_connection_generation() {
    let pending = PendingCommandAcks::default();
    let old = pending
        .register(11, "room-1", "req-old", "agent.completed", Some("inv-1"))
        .unwrap();
    let current = pending
        .register(
            12,
            "room-1",
            "req-current",
            "agent.completed",
            Some("inv-1"),
        )
        .unwrap();
    pending.invalidate_generation(11);
    assert_eq!(
        pending.wait("req-old", 11, old, Duration::from_millis(10)),
        Err(AckError::Disconnected)
    );
    assert_eq!(pending.pending_len(), 1);
    pending.resolve(12, ack("req-current", true)).unwrap();
    assert!(pending
        .wait("req-current", 12, current, Duration::from_millis(10))
        .is_ok());
}

#[test]
fn delayed_old_generation_timeout_does_not_remove_new_registration() {
    let pending = PendingCommandAcks::default();
    let old = pending
        .register(20, "room-1", "same-id", "agent.completed", Some("inv-1"))
        .unwrap();
    pending.invalidate_generation(20);
    let current = pending
        .register(21, "room-1", "same-id", "agent.completed", Some("inv-1"))
        .unwrap();

    assert_eq!(
        pending.resolve(20, ack("same-id", true)),
        Err(AckError::MismatchedAck)
    );
    assert_eq!(pending.pending_len(), 1);
    assert_eq!(
        pending.wait("same-id", 20, old, Duration::from_millis(1)),
        Err(AckError::Disconnected)
    );
    assert_eq!(pending.pending_len(), 1);
    pending.resolve(21, ack("same-id", true)).unwrap();
    let confirmed = pending
        .wait("same-id", 21, current, Duration::from_millis(10))
        .unwrap();
    assert_eq!(confirmed.generation, 21);
}
