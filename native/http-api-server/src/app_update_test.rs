use crate::app_update::parse_app_update;
use serde_json::json;

fn manifest(version: &str, url: &str) -> Vec<u8> {
    json!({
        "schema": 1,
        "channel": "stable",
        "client": {
            "minVersion": "0.0.60",
            "update": {
                "version": version,
                "url": url,
                "sha256": "a".repeat(64),
                "size": 128,
                "releaseNotes": "fix: update"
            }
        },
        "platforms": {}
    })
    .to_string()
    .into_bytes()
}

#[test]
fn given_newer_manifest_when_parse_then_returns_update() {
    let result = parse_app_update(
        &manifest("0.0.63", "https://download.example.com/copis-0.0.63.dmg"),
        "0.0.62",
    )
    .expect("manifest should parse");
    assert_eq!(result["available"], true);
    assert_eq!(result["version"], "0.0.63");
    assert_eq!(result["url"], "https://download.example.com/copis-0.0.63.dmg");
    assert_eq!(result["sha256"], "a".repeat(64));
    assert_eq!(result["size"], 128);
    assert_eq!(result["releaseNotes"], "fix: update");
}

#[test]
fn given_same_or_older_manifest_when_parse_then_returns_not_available() {
    for version in ["0.0.62", "0.0.61"] {
        let result = parse_app_update(
            &manifest(version, "https://download.example.com/copis.dmg"),
            "0.0.62",
        )
        .expect("manifest should parse");
        assert_eq!(result["available"], false);
    }
}

#[test]
fn given_missing_update_when_parse_then_returns_not_available() {
    let body = json!({ "schema": 1, "channel": "stable", "client": { "minVersion": "0.0.62" } })
        .to_string()
        .into_bytes();
    let result = parse_app_update(&body, "0.0.62").expect("manifest should parse");
    assert_eq!(result["available"], false);
}

#[test]
fn given_http_download_when_parse_then_rejects() {
    let result = parse_app_update(
        &manifest("0.0.63", "http://download.example.com/copis.dmg"),
        "0.0.62",
    );
    assert!(result.is_err());
}
