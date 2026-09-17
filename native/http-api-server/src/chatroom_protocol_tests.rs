use super::chatroom_protocol::*;
use serde_json::{json, Value};

#[test]
fn given_lowercase_backend_url_when_building_ws_url_then_use_wss_and_fixed_path() {
    assert_eq!(
        chatroom_ws_url("https://edu.example/module/edu-api").unwrap(),
        "wss://edu.example/module/edu-api/api/chatrooms/v2/ws"
    );
}

#[test]
fn given_event_json_when_parsing_then_preserve_room_seq_and_payload() {
    let event = parse_event(
        br#"{"type":"message.created","roomId":"room-1","seq":7,"payload":{"messageId":"m-1"}}"#,
    )
    .unwrap();
    assert_eq!(event.room_id(), Some("room-1"));
    assert_eq!(event.seq(), Some(7));
    assert_eq!(event.kind(), "message.created");
}

#[test]
fn given_event_when_serializing_then_emit_phase_one_wire_envelope() {
    let event = ChatroomEvent::MessageCreated {
        room_id: "room-1".into(),
        seq: 7,
        payload: json!({"messageId": "m-1"}),
    };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({"type":"message.created","roomId":"room-1","seq":7,"payload":{"messageId":"m-1"}})
    );
}

#[test]
fn given_depth_three_when_validating_then_reject_without_invocation() {
    assert!(validate_invocation_depth(3).is_err());
    assert!(validate_invocation_depth(2).is_ok());
}

#[test]
fn given_upload_sts_with_extra_fields_when_filtering_then_keep_only_sdk_fields_and_action() {
    let value = json!({
        "data": {
            "bucket":"b", "region":"r", "objectKey":"k", "attachmentId":"att-1",
            "credentials": {
                "tmpSecretId":"id", "tmpSecretKey":"key", "sessionToken":"token",
                "startTime":1, "expiredTime":2
            },
            "expiresAt":"later", "action":"upload", "authorization":"jwt", "raw":"secret"
        }
    });
    let grant = filter_cos_sts(&value, CosAction::Upload).unwrap();
    assert_eq!(grant.attachment_id, "att-1");
    assert_eq!(grant.object_key, "k");
    assert_eq!(
        serde_json::to_value(&grant).unwrap(),
        json!({
            "attachmentId":"att-1", "bucket":"b", "region":"r", "objectKey":"k",
            "tmpSecretId":"id", "tmpSecretKey":"key", "sessionToken":"token",
            "startTime":1, "expiredTime":2, "action":"upload"
        })
    );
    let public = public_event(&ChatroomEvent::LocalStatus {
        room_id: None,
        code: "ok".into(),
        message: "ok".into(),
    });
    assert!(!public.to_string().contains("tmpSecret"));
}

#[test]
fn given_download_sts_with_phase_one_shape_when_filtering_then_emit_download_grant() {
    let value = json!({
        "data": {
            "bucket":"b", "region":"r", "objectKey":"k", "attachmentId":"att-1",
            "credentials": {
                "tmpSecretId":"id", "tmpSecretKey":"key", "sessionToken":"token",
                "startTime":10, "expiredTime":20
            },
            "expiresAt":"later"
        }
    });
    let grant = filter_cos_sts(&value, CosAction::Download).unwrap();
    assert_eq!(grant.action, CosAction::Download);
    assert_eq!(
        serde_json::to_value(CosAction::Download).unwrap(),
        json!("download")
    );
    assert_eq!(serde_json::to_value(grant).unwrap()["action"], "download");
}

#[test]
fn given_cos_grant_without_or_with_invalid_attachment_id_when_filtering_then_reject_stably() {
    let base = json!({
        "data": {
            "bucket":"b", "region":"r", "objectKey":"k",
            "credentials": {
                "tmpSecretId":"id", "tmpSecretKey":"key", "sessionToken":"token",
                "startTime":1, "expiredTime":2
            }
        }
    });
    let long_id = "x".repeat(65);
    for attachment_id in [
        None,
        Some(String::new()),
        Some("att/1".to_string()),
        Some(" att-1".to_string()),
        Some(long_id),
    ] {
        let mut value = base.clone();
        if let Some(attachment_id) = attachment_id {
            value["data"]["attachmentId"] = json!(attachment_id);
        }
        let error = filter_cos_sts(&value, CosAction::Upload).unwrap_err();
        assert_eq!(error.code, "cos_sts_invalid");
    }
}

