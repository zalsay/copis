#[cfg(test)]
use crate::skill_market::remote_json_raw;
use crate::skill_market::{
    percent_decode, remote_json, SkillMarketError, SkillMarketResponse, SkillMarketState,
};
use crate::{
    payment_workspace::PaymentWorkspace,
    pi_rpc::{PaymentWorkerAction, PiWorkerManager},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DESKTOP_PAYMENT_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
pub enum WorkingPaymentRoute {
    ListDiamondPackages,
    PendingDiamondPurchase,
    CreateDiamondPurchase,
    CreateVipUpgrade,
    GetOrderPayment { order_id: String },
    CheckPayment { payment_id: String },
    CancelDiamondPayment { payment_id: String },
}

pub fn parse_working_payment_route(
    method: &str,
    target: &str,
) -> Result<WorkingPaymentRoute, String> {
    let path = target.split('?').next().unwrap_or(target);
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match (method, parts.as_slice()) {
        ("GET", ["api", "working", "diamond-packages"]) => {
            Ok(WorkingPaymentRoute::ListDiamondPackages)
        }
        ("GET", ["api", "working", "diamond-purchases", "pending"]) => {
            Ok(WorkingPaymentRoute::PendingDiamondPurchase)
        }
        ("POST", ["api", "working", "diamond-purchases"]) => {
            Ok(WorkingPaymentRoute::CreateDiamondPurchase)
        }
        ("POST", ["api", "working", "vip", "upgrade"]) => Ok(WorkingPaymentRoute::CreateVipUpgrade),
        ("GET", ["api", "working", "orders", order_id, "payment"]) => {
            Ok(WorkingPaymentRoute::GetOrderPayment {
                order_id: decode_identifier(order_id)?,
            })
        }
        ("POST", ["api", "working", "diamond-purchases", payment_id, "check"]) => {
            Ok(WorkingPaymentRoute::CheckPayment {
                payment_id: decode_identifier(payment_id)?,
            })
        }
        ("POST", ["api", "working", "diamond-purchases", payment_id, "cancel"]) => {
            Ok(WorkingPaymentRoute::CancelDiamondPayment {
                payment_id: decode_identifier(payment_id)?,
            })
        }
        _ => Err("Working 支付路由不存在或请求方法不支持".to_string()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopPaymentFlowKind {
    Diamond,
    Vip,
}

impl DesktopPaymentFlowKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Diamond => "diamond",
            Self::Vip => "vip",
        }
    }

    fn prepare_path(self) -> &'static str {
        match self {
            Self::Diamond => "/api/internal/working-desktop/alipay/diamond/prepare",
            Self::Vip => "/api/internal/working-desktop/alipay/vip/prepare",
        }
    }
}

#[derive(Clone, Debug)]
struct WorkingDesktopPaymentFlow {
    capability: String,
    flow_kind: DesktopPaymentFlowKind,
    trade_no: Option<String>,
    out_shake_no: Option<String>,
    request_context: PaymentRequestContext,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshedWorkingAuth {
    pub token: String,
    pub user_id: String,
}

/// refresh token 仅由 Electron 的加密存储持有；Rust 在 VIP 到账后只请求其刷新并接收新的 access token。
pub trait VipPaymentRefresher: Send + Sync {
    fn refresh_after_vip_payment(&self) -> Result<RefreshedWorkingAuth, String>;
}

#[derive(Clone, Debug)]
struct PaymentRequestContext {
    resource_url: String,
    method: String,
    data: String,
    headers: Vec<Value>,
}

impl PaymentRequestContext {
    fn payment_start_request(&self, payment_needed: String) -> Value {
        json!({
            "paymentNeeded": payment_needed,
            "resourceUrl": self.resource_url,
            "method": self.method,
            "data": self.data,
            "headers": self.headers,
            "intentSummary": "Copis Working 设置页支付",
        })
    }

    fn payment_check_request(&self, trade_no: Option<&str>, out_shake_no: Option<&str>) -> Value {
        let mut request = json!({
            "resourceUrl": self.resource_url,
            "method": self.method,
            "data": self.data,
            "headers": self.headers,
        });
        let request_object = request.as_object_mut().expect("支付检查请求必须是对象");
        if let Some(out_shake_no) = out_shake_no {
            request_object.insert(
                "outShakeNo".to_string(),
                Value::String(out_shake_no.to_string()),
            );
        } else if let Some(trade_no) = trade_no {
            request_object.insert("tradeNo".to_string(), Value::String(trade_no.to_string()));
        }
        request
    }
}

/// desktop capability 仅在 Rust 内存中保存，不进入 Renderer、Pi 模型输入或本地配置文件。
#[derive(Default)]
pub struct WorkingPaymentState {
    flows: Mutex<HashMap<String, WorkingDesktopPaymentFlow>>,
    checking: Mutex<HashSet<String>>,
    vip_payment_refresher: Mutex<Option<Arc<dyn VipPaymentRefresher>>>,
}

impl WorkingPaymentState {
    pub fn new() -> Self {
        Self::default()
    }

