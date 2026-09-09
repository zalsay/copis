use super::*;
use serde_json::json;

#[test]
fn persists_urls_across_restart_and_isolates_users_and_sessions() {
    let path = std::env::temp_dir().join(format!(
        "copis-image-{}-{}.db",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let data = json!({"task_id":"task-1","status":"completed","image_url":"https://cos.example/image?q-sign-time=1%3B4000000000"});
    {
        let store = ImageTaskStore::open(&path).unwrap();
        store.save(1, &data, "request-1", "session-1").unwrap();
    }
    let store = ImageTaskStore::open(&path).unwrap();
    let cached = store.cached(1, "task-1", 100).unwrap().unwrap();
    assert_eq!(cached["image_url"], data["image_url"]);
    assert!(store.cached(2, "task-1", 100).unwrap().is_none());
    assert!(store.cached(1, "task-1", 4000000000).unwrap().is_none());
    store.save(1, &data, "", "").unwrap();
    assert_eq!(store.list(1, Some("session-1")).unwrap().len(), 1);
    assert!(store.list(1, Some("other")).unwrap().is_empty());
    assert!(store.list(2, None).unwrap().is_empty());
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pending_and_unknown_expiry_always_require_remote_query() {
    let store = ImageTaskStore::open(":memory:").unwrap();
    for status in ["queued", "running", "completed"] {
        store
            .save(
                1,
                &json!({"task_id":"task","status":status,"image_url":"https://example.com/image"}),
                "",
                "",
            )
            .unwrap();
        assert!(store.cached(1, "task", 1).unwrap().is_none());
    }
}
