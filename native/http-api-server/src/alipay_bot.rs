use crate::agent_files::AgentFilePolicyStore;
use crate::payment_capability::PaymentCapabilityStore;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_AGENT_NAME: &str = "Copis";
const DEFAULT_ALIPAY_BOT_COMMAND: &str = "alipay-bot";
const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_QR_CODE_BYTES: u64 = 1024 * 1024;
const ALIPAY_BOT_MEDIA_ROOT: &str = "/tmp/openclaw/alipay-bot-cli";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AlipayBotAction {
    WalletCheck,
    WalletApply,
    WalletBind,
    WalletClose,
    PaymentStart,
    PaymentCheck,
    PaymentAck,
    Unsupported(String),
}

impl Default for AlipayBotAction {
    fn default() -> Self {
        Self::Unsupported(String::new())
    }
}

impl AlipayBotAction {
    fn parse(value: &str) -> Self {
        match value.trim() {
            "wallet.check" => Self::WalletCheck,
            "wallet.apply" => Self::WalletApply,
            "wallet.bind" => Self::WalletBind,
            "wallet.close" => Self::WalletClose,
            "payment.start" => Self::PaymentStart,
            "payment.check" => Self::PaymentCheck,
            "payment.ack" => Self::PaymentAck,
            other => Self::Unsupported(other.to_string()),
        }
    }

    fn as_str(&self) -> &str {
        match self {
            Self::WalletCheck => "wallet.check",
            Self::WalletApply => "wallet.apply",
            Self::WalletBind => "wallet.bind",
            Self::WalletClose => "wallet.close",
            Self::PaymentStart => "payment.start",
            Self::PaymentCheck => "payment.check",
            Self::PaymentAck => "payment.ack",
            Self::Unsupported(value) => value,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AlipayBotRequest {
    pub action: AlipayBotAction,
    pub session_id: Option<String>,
    pub agent_name: Option<String>,
    pub bind_code: Option<String>,
    pub payment_needed: Option<String>,
    pub resource_url: Option<String>,
    pub method: Option<String>,
    pub data: Option<String>,
    pub headers: Vec<(String, String)>,
    pub intent_summary: Option<String>,
    pub trade_no: Option<String>,
    pub out_shake_no: Option<String>,
}

#[derive(Debug)]
pub struct AlipayBotError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl AlipayBotError {
    fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_alipay_bot_request", message)
    }
}

pub struct AlipayBotResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Default)]
pub struct AlipayBotOutput {
    pub code: Option<i64>,
    pub success: Option<bool>,
    pub message: Option<String>,
    pub error_code: Option<String>,
    pub trade_no: Option<String>,
    pub out_shake_no: Option<String>,
    pub cashier_url: Option<String>,
    pub access_url: Option<String>,
    pub status: Option<String>,
    pub qr_code_path: Option<String>,
    pub qr_code_image: Option<String>,
    pub qr_code_mime_type: Option<String>,
    pub payment_proof: Option<String>,
    pub client_session: Option<String>,
    pub raw: Option<String>,
}

impl AlipayBotOutput {
    fn ok(&self) -> bool {
        self.success
            .or_else(|| self.code.map(|code| code == 200))
            .unwrap_or(true)
    }

    /// 普通 Agent 只能看到可用于继续流程的展示字段；CLI 原文、二维码本地路径和支付凭证不得外泄。
    pub fn to_public_value(&self) -> Value {
        self.to_value(false)
    }

    /// 设置页支付由 Rust 消费受控检查结果。该值只会从 Pi Worker 返回 Rust，不能返回 Renderer。
    pub fn to_payment_value(&self) -> Value {
        self.to_value(true)
    }

