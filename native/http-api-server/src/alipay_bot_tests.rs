use super::{
    build_alipay_bot_args, prepare_alipay_bot_command, resolve_alipay_bot_home,
    sanitize_alipay_output, AlipayBotAction, AlipayBotRequest,
};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn only_supported_wallet_and_payment_actions_build_cli_arguments() {
    let cases = [
        (AlipayBotAction::WalletCheck, vec!["check-wallet"]),
        (
            AlipayBotAction::WalletApply,
            vec!["apply-wallet", "--agent-name", "Copis"],
        ),
        (
            AlipayBotAction::WalletBind,
            vec!["bind-wallet", "--code", "123456"],
        ),
        (AlipayBotAction::WalletClose, vec!["close-wallet"]),
        (
            AlipayBotAction::PaymentCheck,
            vec!["402-query-payment-status", "--trade-no", "trade-1"],
        ),
        (
            AlipayBotAction::PaymentAck,
            vec!["402-buyer-fulfillment-ack", "--trade-no", "trade-1"],
        ),
    ];

    for (action, expected) in cases {
        let request = AlipayBotRequest {
            action,
            agent_name: Some("Copis".to_string()),
            bind_code: Some("123456".to_string()),
            trade_no: Some("trade-1".to_string()),
            ..Default::default()
        };
        assert_eq!(
            build_alipay_bot_args(&request, None).unwrap(),
            expected.into_iter().map(str::to_string).collect::<Vec<_>>()
        );
    }
}

#[test]
fn payment_start_writes_payment_needed_to_a_temporary_file_and_cleans_it_up() {
    let request = AlipayBotRequest {
        action: AlipayBotAction::PaymentStart,
        payment_needed: Some("{\n  \"protocol\": {\"amount\": \"0.01\"}\n}".to_string()),
        resource_url: Some("https://seller.example/prepare".to_string()),
        method: Some("POST".to_string()),
        data: Some(r#"{"resource_id":"R-1"}"#.to_string()),
        headers: vec![("Content-Type".to_string(), "application/json".to_string())],
        ..Default::default()
    };

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "copis-alipay-test-{}-{}",
        std::process::id(),
        suffix
    ));
    let prepared = prepare_alipay_bot_command(&request, &home).unwrap();
    let file_index = prepared
        .args
        .iter()
        .position(|value| value == "--file")
        .unwrap();
    let payment_file = Path::new(&prepared.args[file_index + 1]).to_path_buf();

    assert_eq!(
        &prepared.args[..2],
        &["402-buyer-pay".to_string(), "--file".to_string()]
    );
    assert!(payment_file.starts_with(home.join("tmp")));
    assert_eq!(
        fs::read_to_string(&payment_file).unwrap(),
        request.payment_needed.as_deref().unwrap()
    );
    assert_ne!(
        prepared.args[file_index + 1],
        request.payment_needed.as_deref().unwrap()
    );
    assert!(prepared
        .args
        .iter()
        .any(|value| value == "https://seller.example/prepare"));
    assert!(prepared
        .args
        .iter()
        .any(|value| value == r#"{"resource_id":"R-1"}"#));
    assert!(prepared
        .args
        .iter()
        .any(|value| value == "Content-Type:application/json"));
    assert!(prepared
        .args
        .iter()
        .all(|value| !value.contains(" && ") && !value.contains(';')));

    drop(prepared);
    assert!(!payment_file.exists());
    let _ = fs::remove_dir_all(home);
}

#[test]
fn configured_alipay_home_is_isolated_from_process_home() {
    let fallback = Path::new("/tmp/copis-agent-home/session-1");
    assert_eq!(
        resolve_alipay_bot_home(Some("/tmp/copis-alipay/session-1"), fallback),
        Path::new("/tmp/copis-alipay/session-1")
    );
    assert_eq!(resolve_alipay_bot_home(Some("  "), fallback), fallback);
}

#[test]
fn cli_output_keeps_structured_payment_fields_without_sensitive_raw_text() {
    let output = sanitize_alipay_output(
        "{\"trade_no\":\"trade-1\",\"payment_proof\":\"proof-secret\",\"cashier_url\":\"https://pay.example\"}\nMEDIA: /tmp/openclaw/alipay-bot-cli/qrcode/pay.png\n等待您的支付宝支付",
    );

    assert_eq!(output.trade_no.as_deref(), Some("trade-1"));
    assert_eq!(output.cashier_url.as_deref(), Some("https://pay.example"));
    assert!(output.qr_code_path.is_none());
    assert!(output.payment_proof.is_none());
    assert!(output.raw.is_none());
}

#[test]
fn cli_output_parses_pretty_json_after_cli_diagnostics() {
    let output = sanitize_alipay_output(
        "[alipay-bot-cli] 发现更新\n{\n  \"code\": 200,\n  \"message\": \"已开启支付宝支付功能\"\n}\n",
    );

    assert_eq!(output.code, Some(200));
    assert_eq!(output.message.as_deref(), Some("已开启支付宝支付功能"));
    assert!(output.ok());
}

#[test]
fn unsupported_action_is_rejected_before_cli_execution() {
    let request = AlipayBotRequest {
        action: AlipayBotAction::Unsupported("diamond.purchase".to_string()),
        ..Default::default()
    };

    assert_eq!(
        build_alipay_bot_args(&request, None).unwrap_err().code,
        "unsupported_action"
    );
}

#[test]
fn public_result_does_not_expose_cli_paths_or_payment_proof() {
    let output = sanitize_alipay_output(
        r#"{"success":true,"trade_no":"trade-1","payment_proof":"proof-secret","cashier_url":"https://pay.example"}
MEDIA: /tmp/openclaw/alipay-bot-cli/qrcode/pay.png"#,
    );

    let public = output.to_public_value();
    assert_eq!(
        public.get("tradeNo").and_then(|value| value.as_str()),
        Some("trade-1")
    );
    assert_eq!(
        public.get("cashierUrl").and_then(|value| value.as_str()),
        Some("https://pay.example")
    );
    assert!(public.get("paymentProof").is_none());
    assert!(public.get("qrCodePath").is_none());
    assert!(public.get("raw").is_none());
}