    fn remember(&self, payment_id: String, flow: WorkingDesktopPaymentFlow) {
        self.flows.lock().unwrap().insert(payment_id, flow);
    }

    fn flow(&self, payment_id: &str) -> Option<WorkingDesktopPaymentFlow> {
        self.flows.lock().unwrap().get(payment_id).cloned()
    }

    fn remove(&self, payment_id: &str) {
        self.flows.lock().unwrap().remove(payment_id);
        self.checking.lock().unwrap().remove(payment_id);
    }

    pub fn set_vip_payment_refresher(&self, refresher: Arc<dyn VipPaymentRefresher>) {
        *self.vip_payment_refresher.lock().unwrap() = Some(refresher);
    }

    fn refresh_after_payment(
        &self,
        flow_kind: DesktopPaymentFlowKind,
        status: &str,
        skill_market_state: &SkillMarketState,
    ) {
        if flow_kind != DesktopPaymentFlowKind::Vip || status != "resource_ready" {
            return;
        }
        let Some(refresher) = self.vip_payment_refresher.lock().unwrap().clone() else {
            eprintln!("[支付] VIP 到账后认证刷新器不可用");
            return;
        };
        match refresher.refresh_after_vip_payment() {
            Ok(auth) => skill_market_state.set_working_auth(Some(auth.token), Some(auth.user_id)),
            Err(error) => eprintln!("[支付] VIP 到账后刷新账户状态失败: {}", error),
        }
    }

    fn payment_ids(&self) -> Vec<String> {
        self.flows.lock().unwrap().keys().cloned().collect()
    }

    fn begin_check(&self, payment_id: &str) -> Option<WorkingPaymentCheckGuard<'_>> {
        let mut checking = self.checking.lock().unwrap();
        if !checking.insert(payment_id.to_string()) {
            return None;
        }
        Some(WorkingPaymentCheckGuard {
            state: self,
            payment_id: payment_id.to_string(),
        })
    }
}

struct WorkingPaymentCheckGuard<'a> {
    state: &'a WorkingPaymentState,
    payment_id: String,
}

impl Drop for WorkingPaymentCheckGuard<'_> {
    fn drop(&mut self) {
        self.state.checking.lock().unwrap().remove(&self.payment_id);
    }
}

/// 支付 Worker 是外部进程边界；抽象为 trait 以便用契约测试验证 Rust 编排而不执行真实付款。
pub trait PaymentWorker {
    fn execute_payment(
        &self,
        workspace: &PaymentWorkspace,
        server_account_id: &str,
        action: PaymentWorkerAction,
        request: Value,
    ) -> Result<Value, String>;
}

impl PaymentWorker for PiWorkerManager {
    fn execute_payment(
        &self,
        workspace: &PaymentWorkspace,
        server_account_id: &str,
        action: PaymentWorkerAction,
        request: Value,
    ) -> Result<Value, String> {
        PiWorkerManager::execute_payment(self, workspace, server_account_id, action, request)
    }
}

/// 在订单创建后由 Rust 持续检查支付状态，避免 Agent 根据用户口头确认执行支付查询或履约。
pub fn start_desktop_payment_poller(
    payment_state: Arc<WorkingPaymentState>,
    worker: Arc<PiWorkerManager>,
    workspace: Arc<PaymentWorkspace>,
    skill_market_state: Arc<SkillMarketState>,
) {
    let result = thread::Builder::new()
        .name("copis-payment-poller".to_string())
        .spawn(move || loop {
            let Some(token) = skill_market_state.access_token() else {
                thread::sleep(DESKTOP_PAYMENT_POLL_INTERVAL);
                continue;
            };
            let Some(account_key) = skill_market_state.payment_account_key() else {
                thread::sleep(DESKTOP_PAYMENT_POLL_INTERVAL);
                continue;
            };
            let _ = recover_pending_desktop_payment(&payment_state, &token);
            let failures = poll_desktop_payments_once(
                &payment_state,
                worker.as_ref(),
                workspace.as_ref(),
                skill_market_state.as_ref(),
                &token,
                &account_key,
            );
            if failures > 0 {
                eprintln!("[支付] 自动查询暂时失败，将继续重试");
            }
            thread::sleep(DESKTOP_PAYMENT_POLL_INTERVAL);
        });
    if result.is_err() {
        eprintln!("[支付] 无法启动自动查询任务");
    }
}

