use super::automation::{
    AutomationCreateInput, AutomationRunInput, AutomationStore, AutomationUpdateInput,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_config_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "copis-automation-test-{}-{}-{}",
        label,
        std::process::id(),
        nonce
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn create_input() -> AutomationCreateInput {
    serde_json::from_value(json!({
        "name": "每日汇总",
        "prompt": "整理今日进展",
        "scheduleType": "daily",
        "timeOfDay": "09:30",
        "channelId": "channel-1",
        "workspaceId": "workspace-1",
        "active": true
    }))
    .unwrap()
}

#[test]
fn given_create_input_when_persisted_then_keeps_legacy_automations_json_contract() {
    let config_dir = temporary_config_dir("create");
    let store = AutomationStore::open(config_dir.clone());

    let created = store.create(create_input()).unwrap();
    let listed = store.list().unwrap();

    assert_eq!(listed, vec![created.clone()]);
    let raw: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(config_dir.join("automations.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["version"], 2);
    assert_eq!(raw["automations"][0]["id"], created["id"]);
    assert_eq!(raw["automations"][0]["agentRuntime"], "pi");
    assert_eq!(raw["automations"][0]["intervalMinutes"], 10);
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_completed_once_run_when_appended_then_disables_the_automation() {
    let config_dir = temporary_config_dir("run");
    let store = AutomationStore::open(config_dir.clone());
    let input: AutomationCreateInput = serde_json::from_value(json!({
        "name": "一次性检查",
        "prompt": "执行检查",
        "scheduleType": "once",
        "intervalMinutes": 10,
        "scheduledAt": 1900000000000u64,
        "channelId": "channel-1",
        "workspaceId": "workspace-1"
    }))
    .unwrap();
    let created = store.create(input).unwrap();
    let id = created["id"].as_str().unwrap();

    let updated = store
        .append_run(
            id,
            AutomationRunInput {
                run_at: 1900000001000,
                session_id: "session-1".to_string(),
                status: "success".to_string(),
                duration_ms: Some(50),
                error: None,
                skip_reason: None,
            },
        )
        .unwrap();

    assert_eq!(updated["active"], false);
    assert_eq!(updated["runCount"], 1);
    assert_eq!(updated["runHistory"][0]["status"], "success");
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_automation_run_context_when_creating_then_rejects_recursive_automation() {
    let config_dir = temporary_config_dir("recursion");
    let store = AutomationStore::open(config_dir.clone());

    let error = store.create_for_session(create_input(), "automation").unwrap_err();

    assert!(error.to_string().contains("禁止递归创建"));
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_existing_automation_when_updated_then_resets_changed_max_runs_quota() {
    let config_dir = temporary_config_dir("update");
    let store = AutomationStore::open(config_dir.clone());
    let created = store.create(create_input()).unwrap();
    let id = created["id"].as_str().unwrap();
    store
        .append_run(
            id,
            AutomationRunInput {
                run_at: 1900000001000,
                session_id: "session-1".to_string(),
                status: "success".to_string(),
                duration_ms: None,
                error: None,
                skip_reason: None,
            },
        )
        .unwrap();

    let updated = store
        .update(
            id,
            AutomationUpdateInput {
                max_runs: Some(3),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(updated["maxRuns"], 3);
    assert_eq!(updated["runCount"], 0);
    assert!(updated.get("completedAt").is_none());
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn given_zero_max_runs_when_creating_then_treats_it_as_unlimited() {
    let config_dir = temporary_config_dir("unlimited");
    let store = AutomationStore::open(config_dir.clone());
    let mut input = create_input();
    input.max_runs = Some(0);

    let created = store.create(input).unwrap();

    assert!(created.get("maxRuns").is_none());
    let _ = fs::remove_dir_all(config_dir);
}
