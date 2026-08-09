use super::*;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn test_directory(label: &str) -> PathBuf {
    let unique = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "copis-expert-team-{}-{}-{}",
        label, timestamp, unique
    ))
}

fn store() -> ExpertTeamStore {
    ExpertTeamStore::open(test_directory("test")).unwrap()
}

fn schema(id: Option<&str>, depends_on: Vec<&str>) -> ExpertSchemaInput {
    ExpertSchemaInput {
        id: id.map(str::to_string),
        name: "研究团队".to_string(),
        description: Some("本地团队".to_string()),
        nodes: vec![
            ExpertSchemaNodeInput {
                id: "research".to_string(),
                role: "researcher".to_string(),
                prompt: None,
                depends_on: vec![],
                path: Some("notes/input.md".to_string()),
                config: json!({}),
            },
            ExpertSchemaNodeInput {
                id: "write".to_string(),
                role: "writer".to_string(),
                prompt: None,
                depends_on: depends_on.into_iter().map(str::to_string).collect(),
                path: None,
                config: json!({}),
            },
        ],
        metadata: json!({}),
    }
}

#[test]
fn validation_rejects_cycles_duplicate_ids_and_absolute_paths() {
    let mut input = schema(None, vec!["write"]);
    assert!(matches!(
        validate_schema_input(&input),
        Err(ExpertTeamError::Validation(_))
    ));
    input = schema(None, vec!["missing"]);
    assert!(matches!(
        validate_schema_input(&input),
        Err(ExpertTeamError::Validation(_))
    ));
    input = schema(None, vec![]);
    input.nodes[0].path = Some("/tmp/nope".to_string());
    assert!(matches!(
        validate_schema_input(&input),
        Err(ExpertTeamError::Validation(_))
    ));
    input.nodes[0].path = Some("..\\outside.txt".to_string());
    assert!(matches!(
        validate_schema_input(&input),
        Err(ExpertTeamError::Validation(_))
    ));
}

#[test]
fn publishes_immutable_revisions_and_queues_snapshot_run() {
    let store = store();
    let first = store
        .publish_schema(schema(Some("team"), vec!["research"]))
        .unwrap();
    let first_revision_id = first["schemaRevisionId"].as_i64().unwrap();
    let second = store
        .publish_schema(schema(Some("team"), vec!["research"]))
        .unwrap();
    assert_eq!(second["revision"], 2);
    let run = store
        .create_run(RunCreateInput {
            workspace_slug: "project-a".to_string(),
            schema_id: None,
            schema_revision: None,
            schema_revision_id: Some(first_revision_id),
            input: json!({"topic":"rust"}),
        })
        .unwrap();
    assert_eq!(run["status"], "queued");
    assert_eq!(
        store
            .list_run_events(run["id"].as_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    let canceled = store.cancel_run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(canceled["status"], "cancelled");
}

#[test]
fn schema_revision_id_跨_schema_引用被拒绝() {
    let store = store();
    let first = store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    let second = store
        .publish_schema(schema(Some("team-b"), vec!["research"]))
        .unwrap();
    let first_id = first["schemaRevisionId"].as_i64().unwrap();
    let second_id = second["schemaRevisionId"].as_i64().unwrap();

    // schemaRevisionId 属于 team-b，却声明 schemaId=team-a，必须拒绝
    assert!(matches!(
        store.bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: None,
                schema_revision_id: Some(second_id),
            }
        ),
        Err(ExpertTeamError::NotFound(_))
    ));

    // 匹配的 schemaId + schemaRevisionId 正常绑定
    let binding = store
        .bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-b".to_string()),
                schema_revision: None,
                schema_revision_id: Some(second_id),
            },
        )
        .unwrap();
    assert_eq!(binding["schemaRevisionId"], second_id);

    // 单独传 schemaRevision 不再按 id 隐式回退
    assert!(matches!(
        store.bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: None,
                schema_revision: Some(first_id),
                schema_revision_id: None,
            }
        ),
        Err(ExpertTeamError::Validation(_))
    ));
}

#[test]
fn schema_revision_版本号_按_schema_id_限定() {
    let store = store();
    let first = store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    let first_id = first["schemaRevisionId"].as_i64().unwrap();

    let binding = store
        .bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: Some(2),
                schema_revision_id: None,
            },
        )
        .unwrap();
    assert_eq!(binding["revision"], 2);
    assert_ne!(binding["schemaRevisionId"], first_id);

    // 版本号超出该 schema 的历史范围时报 NotFound，而不是回退到其他 schema
    assert!(matches!(
        store.bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: Some(99),
                schema_revision_id: None,
            }
        ),
        Err(ExpertTeamError::NotFound(_))
    ));
}

