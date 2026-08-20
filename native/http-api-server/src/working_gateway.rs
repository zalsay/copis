use super::auth_session::{
    working_oidc_redirect_uri, AuthError, AuthSession, LoginInput, RegisterInput, SendCodeInput,
    VerifyResetCodeInput,
};
use serde_json::{Map, Value};
use std::fmt;
use std::sync::Arc;

#[derive(Debug)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GatewayError {}

pub fn is_working_gateway_path(path: &str) -> bool {
    [
        "/api/working/config",
        "/api/working/auth-state",
        "/api/working/login",
        "/api/working/login-oidc",
        "/api/working/oauth",
        "/api/working/register",
        "/api/working/send-verification-code",
        "/api/working/verify-password-reset-code",
        "/api/working/reset-password",
        "/api/working/logout",
        "/api/working/current-user",
        "/api/working/workspaces",
        "/api/working/sessions",
        "/api/working/skills",
        "/api/working/settings",
        "/api/working/check-in",
        "/api/working/receive-channel",
        "/api/working/orders",
        "/api/working/feedback",
        "/api/working/image",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.starts_with(&format!("{}/", prefix)))
}

pub fn is_working_oauth_callback_path(path: &str) -> bool {
    path == "/api/working/oauth/callback"
}

pub fn is_working_oauth_success_path(path: &str) -> bool {
    path == "/api/working/oauth/success"
}

pub fn is_working_oauth_failure_path(path: &str) -> bool {
    path == "/api/working/oauth/failure"
}

