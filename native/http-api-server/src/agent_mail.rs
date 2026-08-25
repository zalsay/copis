use crate::agent_files::AgentFilePolicyStore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::process::Command;

const DEFAULT_AGENTLY_CLI_COMMAND: &str = "agently-cli";
const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentMailAction {
    AuthStatus,
    AuthLogin,
    AuthLogout,
    Me,
    MessageList,
    MessageRead,
    MessageSearch,
    MessageSend,
    MessageReply,
    MessageForward,
    MessageTrash,
    MessageDelete,
    AttachmentDownload,
    AttachmentUpload,
    Unsupported(String),
}

impl Default for AgentMailAction {
    fn default() -> Self {
        Self::Unsupported(String::new())
    }
}

impl AgentMailAction {
    pub fn parse(value: &str) -> Self {
        match value.trim() {
            "auth.status" => Self::AuthStatus,
            "auth.login" => Self::AuthLogin,
            "auth.logout" => Self::AuthLogout,
            "me" => Self::Me,
            "message.list" => Self::MessageList,
            "message.read" => Self::MessageRead,
            "message.search" => Self::MessageSearch,
            "message.send" => Self::MessageSend,
            "message.reply" => Self::MessageReply,
            "message.forward" => Self::MessageForward,
            "message.trash" => Self::MessageTrash,
            "message.delete" => Self::MessageDelete,
            "attachment.download" => Self::AttachmentDownload,
            "attachment.upload" => Self::AttachmentUpload,
            other => Self::Unsupported(other.to_string()),
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &str {
        match self {
            Self::AuthStatus => "auth.status",
            Self::AuthLogin => "auth.login",
            Self::AuthLogout => "auth.logout",
            Self::Me => "me",
            Self::MessageList => "message.list",
            Self::MessageRead => "message.read",
            Self::MessageSearch => "message.search",
            Self::MessageSend => "message.send",
            Self::MessageReply => "message.reply",
            Self::MessageForward => "message.forward",
            Self::MessageTrash => "message.trash",
            Self::MessageDelete => "message.delete",
            Self::AttachmentDownload => "attachment.download",
            Self::AttachmentUpload => "attachment.upload",
            Self::Unsupported(value) => value,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentMailRequest {
    pub action: AgentMailAction,
    pub session_id: Option<String>,
    pub id: Option<String>,
    pub query: Option<String>,
    pub dir: Option<String>,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub has_attachments: Option<bool>,
    pub is_unread: Option<bool>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub body_file: Option<String>,
    pub attachments: Vec<String>,
    pub reply_all: Option<bool>,
    pub include_attachments: Option<bool>,
    pub confirmed: Option<bool>,
    pub confirmation_token: Option<String>,
    pub all: Option<bool>,
    pub file: Option<String>,
    pub msg_id: Option<String>,
    pub att_id: Option<String>,
    pub output_dir: Option<String>,
}

#[derive(Debug)]
pub struct AgentMailError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl AgentMailError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_agent_mail_request", message)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingAgentMailPayload {
    action: Option<String>,
    session_id: Option<String>,
    id: Option<String>,
    query: Option<String>,
    dir: Option<String>,
    limit: Option<u64>,
    cursor: Option<String>,
    after: Option<String>,
    before: Option<String>,
    has_attachments: Option<bool>,
    is_unread: Option<bool>,
    to: Option<Vec<String>>,
    cc: Option<Vec<String>>,
    bcc: Option<Vec<String>>,
    subject: Option<String>,
    body: Option<String>,
    body_file: Option<String>,
    attachments: Option<Vec<String>>,
    reply_all: Option<bool>,
    include_attachments: Option<bool>,
    confirmed: Option<bool>,
    confirmation_token: Option<String>,
    all: Option<bool>,
    file: Option<String>,
    msg_id: Option<String>,
    att_id: Option<String>,
    output_dir: Option<String>,
}

pub fn parse_agent_mail_request(body: &[u8]) -> Result<AgentMailRequest, AgentMailError> {
    if body.is_empty() {
        return Err(AgentMailError::invalid("请求体不能为空"));
    }
    let payload: IncomingAgentMailPayload = serde_json::from_slice(body).map_err(|error| {
        AgentMailError::invalid(format!("Agent Mail 请求不是有效 JSON: {}", error))
    })?;

    let raw_action = payload
        .action
        .as_deref()
        .map(str::trim)
        .filter(|val| !val.is_empty())
        .ok_or_else(|| AgentMailError::invalid("action 不能为空"))?;

    let action = AgentMailAction::parse(raw_action);
    if matches!(action, AgentMailAction::Unsupported(_)) {
        return Err(AgentMailError::invalid(format!(
            "不支持的 Agent Mail action: {}",
            raw_action
        )));
    }

    Ok(AgentMailRequest {
        action,
        session_id: payload.session_id,
        id: payload.id,
        query: payload.query,
        dir: payload.dir,
        limit: payload.limit,
        cursor: payload.cursor,
        after: payload.after,
        before: payload.before,
        has_attachments: payload.has_attachments,
        is_unread: payload.is_unread,
        to: payload.to.unwrap_or_default(),
        cc: payload.cc.unwrap_or_default(),
        bcc: payload.bcc.unwrap_or_default(),
        subject: payload.subject,
        body: payload.body,
        body_file: payload.body_file,
        attachments: payload.attachments.unwrap_or_default(),
        reply_all: payload.reply_all,
        include_attachments: payload.include_attachments,
        confirmed: payload.confirmed,
        confirmation_token: payload.confirmation_token,
        all: payload.all,
        file: payload.file,
        msg_id: payload.msg_id,
        att_id: payload.att_id,
        output_dir: payload.output_dir,
    })
}

pub fn build_agent_mail_args(request: &AgentMailRequest) -> Result<Vec<String>, AgentMailError> {
    let mut args = Vec::new();

    match &request.action {
        AgentMailAction::AuthStatus => {
            args.push("auth".to_string());
            args.push("status".to_string());
        }
        AgentMailAction::AuthLogin => {
            args.push("auth".to_string());
            args.push("login".to_string());
        }
        AgentMailAction::AuthLogout => {
            args.push("auth".to_string());
            args.push("logout".to_string());
        }
        AgentMailAction::Me => {
            args.push("+me".to_string());
        }
        AgentMailAction::MessageList => {
            args.push("message".to_string());
            args.push("+list".to_string());
            if let Some(dir) = &request.dir {
                args.push("--dir".to_string());
                args.push(valid_argument(Some(dir), "dir")?);
            }
            if let Some(limit) = request.limit {
                args.push("--limit".to_string());
                args.push(limit.to_string());
            }
            if let Some(cursor) = &request.cursor {
                args.push("--cursor".to_string());
                args.push(valid_argument(Some(cursor), "cursor")?);
            }
            if let Some(after) = &request.after {
                args.push("--after".to_string());
                args.push(valid_argument(Some(after), "after")?);
            }
            if let Some(before) = &request.before {
                args.push("--before".to_string());
                args.push(valid_argument(Some(before), "before")?);
            }
            if request.has_attachments == Some(true) {
                args.push("--has-attachments".to_string());
            }
            if request.is_unread == Some(true) {
                args.push("--is-unread".to_string());
            }
        }
        AgentMailAction::MessageRead => {
            args.push("message".to_string());
            args.push("+read".to_string());
            let id = valid_argument(request.id.as_deref(), "id")?;
            args.push("--id".to_string());
            args.push(id);
        }
        AgentMailAction::MessageSearch => {
            args.push("message".to_string());
            args.push("+search".to_string());
            let query = valid_argument(request.query.as_deref(), "query")?;
            args.push("--q".to_string());
            args.push(query);
            if let Some(dir) = &request.dir {
                args.push("--dir".to_string());
                args.push(valid_argument(Some(dir), "dir")?);
            }
            if let Some(limit) = request.limit {
                args.push("--limit".to_string());
                args.push(limit.to_string());
            }
            if let Some(cursor) = &request.cursor {
                args.push("--cursor".to_string());
                args.push(valid_argument(Some(cursor), "cursor")?);
            }
            if request.has_attachments == Some(true) {
                args.push("--has-attachments".to_string());
            }
            if request.is_unread == Some(true) {
                args.push("--is-unread".to_string());
            }
        }
        AgentMailAction::MessageSend => {
            args.push("message".to_string());
            args.push("+send".to_string());
            if request.to.is_empty() {
                return Err(AgentMailError::invalid("收件人 to 不能为空"));
            }
            for to_addr in &request.to {
                args.push("--to".to_string());
                args.push(valid_argument(Some(to_addr), "to")?);
            }
            for cc_addr in &request.cc {
                args.push("--cc".to_string());
                args.push(valid_argument(Some(cc_addr), "cc")?);
            }
            for bcc_addr in &request.bcc {
                args.push("--bcc".to_string());
                args.push(valid_argument(Some(bcc_addr), "bcc")?);
            }
            if let Some(subject) = &request.subject {
                args.push("--subject".to_string());
                args.push(valid_argument(Some(subject), "subject")?);
            }
            if let Some(body) = &request.body {
                args.push("--body".to_string());
                args.push(valid_argument(Some(body), "body")?);
            }
            if let Some(body_file) = &request.body_file {
                args.push("--body-file".to_string());
                args.push(valid_argument(Some(body_file), "bodyFile")?);
            }
            for att in &request.attachments {
                args.push("--attachment".to_string());
                args.push(valid_argument(Some(att), "attachment")?);
            }
            if request.confirmed == Some(true) {
                args.push("--confirmed".to_string());
            }
            if let Some(ctk) = &request.confirmation_token {
                args.push("--confirmation-token".to_string());
                args.push(valid_argument(Some(ctk), "confirmationToken")?);
            }
        }
        AgentMailAction::MessageReply => {
            args.push("message".to_string());
            args.push("+reply".to_string());
            let id = valid_argument(request.id.as_deref(), "id")?;
            args.push("--id".to_string());
            args.push(id);
            if let Some(body) = &request.body {
                args.push("--body".to_string());
                args.push(valid_argument(Some(body), "body")?);
            }
            if let Some(body_file) = &request.body_file {
                args.push("--body-file".to_string());
                args.push(valid_argument(Some(body_file), "bodyFile")?);
            }
            if request.reply_all == Some(true) {
                args.push("--reply-all".to_string());
            }
            for cc_addr in &request.cc {
                args.push("--cc".to_string());
                args.push(valid_argument(Some(cc_addr), "cc")?);
            }
            for bcc_addr in &request.bcc {
                args.push("--bcc".to_string());
                args.push(valid_argument(Some(bcc_addr), "bcc")?);
            }
            for att in &request.attachments {
                args.push("--attachment".to_string());
                args.push(valid_argument(Some(att), "attachment")?);
            }
            if request.confirmed == Some(true) {
                args.push("--confirmed".to_string());
            }
            if let Some(ctk) = &request.confirmation_token {
                args.push("--confirmation-token".to_string());
                args.push(valid_argument(Some(ctk), "confirmationToken")?);
            }
        }
        AgentMailAction::MessageForward => {
            args.push("message".to_string());
            args.push("+forward".to_string());
            let id = valid_argument(request.id.as_deref(), "id")?;
            args.push("--id".to_string());
            args.push(id);
            if request.to.is_empty() {
                return Err(AgentMailError::invalid("转发收件人 to 不能为空"));
            }
            for to_addr in &request.to {
                args.push("--to".to_string());
                args.push(valid_argument(Some(to_addr), "to")?);
            }
            if let Some(body) = &request.body {
                args.push("--body".to_string());
                args.push(valid_argument(Some(body), "body")?);
            }
            if let Some(body_file) = &request.body_file {
                args.push("--body-file".to_string());
                args.push(valid_argument(Some(body_file), "bodyFile")?);
            }
            if request.include_attachments == Some(true) {
                args.push("--include-attachments".to_string());
            }
            for att in &request.attachments {
                args.push("--attachment".to_string());
                args.push(valid_argument(Some(att), "attachment")?);
            }
            if request.confirmed == Some(true) {
                args.push("--confirmed".to_string());
            }
            if let Some(ctk) = &request.confirmation_token {
                args.push("--confirmation-token".to_string());
                args.push(valid_argument(Some(ctk), "confirmationToken")?);
            }
        }
        AgentMailAction::MessageTrash => {
            args.push("message".to_string());
            args.push("+trash".to_string());
            let id = valid_argument(request.id.as_deref(), "id")?;
            args.push("--id".to_string());
            args.push(id);
            if let Some(ctk) = &request.confirmation_token {
                args.push("--confirmation-token".to_string());
                args.push(valid_argument(Some(ctk), "confirmationToken")?);
            }
        }
        AgentMailAction::MessageDelete => {
            args.push("message".to_string());
            args.push("+delete".to_string());
            if request.all == Some(true) {
                args.push("--all".to_string());
            } else {
                let id = valid_argument(request.id.as_deref(), "id")?;
                args.push("--id".to_string());
                args.push(id);
            }
            if let Some(ctk) = &request.confirmation_token {
                args.push("--confirmation-token".to_string());
                args.push(valid_argument(Some(ctk), "confirmationToken")?);
            }
        }
        AgentMailAction::AttachmentDownload => {
            args.push("attachment".to_string());
            args.push("+download".to_string());
            let msg_id = valid_argument(request.msg_id.as_deref(), "msgId")?;
            let att_id = valid_argument(request.att_id.as_deref(), "attId")?;
            args.push("--msg".to_string());
            args.push(msg_id);
            args.push("--att".to_string());
            args.push(att_id);
            if let Some(output_dir) = &request.output_dir {
                args.push("--output".to_string());
                args.push(valid_argument(Some(output_dir), "outputDir")?);
            }
        }
        AgentMailAction::AttachmentUpload => {
            args.push("attachment".to_string());
            args.push("+upload".to_string());
            let file = valid_argument(request.file.as_deref(), "file")?;
            args.push("--file".to_string());
            args.push(file);
        }
        AgentMailAction::Unsupported(name) => {
            return Err(AgentMailError::invalid(format!(
                "不支持的 action: {}",
                name
            )));
        }
    }

    ensure_argument_size(&args)?;
    Ok(args)
}

pub struct AgentMailHttpOutput {
    pub status: u16,
    pub body: Value,
}

pub fn execute_agent_mail_cli(args: &[String]) -> Result<(i32, String, String), AgentMailError> {
    let command = env::var_os("COPIS_AGENTLY_CLI")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_AGENTLY_CLI_COMMAND.into());

    let mut cmd = Command::new(command);
    cmd.args(args);

    let output = cmd.output().map_err(|error| {
        AgentMailError::new(
            503,
            "agently_cli_unavailable",
            format!("agently-cli CLI 不可用: {}", error),
        )
    })?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok((exit_code, stdout, stderr))
}

pub fn handle_request(
    _policies: &AgentFilePolicyStore,
    method: &str,
    agent_worker_token: Option<&str>,
    body: &[u8],
) -> Result<AgentMailHttpOutput, AgentMailError> {
    if method != "POST" {
        return Err(AgentMailError::new(
            405,
            "method_not_allowed",
            "Agent Mail 接口仅支持 POST",
        ));
    }
    if agent_worker_token.is_none() {
        return Err(AgentMailError::new(
            403,
            "agent_file_token_required",
            "Agent Mail 能力令牌缺失",
        ));
    }

    let request = parse_agent_mail_request(body)?;
    let args = build_agent_mail_args(&request)?;

    let (exit_code, stdout, stderr) = execute_agent_mail_cli(&args)?;

    let parsed_json: Option<Value> = serde_json::from_str(stdout.trim()).ok();

    if let Some(json_val) = parsed_json {
        let status = if exit_code == 0 { 200 } else { 400 };
        return Ok(AgentMailHttpOutput {
            status,
            body: json_val,
        });
    }

    // 处理文本输出（例如 auth login 提示或纯文本）
    if exit_code == 0 {
        // 尝试从 stdout 提取 OAuth URL
        let auth_url = stdout
            .lines()
            .find(|line| line.contains("https://agent.qq.com/page/oauth"))
            .map(|line| line.trim().to_string());

        Ok(AgentMailHttpOutput {
            status: 200,
            body: json!({
                "ok": true,
                "data": {
                    "output": stdout.trim(),
                    "authUrl": auth_url,
                }
            }),
        })
    } else {
        let err_msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "agently-cli 执行失败"
        };
        Ok(AgentMailHttpOutput {
            status: 400,
            body: json!({
                "ok": false,
                "error": {
                    "code": "cli_execution_failed",
                    "message": err_msg,
                    "exitCode": exit_code,
                }
            }),
        })
    }
}

fn valid_text(
    value: Option<&str>,
    name: &str,
    max_bytes: usize,
) -> Result<String, AgentMailError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AgentMailError::invalid(format!("{} 不能为空", name)))?;
    if value.len() > max_bytes {
        return Err(AgentMailError::invalid(format!("{} 过长", name)));
    }
    Ok(value.to_string())
}

fn valid_argument(value: Option<&str>, name: &str) -> Result<String, AgentMailError> {
    let value = valid_text(value, name, MAX_ARGUMENT_BYTES)?;
    if value.contains('\0') {
        return Err(AgentMailError::invalid(format!("{} 包含非法字符", name)));
    }
    Ok(value)
}

fn ensure_argument_size(args: &[String]) -> Result<(), AgentMailError> {
    let total = args.iter().map(String::len).sum::<usize>();
    if total > MAX_ARGUMENT_BYTES {
        return Err(AgentMailError::invalid("agently-cli 参数过大"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_mail_tests.rs"]
mod tests;
