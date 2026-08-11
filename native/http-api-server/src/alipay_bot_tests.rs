use super::{
    build_alipay_bot_args, execute_alipay_bot, handle_request, prepare_alipay_bot_command,
    resolve_alipay_bot_home, sanitize_alipay_output, AlipayBotAction, AlipayBotRequest,
};
use crate::agent_files::AgentFilePolicyStore;
use crate::payment_capability::PaymentCapabilityStore;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

struct EnvironmentVariableGuard {
    name: &'static str,
    value: Option<std::ffi::OsString>,
}

impl EnvironmentVariableGuard {
    fn set(name: &'static str, value: &Path) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self {
            name,
            value: previous,
        }
    }
}

impl Drop for EnvironmentVariableGuard {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_ref() {
            std::env::set_var(self.name, value);
        } else {
            std::env::remove_var(self.name);
        }
    }
}

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

#[cfg(unix)]
#[test]
fn payment_start_runs_cli_with_wallet_scoped_tmpdir() {
    use std::os::unix::fs::PermissionsExt;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "copis-alipay-runtime-test-{}-{}",
        std::process::id(),
        suffix
    ));
    let command = home.join("fake-alipay-bot.sh");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        &command,
        "#!/bin/sh\ntest \"$TMPDIR\" = \"$HOME/tmp\" || exit 42\nprintf '{\\\"trade_no\\\":\\\"trade-1\\\"}\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();

    let _command_guard = EnvironmentVariableGuard::set("COPIS_ALIPAY_BOT_CLI", &command);
    let _home_guard = EnvironmentVariableGuard::set("COPIS_ALIPAY_BOT_HOME", &home);
    let result = execute_alipay_bot(&AlipayBotRequest {
        action: AlipayBotAction::PaymentStart,
        payment_needed: Some("{\\\"amount\\\":\\\"0.01\\\"}".to_string()),
        resource_url: Some("https://seller.example/prepare".to_string()),
        ..Default::default()
    });

    assert_eq!(result.unwrap().trade_no.as_deref(), Some("trade-1"));
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
fn cli_output_parses_markdown_payment_identifiers() {
    let output = sanitize_alipay_output(
        "**✓ 支付待确认**\n**交易号**：20260703008281200344450000060846\n- **手机端用户**：请 [点击此处](https://u.alipay.cn/example) 唤起支付宝APP完成支付\n",
    );

    assert_eq!(
        output.trade_no.as_deref(),
        Some("20260703008281200344450000060846")
    );
    assert_eq!(
        output.cashier_url.as_deref(),
        Some("https://u.alipay.cn/example")
    );
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

#[test]
fn payment_capability_cannot_fall_back_to_an_agent_file_token() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "copis-alipay-capability-test-{}-{}",
        std::process::id(),
        suffix
    ));
    fs::create_dir_all(&home).unwrap();
    let capabilities = PaymentCapabilityStore::new();
    let _token = capabilities
        .register("payment-session-1", &home, "wallet.check")
        .unwrap();
    let body = br#"{"sessionId":"payment-session-1","action":"wallet.check"}"#;

    let result = handle_request(
        &AgentFilePolicyStore::new(),
        &capabilities,
        "POST",
        None,
        Some("incorrect-payment-token"),
        body,
    );
    let error = match result {
        Ok(_) => panic!("错误的支付 capability 不应被接受"),
        Err(error) => error,
    };

    assert_eq!(error.code, "payment_capability_invalid");
    let _ = fs::remove_dir_all(home);
}

#[cfg(unix)]
#[test]
fn payment_capability_rejects_mismatched_action_before_cli_execution() {
    use std::os::unix::fs::PermissionsExt;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "copis-alipay-capability-action-test-{}-{}",
        std::process::id(),
        suffix
    ));
    let cli = home.join("fake-alipay-bot.sh");
    fs::create_dir_all(&home).unwrap();
    fs::write(&cli, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n").unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();

    let capabilities = PaymentCapabilityStore::new();
    let token = capabilities
        .register("payment-session-1", &home, "wallet.check")
        .unwrap();
    let _cli_guard = EnvironmentVariableGuard::set("COPIS_ALIPAY_BOT_CLI", &cli);
    let body = br#"{"sessionId":"payment-session-1","action":"wallet.close"}"#;

    let result = handle_request(
        &AgentFilePolicyStore::new(),
        &capabilities,
        "POST",
        None,
        Some(&token),
        body,
    );

    let error = match result {
        Ok(_) => panic!("错误的支付 capability action 不应被接受"),
        Err(error) => error,
    };

    assert_eq!(error.code, "payment_capability_invalid");
    let _ = fs::remove_dir_all(home);
}