pub fn oidc_success_page() -> &'static str {
    r##"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Copis 授权成功</title>
  <script>
    history.replaceState(null, "", "/api/working/oauth/success");
  </script>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #182230; }
    main { width: min(420px, calc(100% - 40px)); box-sizing: border-box; padding: 36px 32px; text-align: center; background: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(24, 34, 48, .12); }
    .mark { width: 56px; height: 56px; margin: 0 auto 20px; display: grid; place-items: center; border-radius: 50%; background: #1f9d68; color: #fff; font-size: 30px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.3; }
    p { margin: 12px 0 0; color: #667085; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">&#10003;</div>
    <h1>授权成功</h1>
    <p>Copis 已完成 Pi 账号授权，可以返回 Copis 继续使用。</p>
  </main>
</body>
</html>"##
}

pub fn oidc_failure_page() -> &'static str {
    r##"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Copis 授权未完成</title>
  <script>
    history.replaceState(null, "", "/api/working/oauth/failure");
  </script>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #182230; }
    main { width: min(420px, calc(100% - 40px)); box-sizing: border-box; padding: 36px 32px; text-align: center; background: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(24, 34, 48, .12); }
    .mark { width: 56px; height: 56px; margin: 0 auto 20px; display: grid; place-items: center; border-radius: 50%; background: #d97706; color: #fff; font-size: 30px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.3; }
    p { margin: 12px 0 0; color: #667085; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">!</div>
    <h1>授权未完成</h1>
    <p>本次 Pi 账号授权未完成，请返回 Copis 后重试。</p>
  </main>
</body>
</html>"##
}

pub struct WorkingGateway {
    auth: Arc<AuthSession>,
}

impl WorkingGateway {
    pub fn new(auth: Arc<AuthSession>) -> Self {
        Self { auth }
    }
}

pub fn handle_working_gateway_request(
    gateway: &WorkingGateway,
    method: &str,
    target: &str,
    body: Option<&str>,
) -> Result<GatewayResponse, GatewayError> {
    let method = method.trim();
    let (path, query) = split_target(target)?;
    let segments = path_segments(path)?;
    if segments.len() < 3 || segments[0] != "api" || segments[1] != "working" {
        return Err(GatewayError::new(
            404,
            "not_found",
            "Working API 路径不存在",
        ));
    }
    let resource = segments[2].as_str();

    match resource {
        "config" => {
            require_method(method, "GET")?;
            return Ok(json_response(
                200,
                serde_json::json!({ "backendUrl": "local" }),
            ));
        }
        "auth-state" => {
            require_method(method, "GET")?;
            return Ok(json_response(
                200,
                serde_json::to_value(gateway.auth.auth_state()).unwrap(),
            ));
        }
        "login" => {
            require_method(method, "POST")?;
            let input = parse_body(body)?;
            let state = gateway
                .auth
                .login(LoginInput {
                    email: required_string(&input, "email", "登录邮箱不正确", 320)?,
                    password: required_string(&input, "password", "登录密码不正确", 1024)?,
                })
                .map_err(GatewayError::from)?;
            return Ok(json_response(200, serde_json::to_value(state).unwrap()));
        }
        "login-oidc" => {
            require_method(method, "POST")?;
            let redirect_uri = working_oidc_redirect_uri();
            eprintln!(
                "[HTTP API][Working认证] login-oidc 开始 redirect_uri={}",
                redirect_uri
            );
            let authorization_url = gateway
                .auth
                .start_oidc(&redirect_uri)
                .map_err(GatewayError::from)?;
            return Ok(json_response(
                200,
                serde_json::json!({ "authorizationUrl": authorization_url }),
            ));
        }
        "oauth" if segments.len() == 4 && segments[3] == "callback" => {
            require_method(method, "GET")?;
            eprintln!(
                "[HTTP API][Working认证] oauth callback 收到 path={}",
                target.split('?').next().unwrap_or(target)
            );
            gateway
                .auth
                .complete_oidc(target)
                .map_err(GatewayError::from)?;
            return Ok(GatewayResponse {
                status: 200,
                body: None,
            });
        }
        "oauth" if segments.len() == 4 && segments[3] == "success" => {
            require_method(method, "GET")?;
            return Ok(GatewayResponse {
                status: 200,
                body: None,
            });
        }
        "oauth" if segments.len() == 4 && segments[3] == "failure" => {
            require_method(method, "GET")?;
            return Ok(GatewayResponse {
                status: 200,
                body: None,
            });
        }
        "register" => {
            require_method(method, "POST")?;
            let input = parse_body(body)?;
            let result = gateway
                .auth
                .register(RegisterInput {
                    email: required_string(&input, "email", "注册邮箱不正确", 320)?,
                    password: required_string(&input, "password", "注册密码不正确", 1024)?,
                    nickname: optional_string(&input, "nickname", 128)?,
                    invitation_code: optional_string(&input, "invitationCode", 256)?,
                    verification_code: optional_string(&input, "verificationCode", 64)?,
                })
                .map_err(GatewayError::from)?;
            return Ok(json_response(200, result.payload));
        }
        "send-verification-code" => {
            require_method(method, "POST")?;
            let input = parse_body(body)?;
            gateway
                .auth
                .send_code(SendCodeInput {
                    email: required_string(&input, "email", "验证码邮箱不正确", 320)?,
                    purpose: optional_string(&input, "purpose", 64)?,
                })
                .map_err(GatewayError::from)?;
            return Ok(GatewayResponse {
                status: 204,
                body: None,
            });
        }
        "verify-password-reset-code" => {
            require_method(method, "POST")?;
            let input = parse_body(body)?;
            let result = gateway
                .auth
                .verify_reset_code(VerifyResetCodeInput {
                    email: required_string(&input, "email", "验证码邮箱不正确", 320)?,
                    code: required_string(&input, "code", "验证码不正确", 64)?,
                })
                .map_err(GatewayError::from)?;
            return Ok(json_response(
                200,
                serde_json::json!({ "resetToken": result.token }),
            ));
        }
        "reset-password" => {
            require_method(method, "POST")?;
            let input = parse_body(body)?;
            gateway
                .auth
                .reset_password(
                    &required_string(&input, "email", "重置邮箱不正确", 320)?,
                    &required_string(&input, "resetToken", "重置凭证不正确", 1024)?,
                    &required_string(&input, "password", "新密码不正确", 1024)?,
                )
                .map_err(GatewayError::from)?;
            return Ok(GatewayResponse {
                status: 204,
                body: None,
            });
        }
        "logout" => {
            require_method(method, "POST")?;
            gateway.auth.logout().map_err(GatewayError::from)?;
            return Ok(json_response(
                200,
                serde_json::to_value(gateway.auth.auth_state()).unwrap(),
            ));
        }
        _ => {}
    }

    if resource == "sessions" && segments.len() == 5 && segments[4] == "history" {
        require_method(method, "GET")?;
        let run_id = path_segment(&segments[3], "runId")?;
        let session_id =
            query_value(query, "sessionId").or_else(|| query_value(query, "session_id"));
        let mut remote_path = format!(
            "/api/working/sessions/{}/history",
            encode_path_segment(&run_id)
        );
        if let Some(session_id) = session_id {
            let session_id = bounded_string(session_id, "sessionId", 256)?;
            remote_path.push_str("?session_id=");
            remote_path.push_str(&encode_query_value(&session_id));
        }
        return remote_json(gateway, method, &remote_path, None);
    }

    if resource == "sessions" && segments.len() == 3 {
        require_method(method, "GET")?;
        return remote_json(gateway, method, "/api/working/sessions", None);
    }

    if resource == "workspaces" && segments.len() == 3 {
        match method {
            "GET" => return remote_json(gateway, method, "/api/working/workspaces", None),
            "POST" => {
                let input = parse_body(body)?;
                let workspace_path =
                    required_string(&input, "workspacePath", "工作区路径不正确", 4096)?;
                let payload = serde_json::json!({
                    "workspace_path": workspace_path,
                    "pc_id": optional_string(&input, "pcId", 256)?.unwrap_or_default(),
                    "workspace_type": optional_string(&input, "workspaceType", 32)?.unwrap_or_else(|| "local".to_string()),
                    "allow_workspace_write": input.get("allowWorkspaceWrite").and_then(Value::as_bool).unwrap_or(false),
                });
                return remote_json(gateway, method, "/api/working/workspaces", Some(payload));
            }
            _ => return Err(GatewayError::method_not_allowed()),
        }
    }

    if resource == "orders" {
        if segments.len() == 3 && method == "GET" {
            let page = bounded_query_number(query, "page", 1, 1, 100_000)?;
            let page_size =
                bounded_query_number(query, "pageSize", 20, 1, 50).or_else(|error| {
                    if query_value(query, "page_size").is_some() {
                        bounded_query_number(query, "page_size", 20, 1, 50)
                    } else {
                        Err(error)
                    }
                })?;
            return remote_json(
                gateway,
                method,
                &format!("/api/users/orders?page={}&page_size={}", page, page_size),
                None,
            );
        }
        if segments.len() == 4 && method == "DELETE" {
            let order_id = path_segment(&segments[3], "orderId")?;
            return remote_json(
                gateway,
                method,
                &format!("/api/users/orders/{}", encode_path_segment(&order_id)),
                None,
            );
        }
        return Err(GatewayError::new(404, "not_found", "订单路径不存在"));
    }

    if resource == "settings" {
        require_method(method, "GET")?;
        return settings_snapshot(gateway);
    }

    let (remote_method, remote_path, remote_body) = match resource {
        "current-user" => ("GET", "/api/users/me".to_string(), None),
        "skills" => (
            "GET",
            "/api/working/expert-skills/runtime".to_string(),
            None,
        ),
        "feedback" => (
            "POST",
            "/api/feedback/".to_string(),
            Some(parse_body(body)?),
        ),
        "check-in" => (
            "POST",
            "/api/users/checkin".to_string(),
            Some(parse_body_or_empty(body)?),
        ),
        "receive-channel" => {
            if method == "GET" {
                ("GET", "/api/working/receive-channel".to_string(), None)
            } else {
                (
                    "PUT",
                    "/api/working/receive-channel".to_string(),
                    Some(parse_body(body)?),
                )
            }
        }
        "image" => (
            "POST",
            "/api/working/images/generate".to_string(),
            Some(parse_body(body)?),
        ),
        _ => {
            if segments.len() == 3 && resource != "" {
                (
                    method,
                    format!("/api/working/{}", encode_path_segment(resource)),
                    body.map(parse_json_body).transpose()?,
                )
            } else {
                return Err(GatewayError::new(
                    404,
                    "not_found",
                    "Working API 路径不存在",
                ));
            }
        }
    };
    if remote_method != method {
        require_method(method, remote_method)?;
    }
    remote_json(gateway, remote_method, &remote_path, remote_body)
}

fn settings_snapshot(gateway: &WorkingGateway) -> Result<GatewayResponse, GatewayError> {
    let me = authenticated_json(gateway, "GET", "/api/users/me", None)?;
    let mut settings = object_or_empty(me, "当前用户响应")?;
    let user = settings.remove("data").unwrap_or(Value::Null);
    settings.insert("user".to_string(), user.clone());

    let invited = optional_authenticated_json(gateway, "GET", "/api/users/invited", None)
        .map(|value| unwrap_data(&value))
        .filter(Value::is_array)
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let wallet = optional_authenticated_json(gateway, "GET", "/api/family/wallet", None)
        .map(|value| unwrap_data(&value))
        .unwrap_or_else(|| serde_json::json!({}));
    let billing = optional_authenticated_json(gateway, "GET", "/api/users/billing-ledger", None)
        .map(|value| unwrap_data(&value))
        .filter(Value::is_array)
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let invite = optional_authenticated_json(
        gateway,
        "POST",
        "/api/users/invite-code",
        Some(serde_json::json!({})),
    )
    .unwrap_or_else(|| serde_json::json!({}));
    let receive_channel =
        optional_authenticated_json(gateway, "GET", "/api/working/receive-channel", None)
            .map(|value| unwrap_data(&value));

    let wallet = wallet.as_object().cloned().unwrap_or_default();
    settings.insert("invitedUsers".to_string(), invited);
    settings.insert(
        "members".to_string(),
        wallet
            .get("members")
            .cloned()
            .filter(Value::is_array)
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    settings.insert(
        "ledger".to_string(),
        merge_settings_ledger(
            wallet
                .get("ledger")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            billing,
        ),
    );
    if let Some(invite) = invite.as_object() {
        if let Some(data) = invite.get("data").and_then(Value::as_object) {
            if let Some(code) = data.get("Code").or_else(|| data.get("code")) {
                settings.insert("inviteCode".to_string(), code.clone());
            }
        }
        if let Some(link) = invite.get("invite_link") {
            settings.insert("inviteLink".to_string(), link.clone());
        }
    }
    settings.insert(
        "receiveChannel".to_string(),
        receive_channel.unwrap_or(Value::Null),
    );
    Ok(json_response(200, Value::Object(settings)))
}

fn authenticated_json(
    gateway: &WorkingGateway,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, GatewayError> {
    let response = gateway
        .auth
        .authenticated_request(method, path, body.map(|value| value.to_string()))
        .map_err(GatewayError::from)?;
    if response.status == 204 || response.body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&response.body).map_err(|_| {
        GatewayError::new(
            502,
            "invalid_upstream_response",
            "Working 后端响应不是有效 JSON",
        )
    })
}

fn optional_authenticated_json(
    gateway: &WorkingGateway,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Option<Value> {
    authenticated_json(gateway, method, path, body).ok()
}

fn object_or_empty(value: Value, name: &str) -> Result<Map<String, Value>, GatewayError> {
    value.as_object().cloned().ok_or_else(|| {
        GatewayError::new(
            502,
            "invalid_upstream_response",
            &format!("{}不是有效对象", name),
        )
    })
}

fn merge_settings_ledger(family: Value, billing: Value) -> Value {
    let mut entries = Vec::new();
    append_prefixed_ledger(&mut entries, family, "family:", true);
    append_prefixed_ledger(&mut entries, billing, "billing:", false);
    entries.sort_by(|left, right| ledger_timestamp(right).cmp(&ledger_timestamp(left)));
    Value::Array(entries)
}

fn append_prefixed_ledger(entries: &mut Vec<Value>, value: Value, prefix: &str, skip_alipay: bool) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        if skip_alipay
            && item
                .get("source_type")
                .or_else(|| item.get("sourceType"))
                .and_then(Value::as_str)
                .is_some_and(|source_type| {
                    source_type == "alipay_diamond" || source_type == "alipay_diamond_purchase"
                })
        {
            continue;
        }
        let mut item = item.clone();
        if let Some(object) = item.as_object_mut() {
            let id = object.get("id").map(value_identifier).unwrap_or_default();
            object.insert("id".to_string(), Value::String(format!("{}{}", prefix, id)));
        }
        entries.push(item);
    }
}

fn value_identifier(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
        .or_else(|| value.as_u64().map(|number| number.to_string()))
        .unwrap_or_default()
}

fn ledger_timestamp(value: &Value) -> String {
    value
        .get("created_at")
        .or_else(|| value.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn remote_json(
    gateway: &WorkingGateway,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<GatewayResponse, GatewayError> {
    let response = gateway
        .auth
        .authenticated_request(method, path, body.map(|value| value.to_string()))
        .map_err(GatewayError::from)?;
    if response.status == 204 || response.body.is_empty() {
        return Ok(GatewayResponse {
            status: response.status,
            body: None,
        });
    }
    let value = serde_json::from_slice::<Value>(&response.body).map_err(|_| {
        GatewayError::new(
            502,
            "invalid_upstream_response",
            "Working 后端响应不是有效 JSON",
        )
    })?;
    Ok(json_response(response.status, unwrap_data(&value)))
}

impl GatewayError {
    fn new(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    fn method_not_allowed() -> Self {
        Self::new(405, "method_not_allowed", "Working API 请求方法不支持")
    }
}

impl From<AuthError> for GatewayError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Busy => {
                Self::new(429, "auth_operation_busy", "认证操作正在进行，请稍后重试")
            }
            AuthError::NotAuthenticated => Self::new(401, "unauthorized", "请先登录 Copis Working"),
            AuthError::InvalidInput(message) => Self::new(400, "invalid_request", &message),
            AuthError::InvalidResponse(message) => {
                Self::new(502, "invalid_upstream_response", &message)
            }
            AuthError::Storage(message) => {
                eprintln!("[HTTP API][Working认证] 认证存储错误: {}", message);
                Self::new(503, "auth_storage_unavailable", "认证存储不可用")
            }
            AuthError::Network(message) => {
                eprintln!("[HTTP API][Working认证] 认证服务网络错误: {}", message);
                Self::new(503, "auth_network_unavailable", "认证服务暂时无法连接")
            }
            AuthError::RefreshFailed => Self::new(401, "unauthorized", "Working 认证已失效"),
            AuthError::Upstream {
                status,
                code,
                message,
            } => Self::new(status, &code, &message),
        }
    }
}

fn json_response(status: u16, body: Value) -> GatewayResponse {
    GatewayResponse {
        status,
        body: Some(body),
    }
}

fn require_method(actual: &str, expected: &str) -> Result<(), GatewayError> {
    if actual == expected {
        Ok(())
    } else {
        Err(GatewayError::method_not_allowed())
    }
}

fn parse_body(body: Option<&str>) -> Result<Value, GatewayError> {
    let Some(body) = body else {
        return Err(GatewayError::new(
            400,
            "invalid_request_body",
            "请求体不能为空",
        ));
    };
    parse_json_body(body)
}

fn parse_body_or_empty(body: Option<&str>) -> Result<Value, GatewayError> {
    body.map(parse_json_body)
        .transpose()
        .map(|value| value.unwrap_or_else(|| Value::Object(Map::new())))
}

fn parse_json_body(body: &str) -> Result<Value, GatewayError> {
    if body.len() > 10 * 1024 * 1024 {
        return Err(GatewayError::new(
            413,
            "request_body_too_large",
            "请求体过大",
        ));
    }
    serde_json::from_str(body)
        .map_err(|_| GatewayError::new(400, "invalid_json", "请求体不是有效 JSON"))
}

fn required_string(
    value: &Value,
    key: &str,
    message: &str,
    max_length: usize,
) -> Result<String, GatewayError> {
    let value = value.get(key).and_then(Value::as_str).unwrap_or_default();
    bounded_string(value.to_string(), key, max_length)
        .map_err(|_| GatewayError::new(400, "invalid_request", message))
}

fn optional_string(
    value: &Value,
    key: &str,
    max_length: usize,
) -> Result<Option<String>, GatewayError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(bounded_string(value.clone(), key, max_length)?)),
        _ => Err(GatewayError::new(
            400,
            "invalid_request",
            "请求字段类型不正确",
        )),
    }
}