/// 服务重启后恢复一笔待支付的钻石订单，使原有订单也由 Rust 接管状态同步。
/// edu-api 仅允许保留一笔待支付钻石订单，因此无需将交易标识暴露给 Agent。
pub fn recover_pending_desktop_payment(
    payment_state: &WorkingPaymentState,
    working_token: &str,
) -> Result<bool, SkillMarketError> {
    if !payment_state.payment_ids().is_empty() {
        return Ok(false);
    }
    let pending = pending_diamond_payment(working_token)?;
    let payment = required_object_field(&pending, "payment", "没有待恢复的支付会话")?;
    if is_terminal_payment_status(&payment) {
        return Ok(false);
    }
    rehydrate_desktop_payment_flow_from_pending(payment_state, working_token, pending)?;
    Ok(true)
}

/// 执行一轮自动支付检查；返回实际失败次数，正在进行中的手动检查不计为失败。
pub fn poll_desktop_payments_once<P: PaymentWorker>(
    payment_state: &WorkingPaymentState,
    worker: &P,
    workspace: &PaymentWorkspace,
    skill_market_state: &SkillMarketState,
    working_token: &str,
    payment_account_key: &str,
) -> usize {
    payment_state
        .payment_ids()
        .into_iter()
        .filter(|payment_id| {
            match check_desktop_payment(
                payment_state,
                worker,
                workspace,
                skill_market_state,
                working_token,
                payment_account_key,
                payment_id,
            )
            {
                Ok(_) => false,
                Err(error) => error.code != "desktop_payment_check_in_progress",
            }
        })
        .count()
}