#[test]
fn given_subscribe_command_when_serializing_then_emit_strict_initial_wire_envelope() {
    let command = ChatroomCommand::Subscribe {
        rooms: vec![RoomCursor {
            room_id: "room-1".into(),
            after_seq: 7,
        }],
        device_id: "device".into(),
    };
    assert_eq!(
        serde_json::to_value(command).unwrap(),
        json!({
            "type": "subscribe",
            "payload": {"roomIds": ["room-1"], "afterSeq": {"room-1": 7}, "deviceId": "device"}
        })
    );
}

#[test]
fn given_upstream_commands_when_serializing_then_emit_exact_dotted_envelopes() {
    let commands = [
        (
            ChatroomCommand::SendMessage {
                room_id: "room-1".into(),
                client_message_id: "client-1".into(),
                content: "hello".into(),
                mention_agent_ids: vec!["agent-1".into()],
                attachment_ids: vec!["attachment-1".into()],
            },
            json!({"type":"message.create","roomId":"room-1","payload":{"content":"hello","mentionAgentIds":["agent-1"],"attachmentIds":["attachment-1"],"clientMessageId":"client-1"}}),
        ),
        (
            ChatroomCommand::AgentAccepted {
                room_id: "room-1".into(),
                invocation_id: "inv-1".into(),
                agent_id: "ignored".into(),
                device_id: "ignored".into(),
            },
            json!({"type":"agent.accepted","roomId":"room-1","payload":{"invocationId":"inv-1"}}),
        ),
        (
            ChatroomCommand::AgentEvent {
                room_id: "room-1".into(),
                invocation_id: "inv-1".into(),
                event: AgentEventPayload::Delta {
                    text: "part".into(),
                },
            },
            json!({"type":"agent.delta","roomId":"room-1","payload":{"invocationId":"inv-1","delta":"part"}}),
        ),
        (
            ChatroomCommand::AgentEvent {
                room_id: "room-1".into(),
                invocation_id: "inv-1".into(),
                event: AgentEventPayload::Completed {
                    content: "done".into(),
                    mention_agent_ids: vec![],
                    attachment_ids: vec![],
                    client_message_id: "reply-1".into(),
                },
            },
            json!({"type":"agent.completed","roomId":"room-1","payload":{"invocationId":"inv-1","content":"done","mentionAgentIds":[],"attachmentIds":[],"clientMessageId":"reply-1"}}),
        ),
        (
            ChatroomCommand::AgentEvent {
                room_id: "room-1".into(),
                invocation_id: "inv-1".into(),
                event: AgentEventPayload::Failed {
                    code: "failed".into(),
                    message: "ignored".into(),
                },
            },
            json!({"type":"agent.failed","roomId":"room-1","payload":{"invocationId":"inv-1","failureCode":"failed"}}),
        ),
        (
            ChatroomCommand::RenewLease {
                room_id: "room-1".into(),
                agent_id: "room-agent-1".into(),
                device_id: "ignored".into(),
            },
            json!({"type":"agent.heartbeat","roomId":"room-1","payload":{"roomAgentId":"room-agent-1"}}),
        ),
        (
            ChatroomCommand::CursorAck {
                room_id: "room-1".into(),
                seq: 8,
            },
            json!({"type":"cursor.ack","roomId":"room-1","payload":{"seq":8}}),
        ),
    ];
    for (command, expected) in commands {
        assert_eq!(serde_json::to_value(command).unwrap(), expected);
    }
}

#[test]
fn given_local_controls_when_serializing_then_reject_instead_of_emitting_upstream_frames() {
    for command in [
        ChatroomCommand::Unsubscribe {
            room_id: "room-1".into(),
        },
        ChatroomCommand::Close,
    ] {
        assert!(serde_json::to_value(command).is_err());
    }
}