#[test]
fn bind_workspace_仅_schema_id_时使用当前_revision() {
    let store = store();
    store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();

    let binding = store
        .bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: None,
                schema_revision_id: None,
            },
        )
        .unwrap();
    assert_eq!(binding["revision"], 2);
    assert_eq!(binding["schemaId"], "team-a");
}

#[test]
fn get_workspace_binding_返回冻结_revision_且未绑定返回_not_found() {
    let store = store();
    store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    let binding = store
        .bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: None,
                schema_revision_id: None,
            },
        )
        .unwrap();
    let sha256 = binding["sha256"].as_str().unwrap().to_string();
    let revision_id = binding["schemaRevisionId"].as_i64().unwrap();

    let response = handle_request(
        &store,
        "GET",
        "/api/expert-teams/workspaces/project-a/binding",
        &[],
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body["schemaId"], "team-a");
    assert_eq!(response.body["schemaRevisionId"], revision_id);
    assert_eq!(response.body["sha256"], sha256);
    assert_eq!(response.body["workspaceSlug"], "project-a");

    let missing = handle_request(
        &store,
        "GET",
        "/api/expert-teams/workspaces/unknown/binding",
        &[],
    );
    assert!(matches!(missing, Err(ExpertTeamError::NotFound(_))));
}

#[test]
fn 工作区绑定和运行在重启后按_schema_恢复() {
    let directory = test_directory("workspace-recovery");
    let store = ExpertTeamStore::open(&directory).unwrap();
    store
        .publish_schema(schema(Some("team-a"), vec!["research"]))
        .unwrap();
    store
        .publish_schema(schema(Some("team-b"), vec!["research"]))
        .unwrap();
    store
        .bind_workspace(
            "project-a",
            WorkspaceBindingInput {
                schema_id: Some("team-a".to_string()),
                schema_revision: None,
                schema_revision_id: None,
            },
        )
        .unwrap();
    let expected_run = store
        .create_run(RunCreateInput {
            workspace_slug: "project-a".to_string(),
            schema_id: Some("team-a".to_string()),
            schema_revision: None,
            schema_revision_id: None,
            input: json!({ "source": "expert-team-workbench-start" }),
        })
        .unwrap();
    store
        .create_run(RunCreateInput {
            workspace_slug: "project-a".to_string(),
            schema_id: Some("team-b".to_string()),
            schema_revision: None,
            schema_revision_id: None,
            input: json!(null),
        })
        .unwrap();
    store
        .create_run(RunCreateInput {
            workspace_slug: "project-b".to_string(),
            schema_id: Some("team-a".to_string()),
            schema_revision: None,
            schema_revision_id: None,
            input: json!(null),
        })
        .unwrap();
    drop(store);

    let reopened = ExpertTeamStore::open(&directory).unwrap();
    let binding = reopened.get_workspace_binding("project-a").unwrap();
    let runs = reopened
        .list_runs(Some("project-a"), Some("team-a"))
        .unwrap();
    assert_eq!(binding["schemaId"], "team-a");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["id"], expected_run["id"]);

    let response = handle_request(
        &reopened,
        "GET",
        "/api/expert-teams/runs?workspaceSlug=project-a&schemaId=team-a",
        &[],
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body["runs"].as_array().unwrap().len(), 1);
    assert_eq!(response.body["runs"][0]["id"], expected_run["id"]);
}

#[test]
fn request_routes_use_camel_case_and_error_shape() {
    let store = store();
    let body = serde_json::to_vec(&schema(None, vec!["research"])).unwrap();
    let response = handle_request(&store, "POST", "/api/expert-teams/schemas", &body).unwrap();
    assert_eq!(response.status, 201);
    let id = response.body["id"].as_str().unwrap();
    let response = handle_request(
        &store,
        "GET",
        &format!("/api/expert-teams/schemas/{}", id),
        &[],
    )
    .unwrap();
    assert!(response.body["currentRevisionId"].is_i64());
    let response = handle_request(
        &store,
        "POST",
        "/api/expert-teams/runs",
        br#"{"workspaceSlug":"ws"}"#,
    );
    assert!(matches!(response, Err(ExpertTeamError::Validation(_))));
}

#[test]
fn database_uses_expected_file_name() {
    let directory = test_directory("path");
    let _store = ExpertTeamStore::open(&directory).unwrap();
    assert!(directory.join(DATABASE_FILE).exists());
}

