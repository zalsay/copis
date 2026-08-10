use crate::skill_market::{
    percent_decode, remote_json, remote_json_raw, SkillMarketError, SkillMarketResponse,
    SkillMarketState,
};
use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
pub enum WorkingPaymentRoute {
    ListDiamondPackages,
    PendingDiamondPurchase,
    CreateDiamondPurchase,
    CreateVipUpgrade,
    GetOrderPayment { order_id: String },
    CheckPayment { payment_id: String },
    CancelDiamondPayment { payment_id: String },
    CreateAlipayPagePayOrder,
    CheckAlipayPagePayOrder { payment_id: String },
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
        ("POST", ["api", "working", "alipay", "page-orders"]) => {
            Ok(WorkingPaymentRoute::CreateAlipayPagePayOrder)
        }
        ("POST", ["api", "working", "alipay", "page-orders", payment_id, "check"]) => {
            Ok(WorkingPaymentRoute::CheckAlipayPagePayOrder {
                payment_id: decode_identifier(payment_id)?,
            })
        }
        _ => Err("Working 支付路由不存在或请求方法不支持".to_string()),
    }
}

pub fn handle_request(
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
            remote_json(
                "POST",
                "/api/pay/alipay/diamond-purchases",
                &token,
                Some(&json!({ "package_id": package_id }).to_string()),
            )?
        }
        WorkingPaymentRoute::CreateVipUpgrade => {
            remote_json("POST", "/api/users/vip/upgrade", &token, Some("{}"))?
        }
        WorkingPaymentRoute::GetOrderPayment { order_id } => remote_json(
            "GET",
            &format!("/api/users/orders/{}/payment", encode_identifier(&order_id)),
            &token,
            None,
        )?,
        WorkingPaymentRoute::CheckPayment { payment_id } => remote_json_raw(
            "POST",
            &format!(
                "/api/pay/alipay/diamond-purchases/{}/check",
                encode_identifier(&payment_id)
            ),
            &token,
            Some("{}"),
        )?,
        WorkingPaymentRoute::CancelDiamondPayment { payment_id } => remote_json(
            "POST",
            &format!(
                "/api/pay/alipay/diamond-purchases/{}/cancel",
                encode_identifier(&payment_id)
            ),
            &token,
            Some("{}"),
        )?,
        WorkingPaymentRoute::CreateAlipayPagePayOrder => {
            let package_id = parse_package_id(body)?;
            remote_json(
                "POST",
                "/api/pay/alipay/page-orders",
                &token,
                Some(&json!({ "package_id": package_id }).to_string()),
            )?
        }
        WorkingPaymentRoute::CheckAlipayPagePayOrder { payment_id } => remote_json(
            "POST",
            &format!(
                "/api/pay/alipay/page-orders/{}/check",
                encode_identifier(&payment_id)
            ),
            &token,
            Some("{}"),
        )?,
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
