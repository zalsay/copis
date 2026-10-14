use super::edu_api_client::{EduApiClient, EduApiError, EduApiRequest, EduApiResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAuth {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub provider: String,
    pub user: Option<Value>,
    pub expires_at: Option<u64>,
}

impl fmt::Debug for PersistedAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PersistedAuth")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("provider", &self.provider)
            .field("user", &self.user.as_ref().map(|_| "<redacted>"))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingAuthState {
    pub authenticated: bool,
    pub user: Option<Value>,
    pub expires_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct LoginInput {
    pub email: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct RegisterInput {
    pub email: String,
    pub password: String,
    pub nickname: Option<String>,
    pub invitation_code: Option<String>,
    pub verification_code: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SendCodeInput {
    pub email: String,
    pub purpose: Option<String>,
}

#[derive(Clone, Debug)]
pub struct VerifyResetCodeInput {
    pub email: String,
    pub code: String,
}

#[derive(Clone, Debug)]
pub struct RegisterResult {
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct ResetToken {
    pub token: String,
}

pub trait AuthStorage: Send + Sync {
    fn load(&self) -> Result<Option<PersistedAuth>, AuthError>;
    fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError>;
    fn clear(&self) -> Result<(), AuthError>;
}

#[derive(Clone)]
pub enum AuthError {
    Busy,
    NotAuthenticated,
    InvalidInput(String),
    Storage(String),
    Network(String),
    InvalidResponse(String),
    Upstream {
        status: u16,
        code: String,
        message: String,
    },
    RefreshFailed,
}

impl fmt::Debug for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("Busy"),
            Self::NotAuthenticated => formatter.write_str("NotAuthenticated"),
            Self::InvalidInput(message) => formatter
                .debug_tuple("InvalidInput")
                .field(message)
                .finish(),
            Self::Storage(message) => formatter.debug_tuple("Storage").field(message).finish(),
            Self::Network(message) => formatter.debug_tuple("Network").field(message).finish(),
            Self::InvalidResponse(message) => formatter
                .debug_tuple("InvalidResponse")
                .field(message)
                .finish(),
            Self::Upstream {
                status,
                code,
                message,
            } => formatter
                .debug_struct("Upstream")
                .field("status", status)
                .field("code", code)
                .field("message", message)
                .finish(),
            Self::RefreshFailed => formatter.write_str("RefreshFailed"),
        }
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("认证操作正在进行，请稍后重试"),
            Self::NotAuthenticated => formatter.write_str("请先登录 Copis Working"),
            Self::InvalidInput(message)
            | Self::Storage(message)
            | Self::Network(message)
            | Self::InvalidResponse(message) => formatter.write_str(message),
            Self::Upstream {
                status, message, ..
            } => {
                write!(
                    formatter,
                    "Working 认证请求失败（HTTP {}）：{}",
                    status, message
                )
            }
            Self::RefreshFailed => formatter.write_str("Working 认证刷新失败"),
        }
    }
}

impl std::error::Error for AuthError {}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum AuthOperation {
    Login,
    Register,
    SendCode,
    VerifyCode,
    ResetPassword,
}

struct AuthOperationGate {
    active: Mutex<HashSet<AuthOperation>>,
}

impl AuthOperationGate {
    fn try_acquire(
        self: &Arc<Self>,
        operation: AuthOperation,
    ) -> Result<AuthOperationPermit, AuthError> {
        let mut active = self.active.lock().unwrap();
        if !active.insert(operation) {
            return Err(AuthError::Busy);
        }
        Ok(AuthOperationPermit {
            gate: self.clone(),
            operation,
        })
    }
}

struct AuthOperationPermit {
    gate: Arc<AuthOperationGate>,
    operation: AuthOperation,
}

impl Drop for AuthOperationPermit {
    fn drop(&mut self) {
        self.gate.active.lock().unwrap().remove(&self.operation);
    }
}

struct RefreshState {
    active: bool,
    generation: u64,
    waiters: usize,
    result: Option<Result<String, AuthError>>,
}

struct PendingOidcAuthorization {
    state: String,
    code_verifier: String,
    token_endpoint: String,
    redirect_uri: String,
    expires_at: u64,
}

pub struct AuthSession {
    client: Arc<EduApiClient>,
    oidc_client: Option<Arc<EduApiClient>>,
    storage: Arc<dyn AuthStorage>,
    auth: Mutex<Option<PersistedAuth>>,
    // 只在认证 Mutex 下读取/推进，隔离旧登录的业务请求；不会写入持久化认证格式。
    auth_generation: AtomicU64,
    auth_storage_gate: Mutex<()>,
    pending_oidc: Mutex<Option<PendingOidcAuthorization>>,
    operation_gate: Arc<AuthOperationGate>,
    refresh_state: Mutex<RefreshState>,
    refresh_wakeup: Condvar,
    request_sequence: AtomicU64,
    auth_state_observer: Mutex<Option<Arc<dyn Fn(bool) + Send + Sync>>>,
}

impl AuthSession {
    pub fn new(
        client: Arc<EduApiClient>,
        storage: Arc<dyn AuthStorage>,
    ) -> Result<Self, AuthError> {
        Self::new_with_oidc(client, storage, None)
    }

    pub fn new_with_oidc(
        client: Arc<EduApiClient>,
        storage: Arc<dyn AuthStorage>,
        oidc_client: Option<Arc<EduApiClient>>,
    ) -> Result<Self, AuthError> {
        let persisted = storage.load()?;
        let persisted = persisted.map(normalize_persisted_auth).transpose()?;
        Ok(Self {
            client,
            oidc_client,
            storage,
            auth: Mutex::new(persisted),
            auth_generation: AtomicU64::new(0),
            auth_storage_gate: Mutex::new(()),
            pending_oidc: Mutex::new(None),
            operation_gate: Arc::new(AuthOperationGate {
                active: Mutex::new(HashSet::new()),
            }),
            refresh_state: Mutex::new(RefreshState {
                active: false,
                generation: 0,
                waiters: 0,
                result: None,
            }),
            refresh_wakeup: Condvar::new(),
            request_sequence: AtomicU64::new(1),
            auth_state_observer: Mutex::new(None),
        })
    }

    pub fn set_auth_state_observer(&self, observer: Arc<dyn Fn(bool) + Send + Sync>) {
        *self.auth_state_observer.lock().unwrap() = Some(observer);
    }

    fn notify_auth_state_changed(&self, authenticated: bool) {
        let observer = self.auth_state_observer.lock().unwrap().clone();
        if let Some(observer) = observer {
            observer(authenticated);
        }
    }

    pub fn auth_state(&self) -> WorkingAuthState {
        let auth = self.auth.lock().unwrap();
        match auth.as_ref() {
            Some(auth) => WorkingAuthState {
                authenticated: true,
                user: auth.user.clone(),
                expires_at: auth.expires_at,
            },
            None => WorkingAuthState {
                authenticated: false,
                user: None,
                expires_at: None,
            },
        }
    }

    pub fn start_oidc(&self, redirect_uri: &str) -> Result<String, AuthError> {
        let client = self
            .oidc_client
            .as_ref()
            .ok_or_else(|| AuthError::InvalidResponse("OIDC 认证服务未配置".to_string()))?;
        validate_oidc_redirect_uri(redirect_uri)?;
        let discovery = client
            .request(EduApiRequest {
                method: "GET".to_string(),
                path: "/.well-known/openid-configuration".to_string(),
                body: None,
                access_token: None,
                headers: Vec::new(),
                request_id: "auth-oidc-discovery".to_string(),
            })
            .map_err(map_edu_error)?;
        let discovery = parse_json_response(&discovery, "OIDC discovery 响应")?;
        let issuer = first_string(&discovery, &["issuer"])
            .ok_or_else(|| AuthError::InvalidResponse("OIDC discovery 缺少 issuer".to_string()))?;
        if issuer.trim_end_matches('/') != client.base_url().trim_end_matches('/') {
            return Err(AuthError::InvalidResponse("OIDC issuer 不匹配".to_string()));
        }
        let authorization_endpoint = first_string(&discovery, &["authorization_endpoint"])
            .ok_or_else(|| AuthError::InvalidResponse("OIDC discovery 缺少授权地址".to_string()))?;
        let token_endpoint = first_string(&discovery, &["token_endpoint"]).ok_or_else(|| {
            AuthError::InvalidResponse("OIDC discovery 缺少 token 地址".to_string())
        })?;
        let authorization_endpoint =
            validate_oidc_endpoint(&authorization_endpoint, client.base_url())?;
        let token_endpoint = validate_oidc_endpoint(&token_endpoint, client.base_url())?;
        eprintln!(
            "[HTTP API][OIDC] discovery 成功 issuer={} authorization_endpoint={} token_endpoint={}",
            issuer, authorization_endpoint.url, token_endpoint.url
        );
        let mut state_bytes = [0_u8; 32];
        let mut verifier_bytes = [0_u8; 32];
        getrandom::getrandom(&mut state_bytes)
            .map_err(|_| AuthError::InvalidResponse("OIDC state 生成失败".to_string()))?;
        getrandom::getrandom(&mut verifier_bytes)
            .map_err(|_| AuthError::InvalidResponse("OIDC PKCE verifier 生成失败".to_string()))?;
        let state = URL_SAFE_NO_PAD.encode(state_bytes);
        let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        let authorization_url = format!(
            "{}?client_id=copis-desktop&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            authorization_endpoint.url,
            percent_encode(redirect_uri),
            percent_encode("openid profile email offline_access"),
            percent_encode(&state),
            percent_encode(&code_challenge),
        );
        *self.pending_oidc.lock().unwrap() = Some(PendingOidcAuthorization {
            state,
            code_verifier,
            token_endpoint: token_endpoint.path,
            redirect_uri: redirect_uri.to_string(),
            expires_at: now_secs().saturating_add(5 * 60),
        });
        eprintln!(
            "[HTTP API][OIDC] 授权地址已生成 redirect_uri={}",
            redirect_uri
        );
        Ok(authorization_url)
    }

    pub fn complete_oidc(&self, target: &str) -> Result<WorkingAuthState, AuthError> {
        let previous_auth = self.auth.lock().unwrap().clone();
        eprintln!(
            "[HTTP API][OIDC] 回调开始 path={} has_code={} has_state={} has_error={}",
            target.split('?').next().unwrap_or(target),
            query_param(target, "code").is_some(),
            query_param(target, "state").is_some(),
            query_param(target, "error").is_some()
        );
        let pending =
            self.pending_oidc.lock().unwrap().take().ok_or_else(|| {
                AuthError::InvalidInput("OIDC 登录状态不存在或已过期".to_string())
            })?;
        if pending.expires_at <= now_secs() {
            return Err(AuthError::InvalidInput(
                "OIDC 登录已超时，请重新开始".to_string(),
            ));
        }
        let code = query_param(target, "code")
            .ok_or_else(|| AuthError::InvalidInput("OIDC 回调缺少授权码".to_string()))?;
        let state = query_param(target, "state")
            .ok_or_else(|| AuthError::InvalidInput("OIDC 回调缺少 state".to_string()))?;
        if state != pending.state {
            return Err(AuthError::InvalidInput("OIDC state 校验失败".to_string()));
        }
        if let Some(error) = query_param(target, "error") {
            return Err(AuthError::InvalidInput(format!("OIDC 授权失败: {}", error)));
        }
        let response = self.oidc_client.as_ref().ok_or_else(|| {
            AuthError::InvalidResponse("OIDC 认证服务未配置".to_string())
        })?.request(EduApiRequest {
            method: "POST".to_string(),
            path: pending.token_endpoint,
            body: Some(format!(
                "grant_type=authorization_code&client_id=copis-desktop&redirect_uri={}&code={}&code_verifier={}",
                percent_encode(&pending.redirect_uri),
                percent_encode(&code),
                percent_encode(&pending.code_verifier),
            )),
            access_token: None,
            headers: Vec::new(),
            request_id: "auth-oidc-token".to_string(),
        }).map_err(map_edu_error)?;
        eprintln!(
            "[HTTP API][OIDC] token endpoint 响应 status={} body_bytes={}",
            response.status,
            response.body.len()
        );
        let payload = unwrap_data(&parse_json_response(&response, "OIDC token 响应")?);
        let access_token = first_string(&payload, &["access_token", "accessToken", "token"])
            .ok_or_else(|| {
                AuthError::InvalidResponse("OIDC token 响应缺少 access token".to_string())
            })?;
        let refresh_token = first_string(&payload, &["refresh_token", "refreshToken"]);
        let expires_at = payload
            .get("expires_in")
            .and_then(Value::as_u64)
            .map(|value| now_secs().saturating_add(value))
            .or_else(|| jwt_expiry(&access_token));
        let mut persisted = PersistedAuth {
            access_token,
            refresh_token,
            provider: "oidc".to_string(),
            user: None,
            expires_at,
        };
        eprintln!(
            "[HTTP API][OIDC] token 解析成功 has_refresh_token={} expires_at_present={}",
            persisted.refresh_token.is_some(),
            persisted.expires_at.is_some()
        );
        if let Err(error) = self.save_auth_snapshot(&persisted, &previous_auth, false) {
            eprintln!("[HTTP API][OIDC] 首次保存认证记录失败: {}", error);
            return Err(error);
        }
        eprintln!("[HTTP API][OIDC] 首次保存认证记录成功");
        self.notify_auth_state_changed(true);
        if let Ok(current_user) = self.authenticated_request("GET", "/api/users/me", None) {
            if let Ok(payload) = parse_json_response(&current_user, "当前用户响应") {
                let previous = persisted.clone();
                persisted.user = Some(sanitize_user(&unwrap_data(&payload)));
                if let Err(error) = self.save_auth_snapshot(&persisted, &Some(previous), false) {
                    eprintln!("[HTTP API][OIDC] 保存用户信息失败: {}", error);
                    return Err(error);
                }
                eprintln!("[HTTP API][OIDC] 保存用户信息成功");
            }
        }
        Ok(self.auth_state())
    }
    pub fn login(&self, input: LoginInput) -> Result<WorkingAuthState, AuthError> {
        let _permit = self.operation_gate.try_acquire(AuthOperation::Login)?;
        let previous_auth = self.auth.lock().unwrap().clone();
        let email = validate_field(input.email, "邮箱", 320)?;
        let password = validate_field(input.password, "密码", 1024)?;
        let response = self.request_public(
            "POST",
            "/api/auth/login",
            Some(json!({ "email": email, "password": password })),
        )?;
        let payload = parse_json_response(&response, "登录响应")?;
        let access_token = first_string(&payload, &["token", "access_token", "accessToken"])
            .ok_or_else(|| AuthError::InvalidResponse("登录响应缺少 token".to_string()))?;
        let refresh_token = first_string(&payload, &["refresh_token", "refreshToken"]);
        let user = payload
            .get("user")
            .cloned()
            .filter(|value| value.is_object())
            .map(|value| sanitize_user(&value))
            .or_else(|| user_snapshot_from_auth_payload(&payload, Some(&email)));
        let expires_at = jwt_expiry(&access_token);
        let mut persisted = PersistedAuth {
            access_token,
            refresh_token,
            provider: "legacy".to_string(),
            user,
            expires_at,
        };
        self.save_auth_snapshot(&persisted, &previous_auth, false)?;
        self.notify_auth_state_changed(true);

        if persisted.user.is_none() {
            match self.authenticated_request("GET", "/api/users/me", None) {
                Ok(current_user) => {
                    if let Ok(payload) = parse_json_response(&current_user, "当前用户响应") {
                        let previous = persisted.clone();
                        persisted.user = Some(sanitize_user(&unwrap_data(&payload)));
                        self.save_auth_snapshot(&persisted, &Some(previous), false)?;
                    }
                }
                Err(error @ AuthError::Upstream { status: 401, .. }) => {
                    let _ = self.clear_auth_snapshot(Some(&persisted));
                    return Err(error);
                }
                Err(_) => {}
            }
        }
        Ok(self.auth_state())
    }

    pub fn register(&self, input: RegisterInput) -> Result<RegisterResult, AuthError> {
        let _permit = self.operation_gate.try_acquire(AuthOperation::Register)?;
        let email = validate_field(input.email, "邮箱", 320)?;
        let password = validate_field(input.password, "密码", 1024)?;
        let nickname = validate_optional(input.nickname, "昵称", 128)?;
        let invitation_code = validate_optional(input.invitation_code, "邀请码", 256)?;
        let verification_code = validate_optional(input.verification_code, "验证码", 64)?;
        let response = self.request_public(
            "POST",
            "/api/auth/register",
            Some(json!({
                "email": email,
                "password": password,
                "nickname": nickname.unwrap_or_default(),
                "invitationCode": invitation_code.unwrap_or_default(),
                "verificationCode": verification_code.unwrap_or_default(),
            })),
        )?;
        Ok(RegisterResult {
            payload: unwrap_data(&parse_json_response(&response, "注册响应")?),
        })
    }

    pub fn send_code(&self, input: SendCodeInput) -> Result<(), AuthError> {
        let _permit = self.operation_gate.try_acquire(AuthOperation::SendCode)?;
        let email = validate_field(input.email, "邮箱", 320)?;
        let purpose = validate_optional(input.purpose, "验证码用途", 64)?;
        self.request_public(
            "POST",
            "/api/auth/send-code",
            Some(json!({ "email": email, "purpose": purpose.unwrap_or_else(|| "register".to_string()) })),
        )?;
        Ok(())
    }

    pub fn verify_reset_code(&self, input: VerifyResetCodeInput) -> Result<ResetToken, AuthError> {
        let _permit = self.operation_gate.try_acquire(AuthOperation::VerifyCode)?;
        let email = validate_field(input.email, "邮箱", 320)?;
        let code = validate_field(input.code, "验证码", 64)?;
        let response = self.request_public(
            "POST",
            "/api/auth/verify-code",
            Some(json!({ "email": email, "code": code, "purpose": "password_reset" })),
        )?;
        let payload = unwrap_data(&parse_json_response(&response, "验证码响应")?);
        let token = first_string(&payload, &["reset_token", "resetToken"])
            .ok_or_else(|| AuthError::InvalidResponse("验证码响应缺少重置凭证".to_string()))?;
        Ok(ResetToken { token })
    }

    pub fn reset_password(
        &self,
        email: &str,
        reset_token: &str,
        password: &str,
    ) -> Result<(), AuthError> {
        let _permit = self
            .operation_gate
            .try_acquire(AuthOperation::ResetPassword)?;
        let email = validate_field(email.to_string(), "邮箱", 320)?;
        let reset_token = validate_field(reset_token.to_string(), "重置凭证", 1024)?;
        let password = validate_field(password.to_string(), "密码", 1024)?;
        self.request_public(
            "POST",
            "/api/auth/password/reset",
            Some(json!({ "email": email, "reset_token": reset_token, "password": password })),
        )?;
        Ok(())
    }

    pub fn refresh_single_flight(&self) -> Result<String, AuthError> {
        let (_, generation) = self.auth_snapshot_for_generation(None)?;
        self.refresh_for_generation(generation)
    }

    fn refresh_for_generation(&self, generation: u64) -> Result<String, AuthError> {
        let mut state = self.refresh_state.lock().unwrap();
        self.auth_snapshot_for_generation(Some(generation))?;
        if state.active {
            // 只允许同一登录共享刷新结果，避免新账号复用旧账号的 token。
            if state.generation != generation {
                return Err(AuthError::Busy);
            }
            if self.auth_storage_gate.try_lock().is_err() {
                return Err(AuthError::Busy);
            }
            state.waiters += 1;
            while state.active {
                state = self.refresh_wakeup.wait(state).unwrap();
            }
            state.waiters -= 1;
            self.auth_snapshot_for_generation(Some(generation))?;
            return state
                .result
                .clone()
                .unwrap_or(Err(AuthError::RefreshFailed));
        }
        if self.auth_storage_gate.try_lock().is_err() {
            return Err(AuthError::Busy);
        }
        let (auth, _) = self.auth_snapshot_for_generation(Some(generation))?;
        let refresh_token = auth.refresh_token.ok_or(AuthError::NotAuthenticated)?;
        state.active = true;
        state.generation = generation;
        state.result = None;
        drop(state);

        let result = self.perform_refresh(&refresh_token, generation);
        let mut state = self.refresh_state.lock().unwrap();
        state.active = false;
        state.result = Some(result.clone());
        self.refresh_wakeup.notify_all();
        result
    }

    #[cfg(test)]
    pub fn refresh_waiters(&self) -> usize {
        self.refresh_state.lock().unwrap().waiters
    }

    pub fn logout(&self) -> Result<(), AuthError> {
        self.clear_auth_snapshot(None).map(|_| ())
    }

    pub fn authenticated_request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<EduApiResponse, AuthError> {
        self.authenticated_request_with_headers(method, path, body, Vec::new())
    }

    pub fn authenticated_request_with_headers(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
        headers: Vec<(String, String)>,
    ) -> Result<EduApiResponse, AuthError> {
        let (auth, generation) = self.auth_snapshot_for_generation(None)?;
        let result = self.request_with_token(
            method,
            path,
            body.clone(),
            Some(auth.access_token),
            headers.clone(),
        );
        self.auth_snapshot_for_generation(Some(generation))?;
        match result {
            Ok(response) => Ok(response),
            Err(AuthError::Upstream { status: 401, .. }) => {
                let token = self.refresh_for_generation(generation)?;
                self.auth_snapshot_for_generation(Some(generation))?;
                let replay = self.request_with_token(method, path, body, Some(token), headers);
                self.auth_snapshot_for_generation(Some(generation))?;
                match replay {
                    Ok(response) => Ok(response),
                    Err(replayed @ AuthError::Upstream { status: 401, .. }) => {
                        let _ = self.clear_auth_snapshot_for_generation(None, Some(generation));
                        Err(replayed)
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    fn auth_snapshot_for_generation(
        &self,
        expected: Option<u64>,
    ) -> Result<(PersistedAuth, u64), AuthError> {
        let auth = self.auth.lock().unwrap();
        let generation = self.auth_generation.load(Ordering::Relaxed);
        if expected.is_some_and(|expected| expected != generation) {
            return Err(AuthError::NotAuthenticated);
        }
        Ok((auth.clone().ok_or(AuthError::NotAuthenticated)?, generation))
    }

    pub(crate) fn current_access_token(&self) -> Result<String, AuthError> {
        self.auth
            .lock()
            .unwrap()
            .as_ref()
            .map(|auth| auth.access_token.clone())
            .ok_or(AuthError::NotAuthenticated)
    }

    pub(crate) fn image_task_identity(&self) -> Result<(u64, String, Option<u64>), AuthError> {
        let auth = self.auth.lock().unwrap();
        let auth = auth.as_ref().ok_or(AuthError::NotAuthenticated)?;
        let user_id = auth
            .user
            .as_ref()
            .and_then(|user| {
                user.get("ID")
                    .or_else(|| user.get("id"))
                    .or_else(|| user.get("user_id"))
            })
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or(AuthError::NotAuthenticated)?;
        Ok((user_id, auth.access_token.clone(), auth.expires_at))
    }

    fn request_public(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<EduApiResponse, AuthError> {
        self.request_with_token(
            method,
            path,
            body.map(|value| value.to_string()),
            None,
            Vec::new(),
        )
    }

    fn request_with_token(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
        access_token: Option<String>,
        headers: Vec<(String, String)>,
    ) -> Result<EduApiResponse, AuthError> {
        self.request_with_client(&self.client, method, path, body, access_token, headers)
    }

    fn request_with_client(
        &self,
        client: &EduApiClient,
        method: &str,
        path: &str,
        body: Option<String>,
        access_token: Option<String>,
        headers: Vec<(String, String)>,
    ) -> Result<EduApiResponse, AuthError> {
        let request_id = format!(
            "auth-{}",
            self.request_sequence.fetch_add(1, Ordering::Relaxed)
        );
        let request = EduApiRequest {
            method: method.to_string(),
            path: path.to_string(),
            body,
            access_token,
            headers,
            request_id,
        };
        client.request(request).map_err(map_edu_error)
    }

    fn perform_refresh(&self, refresh_token: &str, generation: u64) -> Result<String, AuthError> {
        let (previous, _) = self.auth_snapshot_for_generation(Some(generation))?;
        if previous.refresh_token.as_deref() != Some(refresh_token) {
            return Err(AuthError::NotAuthenticated);
        }
        let provider = previous.provider.clone();
        let response = if provider == "oidc" {
            let client = self
                .oidc_client
                .as_ref()
                .ok_or_else(|| AuthError::InvalidResponse("OIDC 认证服务未配置".to_string()))?;
            self.request_with_client(
                client,
                "POST",
                "/oauth/token",
                Some(format!(
                    "grant_type=refresh_token&client_id=copis-desktop&refresh_token={}",
                    percent_encode(refresh_token)
                )),
                None,
                Vec::new(),
            )
        } else {
            self.request_public(
                "POST",
                "/api/auth/refresh",
                Some(json!({ "refresh_token": refresh_token })),
            )
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if matches!(&error, AuthError::Upstream { status: 400, code, .. } if code == "invalid_grant")
                {
                    self.clear_after_refresh_failure(&previous, generation);
                } else if matches!(error, AuthError::Upstream { status: 401, .. }) {
                    self.clear_after_refresh_failure(&previous, generation);
                }
                return Err(error);
            }
        };
        let payload = unwrap_data(&parse_json_response(&response, "刷新响应")?);
        let access_token = first_string(&payload, &["token", "access_token", "accessToken"])
            .ok_or_else(|| AuthError::InvalidResponse("刷新响应缺少 token".to_string()))?;
        let (current, _) = self.auth_snapshot_for_generation(Some(generation))?;
        if !same_auth_identity(&current, &previous) {
            return Err(AuthError::NotAuthenticated);
        }
        let next = PersistedAuth {
            access_token: access_token.clone(),
            refresh_token: first_string(&payload, &["refresh_token", "refreshToken"])
                .or(previous.refresh_token.clone()),
            provider,
            user: current.user,
            expires_at: payload
                .get("expires_in")
                .and_then(Value::as_u64)
                .map(|value| now_secs().saturating_add(value))
                .or_else(|| jwt_expiry(&access_token)),
        };
        self.save_auth_snapshot_for_generation(&next, &Some(previous), true, Some(generation))?;
        self.notify_auth_state_changed(true);
        Ok(access_token)
    }

    fn clear_after_refresh_failure(&self, expected: &PersistedAuth, generation: u64) {
        if self
            .clear_auth_snapshot_for_generation(Some(expected), Some(generation))
            .is_err()
        {
            eprintln!("[HTTP API][认证] 自动清理认证存储失败");
        }
    }

    fn save_auth_snapshot(
        &self,
        next: &PersistedAuth,
        expected: &Option<PersistedAuth>,
        preserve_current_user: bool,
    ) -> Result<(), AuthError> {
        self.save_auth_snapshot_for_generation(next, expected, preserve_current_user, None)
    }

    fn save_auth_snapshot_for_generation(
        &self,
        next: &PersistedAuth,
        expected: &Option<PersistedAuth>,
        preserve_current_user: bool,
        expected_generation: Option<u64>,
    ) -> Result<(), AuthError> {
        let _storage_guard = self.auth_storage_gate.lock().unwrap();
        let (previous, persisted) = {
            let mut auth = self.auth.lock().unwrap();
            if !same_optional_auth(&auth, expected)
                || expected_generation.is_some_and(|generation| {
                    generation != self.auth_generation.load(Ordering::Relaxed)
                })
            {
                return Err(AuthError::NotAuthenticated);
            }
            let previous = auth.clone();
            let mut persisted = next.clone();
            if preserve_current_user {
                if let (Some(expected), Some(current)) = (expected, auth.as_ref()) {
                    if next.access_token != expected.access_token
                        && same_auth_identity(current, expected)
                    {
                        persisted.user = current.user.clone();
                    }
                }
            }
            // 同账号资料更新和 token 刷新保留代次；切换凭据使所有旧业务请求失效。
            if !preserve_current_user && !same_optional_auth(&Some(persisted.clone()), &previous) {
                self.auth_generation.fetch_add(1, Ordering::Relaxed);
            }
            *auth = Some(persisted.clone());
            (previous, persisted)
        };

        if let Err(error) = self.storage.save(&persisted) {
            let mut auth = self.auth.lock().unwrap();
            if auth
                .as_ref()
                .map(|current| same_auth_identity(current, &persisted))
                .unwrap_or(false)
            {
                // 回滚凭据也是登录边界，撤销暂存账号期间发出的业务请求。
                if !same_optional_auth(&auth, &previous) {
                    self.auth_generation.fetch_add(1, Ordering::Relaxed);
                }
                *auth = previous;
            }
            return Err(error);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn save_auth_snapshot_for_test(
        &self,
        next: &PersistedAuth,
        expected: &Option<PersistedAuth>,
    ) -> Result<(), AuthError> {
        self.save_auth_snapshot(next, expected, false)
    }

    fn clear_auth_snapshot(&self, expected: Option<&PersistedAuth>) -> Result<bool, AuthError> {
        self.clear_auth_snapshot_for_generation(expected, None)
    }

    fn clear_auth_snapshot_for_generation(
        &self,
        expected: Option<&PersistedAuth>,
        expected_generation: Option<u64>,
    ) -> Result<bool, AuthError> {
        let _storage_guard = self.auth_storage_gate.lock().unwrap();
        {
            let mut auth = self.auth.lock().unwrap();
            if expected_generation.is_some_and(|generation| {
                generation != self.auth_generation.load(Ordering::Relaxed)
            }) {
                return Ok(false);
            }
            if !expected
                .map(|expected| {
                    auth.as_ref()
                        .map(|current| same_auth_identity(current, expected))
                        .unwrap_or(false)
                })
                .unwrap_or(true)
            {
                return Ok(false);
            }
            self.auth_generation.fetch_add(1, Ordering::Relaxed);
            *auth = None;
        }

        let storage_result = self.storage.clear();
        self.notify_auth_state_changed(false);
        storage_result.map(|()| true)
    }
}

fn same_auth_identity(left: &PersistedAuth, right: &PersistedAuth) -> bool {
    let left_owner = left.user.as_ref().and_then(auth_user_identity);
    let right_owner = right.user.as_ref().and_then(auth_user_identity);
    left.access_token == right.access_token
        && left.refresh_token == right.refresh_token
        && left.provider == right.provider
        && left_owner
            .zip(right_owner)
            .map(|(left, right)| left == right)
            .unwrap_or(true)
}

fn same_optional_auth(left: &Option<PersistedAuth>, right: &Option<PersistedAuth>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_auth_identity(left, right),
        (None, None) => true,
        _ => false,
    }
}

fn auth_user_identity(user: &Value) -> Option<&Value> {
    ["ID", "id", "user_id", "sub"]
        .iter()
        .find_map(|key| user.get(key).filter(|value| !value.is_null()))
}

pub fn working_oidc_redirect_uri() -> String {
    let port = std::env::var("COPIS_HTTP_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(51730);
    format!("http://127.0.0.1:{port}/api/working/oauth/callback")
}

fn validate_oidc_redirect_uri(value: &str) -> Result<(), AuthError> {
    if value != working_oidc_redirect_uri() {
        return Err(AuthError::InvalidInput("OIDC 回调地址不安全".to_string()));
    }
    if value.contains('?') || value.contains('#') || value.contains('@') || value.contains("..") {
        return Err(AuthError::InvalidInput("OIDC 回调地址不安全".to_string()));
    }
    Ok(())
}

struct ValidatedOidcEndpoint {
    url: String,
    path: String,
}

fn validate_oidc_endpoint(value: &str, issuer: &str) -> Result<ValidatedOidcEndpoint, AuthError> {
    let value = value.trim().trim_end_matches('/');
    let issuer = issuer.trim_end_matches('/');
    if value.is_empty()
        || value.contains('?')
        || value.contains('#')
        || value.contains("..")
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(AuthError::InvalidResponse(
            "OIDC endpoint 不安全".to_string(),
        ));
    }
    if value.starts_with('/') {
        return Ok(ValidatedOidcEndpoint {
            url: format!("{}{}", issuer, value),
            path: value.to_string(),
        });
    }
    let relative = value
        .strip_prefix(issuer)
        .filter(|suffix| suffix.starts_with('/'))
        .ok_or_else(|| AuthError::InvalidResponse("OIDC endpoint 与 issuer 不匹配".to_string()))?;
    Ok(ValidatedOidcEndpoint {
        url: value.to_string(),
        path: relative.to_string(),
    })
}

fn percent_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{:02X}", byte));
        }
        output
    })
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_digit(bytes[index + 1])?;
            let low = hex_digit(bytes[index + 2])?;
            output.push((high << 4) | low);
            index += 3;
        } else if bytes[index] == b'+' {
            output.push(b' ');
            index += 1;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn query_param(target: &str, name: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key)?.as_str() == name)
            .then(|| percent_decode(value))
            .flatten()
    })
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn normalize_persisted_auth(mut auth: PersistedAuth) -> Result<PersistedAuth, AuthError> {
    if auth.access_token.trim().is_empty() {
        return Err(AuthError::InvalidResponse(
            "认证存储缺少 access token".to_string(),
        ));
    }
    auth.user = auth.user.as_ref().map(sanitize_user);
    if auth.expires_at.is_none() {
        auth.expires_at = jwt_expiry(&auth.access_token);
    }
    Ok(auth)
}

fn validate_field(value: String, name: &str, max_length: usize) -> Result<String, AuthError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(AuthError::InvalidInput(format!("{}参数不正确", name)));
    }
    Ok(value)
}

