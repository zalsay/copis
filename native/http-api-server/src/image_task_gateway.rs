use super::*;

pub(super) fn handle(
    gateway: &WorkingGateway,
    method: &str,
    segments: &[String],
    query: &str,
    body: Option<&str>,
) -> Result<GatewayResponse, GatewayError> {
    require_method(
        method,
        if segments.len() == 4 && method != "GET" {
            "POST"
        } else {
            "GET"
        },
    )?;
    let store = gateway
        .image_store
        .as_ref()
        .map_err(|_| GatewayError::new(503, "image_storage_error", "图片任务数据库不可用"))?;
    let (user_id, mut token, expires_at) = gateway
        .auth
        .image_task_identity()
        .map_err(GatewayError::from)?;
    if expires_at.is_some_and(|v| v <= image_task_store::now()) {
        gateway
            .auth
            .refresh_single_flight()
            .map_err(GatewayError::from)?;
        let (refreshed_user, refreshed_token, _) = gateway
            .auth
            .image_task_identity()
            .map_err(GatewayError::from)?;
        if refreshed_user != user_id {
            return Err(GatewayError::new(
                401,
                "account_changed",
                "账号已切换，请重新查询图片任务",
            ));
        }
        token = refreshed_token;
    }
    if segments.len() == 4 && method == "GET" {
        let session = query_value(query, "session_id");
        let tasks = store
            .list(user_id, session.as_deref())
            .map_err(|_| GatewayError::new(503, "image_storage_error", "读取图片任务记录失败"))?;
        return Ok(json_response(
            200,
            serde_json::json!({"data":{"tasks":tasks}}),
        ));
    }
    if segments.len() == 5 && query_value(query, "refresh").as_deref() != Some("1") {
        if let Some(data) = store
            .cached(user_id, &segments[4], image_task_store::now())
            .map_err(|_| GatewayError::new(503, "image_storage_error", "读取图片任务记录失败"))?
        {
            return Ok(json_response(200, serde_json::json!({"data":data})));
        }
    }
    let client = gateway.model_client.as_ref().ok_or_else(|| {
        GatewayError::new(500, "configuration_error", "model-request 服务配置不正确")
    })?;
    let (remote_method, remote_path, remote_body, headers) = if segments.len() == 4 {
        let input = parse_body(body)?;
        let prompt = input
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GatewayError::new(400, "invalid_request", "prompt 参数缺失"))?;
        let request_id = input
            .get("request_id")
            .or_else(|| input.get("requestId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GatewayError::new(400, "invalid_request", "request_id 参数缺失"))?;
        let mut payload = serde_json::Map::new();
        payload.insert("prompt".to_string(), Value::String(prompt.to_string()));
        if let Some(size) = input
            .get("size")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            payload.insert("size".to_string(), Value::String(size.to_string()));
        }
        if let Some(session_id) = input
            .get("sessionId")
            .or_else(|| input.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            payload.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        payload.insert(
            "request_id".to_string(),
            Value::String(request_id.to_string()),
        );
        (
            "POST",
            "/v1/images/tasks".to_string(),
            serde_json::to_string(&Value::Object(payload)).unwrap(),
            vec![
                ("Idempotency-Key".to_string(), request_id.to_string()),
                (
                    "X-Working-Model-Source-Type".to_string(),
                    "copis-agent-model".to_string(),
                ),
            ],
        )
    } else if segments.len() == 5 {
        let task_id = encode_path_segment(&segments[4]);
        (
            "GET",
            format!("/v1/images/tasks/{task_id}"),
            String::new(),
            vec![(
                "X-Working-Model-Source-Type".to_string(),
                "copis-agent-model".to_string(),
            )],
        )
    } else {
        return Err(GatewayError::new(404, "not_found", "图片任务路径不存在"));
    };
    let open_request = |access_token: &str| {
        client.open(
            remote_method,
            &remote_path,
            &remote_body,
            access_token,
            headers.clone(),
        )
    };
    let mut response = open_request(&token).map_err(|error| GatewayError {
        status: 502,
        code: "upstream_error".to_string(),
        message: error.to_string(),
    })?;
    if response.status == 401 {
        gateway
            .auth
            .refresh_single_flight()
            .map_err(GatewayError::from)?;
        let (refreshed_user, refreshed, _) = gateway
            .auth
            .image_task_identity()
            .map_err(GatewayError::from)?;
        if refreshed_user != user_id {
            return Err(GatewayError::new(
                401,
                "account_changed",
                "账号已切换，请重新查询图片任务",
            ));
        }
        response = open_request(&refreshed).map_err(|error| GatewayError {
            status: 502,
            code: "upstream_error".to_string(),
            message: error.to_string(),
        })?;
        if response.status == 401 {
            return Err(GatewayError::new(
                401,
                "unauthorized",
                "认证已失效，请重新登录",
            ));
        }
    }
    let mut reader = response.body;
    let mut raw = Vec::new();
    reader
        .read_to_end(&mut raw)
        .map_err(|_| GatewayError::new(502, "upstream_error", "读取 model-request 响应失败"))?;
    let parsed: Value = serde_json::from_slice(&raw)
        .map_err(|_| GatewayError::new(502, "upstream_error", "model-request 响应不是有效 JSON"))?;
    let safe = sanitize_image_task_response(parsed);
    if !(200..300).contains(&response.status) {
        let error = safe
            .get("data")
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("图片任务请求失败");
        return Err(GatewayError::new(
            response.status,
            "image_task_error",
            error,
        ));
    }
    if segments.len() == 5 && safe["data"]["task_id"].as_str() != Some(segments[4].as_str()) {
        return Err(GatewayError::new(
            502,
            "image_task_error",
            "图片任务响应 ID 不匹配",
        ));
    }
    let metadata: Value = serde_json::from_str(&remote_body).unwrap_or(Value::Null);
    store
        .save(
            user_id,
            &safe["data"],
            metadata["request_id"].as_str().unwrap_or(""),
            metadata["sessionId"].as_str().unwrap_or(""),
        )
        .map_err(|_| {
            GatewayError::new(
                503,
                "image_storage_error",
                &format!(
                    "图片任务本地保存失败，task_id={}",
                    safe["data"]["task_id"].as_str().unwrap_or("")
                ),
            )
        })?;
    return Ok(json_response(response.status, safe));
}