#[test]
fn given_all_phase_one_events_when_parsing_then_accept_persisted_and_transient_envelopes() {
    let persisted = [
        "message.created",
        "room.updated",
        "member.removed",
        "agent.updated",
        "attachment.updated",
        "agent.offline",
        "agent.busy",
        "agent.disabled",
        "invocation.limit_reached",
    ];
    for (seq, typ) in persisted.into_iter().enumerate() {
        let input = json!({"type": typ, "roomId": "room-1", "seq": seq + 1, "payload": {"messageId": format!("m-{seq}")}});
        assert!(
            parse_event(&serde_json::to_vec(&input).unwrap()).is_ok(),
            "{typ}"
        );
    }
    for typ in [
        "member.presence_changed",
        "agent.presence_changed",
        "agent.invocation",
        "agent.accepted",
        "agent.delta",
        "agent.completed",
        "agent.failed",
    ] {
        let input = json!({"type": typ, "roomId": "room-1", "payload": {"value": "ok"}});
        assert!(
            parse_event(&serde_json::to_vec(&input).unwrap()).is_ok(),
            "{typ}"
        );
    }
    assert!(
        parse_event(br#"{"type":"error","payload":{"code":"offline","message":"try later"}}"#)
            .is_ok()
    );
}

#[test]
fn given_malformed_or_sensitive_event_when_parsing_then_reject() {
    for input in [
        br#"{"type":"unknown","roomId":"room-1"}"#.as_slice(),
        br#"{"type":"message.created","roomId":"room-1","seq":0}"#.as_slice(),
        br#"{"type":"message.created","roomId":"room-1","seq":1,"authorization":"jwt"}"#.as_slice(),
        br#"{"type":"message.created","roomId":"room-1","seq":1}{"type":"x"}"#.as_slice(),
        br#"{"type":"message.created","roomId":"room-1","seq":1,"payload":{"objectKey":"secret"}}"#
            .as_slice(),
        br#"{"type":"message.created","roomId":"room-1","seq":1,"payload":{"x":1,"x":2}}"#
            .as_slice(),
    ] {
        assert!(
            parse_event(input).is_err(),
            "accepted malformed event: {}",
            String::from_utf8_lossy(input)
        );
    }
}

#[test]
fn given_snapshot_when_parsing_then_expose_latest_seq_without_persistent_seq() {
    let event =
        parse_event(br#"{"type":"room.snapshot","roomId":"room-1","latestSeq":0,"payload":{}}"#)
            .unwrap();
    assert_eq!(event.seq(), None);
    assert_eq!(event.kind(), "room.snapshot");
}

#[test]
fn given_public_message_with_attachment_ids_when_sanitizing_then_keep_ids_and_remove_secrets() {
    let event = ChatroomEvent::MessageCreated {
        room_id: "room-1".into(),
        seq: 1,
        payload: json!({"message":"ok", "attachmentIds":["att-1", "att-2"], "nested":{"accessToken":"secret", "localPath":"/tmp/x"}, "items":[{"sessionToken":"secret"}], "authorization":"Bearer jwt"}),
    };
    let public = public_event(&event);
    assert_eq!(public["roomId"], "room-1");
    assert_eq!(public["seq"], 1);
    assert_eq!(public["payload"]["message"], "ok");
    assert_eq!(
        public["payload"]["attachmentIds"],
        json!(["att-1", "att-2"])
    );
    assert!(!public.to_string().contains("secret"));
}

#[test]
fn given_public_attachment_event_with_cos_grant_when_serializing_then_keep_id_and_filter_grant_secrets(
) {
    let grant = filter_cos_sts(
        &json!({
            "data": {
                "bucket":"b", "region":"r", "objectKey":"private/path",
                "attachmentId":"att-1",
                "credentials": {
                    "tmpSecretId":"id", "tmpSecretKey":"key", "sessionToken":"token",
                    "startTime":1, "expiredTime":2
                },
                "action":"download"
            }
        }),
        CosAction::Download,
    )
    .unwrap();
    let event = ChatroomEvent::AttachmentUpdated {
        room_id: "room-1".into(),
        seq: 2,
        payload: json!({
            "attachmentId":"att-1",
            "grant":serde_json::to_value(grant).unwrap(),
            "Authorization":"Bearer jwt"
        }),
    };

    let public: Value = serde_json::to_value(&event).unwrap();
    assert_eq!(public["payload"]["attachmentId"], "att-1");
    assert_eq!(public["payload"]["grant"]["attachmentId"], "att-1");
    for field in [
        "objectKey",
        "tmpSecretId",
        "tmpSecretKey",
        "sessionToken",
        "Authorization",
    ] {
        assert!(public["payload"].get(field).is_none(), "leaked {field}");
        assert!(
            public["payload"]["grant"].get(field).is_none(),
            "leaked grant {field}"
        );
    }
}

#[test]
fn given_invalid_cos_grant_when_filtering_then_return_stable_error() {
    for value in [
        json!({"bucket":"b"}),
        json!({"data":{"bucket":"b","region":"r","objectKey":"k","attachmentId":"att-1","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"token","startTime":2,"expiredTime":1},"action":"upload"}}),
        json!({"data":{"bucket":"b","region":"r","objectKey":"k","attachmentId":"att-1","credentials":{"tmpSecretId":"id","tmpSecretKey":"key","sessionToken":"token","startTime":1,"expiredTime":2},"action":"download"}}),
    ] {
        let error = filter_cos_sts(&value, CosAction::Upload).unwrap_err();
        assert_eq!(error.code, "cos_sts_invalid");
    }
}

#[test]
fn given_valid_room_ids_when_normalizing_then_reject_path_and_control_injection() {
    assert_eq!(normalize_room_id("room-1").unwrap(), "room-1");
    for room_id in [
        "",
        " ",
        " room-1",
        "room-1 ",
        "../room",
        "room/1",
        "room?x",
        "room\n1",
        &"x".repeat(129),
    ] {
        assert!(
            normalize_room_id(room_id).is_err(),
            "accepted room id {room_id:?}"
        );
    }
}

#[test]
fn given_payload_at_64_kib_when_parsing_then_accept_but_reject_payload_plus_one() {
    for (size, accepted) in [(65_525usize, true), (65_526, false)] {
        let input = json!({
            "type":"agent.delta",
            "roomId":"room-1",
            "payload":{"text":"x".repeat(size)}
        });
        assert_eq!(
            parse_event(&serde_json::to_vec(&input).unwrap()).is_ok(),
            accepted,
            "payload size {size}"
        );
    }
}

#[test]
fn given_frame_larger_than_protocol_limit_when_parsing_then_reject() {
    let input = json!({
        "type":"agent.delta",
        "roomId":"room-1",
        "payload":{"text":"x".repeat(130_000)}
    });
    assert!(parse_event(&serde_json::to_vec(&input).unwrap()).is_err());
}

#[test]
fn given_subscribe_limits_when_serializing_then_enforce_server_boundaries() {
    let room = |index| RoomCursor {
        room_id: format!("room-{index}"),
        after_seq: 0,
    };
    for (rooms, device, accepted) in [
        ((0..50).map(room).collect::<Vec<_>>(), "d".into(), true),
        ((0..51).map(room).collect::<Vec<_>>(), "d".into(), false),
        (vec![room(1)], "d".repeat(128), true),
        (vec![room(1)], "d".repeat(129), false),
        (vec![room(1)], "".into(), false),
        (
            vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: i64::MAX as u64 + 1,
            }],
            "d".into(),
            false,
        ),
    ] {
        let result = serde_json::to_value(ChatroomCommand::Subscribe {
            rooms,
            device_id: device,
        });
        assert_eq!(result.is_ok(), accepted);
    }
}

#[test]
fn given_command_limits_when_serializing_then_reject_invalid_ids_content_and_mentions() {
    let base = |event| ChatroomCommand::AgentEvent {
        room_id: "room-1".into(),
        invocation_id: "inv-1".into(),
        event,
    };
    let commands = [
        ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "c".repeat(129),
            content: "hello".into(),
            mention_agent_ids: vec![],
            attachment_ids: vec![],
        },
        ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "c".into(),
            content: " ".into(),
            mention_agent_ids: vec![],
            attachment_ids: vec![],
        },
        ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "c".into(),
            content: "hello".into(),
            mention_agent_ids: vec!["a".into(); 4],
            attachment_ids: vec![],
        },
        ChatroomCommand::SendMessage {
            room_id: "room-1".into(),
            client_message_id: "c".into(),
            content: "hello".into(),
            mention_agent_ids: vec!["agent/1".into()],
            attachment_ids: vec![],
        },
        base(AgentEventPayload::Delta {
            text: "x".repeat(65_537),
        }),
        base(AgentEventPayload::Completed {
            content: " ".into(),
            mention_agent_ids: vec![],
            attachment_ids: vec![],
            client_message_id: "reply".into(),
        }),
        base(AgentEventPayload::Failed {
            code: "f".repeat(65),
            message: "ignored".into(),
        }),
        ChatroomCommand::AgentAccepted {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            agent_id: "".into(),
            device_id: "device".into(),
        },
        ChatroomCommand::RenewLease {
            room_id: "room-1".into(),
            agent_id: "agent-1".into(),
            device_id: "d".repeat(129),
        },
    ];
    for command in commands {
        assert!(serde_json::to_value(command).is_err());
    }
    assert!(serde_json::to_value(ChatroomCommand::CursorAck {
        room_id: "room-1".into(),
        seq: i64::MAX as u64 + 1
    })
    .is_err());
}