fn validate_optional(
    value: Option<String>,
    name: &str,
    max_length: usize,
) -> Result<Option<String>, AuthError> {
    value
        .map(|value| validate_field(value, name, max_length))
        .transpose()
}

fn parse_json_response(response: &EduApiResponse, name: &str) -> Result<Value, AuthError> {
    if response.body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&response.body)
        .map_err(|_| AuthError::InvalidResponse(format!("{}不是有效 JSON", name)))
}

fn unwrap_data(value: &Value) -> Value {
    value.get("data").cloned().unwrap_or_else(|| value.clone())
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn user_snapshot_from_auth_payload(value: &Value, email: Option<&str>) -> Option<Value> {
    let id = value
        .get("user_id")
        .or_else(|| value.get("userId"))
        .cloned()?;
    let mut user = Map::new();
    user.insert("id".to_string(), id);
    if let Some(email) = email.filter(|email| !email.trim().is_empty()) {
        user.insert("email".to_string(), Value::String(email.to_string()));
    }
    for key in [
        "email",
        "is_admin",
        "account_type",
        "role",
        "must_change_password",
    ] {
        if let Some(field) = value.get(key) {
            user.insert(key.to_string(), field.clone());
        }
    }
    Some(Value::Object(user))
}

fn sanitize_user(value: &Value) -> Value {
    let Value::Object(object) = value else {
        return Value::Null;
    };
    let mut sanitized = Map::new();
    for (key, value) in object {
        if key.to_ascii_lowercase().contains("password")
            || key.to_ascii_lowercase().contains("secret")
            || key.to_ascii_lowercase().contains("credential")
            || key.eq_ignore_ascii_case("token")
        {
            continue;
        }
        sanitized.insert(key.clone(), value.clone());
    }
    Value::Object(sanitized)
}

fn jwt_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value = serde_json::from_slice::<Value>(&decoded).ok()?;
    value.get("exp").and_then(Value::as_u64)
}

fn map_edu_error(error: EduApiError) -> AuthError {
    match error {
        EduApiError::Upstream {
            status,
            code,
            message,
            ..
        } => AuthError::Upstream {
            status,
            code,
            message,
        },
        EduApiError::Overloaded => AuthError::Busy,
        EduApiError::InvalidPath(message) | EduApiError::InvalidConfiguration(message) => {
            AuthError::InvalidInput(message)
        }
        EduApiError::InvalidHeader => AuthError::InvalidInput("认证请求头不正确".to_string()),
        EduApiError::RequestBodyTooLarge | EduApiError::ResponseBodyTooLarge => {
            AuthError::InvalidInput("认证请求数据过大".to_string())
        }
        EduApiError::Transport(message) => AuthError::Network(message),
    }
}