pub fn handle_request<P: PaymentWorker>(
    state: &SkillMarketState,
    payment_state: &WorkingPaymentState,
    worker: &P,
    workspace: &PaymentWorkspace,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<SkillMarketResponse, SkillMarketError> {
    let route = parse_working_payment_route(method, target).map_err(|message| {
        SkillMarketError::new(400, "invalid_working_payment_request", message)
    })?;
    let token = state
        .access_token()
        .ok_or_else(|| SkillMarketError::new(401, "unauthorized", "请先登录 Copis Working"))?;
    let payment_account_key = state.payment_account_key();

    let response = match route {
        WorkingPaymentRoute::ListDiamondPackages => {
            remote_json("GET", "/api/pay/alipay/diamond-packages", &token, None)?
        }
        WorkingPaymentRoute::PendingDiamondPurchase => remote_json(
            "GET",
            "/api/pay/alipay/diamond-purchases/pending",
            &token,
            None,
        )?,
        WorkingPaymentRoute::CreateDiamondPurchase => {
            let package_id = parse_package_id(body)?;
            create_desktop_payment(
                payment_state,
                worker,
                workspace,
                &token,
                required_payment_account_key(payment_account_key.as_deref())?,
                DesktopPaymentFlowKind::Diamond,
                Some(package_id),
            )?
        }
        WorkingPaymentRoute::CreateVipUpgrade => create_desktop_payment(
            payment_state,
            worker,
            workspace,
            &token,
            required_payment_account_key(payment_account_key.as_deref())?,
            DesktopPaymentFlowKind::Vip,
            None,
        )?,
        WorkingPaymentRoute::GetOrderPayment { order_id } => remote_json(
            "GET",
            &format!("/api/users/orders/{}/payment", encode_identifier(&order_id)),
            &token,
            None,
        )?,
        WorkingPaymentRoute::CheckPayment { payment_id } => {
            check_desktop_payment(
                payment_state,
                worker,
                workspace,
                state,
                &token,
                required_payment_account_key(payment_account_key.as_deref())?,
                &payment_id,
            )?
        }
        WorkingPaymentRoute::CancelDiamondPayment { payment_id } => {
            cancel_desktop_payment(payment_state, &payment_id)?
        }
    };

    Ok(SkillMarketResponse {
        status: 200,
        body: Some(response),
    })
}

fn create_desktop_payment<P: PaymentWorker>(
    payment_state: &WorkingPaymentState,
    worker: &P,
    workspace: &PaymentWorkspace,
    working_token: &str,
    payment_account_key: &str,
    flow_kind: DesktopPaymentFlowKind,
    package_id: Option<u64>,
) -> Result<Value, SkillMarketError> {
    let prepare_body = match package_id {
        Some(package_id) => json!({ "package_id": package_id }).to_string(),
        None => "{}".to_string(),
    };
    // prepare 会为 capability 绑定旧会话，并可能把会话状态写回 created；先保存待支付快照，
    // 才能继续展示原二维码而不是误判为异常订单。
    let pending_snapshot = if flow_kind == DesktopPaymentFlowKind::Diamond {
        Some(pending_diamond_payment(working_token)?)
    } else {
        None
    };
    // 旧会话异常时只取消并重新准备一次，避免无限重试或重复创建支付订单。
    for attempt in 0..2 {
        let capability = issue_desktop_capability(working_token, flow_kind)?;
        let prepared = remote_json(
            "POST",
            flow_kind.prepare_path(),
            &capability,
            Some(&prepare_body),
        )?;
        let prepared_payment = required_object_field(&prepared, "payment", "支付准备响应缺少支付会话")?;
        let payment_id = required_string_field(
            &prepared_payment,
            "payment_id",
            "支付准备响应缺少支付会话 ID",
        )?;
        let package = payment_package_for_flow(&prepared, &prepared_payment, flow_kind)?;
        let pending_existing = prepared
            .get("pending_existing")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let vip = prepared.get("vip").cloned();

        if flow_kind == DesktopPaymentFlowKind::Diamond && pending_existing {
            if let Some(result) = reuse_pending_diamond_payment(
                payment_state,
                &capability,
                &payment_id,
                package.clone(),
                pending_snapshot.as_ref(),
            )? {
                return Ok(result);
            }
            cancel_prepared_diamond_payment(&capability, &payment_id)?;
            if attempt == 0 {
                continue;
            }
            return Err(SkillMarketError::new(
                409,
                "desktop_payment_recovery_failed",
                "待支付订单状态异常，请稍后重新发起支付",
            ));
        }

        if is_terminal_payment_status(&prepared_payment) {
            return Ok(desktop_purchase_result(
                prepared_payment,
                package,
                flow_kind,
                pending_existing,
                vip,
            ));
        }

        let context = remote_json(
            "POST",
            "/api/internal/working-desktop/alipay/payment-context",
            &capability,
            Some(&json!({ "payment_id": payment_id }).to_string()),
        )?;
        let (payment_needed, request_context) = payment_request_context(&context)?;
        let payment_request = request_context.payment_start_request(payment_needed);
        let worker_result = worker
            .execute_payment(
                workspace,
                payment_account_key,
                PaymentWorkerAction::PaymentStart,
                payment_request,
            )
            .map_err(payment_worker_error)?;
        ensure_worker_succeeded(&worker_result, "生成支付宝支付二维码失败")?;

        let started = remote_json(
            "POST",
            "/api/internal/working-desktop/alipay/payment-started",
            &capability,
            Some(&payment_started_request(&payment_id, &worker_result).to_string()),
        )?;
        let payment = required_object_field(&started, "payment", "支付启动响应缺少支付会话")?;
        payment_state.remember(
            payment_id,
            WorkingDesktopPaymentFlow {
                capability,
                flow_kind,
                trade_no: optional_string_field(&worker_result, "tradeNo"),
                out_shake_no: optional_string_field(&worker_result, "outShakeNo"),
                request_context,
            },
        );
        return Ok(desktop_purchase_result(
            payment,
            package,
            flow_kind,
            pending_existing,
            vip,
        ));
    }

    Err(SkillMarketError::new(
        409,
        "desktop_payment_recovery_failed",
        "待支付订单状态异常，请稍后重新发起支付",
    ))
}

/// 复用已有的待支付订单，只恢复本机检查上下文，绝不再次启动支付或生成新二维码。
fn reuse_pending_diamond_payment(
    payment_state: &WorkingPaymentState,
    capability: &str,
    payment_id: &str,
    package: Value,
    pending: Option<&Value>,
) -> Result<Option<Value>, SkillMarketError> {
    let payment = match pending
        .and_then(|value| value.get("payment"))
        .filter(|value| value.is_object())
        .cloned()
    {
        Some(payment) => payment,
        None => return Ok(None),
    };
    if required_string_field(&payment, "payment_id", "待支付订单缺少支付会话 ID")? != payment_id {
        return Err(SkillMarketError::new(
            409,
            "desktop_payment_context_changed",
            "支付会话状态已变化，请重新发起支付",
        ));
    }
    if optional_string_field(&payment, "status").as_deref() != Some("pending_user_pay")
        || optional_string_field(&payment, "qrcode_image").is_none()
    {
        return Ok(None);
    }

    let context = remote_json(
        "POST",
        "/api/internal/working-desktop/alipay/payment-context",
        capability,
        Some(&json!({ "payment_id": payment_id }).to_string()),
    )?;
    let (_, request_context) = payment_request_context(&context)?;
    payment_state.remember(
        payment_id.to_string(),
        WorkingDesktopPaymentFlow {
            capability: capability.to_string(),
            flow_kind: DesktopPaymentFlowKind::Diamond,
            trade_no: optional_string_field(&payment, "trade_no"),
            out_shake_no: optional_string_field(&payment, "out_shake_no"),
            request_context,
        },
    );
    Ok(Some(desktop_purchase_result(
        payment,
        package,
        DesktopPaymentFlowKind::Diamond,
        true,
        None,
    )))
}

fn cancel_prepared_diamond_payment(capability: &str, payment_id: &str) -> Result<(), SkillMarketError> {
    let finalized = remote_json(
        "POST",
        "/api/internal/working-desktop/alipay/payment-finalize",
        capability,
        Some(&json!({ "payment_id": payment_id, "action": "cancel" }).to_string()),
    )?;
    let payment = required_object_field(&finalized, "payment", "取消支付响应缺少支付会话")?;
    if optional_string_field(&payment, "status").as_deref() != Some("cancelled") {
        return Err(SkillMarketError::new(
            409,
            "desktop_payment_cancel_failed",
            "待支付订单状态已变化，请稍后重试",
        ));
    }
    Ok(())
}

fn check_desktop_payment<P: PaymentWorker>(
    payment_state: &WorkingPaymentState,
    worker: &P,
    workspace: &PaymentWorkspace,
    skill_market_state: &SkillMarketState,
    working_token: &str,
    payment_account_key: &str,
    payment_id: &str,
) -> Result<Value, SkillMarketError> {
    let _check_guard = payment_state.begin_check(payment_id).ok_or_else(|| {
        SkillMarketError::new(
            409,
            "desktop_payment_check_in_progress",
            "支付状态正在查询，请稍候",
        )
    })?;
    let flow = match payment_state.flow(payment_id) {
        Some(flow) => flow,
        None => rehydrate_desktop_payment_flow(payment_state, working_token, payment_id)?,
    };
    if flow.out_shake_no.is_none() && flow.trade_no.is_none() {
        return Err(SkillMarketError::new(
            409,
            "desktop_payment_context_missing",
            "支付会话缺少交易标识，请重新发起支付",
        ));
    }
    let request = flow
        .request_context
        .payment_check_request(flow.trade_no.as_deref(), flow.out_shake_no.as_deref());

    let worker_result = worker
        .execute_payment(
            workspace,
            payment_account_key,
            PaymentWorkerAction::PaymentCheck,
            request,
        )
        .map_err(payment_worker_error)?;
    ensure_worker_succeeded(&worker_result, "检查支付宝支付状态失败")?;
    let check_result = payment_check_result(&worker_result)?;
    let finalized = remote_json(
        "POST",
        "/api/internal/working-desktop/alipay/payment-finalize",
        &flow.capability,
        Some(
            &json!({
                "payment_id": payment_id,
                "action": "check",
                "check_result": check_result,
            })
            .to_string(),
        ),
    )?;
    let payment = required_object_field(&finalized, "payment", "支付确认响应缺少支付会话")?;
    let status =
        optional_string_field(&payment, "status").unwrap_or_else(|| "pending_user_pay".to_string());
    payment_state.refresh_after_payment(flow.flow_kind, &status, skill_market_state);
    if is_terminal_payment_status(&payment) {
        payment_state.remove(payment_id);
    }
    Ok(json!({
        "data": {
            "status": status,
            "payment": payment,
        }
    }))
}

/// 进程重启后，Agent 仍只需传入 payment_id；Rust 重新取得并绑定短期 capability，绝不让 Agent 接触交易标识。
fn rehydrate_desktop_payment_flow(
    payment_state: &WorkingPaymentState,
    working_token: &str,
    payment_id: &str,
) -> Result<WorkingDesktopPaymentFlow, SkillMarketError> {
    let pending = pending_diamond_payment(working_token)?;
    let pending_payment = required_object_field(&pending, "payment", "支付会话不存在或已结束")?;
    let pending_payment_id = required_string_field(
        &pending_payment,
        "payment_id",
        "支付会话响应缺少支付会话 ID",
    )?;
    if pending_payment_id != payment_id {
        return Err(SkillMarketError::new(
            404,
            "desktop_payment_not_found",
            "支付会话不存在或已结束",
        ));
    }
    rehydrate_desktop_payment_flow_from_pending(payment_state, working_token, pending)
}

fn pending_diamond_payment(working_token: &str) -> Result<Value, SkillMarketError> {
    remote_json(
        "GET",
        "/api/pay/alipay/diamond-purchases/pending",
        working_token,
        None,
    )
}

fn rehydrate_desktop_payment_flow_from_pending(
    payment_state: &WorkingPaymentState,
    working_token: &str,
    pending: Value,
) -> Result<WorkingDesktopPaymentFlow, SkillMarketError> {
    let pending_payment = required_object_field(&pending, "payment", "支付会话不存在或已结束")?;
    let pending_payment_id = required_string_field(
        &pending_payment,
        "payment_id",
        "支付会话响应缺少支付会话 ID",
    )?;
    let flow_kind = pending_payment_flow_kind(&pending)?;
    let package = required_object_field(&pending, "package", "支付会话响应缺少套餐")?;
    let prepare_body = match flow_kind {
        DesktopPaymentFlowKind::Diamond => {
            let package_id = package
                .get("id")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid_desktop_payment_response("支付会话响应缺少有效套餐 ID"))?;
            json!({ "package_id": package_id })
        }
        DesktopPaymentFlowKind::Vip => json!({}),
    };

    let capability = issue_desktop_capability(working_token, flow_kind)?;
    let prepared = remote_json(
        "POST",
        flow_kind.prepare_path(),
        &capability,
        Some(&prepare_body.to_string()),
    )?;
    let prepared_payment = required_object_field(&prepared, "payment", "支付准备响应缺少支付会话")?;
    let prepared_payment_id = required_string_field(
        &prepared_payment,
        "payment_id",
        "支付准备响应缺少支付会话 ID",
    )?;
    if prepared_payment_id != pending_payment_id {
        return Err(SkillMarketError::new(
            409,
            "desktop_payment_context_changed",
            "支付会话状态已变化，请重新发起支付",
        ));
    }

    let context = remote_json(
        "POST",
        "/api/internal/working-desktop/alipay/payment-context",
        &capability,
        Some(&json!({ "payment_id": pending_payment_id }).to_string()),
    )?;
    let (_, request_context) = payment_request_context(&context)?;
    let flow = WorkingDesktopPaymentFlow {
        capability,
        flow_kind,
        trade_no: optional_string_field(&pending_payment, "trade_no")
            .or_else(|| optional_string_field(&prepared_payment, "trade_no")),
        out_shake_no: optional_string_field(&pending_payment, "out_shake_no")
            .or_else(|| optional_string_field(&prepared_payment, "out_shake_no")),
        request_context,
    };
    payment_state.remember(pending_payment_id, flow.clone());
    Ok(flow)
}