fn bounded_string(value: String, _name: &str, max_length: usize) -> Result<String, GatewayError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(GatewayError::new(400, "invalid_request", "请求字段不正确"));
    }
    Ok(value)
}

fn split_target(target: &str) -> Result<(&str, &str), GatewayError> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if !path.starts_with('/') || path.starts_with("//") || path.contains('#') {
        return Err(GatewayError::new(
            400,
            "invalid_path",
            "Working API 路径不正确",
        ));
    }
    Ok((path, query))
}

fn path_segments(path: &str) -> Result<Vec<String>, GatewayError> {
    path.split('/')
        .filter(|part| !part.is_empty())
        .map(|part| decode_component(part, false))
        .collect()
}

fn path_segment(value: &str, _name: &str) -> Result<String, GatewayError> {
    if value.is_empty() || value == "." || value == ".." || value.contains('/') {
        return Err(GatewayError::new(400, "invalid_path", "路径参数不正确"));
    }
    Ok(value.to_string())
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .find_map(|pair| {
            let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
            if decode_component(raw_key, true).ok()?.as_str() == key {
                decode_component(raw_value, true).ok()
            } else {
                None
            }
        })
}

fn bounded_query_number(
    query: &str,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, GatewayError> {
    let Some(value) = query_value(query, key) else {
        return Ok(default);
    };
    let parsed = value
        .parse::<u64>()
        .map_err(|_| GatewayError::new(400, "invalid_query", "分页参数不正确"))?;
    if parsed < min || parsed > max {
        return Err(GatewayError::new(400, "invalid_query", "分页参数超出范围"));
    }
    Ok(parsed)
}

fn decode_component(value: &str, plus_as_space: bool) -> Result<String, GatewayError> {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'%' if index + 2 < raw.len() => {
                let high = hex(raw[index + 1])
                    .ok_or_else(|| GatewayError::new(400, "invalid_path", "URL 编码不正确"))?;
                let low = hex(raw[index + 2])
                    .ok_or_else(|| GatewayError::new(400, "invalid_path", "URL 编码不正确"))?;
                bytes.push((high << 4) | low);
                index += 3;
            }
            b'%' => return Err(GatewayError::new(400, "invalid_path", "URL 编码不正确")),
            b'+' if plus_as_space => {
                bytes.push(b' ');
                index += 1;
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    let value = String::from_utf8(bytes)
        .map_err(|_| GatewayError::new(400, "invalid_path", "URL 编码不是 UTF-8"))?;
    if value == "." || value == ".." || value.contains('/') || value.contains('\\') {
        return Err(GatewayError::new(400, "invalid_path", "路径参数不安全"));
    }
    Ok(value)
}

fn encode_path_segment(value: &str) -> String {
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{:02X}", byte));
        }
        output
    })
}

fn encode_query_value(value: &str) -> String {
    encode_path_segment(value).replace("%2F", "%2F")
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn unwrap_data(value: &Value) -> Value {
    value.get("data").cloned().unwrap_or_else(|| value.clone())
}
