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

fn platform_manifest() -> Vec<u8> {
    json!({
        "schema": 1,
        "channel": "stable",
        "client": {
            "update": {
                "version": "0.0.65",
                "url": "https://download.example.com/Copis-Setup.exe",
                "sha256": "c".repeat(64),
                "size": 64
            },
            "updates": {
                "darwin-arm64": {
                    "version": "0.0.63",
                    "url": "https://download.example.com/Copis-arm64.dmg",
                    "sha256": "a".repeat(64),
                    "size": 128
                },
                "darwin-x64": {
                    "version": "0.0.74",
                    "url": "https://download.example.com/Copis-x64.dmg",
                    "sha256": "d".repeat(64),
                    "size": 251228743
                },
                "win32-x64": {
                    "version": "0.0.64",
                    "url": "https://download.example.com/Copis-Setup.exe",
                    "sha256": "b".repeat(64),
                    "size": 256
                }
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
        Some("darwin-arm64"),
    )
    .expect("manifest should parse");
    assert_eq!(result["available"], true);
    assert_eq!(result["version"], "0.0.63");
    assert_eq!(result["latestVersion"], "0.0.63");
    assert_eq!(
        result["url"],
        "https://download.example.com/copis-0.0.63.dmg"
    );
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
            Some("darwin-arm64"),
        )
        .expect("manifest should parse");
        assert_eq!(result["available"], false);
        assert_eq!(result["version"], version);
        assert_eq!(result["latestVersion"], version);
    }
}

#[test]
fn given_cross_version_manifest_when_parse_then_reports_global_latest_version() {
    let result = parse_app_update(&platform_manifest(), "0.0.60", Some("win32-x64"))
        .expect("manifest should parse");
    assert_eq!(result["available"], true);
    assert_eq!(result["version"], "0.0.64");
    assert_eq!(result["latestVersion"], "0.0.74");
}

#[test]
fn given_missing_update_when_parse_then_returns_not_available() {
    let body = json!({ "schema": 1, "channel": "stable", "client": { "minVersion": "0.0.62" } })
        .to_string()
        .into_bytes();
    let result =
        parse_app_update(&body, "0.0.62", Some("darwin-arm64")).expect("manifest should parse");
    assert_eq!(result["available"], false);
}

#[test]
fn given_http_download_when_parse_then_rejects() {
    let result = parse_app_update(
        &manifest("0.0.63", "http://download.example.com/copis.dmg"),
        "0.0.62",
        Some("darwin-arm64"),
    );
    assert!(result.is_err());
}

#[test]
fn given_legacy_windows_update_when_parse_on_macos_then_returns_not_available() {
    let result = parse_app_update(
        &manifest("0.0.63", "https://download.example.com/Copis-Setup.exe"),
        "0.0.62",
        Some("darwin-arm64"),
    )
    .expect("manifest should parse");
    assert_eq!(result["available"], false);
}

#[test]
fn given_platform_manifest_when_parse_then_selects_matching_installer() {
    let mac_result = parse_app_update(&platform_manifest(), "0.0.62", Some("darwin-arm64"))
        .expect("macOS manifest should parse");
    assert_eq!(
        mac_result["url"],
        "https://download.example.com/Copis-arm64.dmg"
    );

    let intel_mac_result = parse_app_update(&platform_manifest(), "0.0.73", Some("darwin-x64"))
        .expect("Intel macOS manifest should parse");
    assert_eq!(intel_mac_result["version"], "0.0.74");
    assert_eq!(
        intel_mac_result["url"],
        "https://download.example.com/Copis-x64.dmg"
    );
    assert_eq!(intel_mac_result["sha256"], "d".repeat(64));
    assert_eq!(intel_mac_result["size"], 251228743);

    let windows_result = parse_app_update(&platform_manifest(), "0.0.62", Some("win32-x64"))
        .expect("Windows manifest should parse");
    assert_eq!(
        windows_result["url"],
        "https://download.example.com/Copis-Setup.exe"
    );
}

#[test]
fn given_platform_manifest_without_current_platform_when_parse_then_returns_not_available() {
    let result = parse_app_update(&platform_manifest(), "0.0.62", Some("linux-x64"))
        .expect("manifest should parse");
    assert_eq!(result["available"], false);
}