#[test]
fn given_invalid_backend_url_when_building_ws_url_then_reject_query_fragment_or_scheme() {
    for base in [
        "ftp://edu.example",
        "https://edu.example?token=secret",
        "https://edu.example/#fragment",
        "https://edu.example/\nsecret",
        "https://",
    ] {
        assert!(chatroom_ws_url(base).is_err(), "accepted URL {base:?}");
    }
}

#[test]
fn given_public_local_status_when_serializing_then_use_renderer_safe_fields() {
    let value: Value = public_event(&ChatroomEvent::LocalStatus {
        room_id: Some("room-1".into()),
        code: "realtime_gap".into(),
        message: "补拉事件".into(),
    });
    assert_eq!(
        value,
        json!({"type":"local.status","roomId":"room-1","code":"realtime_gap","message":"补拉事件"})
    );
}

#[test]
fn given_non_snapshot_event_when_latest_seq_is_present_then_reject() {
    for typ in ["message.created", "agent.delta"] {
        let value = if typ == "message.created" {
            json!({"type":typ,"roomId":"room-1","seq":1,"latestSeq":2,"payload":{}})
        } else {
            json!({"type":typ,"roomId":"room-1","latestSeq":2,"payload":{}})
        };
        assert!(
            parse_event(&serde_json::to_vec(&value).unwrap()).is_err(),
            "accepted latestSeq for {typ}"
        );
    }
}