    fn to_value(&self, include_payment_secrets: bool) -> Value {
        let mut value = Map::new();
        value.insert("ok".to_string(), Value::Bool(self.ok()));
        if let Some(code) = self.code {
            value.insert("code".to_string(), json!(code));
        }
        if let Some(success) = self.success {
            value.insert("success".to_string(), json!(success));
        }
        if let Some(message) = self.message.as_deref() {
            value.insert("message".to_string(), json!(message));
        }
        if let Some(error_code) = self.error_code.as_deref() {
            value.insert("errorCode".to_string(), json!(error_code));
        }
        if let Some(trade_no) = self.trade_no.as_deref() {
            value.insert("tradeNo".to_string(), json!(trade_no));
        }
        if let Some(out_shake_no) = self.out_shake_no.as_deref() {
            value.insert("outShakeNo".to_string(), json!(out_shake_no));
        }
        if let Some(cashier_url) = self.cashier_url.as_deref() {
            value.insert("cashierUrl".to_string(), json!(cashier_url));
        }
        if let Some(access_url) = self.access_url.as_deref() {
            value.insert("accessUrl".to_string(), json!(access_url));
        }
        if let Some(status) = self.status.as_deref() {
            value.insert("status".to_string(), json!(status));
        }
        if let Some(qr_code_image) = self.qr_code_image.as_deref() {
            value.insert("qrCodeImage".to_string(), json!(qr_code_image));
        }
        if let Some(qr_code_mime_type) = self.qr_code_mime_type.as_deref() {
            value.insert("qrCodeMimeType".to_string(), json!(qr_code_mime_type));
        }
        if include_payment_secrets {
            if let Some(payment_proof) = self.payment_proof.as_deref() {
                value.insert("paymentProof".to_string(), json!(payment_proof));
            }
            if let Some(client_session) = self.client_session.as_deref() {
                value.insert("clientSession".to_string(), json!(client_session));
            }
        }
        Value::Object(value)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AlipayHeaderInput {
    Pair((String, String)),
    Object { name: String, value: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlipayBotWireRequest {
    session_id: String,
    action: String,
    #[serde(default, alias = "agent_name")]
    agent_name: Option<String>,
    #[serde(default, alias = "bind_code")]
    bind_code: Option<String>,
    #[serde(default, alias = "payment_needed")]
    payment_needed: Option<String>,
    #[serde(default, alias = "resource_url")]
    resource_url: Option<String>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    headers: Vec<AlipayHeaderInput>,
    #[serde(default, alias = "intent_summary")]
    intent_summary: Option<String>,
    #[serde(default, alias = "trade_no")]
    trade_no: Option<String>,
    #[serde(default, alias = "out_shake_no")]
    out_shake_no: Option<String>,
}

fn parse_request(body: &[u8]) -> Result<AlipayBotRequest, AlipayBotError> {
    let input = serde_json::from_slice::<AlipayBotWireRequest>(body)
        .map_err(|_| AlipayBotError::invalid("alipay-bot 请求不是有效 JSON"))?;
    let session_id = non_empty_text(Some(input.session_id), "sessionId", 512)?;
    let headers = input
        .headers
        .into_iter()
        .map(|header| match header {
            AlipayHeaderInput::Pair((name, value)) => (name, value),
            AlipayHeaderInput::Object { name, value } => (name, value),
        })
        .collect();

    Ok(AlipayBotRequest {
        action: AlipayBotAction::parse(&input.action),
        session_id: Some(session_id),
        agent_name: input.agent_name,
        bind_code: input.bind_code,
        payment_needed: input.payment_needed,
        resource_url: input.resource_url,
        method: input.method,
        data: input.data,
        headers,
        intent_summary: input.intent_summary,
        trade_no: input.trade_no,
        out_shake_no: input.out_shake_no,
    })
}

pub fn handle_request(
    policy_store: &AgentFilePolicyStore,
    payment_capabilities: &PaymentCapabilityStore,
    method: &str,
    agent_worker_token: Option<&str>,
    payment_capability_token: Option<&str>,
    body: &[u8],
) -> Result<AlipayBotResponse, AlipayBotError> {
    if !method.eq_ignore_ascii_case("POST") {
        return Err(AlipayBotError::new(
            405,
            "method_not_allowed",
            "alipay-bot 能力接口只支持 POST",
        ));
    }
    let request = parse_request(body)?;
    let session_id = request
        .session_id
        .as_deref()
        .ok_or_else(|| AlipayBotError::invalid("alipay-bot 请求缺少 sessionId"))?;
    let payment_home = match payment_capability_token {
        Some(token) => Some(
            payment_capabilities
                .resolve(session_id, token, request.action.as_str())
                .map_err(|error| AlipayBotError::new(error.status, error.code, error.message))?,
        ),
        None => {
            let token = agent_worker_token.ok_or_else(|| {
                AlipayBotError::new(403, "agent_file_token_required", "Agent 支付能力令牌缺失")
            })?;
            policy_store
                .validate_worker_token(session_id, token)
                .map_err(|error| AlipayBotError::new(error.status, error.code, error.message))?;
            None
        }
    };

    let output = execute_alipay_bot_with_home(&request, payment_home.as_deref())?;
    Ok(AlipayBotResponse {
        status: 200,
        body: if payment_capability_token.is_some() {
            output.to_payment_value()
        } else {
            output.to_public_value()
        },
    })
}

pub fn build_alipay_bot_args(
    request: &AlipayBotRequest,
    payment_file: Option<&Path>,
) -> Result<Vec<String>, AlipayBotError> {
    let mut args = Vec::new();
    match &request.action {
        AlipayBotAction::WalletCheck => args.push("check-wallet".to_string()),
        AlipayBotAction::WalletApply => {
            args.push("apply-wallet".to_string());
            args.push("--agent-name".to_string());
            args.push(valid_text(
                request.agent_name.as_deref().or(Some(DEFAULT_AGENT_NAME)),
                "agentName",
                128,
            )?);
        }
        AlipayBotAction::WalletBind => {
            args.push("bind-wallet".to_string());
            args.push("--code".to_string());
            args.push(valid_text(request.bind_code.as_deref(), "code", 128)?);
        }
        AlipayBotAction::WalletClose => args.push("close-wallet".to_string()),
        AlipayBotAction::PaymentStart => {
            args.push("402-buyer-pay".to_string());
            args.push("--file".to_string());
            let payment_file = payment_file
                .and_then(Path::to_str)
                .ok_or_else(|| AlipayBotError::invalid("Payment-Needed 临时文件不可用"))?;
            args.push(valid_argument(Some(payment_file), "paymentFile")?);
            args.push("--resource-url".to_string());
            args.push(valid_http_url(
                request.resource_url.as_deref(),
                "resourceUrl",
            )?);
            append_payment_request_args(&mut args, request, true)?;
        }
        AlipayBotAction::PaymentCheck => {
            args.push("402-query-payment-status".to_string());
            if let Some(out_shake_no) = request.out_shake_no.as_deref() {
                args.push("--out-shake-no".to_string());
                args.push(valid_text(Some(out_shake_no), "outShakeNo", 256)?);
            } else if let Some(trade_no) = request.trade_no.as_deref() {
                args.push("--trade-no".to_string());
                args.push(valid_text(Some(trade_no), "tradeNo", 256)?);
            } else {
                return Err(AlipayBotError::invalid(
                    "payment.check 请求缺少 tradeNo 或 outShakeNo",
                ));
            }
            append_payment_request_args(&mut args, request, false)?;
        }
        AlipayBotAction::PaymentAck => {
            args.push("402-buyer-fulfillment-ack".to_string());
            args.push("--trade-no".to_string());
            args.push(valid_text(request.trade_no.as_deref(), "tradeNo", 256)?);
        }
        AlipayBotAction::Unsupported(action) => {
            return Err(AlipayBotError::new(
                400,
                "unsupported_action",
                format!("不支持的 alipay-bot action: {}", action),
            ));
        }
    }
    ensure_argument_size(&args)?;
    Ok(args)
}

fn append_payment_request_args(
    args: &mut Vec<String>,
    request: &AlipayBotRequest,
    include_session: bool,
) -> Result<(), AlipayBotError> {
    if include_session {
        if let Some(session_id) = request.session_id.as_deref() {
            args.push("--session-id".to_string());
            args.push(valid_text(Some(session_id), "sessionId", 512)?);
        }
        if let Some(intent_summary) = request.intent_summary.as_deref() {
            args.push("--intent-summary".to_string());
            args.push(valid_text(Some(intent_summary), "intentSummary", 512)?);
        }
    }
    if let Some(method) = request.method.as_deref() {
        let method = valid_text(Some(method), "method", 8)?.to_ascii_uppercase();
        if method != "GET" && method != "POST" {
            return Err(AlipayBotError::invalid("method 只支持 GET 或 POST"));
        }
        args.push("--method".to_string());
        args.push(method);
    }
    if let Some(data) = request.data.as_deref() {
        args.push("--data".to_string());
        args.push(valid_argument(Some(data), "data")?);
    }
    for (name, value) in &request.headers {
        let name = valid_text(Some(name), "header name", 256)?;
        let value = valid_text(Some(value), "header value", 4 * 1024)?;
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err(AlipayBotError::invalid("header 不能包含换行符"));
        }
        args.push("--header".to_string());
        args.push(format!("{}:{}", name, value));
    }
    Ok(())
}

struct PreparedAlipayBotCommand {
    args: Vec<String>,
    payment_file: Option<PathBuf>,
}

impl Drop for PreparedAlipayBotCommand {
    fn drop(&mut self) {
        if let Some(path) = self.payment_file.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn prepare_alipay_bot_command(
    request: &AlipayBotRequest,
    bot_home: &Path,
) -> Result<PreparedAlipayBotCommand, AlipayBotError> {
    let payment_file = if matches!(&request.action, AlipayBotAction::PaymentStart) {
        let payment_needed =
            valid_file_content(request.payment_needed.as_deref(), "paymentNeeded")?;
        Some(write_payment_needed_file(bot_home, &payment_needed)?)
    } else {
        None
    };
    let args = match build_alipay_bot_args(request, payment_file.as_deref()) {
        Ok(args) => args,
        Err(error) => {
            if let Some(path) = payment_file.as_ref() {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
    };
    Ok(PreparedAlipayBotCommand { args, payment_file })
}

fn write_payment_needed_file(
    bot_home: &Path,
    payment_needed: &str,
) -> Result<PathBuf, AlipayBotError> {
    let tmp_dir = ensure_alipay_bot_tmp_dir(bot_home)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = tmp_dir.join(format!(
        "payment-needed-{}-{}.json",
        std::process::id(),
        nonce
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| {
        AlipayBotError::new(
            500,
            "alipay_payment_file_failed",
            "无法准备支付宝支付请求文件",
        )
    })?;
    if file.write_all(payment_needed.as_bytes()).is_err() || file.flush().is_err() {
        let _ = fs::remove_file(&path);
        return Err(AlipayBotError::new(
            500,
            "alipay_payment_file_failed",
            "无法写入支付宝支付请求文件",
        ));
    }
    Ok(path)
}

fn ensure_alipay_bot_tmp_dir(bot_home: &Path) -> Result<PathBuf, AlipayBotError> {
    let tmp_dir = bot_home.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|_| {
        AlipayBotError::new(
            500,
            "alipay_payment_file_failed",
            "无法准备支付宝支付请求文件",
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&tmp_dir)
            .map_err(|_| {
                AlipayBotError::new(
                    500,
                    "alipay_payment_file_failed",
                    "无法准备支付宝支付请求文件",
                )
            })?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&tmp_dir, permissions).map_err(|_| {
            AlipayBotError::new(
                500,
                "alipay_payment_file_failed",
                "无法准备支付宝支付请求文件",
            )
        })?;
    }
    Ok(tmp_dir)
}

#[cfg(test)]
fn execute_alipay_bot(request: &AlipayBotRequest) -> Result<AlipayBotOutput, AlipayBotError> {
    execute_alipay_bot_with_home(request, None)
}

fn execute_alipay_bot_with_home(
    request: &AlipayBotRequest,
    payment_home: Option<&Path>,
) -> Result<AlipayBotOutput, AlipayBotError> {
    let command = env::var_os("COPIS_ALIPAY_BOT_CLI")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ALIPAY_BOT_COMMAND.into());
    let fallback_home = current_process_home();
    let configured_home = env::var("COPIS_ALIPAY_BOT_HOME").ok();
    let bot_home = payment_home
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resolve_alipay_bot_home(configured_home.as_deref(), &fallback_home));
    let tmp_dir = ensure_alipay_bot_tmp_dir(&bot_home)?;
    let prepared = prepare_alipay_bot_command(request, &bot_home)?;

    let output = Command::new(command)
        .args(&prepared.args)
        .env("HOME", &bot_home)
        .env("USERPROFILE", &bot_home)
        .env("TMPDIR", &tmp_dir)
        .env("COPIS_ALIPAY_BOT_HOME", &bot_home)
        .output()
        .map_err(|_| {
            AlipayBotError::new(
                503,
                "alipay_bot_unavailable",
                "alipay-bot CLI 不可用，请先安装并配置 alipay-bot",
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 官方 CLI 会把结构化结果和 MEDIA 行分别写入 stdout、stderr，必须合并解析。
    let combined_output = format!("{stdout}\n{stderr}");
    let mut sanitized = sanitize_alipay_output(&combined_output);
    if let Some(qr_code_image) = read_qr_code_data_url(&combined_output, &tmp_dir) {
        sanitized.qr_code_mime_type =
            qr_code_data_url_mime_type(&qr_code_image).map(str::to_string);
        sanitized.qr_code_image = Some(qr_code_image);
    }
    if !output.status.success() {
        let message = sanitized
            .message
            .clone()
            .unwrap_or_else(|| "alipay-bot CLI 执行失败".to_string());
        return Err(AlipayBotError::new(502, "alipay_bot_failed", message));
    }
    Ok(sanitized)
}

pub fn resolve_alipay_bot_home(configured: Option<&str>, fallback: &Path) -> PathBuf {
    configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

pub fn sanitize_alipay_output(raw: &str) -> AlipayBotOutput {
    let mut output = AlipayBotOutput::default();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("MEDIA:") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        merge_alipay_output_json(&mut output, &value);
    }
    if let Some(value) = extract_first_json_value(raw) {
        merge_alipay_output_json(&mut output, &value);
    }

    if output.trade_no.is_none() {
        output.trade_no = extract_markdown_trade_no(raw);
    }
    if output.out_shake_no.is_none() {
        output.out_shake_no = extract_markdown_out_shake_no(raw);
    }
    if output.cashier_url.is_none() {
        output.cashier_url = extract_http_url(raw);
    }
    if output.access_url.is_none() {
        output.access_url = extract_wallet_access_url(raw);
    }
    // CLI 路径和原始输出只允许在进程内部存在；支付 proof 由受控 capability 响应单独返回 Rust。
    output.qr_code_path = None;
    output.raw = None;
    output
}

/// 只接受本次 CLI 临时目录或官方 CLI 固定媒体目录中的常规图片，避免 MEDIA 行被伪造后读取任意本地文件。
fn read_qr_code_data_url(raw: &str, tmp_dir: &Path) -> Option<String> {
    let media_path = raw.lines().find_map(|line| {
        line.trim()
            .strip_prefix("MEDIA:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })?;
    let candidate = if media_path.is_absolute() {
        media_path
    } else {
        tmp_dir.join(media_path)
    };
    let canonical_image = fs::canonicalize(candidate).ok()?;
    let canonical_tmp_dir = fs::canonicalize(tmp_dir).ok();
    let canonical_media_root = fs::canonicalize(ALIPAY_BOT_MEDIA_ROOT).ok();
    let is_allowed = canonical_tmp_dir
        .as_ref()
        .is_some_and(|root| canonical_image.starts_with(root))
        || canonical_media_root
            .as_ref()
            .is_some_and(|root| canonical_image.starts_with(root));
    if !is_allowed {
        return None;
    }
    let metadata = fs::metadata(&canonical_image).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_QR_CODE_BYTES {
        return None;
    }
    let bytes = fs::read(canonical_image).ok()?;
    let mime_type = qr_code_mime_type(&bytes)?;
    Some(format!(
        "data:{};base64,{}",
        mime_type,
        BASE64_STANDARD.encode(bytes)
    ))
}

fn qr_code_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn qr_code_data_url_mime_type(value: &str) -> Option<&'static str> {
    ["image/png", "image/jpeg", "image/gif", "image/webp"]
        .into_iter()
        .find(|mime_type| value.starts_with(&format!("data:{};base64,", mime_type)))
}

fn extract_markdown_trade_no(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let line = line.trim().replace("**", "");
        let value = line
            .trim_start_matches(['-', '*', ' '])
            .strip_prefix("交易号")?
            .trim_start_matches(['：', ':', ' ']);
        let value = value
            .split_whitespace()
            .next()
            .map(|value| value.trim_matches(|character| matches!(character, '*' | '`')))?;
        sanitize_text(value)
    })
}

fn extract_markdown_out_shake_no(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let line = line.trim().replace("**", "").replace('`', "");
        let line = line.trim_start_matches(['-', '*', ' ']);
        let lower = line.to_ascii_lowercase();
        for label in ["outshakeno", "out_shake_no"] {
            if !lower.starts_with(label) {
                continue;
            }
            let value = &line[label.len()..];
            if !value.starts_with(['：', ':', ' ', '\t']) {
                continue;
            }
            let value = value
                .trim_start_matches(['：', ':', ' ', '\t'])
                .split_whitespace()
                .next()?;
            return sanitize_text(value.trim_matches(|character| matches!(character, '*' | '`')));
        }
        None
    })
}

fn extract_http_url(raw: &str) -> Option<String> {
    raw.split(|character: char| character.is_whitespace() || matches!(character, '(' | '['))
        .find_map(sanitize_http_url)
}

/// 官方钱包 CLI 会把授权链接放在“开启支付宝支付功能”这类 Markdown 行中，单独映射为 accessUrl。
fn extract_wallet_access_url(raw: &str) -> Option<String> {
    raw.lines()
        .filter(|line| line.contains("开启") || line.contains("授权") || line.contains("绑定"))
        .find_map(extract_http_url)
}

fn merge_alipay_output_json(output: &mut AlipayBotOutput, value: &Value) {
    merge_alipay_output_json_at_depth(output, value, 0);
}

fn merge_alipay_output_json_at_depth(output: &mut AlipayBotOutput, value: &Value, depth: usize) {
    let Some(object) = value.as_object() else {
        return;
    };
    output.code = output.code.or_else(|| get_i64(object, &["code"]));
    output.success = output
        .success
        .or_else(|| get_bool(object, &["success", "ok"]));
    output.message = output.message.take().or_else(|| {
        get_string(
            object,
            &["message", "errorMsg", "error_msg", "errorMessage"],
        )
        .and_then(|value| sanitize_text(&value))
    });
    output.error_code = output.error_code.take().or_else(|| {
        get_string(object, &["errorCode", "error_code"]).and_then(|value| sanitize_text(&value))
    });
    output.trade_no = output.trade_no.take().or_else(|| {
        get_string(object, &["tradeNo", "trade_no"]).and_then(|value| sanitize_text(&value))
    });
    output.out_shake_no = output.out_shake_no.take().or_else(|| {
        get_string(object, &["outShakeNo", "out_shake_no"]).and_then(|value| sanitize_text(&value))
    });
    output.cashier_url = output.cashier_url.take().or_else(|| {
        get_string(
            object,
            &["cashierUrl", "cashier_url", "paymentUrl", "payment_url"],
        )
        .and_then(|value| sanitize_http_url(&value))
    });
    output.access_url = output.access_url.take().or_else(|| {
        get_string(object, &["accessUrl", "access_url"]).and_then(|value| sanitize_http_url(&value))
    });
    output.status = output
        .status
        .take()
        .or_else(|| get_string(object, &["status"]).and_then(|value| sanitize_text(&value)));
    output.payment_proof = output.payment_proof.take().or_else(|| {
        get_string(object, &["paymentProof", "payment_proof"])
            .and_then(|value| sanitize_text(&value))
    });
    output.client_session = output.client_session.take().or_else(|| {
        get_string(object, &["clientSession", "client_session"])
            .and_then(|value| sanitize_text(&value))
    });
    if depth < 4 {
        for envelope in ["data", "result"] {
            if let Some(value) = object.get(envelope) {
                merge_alipay_output_json_at_depth(output, value, depth + 1);
            }
        }
    }
}

fn extract_first_json_value(raw: &str) -> Option<Value> {
    let mut offset = 0;
    while let Some(relative_start) = raw[offset..].find('{') {
        let start = offset + relative_start;
        let mut deserializer = serde_json::Deserializer::from_str(&raw[start..]);
        if let Ok(value) = Value::deserialize(&mut deserializer) {
            return Some(value);
        }
        offset = start + 1;
    }
    None
}

fn current_process_home() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("copis-alipay-bot"))
}

fn non_empty_text(
    value: Option<String>,
    name: &str,
    max_bytes: usize,
) -> Result<String, AlipayBotError> {
    valid_text(value.as_deref(), name, max_bytes)
}

fn valid_text(value: Option<&str>, name: &str, max_bytes: usize) -> Result<String, AlipayBotError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AlipayBotError::invalid(format!("{} 不能为空", name)))?;
    if value.len() > max_bytes {
        return Err(AlipayBotError::invalid(format!("{} 过长", name)));
    }
    Ok(value.to_string())
}

fn valid_argument(value: Option<&str>, name: &str) -> Result<String, AlipayBotError> {
    let value = valid_text(value, name, MAX_ARGUMENT_BYTES)?;
    if value.contains(['\0', '\r', '\n']) {
        return Err(AlipayBotError::invalid(format!("{} 包含非法字符", name)));
    }
    Ok(value)
}

fn valid_file_content(value: Option<&str>, name: &str) -> Result<String, AlipayBotError> {
    let value = valid_text(value, name, MAX_ARGUMENT_BYTES)?;
    if value.contains('\0') {
        return Err(AlipayBotError::invalid(format!("{} 包含非法字符", name)));
    }
    Ok(value)
}

fn valid_http_url(value: Option<&str>, name: &str) -> Result<String, AlipayBotError> {
    let value = valid_argument(value, name)?;
    if !value.starts_with("https://") && !value.starts_with("http://") {
        return Err(AlipayBotError::invalid(format!(
            "{} 必须是 HTTP(S) 地址",
            name
        )));
    }
    Ok(value)
}

fn ensure_argument_size(args: &[String]) -> Result<(), AlipayBotError> {
    let total = args.iter().map(String::len).sum::<usize>();
    if total > MAX_ARGUMENT_BYTES {
        return Err(AlipayBotError::invalid("alipay-bot 参数过大"));
    }
    Ok(())
}

fn get_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn get_i64(object: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_i64))
}

fn get_bool(object: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_bool))
}

fn sanitize_text(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TEXT_BYTES || value.contains(['\0', '\r', '\n']) {
        return None;
    }
    Some(value.to_string())
}

fn sanitize_http_url(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(|character| {
        matches!(
            character,
            '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '<' | '>' | '}' | ','
        )
    });
    if (value.starts_with("https://") || value.starts_with("http://"))
        && !value.chars().any(char::is_whitespace)
        && value.len() <= MAX_TEXT_BYTES
    {
        Some(value.to_string())
    } else {
        None
    }
}

#[cfg(test)]
#[path = "alipay_bot_tests.rs"]
mod tests;
