use super::*;
use serde_json::json;

#[test]
fn parses_auth_status_request() {
    let body = json!({
        "action": "auth.status",
        "sessionId": "session-123"
    })
    .to_string();

    let request = parse_agent_mail_request(body.as_bytes()).expect("should parse");
    assert_eq!(request.action, AgentMailAction::AuthStatus);
    assert_eq!(request.session_id.as_deref(), Some("session-123"));

    let args = build_agent_mail_args(&request).expect("should build args");
    assert_eq!(args, vec!["auth", "status"]);
}

#[test]
fn parses_me_request() {
    let body = json!({
        "action": "me"
    })
    .to_string();

    let request = parse_agent_mail_request(body.as_bytes()).expect("should parse");
    assert_eq!(request.action, AgentMailAction::Me);

    let args = build_agent_mail_args(&request).expect("should build args");
    assert_eq!(args, vec!["+me"]);
}

#[test]
fn parses_message_list_request_with_flags() {
    let body = json!({
        "action": "message.list",
        "dir": "inbox",
        "limit": 10,
        "isUnread": true,
        "hasAttachments": true
    })
    .to_string();

    let request = parse_agent_mail_request(body.as_bytes()).expect("should parse");
    assert_eq!(request.action, AgentMailAction::MessageList);

    let args = build_agent_mail_args(&request).expect("should build args");
    assert_eq!(
        args,
        vec![
            "message",
            "+list",
            "--dir",
            "inbox",
            "--limit",
            "10",
            "--has-attachments",
            "--is-unread"
        ]
    );
}

#[test]
fn parses_message_send_request_with_recipients_and_attachments() {
    let body = json!({
        "action": "message.send",
        "to": ["alice@example.com", "bob@example.com"],
        "cc": ["carol@example.com"],
        "subject": "周报",
        "body": "请查收周报",
        "attachments": ["./report.pdf"],
        "confirmed": true
    })
    .to_string();

    let request = parse_agent_mail_request(body.as_bytes()).expect("should parse");
    assert_eq!(request.action, AgentMailAction::MessageSend);

    let args = build_agent_mail_args(&request).expect("should build args");
    assert_eq!(
        args,
        vec![
            "message",
            "+send",
            "--to",
            "alice@example.com",
            "--to",
            "bob@example.com",
            "--cc",
            "carol@example.com",
            "--subject",
            "周报",
            "--body",
            "请查收周报",
            "--attachment",
            "./report.pdf",
            "--confirmed"
        ]
    );
}

#[test]
fn rejects_unsupported_action() {
    let body = json!({
        "action": "unknown.action"
    })
    .to_string();

    let result = parse_agent_mail_request(body.as_bytes());
    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(err.message.contains("不支持的 Agent Mail action"));
}

#[test]
fn rejects_send_without_to_recipient() {
    let body = json!({
        "action": "message.send",
        "subject": "周报"
    })
    .to_string();

    let request = parse_agent_mail_request(body.as_bytes()).expect("should parse");
    let result = build_agent_mail_args(&request);
    assert!(result.is_err());
    assert!(result.err().unwrap().message.contains("收件人 to 不能为空"));
}
