    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use super::pi_rpc::{
        format_sse_event, is_agent_messages_route, is_agent_queue_route, is_agent_status_route,
        is_agent_stop_route, is_agent_workers_status_route, is_agent_workers_stop_all_route,
        parse_worker_frame, sse_headers,
    };
    use super::{
        append_recording_line, decode_hex, encode_hex, find_subslice, is_allowed_origin,
        handle_connection, is_internal_path, is_internal_token_valid, is_safe_path_component,
        is_skill_market_path, is_vite_dev_origin, is_web_route_authorized,
        parse_internal_recording_route, recording_marker, Bridge, HttpRequest,
    };

    #[test]
    fn hex_round_trip_supports_utf8() {
        let value = "Copis HTTP API / 测试";
        let encoded = encode_hex(value.as_bytes());
        assert_eq!(
            String::from_utf8(decode_hex(&encoded).unwrap()).unwrap(),
            value
        );
    }

    #[test]
    fn rejects_malformed_hex() {
        assert!(decode_hex("0").is_none());
        assert!(decode_hex("zz").is_none());
    }

    #[test]
    fn finds_http_delimiter() {
        assert_eq!(
            find_subslice(b"GET / HTTP/1.1\r\n\r\n", b"\r\n\r\n"),
            Some(14)
        );
        assert_eq!(find_subslice(b"abc", b"\r\n"), None);
    }

    #[test]
    fn allows_vite_and_packaged_electron_origins() {
        assert!(is_allowed_origin("null"));
    }

    #[test]
    fn parses_only_safe_recording_routes() {
        let route = parse_internal_recording_route(
            "/internal/browser-workflows/recordings/workspace-1/recording-1/event?x=1",
        )
        .unwrap();
        assert_eq!(route.workspace, "workspace-1");
        assert_eq!(route.recording_id, "recording-1");
        assert_eq!(route.action, "event");
        assert!(parse_internal_recording_route(
            "/internal/browser-workflows/recordings/../recording-1/event",
        )
        .is_none());
        assert!(!is_safe_path_component("workspace/escape"));
    }

    #[test]
    fn recording_markers_are_single_jsonl_lines() {
        let marker =
            String::from_utf8(recording_marker("recording-1", "recording_finished")).unwrap();
        assert!(marker.ends_with('}'));
        assert!(!marker.contains('\n'));
        assert!(marker.contains("recording-1"));
    }

    #[test]
    fn appends_valid_jsonl_lines_and_rejects_multiline_payloads() {
        let path =
            std::env::temp_dir().join(format!("copis-recording-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let bridge = Bridge::new();
        append_recording_line(&bridge, &path, br#"{"kind":"recording_started"}"#, true).unwrap();
        append_recording_line(&bridge, &path, br#"{"type":"click"}"#, false).unwrap();
        assert!(append_recording_line(&bridge, &path, b"{\"type\":\"click\"}\n{}", false).is_err());
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn only_allows_vite_origins() {
        assert!(is_allowed_origin("http://127.0.0.1:5174"));
        assert!(is_allowed_origin("http://localhost:5174"));
        assert!(!is_allowed_origin("http://example.com"));
    }

    #[test]
    fn requires_web_token_for_browser_origins() {
        let previous = std::env::var("COPIS_HTTP_API_WEB_TOKEN").ok();
        std::env::set_var("COPIS_HTTP_API_WEB_TOKEN", "web-token-1");

        let without_header = HttpRequest {
            method: "GET".to_string(),
            target: "/api/memory".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert!(!is_web_route_authorized(Some("null"), &without_header, "/api/memory"));

        let mut headers = HashMap::new();
        headers.insert(
            "x-copis-web-token".to_string(),
            "web-token-1".to_string(),
        );
        let with_header = HttpRequest {
            method: "GET".to_string(),
            target: "/api/memory".to_string(),
            headers,
            body: Vec::new(),
        };
        assert!(is_web_route_authorized(Some("null"), &with_header, "/api/memory"));

        let wrong_header = HttpRequest {
            method: "GET".to_string(),
            target: "/api/memory".to_string(),
            headers: HashMap::from([("x-copis-web-token".to_string(), "wrong".to_string())]),
            body: Vec::new(),
        };
        assert!(!is_web_route_authorized(Some("null"), &wrong_header, "/api/memory"));

        match previous {
            Some(value) => std::env::set_var("COPIS_HTTP_API_WEB_TOKEN", value),
            None => std::env::remove_var("COPIS_HTTP_API_WEB_TOKEN"),
        }
    }

    #[test]
    fn web_token_gate_exempts_vite_origin_and_local_process() {
        let request = HttpRequest {
            method: "GET".to_string(),
            target: "/api/memory".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert!(is_vite_dev_origin("http://127.0.0.1:5174"));
        assert!(is_vite_dev_origin("http://localhost:5174"));
        assert!(!is_vite_dev_origin("http://example.com"));
        assert!(is_web_route_authorized(
            Some("http://127.0.0.1:5174"),
            &request,
            "/api/memory"
        ));
        assert!(is_web_route_authorized(None, &request, "/api/memory"));
    }

    #[test]
    fn web_token_gate_skips_internal_and_health_routes() {
        let request = HttpRequest {
            method: "GET".to_string(),
            target: "/api/health".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert!(is_internal_path("/internal/working-auth/token"));
        assert!(is_internal_path("/api/internal/agent/prepare"));
        assert!(!is_internal_path("/api/memory"));
        assert!(is_web_route_authorized(
            Some("null"),
            &request,
            "/api/health"
        ));
        assert!(is_web_route_authorized(
            Some("null"),
            &request,
            "/internal/working-auth/token"
        ));
        assert!(is_web_route_authorized(
            Some("null"),
            &request,
            "/api/internal/agent/prepare"
        ));
    }

    #[test]
    fn internal_token_uses_constant_time_comparison() {
        assert!(super::agent_files::tokens_equal("abc-123", "abc-123"));
        assert!(!super::agent_files::tokens_equal("abc-123", "abc-124"));
        assert!(!super::agent_files::tokens_equal("abc-123", "abc-12"));
        assert!(!super::agent_files::tokens_equal("abc-123", ""));

        let previous = std::env::var("COPIS_HTTP_API_INTERNAL_TOKEN").ok();
        std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", "internal-token-1");

        let valid = HttpRequest {
            method: "GET".to_string(),
            target: "/internal/working-auth/token".to_string(),
            headers: HashMap::from([("x-copis-internal-token".to_string(), "internal-token-1".to_string())]),
            body: Vec::new(),
        };
        assert!(is_internal_token_valid(&valid));

        let invalid = HttpRequest {
            method: "GET".to_string(),
            target: "/internal/working-auth/token".to_string(),
            headers: HashMap::from([("x-copis-internal-token".to_string(), "internal-token-2".to_string())]),
            body: Vec::new(),
        };
        assert!(!is_internal_token_valid(&invalid));

        let missing = HttpRequest {
            method: "GET".to_string(),
            target: "/internal/working-auth/token".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert!(!is_internal_token_valid(&missing));

        match previous {
            Some(value) => std::env::set_var("COPIS_HTTP_API_INTERNAL_TOKEN", value),
            None => std::env::remove_var("COPIS_HTTP_API_INTERNAL_TOKEN"),
        }
    }

    #[test]
    fn bridge_request_times_out_and_cleans_pending() {
        let previous = std::env::var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS").ok();
        std::env::set_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS", "50");
        let bridge = Bridge::new();
        let request = HttpRequest {
            method: "GET".to_string(),
            target: "/api/example".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let result = bridge.send_request(&request);
        let error = match result {
            Err(message) => message,
            Ok(_) => panic!("预期业务桥超时错误"),
        };
        assert_eq!(error, super::BRIDGE_TIMEOUT_MESSAGE);
        assert!(bridge.pending.lock().unwrap().is_empty());
        match previous {
            Some(value) => std::env::set_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS", value),
            None => std::env::remove_var("COPIS_HTTP_API_BRIDGE_TIMEOUT_MS"),
        }
    }

    #[test]
    fn slow_connection_is_closed_by_read_timeout() {
        let previous = std::env::var("COPIS_HTTP_API_READ_TIMEOUT_MS").ok();
        std::env::set_var("COPIS_HTTP_API_READ_TIMEOUT_MS", "80");

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let directory = std::env::temp_dir().join(format!(
            "copis-http-read-timeout-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let bridge = Arc::new(Bridge::new());
        let workers = Arc::new(super::pi_rpc::PiWorkerManager::new());
        let memory_store = Arc::new(
            super::memory::MemoryStore::open(directory.join("memory")).unwrap(),
        );
        let expert_team_store = Arc::new(
            super::expert_teams::ExpertTeamStore::open(directory.join("expert-teams")).unwrap(),
        );
        let skill_market_state = Arc::new(super::skill_market::SkillMarketState::new(None));
        let workspace_mcp_store =
            Arc::new(super::workspace_mcp::WorkspaceMcpStore::open(directory.join("mcp")));

        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(
                stream,
                bridge,
                workers,
                memory_store,
                expert_team_store,
                skill_market_state,
                workspace_mcp_store,
            );
        });
        let mut client = std::net::TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buffer = Vec::new();
        client.read_to_end(&mut buffer).unwrap();
        server.join().unwrap();
        let text = String::from_utf8_lossy(&buffer);
        assert!(
            text.contains("400"),
            "预期读超时后返回 400，实际响应: {}",
            text
        );

        let _ = std::fs::remove_dir_all(&directory);
        match previous {
            Some(value) => std::env::set_var("COPIS_HTTP_API_READ_TIMEOUT_MS", value),
            None => std::env::remove_var("COPIS_HTTP_API_READ_TIMEOUT_MS"),
        }
    }

    #[test]
    fn recognizes_only_agent_message_post_as_stream_route() {
        assert!(is_agent_messages_route(
            "POST",
            "/api/agent/sessions/session-1/messages"
        ));
        assert!(!is_agent_messages_route(
            "GET",
            "/api/agent/sessions/session-1/messages"
        ));
        assert!(!is_agent_messages_route("POST", "/api/agent/sessions"));
    }

    #[test]
    fn recognizes_only_agent_stop_post_as_stop_route() {
        assert!(is_agent_stop_route(
            "POST",
            "/api/agent/sessions/session-1/stop"
        ));
        assert!(!is_agent_stop_route(
            "GET",
            "/api/agent/sessions/session-1/stop"
        ));
        assert!(!is_agent_stop_route(
            "POST",
            "/api/agent/sessions/session-1/stop/extra"
        ));
    }

    #[test]
    fn recognizes_only_agent_queue_post_as_queue_route() {
        assert!(is_agent_queue_route(
            "POST",
            "/api/agent/sessions/session-1/queue"
        ));
        assert!(!is_agent_queue_route(
            "GET",
            "/api/agent/sessions/session-1/queue"
        ));
        assert!(!is_agent_queue_route(
            "POST",
            "/api/agent/sessions/session-1/queue/extra"
        ));
    }

    #[test]
    fn recognizes_only_pi_worker_lifecycle_routes() {
        assert!(is_agent_status_route(
            "GET",
            "/api/agent/sessions/session-1/status"
        ));
        assert!(!is_agent_status_route(
            "POST",
            "/api/agent/sessions/session-1/status"
        ));
        assert!(is_agent_workers_status_route(
            "GET",
            "/api/agent/workers/status"
        ));
        assert!(is_agent_workers_stop_all_route(
            "POST",
            "/api/agent/workers/stop-all"
        ));
        assert!(!is_agent_workers_stop_all_route(
            "GET",
            "/api/agent/workers/stop-all"
        ));
    }

    #[test]
    fn recognizes_skill_market_routes_as_rust_owned_routes() {
        assert!(is_skill_market_path("/api/working/skill-market"));
        assert!(is_skill_market_path("/api/working/skill-market/12/install"));
        assert!(!is_skill_market_path("/api/working/skill-markets"));
    }

    #[test]
    fn formats_sse_response_headers_without_content_length() {
        let headers = sse_headers(200);
        assert!(headers.contains("Content-Type: text/event-stream"));
        assert!(headers.contains("Cache-Control: no-cache"));
        assert!(!headers.contains("Content-Length"));
    }

    #[test]
    fn formats_json_as_an_sse_data_frame() {
        assert_eq!(
            format_sse_event(r#"{"type":"text_delta","text":"你好"}"#),
            "data: {\"type\":\"text_delta\",\"text\":\"你好\"}\n\n"
        );
    }

    #[test]
    fn parses_worker_jsonl_frames_without_accepting_non_objects() {
        let frame =
            parse_worker_frame(r#"{"type":"event","sessionId":"s1"}"#).expect("valid worker frame");
        assert_eq!(frame["type"], "event");
        assert!(parse_worker_frame("[]").is_none());
        assert!(parse_worker_frame("not-json").is_none());
    }