fn pending_payment_flow_kind(pending: &Value) -> Result<DesktopPaymentFlowKind, SkillMarketError> {
    let package = required_object_field(pending, "package", "支付会话响应缺少套餐")?;
    if ["service_id", "goods_name"]
        .iter()
        .any(|field| optional_string_field(&package, field).as_deref() == Some("pi-vip"))
    {
        return Ok(DesktopPaymentFlowKind::Vip);
    }
    Ok(DesktopPaymentFlowKind::Diamond)
}

fn cancel_desktop_payment(
    payment_state: &WorkingPaymentState,
    payment_id: &str,
) -> Result<Value, SkillMarketError> {
    let flow = payment_state.flow(payment_id).ok_or_else(|| {
        SkillMarketError::new(
            409,
            "desktop_payment_context_missing",
            "支付会话已失效，请重新发起支付",
        )
    })?;
    if flow.flow_kind != DesktopPaymentFlowKind::Diamond {
        return Err(SkillMarketError::new(
            403,
            "desktop_payment_cancel_not_allowed",
            "VIP 支付订单不支持取消",
        ));
    }
    let finalized = remote_json(
        "POST",
        "/api/internal/working-desktop/alipay/payment-finalize",
        &flow.capability,
        Some(&json!({ "payment_id": payment_id, "action": "cancel" }).to_string()),
    )?;
    let payment = required_object_field(&finalized, "payment", "取消支付响应缺少支付会话")?;
    payment_state.remove(payment_id);
    Ok(json!({ "cancelled": true, "payment": payment }))
}