#[test]
fn given_room_id_at_edu_api_limit_when_normalizing_then_enforce_64_utf8_bytes() {
    assert_eq!(normalize_room_id(&"r".repeat(64)).unwrap().len(), 64);
    assert!(normalize_room_id(&"r".repeat(65)).is_err());
    assert_eq!(normalize_room_id(&"中".repeat(21)).unwrap().len(), 63);
    assert!(normalize_room_id(&format!("{}中", "r".repeat(62))).is_err());
}

#[test]
fn given_invalid_command_fields_when_serializing_then_reject_before_wire() {
    let commands = [
        ChatroomCommand::SendMessage {
            room_id: "room/1".into(),
            client_message_id: "client-1".into(),
            content: "x".into(),
            mention_agent_ids: vec![],
            attachment_ids: vec![],
        },
        ChatroomCommand::AgentEvent {
            room_id: "room-1".into(),
            invocation_id: "inv-1".into(),
            event: AgentEventPayload::Completed {
                content: "done".into(),
                mention_agent_ids: vec![],
                attachment_ids: vec![],
                client_message_id: "".into(),
            },
        },
        ChatroomCommand::CursorAck {
            room_id: "room-1".into(),
            seq: 0,
        },
        ChatroomCommand::Subscribe {
            rooms: vec![],
            device_id: "device".into(),
        },
        ChatroomCommand::Subscribe {
            rooms: vec![RoomCursor {
                room_id: "room-1".into(),
                after_seq: 0,
            }],
            device_id: "".into(),
        },
    ];
    for command in commands {
        assert!(serde_json::to_value(command).is_err());
    }
}

#[test]
fn given_url_with_whitespace_or_userinfo_when_building_ws_url_then_reject() {
    for base in [
        " https://edu.example",
        "https://edu.example ",
        "https://user@edu.example",
        "https:///path",
    ] {
        assert!(
            chatroom_ws_url(base).is_err(),
            "accepted unsafe backend URL {base:?}"
        );
    }
}

#[test]
fn given_sensitive_scalar_variants_when_parsing_then_reject_case_insensitively() {
    for value in [
        "bEaReR abcdefghijklmnop",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue",
        "QCS::cam::uin/100",
        "/vAr/tmp/private/project",
    ] {
        let event = json!({"type":"agent.delta","roomId":"room-1","payload":{"value":value}});
        assert!(
            parse_event(&serde_json::to_vec(&event).unwrap()).is_err(),
            "accepted sensitive scalar {value}"
        );
    }
}
