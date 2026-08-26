use crate::working_model::merge_alias_latencies;
use serde_json::{json, Value};

#[test]
fn given_latencies_and_configs_when_merge_then_aliases_map_to_model_ids() {
    let mut payload = json!({
        "data": {
            "gpt-5.4-mini": 312.5,
            "gpt-5.4": 920.0,
            "deepseek-chat": 1800.0
        }
    });
    let configs = vec![
        json!({ "alias": "fast", "model_id": "gpt-5.4-mini" }),
        json!({ "alias": "export", "model_id": "gpt-5.4" }),
        json!({ "alias": "global", "model_id": "gpt-5.4-mini" }),
        json!({ "alias": "deepseek-v4-flash", "model_id": "deepseek-chat" }),
        json!({ "alias": "deepseek-v4-pro", "model_id": "deepseek-chat" }),
    ];
    merge_alias_latencies(&mut payload, &configs);
    let data = payload.get("data").expect("data should exist");
    assert_eq!(data["fast"], 312.5);
    assert_eq!(data["export"], 920.0);
    assert_eq!(data["global"], 312.5);
    assert_eq!(data["deepseek-v4-flash"], 1800.0);
    assert_eq!(data["deepseek-v4-pro"], 1800.0);
}

#[test]
fn given_missing_alias_config_when_merge_then_ignores_unknown_aliases() {
    let mut payload = json!({ "data": { "gpt-5.4-mini": 312.5 } });
    let configs = vec![Value::Null];
    merge_alias_latencies(&mut payload, &configs);
    assert_eq!(payload["data"]["fast"], Value::Null);
}