fn issue_desktop_capability(
    working_token: &str,
    flow_kind: DesktopPaymentFlowKind,
) -> Result<String, SkillMarketError> {
    let response = remote_json(
        "POST",
        "/api/internal/working-desktop/payment-capabilities",
        working_token,
        Some(&json!({ "flow_kind": flow_kind.as_str() }).to_string()),
    )?;
    let capability = required_string_field(&response, "capability", "支付能力响应格式不正确")?;
    if !capability.starts_with("wdpc_") || capability.len() > 1024 {
        return Err(SkillMarketError::new(
            502,
            "invalid_desktop_payment_capability",
            "支付能力响应格式不正确",
        ));
    }
    Ok(capability)
}

fn payment_request_context(context: &Value) -> Result<(String, PaymentRequestContext), SkillMarketError> {
    let payment_needed = context
        .get("payment_needed")
        .ok_or_else(|| invalid_desktop_payment_response("支付上下文缺少 Payment-Needed"))?;
    let payment_needed = match payment_needed {
        Value::String(value) if !value.trim().is_empty() => value.clone(),
        Value::String(_) => {
            return Err(invalid_desktop_payment_response(
                "支付上下文缺少 Payment-Needed",
            ))
        }
        value => serde_json::to_string(value)
            .map_err(|_| invalid_desktop_payment_response("支付上下文格式不正确"))?,
    };
    let resource_url = required_string_field(context, "resource_url", "支付上下文缺少资源地址")?;
    let method = required_string_field(context, "method", "支付上下文缺少请求方法")?;
    let data = required_string_field(context, "data", "支付上下文缺少请求数据")?;
    let headers = context
        .get("headers")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_desktop_payment_response("支付上下文缺少请求头"))?
        .iter()
        .map(|(name, value)| {
            value.as_str().map_or_else(
                || {
                    Err(invalid_desktop_payment_response(
                        "支付上下文请求头格式不正确",
                    ))
                },
                |value| Ok(json!({ "name": name, "value": value })),
            )
        })
        .collect::<Result<Vec<Value>, SkillMarketError>>()?;
    Ok((
        payment_needed,
        PaymentRequestContext {
            resource_url,
            method,
            data,
            headers,
        },
    ))
}