#[test]
fn empty_database_is_seeded_with_pi_only_builtin_dag() {
    let store = store();
    let schemas = store.list_schemas().unwrap();
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0]["id"], BUILTIN_SCHEMA_ID);
    assert_eq!(schemas[0]["name"], "深入研究团队");
    assert_eq!(schemas[0]["snapshot"]["metadata"]["execution"], "pi-only");
    assert_eq!(
        schemas[0]["snapshot"]["metadata"]["templateVersion"],
        BUILTIN_TEMPLATE_VERSION
    );
    let nodes = schemas[0]["snapshot"]["nodes"].as_array().unwrap();
    assert_eq!(
        nodes
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["researcher", "summary", "reviewer"]
    );
    assert_eq!(nodes[0]["role"], "researcher");
    assert_eq!(nodes[0]["dependsOn"], json!([]));
    assert_eq!(
        nodes[0]["prompt"],
        "搜集与任务相关的可靠资料、来源和关键事实，整理为可读的 Markdown 资料文档。"
    );
    assert_eq!(nodes[0]["path"], "research/materials.md");
    assert_eq!(nodes[1]["role"], "writer");
    assert_eq!(nodes[1]["dependsOn"], json!(["researcher"]));
    assert_eq!(
        nodes[1]["prompt"],
        "阅读 researcher 的资料文档，将资料提炼并总结为结构清晰的 Markdown 文档。"
    );
    assert_eq!(nodes[1]["path"], "summary/summary.md");
    assert_eq!(nodes[2]["role"], "reviewer");
    assert_eq!(nodes[2]["dependsOn"], json!(["summary"]));
    assert_eq!(
        nodes[2]["prompt"],
        "检验前序研究与总结是否准确、完整、可追溯，输出 Markdown 检验报告。"
    );
    assert_eq!(nodes[2]["path"], "review/validation-report.md");
}

#[test]
fn old_builtin_revision_is_upgraded_without_replacing_history() {
    let directory = test_directory("upgrade");
    let store = ExpertTeamStore::open(&directory).unwrap();
    let mut old = builtin_schema_input();
    old.name = "AI 教育研究撰写审核团队".to_string();
    old.metadata = json!({"source":"copis-builtin","execution":"pi-only"});
    old.nodes[0].id = "research".to_string();
    old.nodes[0].path = Some("research/summary.md".to_string());
    old.nodes[1].id = "writer".to_string();
    old.nodes[1].depends_on = vec!["research".to_string()];
    old.nodes[1].path = Some("draft/article.md".to_string());
    old.nodes[2].depends_on = vec!["writer".to_string()];
    old.nodes[2].path = Some("review/report.md".to_string());
    store.publish_schema(old).unwrap();
    drop(store);

    let upgraded = ExpertTeamStore::open(&directory).unwrap();
    let schema = upgraded.get_schema(BUILTIN_SCHEMA_ID).unwrap();
    assert_eq!(schema["revisions"].as_array().unwrap().len(), 3);
    assert_eq!(schema["revisions"][0]["revision"], 3);
    assert_eq!(
        schema["revisions"][1]["snapshot"]["name"],
        "AI 教育研究撰写审核团队"
    );
    assert_eq!(schema["revisions"][0]["snapshot"]["name"], "深入研究团队");
    assert_eq!(
        schema["revisions"][0]["snapshot"]["metadata"]["templateVersion"],
        BUILTIN_TEMPLATE_VERSION
    );
    assert_eq!(
        schema["revisions"][0]["snapshot"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["researcher", "summary", "reviewer"]
    );
}

#[test]
fn custom_schema_with_builtin_id_is_not_overwritten() {
    let directory = test_directory("custom");
    let store = ExpertTeamStore::open(&directory).unwrap();
    let mut custom = schema(Some(BUILTIN_SCHEMA_ID), vec!["research"]);
    custom.name = "用户自定义团队".to_string();
    custom.metadata = json!({"source":"user"});
    store.publish_schema(custom).unwrap();
    drop(store);

    let reopened = ExpertTeamStore::open(&directory).unwrap();
    let schema = reopened.get_schema(BUILTIN_SCHEMA_ID).unwrap();
    assert_eq!(schema["name"], "用户自定义团队");
    assert_eq!(schema["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(
        schema["revisions"][0]["snapshot"]["metadata"]["source"],
        "user"
    );
}

#[test]
fn current_builtin_v2_does_not_create_duplicate_revision() {
    let directory = test_directory("v2");
    let store = ExpertTeamStore::open(&directory).unwrap();
    drop(store);

    let reopened = ExpertTeamStore::open(&directory).unwrap();
    let schema = reopened.get_schema(BUILTIN_SCHEMA_ID).unwrap();
    assert_eq!(schema["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(schema["revisions"][0]["revision"], 1);
    assert_eq!(
        schema["revisions"][0]["snapshot"]["metadata"]["templateVersion"],
        BUILTIN_TEMPLATE_VERSION
    );
}