fn payment_started_request(payment_id: &str, worker_result: &Value) -> Value {
    let mut request = json!({
        "payment_id": payment_id,
        "bot_result": {
            "action": "payment.start",
            "ok": worker_result.get("ok").and_then(Value::as_bool).unwrap_or(true),
        },
    });
    let request_object = request.as_object_mut().expect("支付启动回写请求必须是对象");
    for (source, target) in [
        ("tradeNo", "trade_no"),
        ("outShakeNo", "out_shake_no"),
        ("cashierUrl", "cashier_url"),
        ("qrCodeImage", "qrcode_image"),
        ("qrCodeMimeType", "qrcode_mime_type"),
    ] {
        if let Some(value) = optional_string_field(worker_result, source) {
            request_object.insert(target.to_string(), Value::String(value));
        }
    }
    request
}

fn payment_check_result(worker_result: &Value) -> Result<Value, SkillMarketError> {
    let status = optional_string_field(worker_result, "status")
        .unwrap_or_else(|| "pending".to_string())
        .to_ascii_lowercase();
    let status = match status.as_str() {
        "paid" | "success" | "trade_success" | "trade_finished" => "paid",
        "pending" | "pending_user_pay" | "waiting" | "processing" => "pending",
        _ => {
            return Err(SkillMarketError::new(
                502,
                "invalid_local_payment_check",
                "本机支付检查返回了不支持的状态",
            ))
        }
    };
    let mut result = json!({ "status": status });
    let result_object = result.as_object_mut().expect("支付检查结果必须是对象");
    for (source, target) in [
        ("tradeNo", "trade_no"),
        ("outShakeNo", "out_shake_no"),
        ("clientSession", "client_session"),
    ] {
        if let Some(value) = optional_string_field(worker_result, source) {
            result_object.insert(target.to_string(), Value::String(value));
        }
    }
    if status == "paid" {
        if let Some(payment_proof) = optional_string_field(worker_result, "paymentProof") {
            result_object.insert("payment_proof".to_string(), Value::String(payment_proof));
        }
    }
    Ok(result)
}

fn payment_package_for_flow(
    prepared: &Value,
    payment: &Value,
    flow_kind: DesktopPaymentFlowKind,
) -> Result<Value, SkillMarketError> {
    if let Some(package) = prepared.get("package").filter(|value| value.is_object()) {
        return Ok(package.clone());
    }
    if flow_kind != DesktopPaymentFlowKind::Vip {
        return Err(invalid_desktop_payment_response("支付准备响应缺少有效套餐"));
    }
    let vip = required_object_field(prepared, "vip", "VIP 支付响应缺少权益信息")?;
    let amount = optional_string_field(&vip, "amount")
        .or_else(|| optional_string_field(payment, "amount"))
        .ok_or_else(|| invalid_desktop_payment_response("VIP 支付响应缺少金额"))?;
    let amount_cents = vip.get("amount_cents").cloned().unwrap_or(Value::from(0));
    let diamonds = vip.get("bonus_diamonds").cloned().unwrap_or(Value::from(0));
    Ok(json!({
        "id": 1,
        "service_id": "pi-vip",
        "goods_name": optional_string_field(payment, "goods_name").unwrap_or_else(|| "pi-vip".to_string()),
        "amount": amount,
        "amount_cents": amount_cents,
        "diamonds": diamonds,
        "currency": optional_string_field(payment, "currency").unwrap_or_else(|| "CNY".to_string()),
        "enabled": true,
    }))
}

fn desktop_purchase_result(
    payment: Value,
    package: Value,
    flow_kind: DesktopPaymentFlowKind,
    pending_existing: bool,
    vip: Option<Value>,
) -> Value {
    json!({
        "out_trade_no": payment.get("out_trade_no").cloned().unwrap_or(Value::Null),
        "package": package,
        "is_vip": flow_kind == DesktopPaymentFlowKind::Vip,
        "pending_existing": pending_existing,
        "payment": payment,
        "vip": vip,
    })
}

fn ensure_worker_succeeded(result: &Value, fallback: &str) -> Result<(), SkillMarketError> {
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        let message =
            optional_string_field(result, "message").unwrap_or_else(|| fallback.to_string());
        return Err(SkillMarketError::new(
            502,
            "local_pi_payment_failed",
            message,
        ));
    }
    Ok(())
}

fn payment_worker_error(message: String) -> SkillMarketError {
    SkillMarketError::new(502, "local_pi_payment_failed", message)
}

fn required_object_field(
    value: &Value,
    field: &str,
    message: &str,
) -> Result<Value, SkillMarketError> {
    value
        .get(field)
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| invalid_desktop_payment_response(message))
}

fn required_string_field(
    value: &Value,
    field: &str,
    message: &str,
) -> Result<String, SkillMarketError> {
    optional_string_field(value, field).ok_or_else(|| invalid_desktop_payment_response(message))
}

fn optional_string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn invalid_desktop_payment_response(message: impl Into<String>) -> SkillMarketError {
    SkillMarketError::new(502, "invalid_desktop_payment_response", message)
}

fn required_payment_account_key(value: Option<&str>) -> Result<&str, SkillMarketError> {
    value.filter(|value| !value.trim().is_empty()).ok_or_else(|| {
        SkillMarketError::new(
            409,
            "desktop_payment_identity_missing",
            "本机支付身份尚未同步，请重新登录 Copis Working 后重试",
        )
    })
}

fn is_terminal_payment_status(payment: &Value) -> bool {
    matches!(
        optional_string_field(payment, "status").as_deref(),
        Some("resource_ready") | Some("cancelled") | Some("expired") | Some("failed")
    )
}

#[cfg(test)]
fn legacy_handle_request(
    state: &SkillMarketState,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<SkillMarketResponse, SkillMarketError> {
    let route = parse_working_payment_route(method, target).map_err(|message| {
        SkillMarketError::new(400, "invalid_working_payment_request", message)
    })?;
    let token = state
        .access_token()
        .ok_or_else(|| SkillMarketError::new(401, "unauthorized", "请先登录 Copis Working"))?;
    let response = match route {
        WorkingPaymentRoute::CreateDiamondPurchase => {
            let package_id = parse_package_id(body)?;
            remote_json(
                "POST",
                "/api/pay/alipay/diamond-purchases",
                &token,
                Some(&json!({ "package_id": package_id }).to_string()),
            )?
        }
        WorkingPaymentRoute::CheckPayment { payment_id } => remote_json_raw(
            "POST",
            &format!(
                "/api/pay/alipay/diamond-purchases/{}/check",
                encode_identifier(&payment_id)
            ),
            &token,
            Some("{}"),
        )?,
        _ => {
            return Err(SkillMarketError::new(
                400,
                "legacy_working_payment_route_unsupported",
                "旧支付测试路由不支持",
            ))
        }
    };
    Ok(SkillMarketResponse {
        status: 200,
        body: Some(response),
    })
}

fn decode_identifier(value: &str) -> Result<String, String> {
    let decoded = percent_decode(value)?;
    if decoded.trim().is_empty() {
        return Err("支付或订单标识不能为空".to_string());
    }
    Ok(decoded)
}

fn encode_identifier(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![char::from(*byte)]
            } else {
                format!("%{:02X}", byte).chars().collect()
            }
        })
        .collect()
}

fn parse_package_id(body: &[u8]) -> Result<u64, SkillMarketError> {
    let value = serde_json::from_slice::<Value>(body)
        .map_err(|_| SkillMarketError::new(400, "invalid_package_id", "套餐 ID 不正确"))?;
    let package_id = value
        .get("packageId")
        .or_else(|| value.get("package_id"))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| SkillMarketError::new(400, "invalid_package_id", "套餐 ID 不正确"))?;
    Ok(package_id)
}

#[cfg(test)]
#[path = "working_payment_tests.rs"]
mod tests;
