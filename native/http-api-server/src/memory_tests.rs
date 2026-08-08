    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let suffix = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "copis-memory-test-{}-{}",
                std::process::id(),
                suffix
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn workspace_capture(slug: &str, content: &str) -> MemoryCaptureInput {
        MemoryCaptureInput {
            workspace_slug: Some(slug.to_string()),
            scope: MemoryScope::Workspace,
            kind: MemoryKind::Project,
            title: "项目事实".to_string(),
            content: content.to_string(),
            tags: vec!["测试".to_string()],
            source: MemorySource::Agent,
        }
    }

    fn user_capture(content: &str) -> MemoryCaptureInput {
        MemoryCaptureInput {
            workspace_slug: None,
            scope: MemoryScope::User,
            kind: MemoryKind::Preference,
            title: "用户偏好".to_string(),
            content: content.to_string(),
            tags: Vec::new(),
            source: MemorySource::User,
        }
    }

    #[test]
    fn maintenance_action_accepts_camel_case_wire_fields() {
        let input: MemoryMaintenanceApplyInput = serde_json::from_str(
            r#"{
              "workspaceSlug":"project-a",
              "expectedCaptureCount":1,
              "actions":[{
                "operation":"promote",
                "id":"memory-1",
                "expectedRevision":1,
                "kind":"project"
              }]
            }"#,
        )
        .unwrap();

        assert!(matches!(
            input.actions.first(),
            Some(MemoryMaintenanceAction::Promote {
                expected_revision: 1,
                ..
            })
        ));
    }

    #[test]
    fn empty_notebook_capture_persists_entries_with_revision_one() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let result = store
            .capture(workspace_capture("project-a", "Rust API"))
            .unwrap();

        assert_eq!(result.entry.revision, 1);
        assert!(directory.0.join("memory.db").exists());
        assert!(!directory.0.join("entries.json").exists());
        store.integrity_check().unwrap();
        let reopened = MemoryStore::open(&directory.0).unwrap();
        assert_eq!(
            reopened.get(&result.entry.id, Some("project-a")).unwrap(),
            result.entry
        );
    }

    #[test]
    fn 同_scope_规范化内容只保留一个_active_entry() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let first = store
            .capture(workspace_capture("project-a", "稳定   事实"))
            .unwrap();
        let second = store
            .capture(workspace_capture("project-a", "稳定 事实"))
            .unwrap();

        assert_eq!(first.entry.id, second.entry.id);
        assert!(second.deduplicated);
        assert_eq!(
            store
                .list(Some("project-a"), None, None, None, false, 20)
                .unwrap()
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn 不同_workspace_严格隔离但都可看到_user_memory() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let user = store.capture(user_capture("用户习惯")).unwrap();
        let a = store
            .capture(workspace_capture("project-a", "A 的经验"))
            .unwrap();
        let b = store
            .capture(workspace_capture("project-b", "B 的经验"))
            .unwrap();

        let a_entries = store
            .list(Some("project-a"), None, None, None, false, 20)
            .unwrap()
            .entries;
        let b_entries = store
            .list(Some("project-b"), None, None, None, false, 20)
            .unwrap()
            .entries;
        assert!(a_entries.iter().any(|entry| entry.id == user.entry.id));
        assert!(a_entries.iter().any(|entry| entry.id == a.entry.id));
        assert!(!a_entries.iter().any(|entry| entry.id == b.entry.id));
        assert!(b_entries.iter().any(|entry| entry.id == user.entry.id));
        assert!(!b_entries.iter().any(|entry| entry.id == a.entry.id));
    }

    #[test]
    fn 搜索和_limit_由服务端拒绝非法值并限制最大返回数() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        for index in 0..3 {
            let mut input = user_capture(&format!("可检索内容 {}", index));
            input.title = format!("条目 {}", index);
            store.capture(input).unwrap();
        }

        assert_eq!(
            store
                .list(None, Some("可检索"), None, None, false, 2)
                .unwrap()
                .entries
                .len(),
            2
        );
        assert!(matches!(
            store.list(None, Some(""), None, None, false, 2),
            Err(MemoryError::Validation(_))
        ));
        assert!(matches!(
            store.list(None, Some("可检索"), None, None, false, 51),
            Err(MemoryError::Validation(_))
        ));
        assert!(matches!(
            store.recall(None, "", 8),
            Err(MemoryError::Validation(_))
        ));
        assert!(matches!(
            store.recall(None, "可检索", 9),
            Err(MemoryError::Validation(_))
        ));
    }

    #[test]
    fn expected_revision_冲突时原记录保持不变() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("原始内容")).unwrap();
        let result = store.rewrite(
            &captured.entry.id,
            MemoryRewriteInput {
                workspace_slug: None,
                title: Some("新标题".to_string()),
                content: None,
                kind: None,
                tags: None,
                expected_revision: 0,
            },
        );
        assert!(matches!(result, Err(MemoryError::Conflict(_))));
        assert_eq!(store.get(&captured.entry.id, None).unwrap(), captured.entry);
    }

    #[test]
    fn archived_entries_are_hidden_unless_requested() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("需要归档")).unwrap();
        store.archive(&captured.entry.id, None).unwrap();
        assert!(store
            .list(None, None, None, None, false, 20)
            .unwrap()
            .entries
            .is_empty());
        assert_eq!(
            store
                .list(None, None, None, None, true, 20)
                .unwrap()
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn stats_统计全部条目不受列表返回上限影响() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let mut archived_id = String::new();
        for index in 0..60 {
            let result = store
                .capture(workspace_capture("project-a", &format!("事实 {}", index)))
                .unwrap();
            if index == 0 {
                archived_id = result.entry.id.clone();
            }
        }
        store.capture(user_capture("用户习惯")).unwrap();
        store.archive(&archived_id, Some("project-a")).unwrap();
        let stats = store.stats(Some("project-a")).unwrap();
        assert_eq!(stats.workspace_count, 59);
        assert_eq!(stats.archived_count, 1);
        assert_eq!(stats.user_count, 1);

        let user_only = store.stats(None).unwrap();
        assert_eq!(user_only.user_count, 1);
        assert_eq!(user_only.workspace_count, 0);
        assert_eq!(user_only.archived_count, 0);
    }

    #[test]
    fn restore_旧_revision_会创建新_revision并保留历史() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("第一版")).unwrap();
        let updated = store
            .rewrite(
                &captured.entry.id,
                MemoryRewriteInput {
                    workspace_slug: None,
                    title: None,
                    content: Some("第二版".to_string()),
                    kind: None,
                    tags: None,
                    expected_revision: 1,
                },
            )
            .unwrap();
        let restored = store
            .restore(
                &updated.id,
                MemoryRestoreInput {
                    workspace_slug: None,
                    revision: 1,
                },
            )
            .unwrap();
        assert_eq!(restored.content, "第一版");
        assert_eq!(restored.revision, 3);
        assert_eq!(store.history(&restored.id, None).unwrap().len(), 3);
    }

    #[test]
    fn 自动_capture_batch进入scratch并产生maintenance计数() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let response = store
            .capture_batch(MemoryCaptureBatchInput {
                workspace_slug: "project-a".to_string(),
                items: vec![MemoryCaptureBatchItem {
                    kind: MemoryKind::Scratch,
                    title: "短期事实".to_string(),
                    content: "当前正在处理迁移".to_string(),
                    tags: Vec::new(),
                }],
            })
            .unwrap();
        assert_eq!(response.added, 1);
        assert_eq!(
            store.maintenance_state("project-a").unwrap().capture_count,
            1
        );
        assert!(store
            .context(MemoryContextInput {
                workspace_slug: Some("project-a".to_string()),
                query: None,
                max_chars: Some(1000)
            })
            .unwrap()
            .text
            .contains("当前正在处理"));
    }

    #[test]
    fn maintenance_revision冲突时整个事务回滚且marker不前进() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let batch = store
            .capture_batch(MemoryCaptureBatchInput {
                workspace_slug: "project-a".to_string(),
                items: vec![
                    MemoryCaptureBatchItem {
                        kind: MemoryKind::Scratch,
                        title: "第一条".to_string(),
                        content: "第一条临时事实".to_string(),
                        tags: Vec::new(),
                    },
                    MemoryCaptureBatchItem {
                        kind: MemoryKind::Scratch,
                        title: "第二条".to_string(),
                        content: "第二条临时事实".to_string(),
                        tags: Vec::new(),
                    },
                ],
            })
            .unwrap();
        let first = &batch.entries[0];
        let second = &batch.entries[1];
        let result = store.apply_maintenance(MemoryMaintenanceApplyInput {
            workspace_slug: "project-a".to_string(),
            expected_capture_count: 2,
            actions: vec![
                MemoryMaintenanceAction::Promote {
                    id: first.id.clone(),
                    expected_revision: first.revision,
                    kind: MemoryKind::Project,
                },
                MemoryMaintenanceAction::Archive {
                    id: second.id.clone(),
                    expected_revision: 0,
                },
            ],
        });

        assert!(matches!(result, Err(MemoryError::Conflict(_))));
        assert_eq!(
            store.get(&first.id, Some("project-a")).unwrap().kind,
            MemoryKind::Scratch
        );
        assert_eq!(store.get(&first.id, Some("project-a")).unwrap().revision, 1);
        assert!(!store.get(&second.id, Some("project-a")).unwrap().archived);
        let state = store.maintenance_state("project-a").unwrap();
        assert_eq!(state.last_consolidated_capture_count, 0);
    }

    #[test]
    fn maintenance会归档超过14天的scratch并保留revision历史() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store
            .capture_batch(MemoryCaptureBatchInput {
                workspace_slug: "project-a".to_string(),
                items: vec![MemoryCaptureBatchItem {
                    kind: MemoryKind::Scratch,
                    title: "过期状态".to_string(),
                    content: "应当被清理".to_string(),
                    tags: Vec::new(),
                }],
            })
            .unwrap();
        let old_captured_at = now_millis().saturating_sub(SCRATCH_RETENTION_MS + 1);
        {
            let connection = store.connection.lock().unwrap();
            connection
                .execute(
                    "UPDATE memory_entries SET captured_at = ?, expires_at = ? WHERE id = ?",
                    params![
                        old_captured_at as i64,
                        old_captured_at as i64,
                        captured.entries[0].id
                    ],
                )
                .unwrap();
        }

        let response = store
            .apply_maintenance(MemoryMaintenanceApplyInput {
                workspace_slug: "project-a".to_string(),
                expected_capture_count: 1,
                actions: Vec::new(),
            })
            .unwrap();
        assert!(response.entries.iter().any(|entry| entry.archived));
        let archived = store
            .get(&captured.entries[0].id, Some("project-a"))
            .unwrap();
        assert!(archived.archived);
        assert_eq!(archived.revision, 2);
        assert_eq!(
            store
                .history(&archived.id, Some("project-a"))
                .unwrap()
                .len(),
            2
        );
        assert!(store
            .maintenance_state("project-a")
            .unwrap()
            .last_cleanup_at
            .is_some());
    }

    #[test]
    fn 首次启动导入旧json但成功后不再双写() {
        let directory = TestDirectory::new();
        let entry = MemoryEntry {
            id: "legacy-1".to_string(),
            scope: MemoryScope::User,
            workspace_slug: None,
            kind: MemoryKind::Fact,
            title: "旧事实".to_string(),
            content: "旧文件内容".to_string(),
            tags: vec!["legacy".to_string()],
            source: MemorySource::Import,
            created_at: 10,
            updated_at: 10,
            captured_at: 0,
            revision: 1,
            archived: false,
            expires_at: None,
        };
        let revision = MemoryRevision {
            memory_id: entry.id.clone(),
            revision: 1,
            operation: MemoryOperation::Capture,
            snapshot: entry.clone(),
            created_at: 10,
            author: None,
        };
        fs::write(
            directory.0.join("entries.json"),
            serde_json::to_string(&vec![entry.clone()]).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.0.join("revisions.jsonl"),
            format!("{}\n", serde_json::to_string(&revision).unwrap()),
        )
        .unwrap();
        let before = fs::read_to_string(directory.0.join("entries.json")).unwrap();
        let store = MemoryStore::open(&directory.0).unwrap();
        assert_eq!(store.get("legacy-1", None).unwrap().content, "旧文件内容");
        drop(store);
        let reopened = MemoryStore::open(&directory.0).unwrap();
        assert_eq!(reopened.history("legacy-1", None).unwrap().len(), 1);
        assert_eq!(
            fs::read_to_string(directory.0.join("entries.json")).unwrap(),
            before
        );
    }

    #[test]
    fn export_current_workspace_includes_user_and_selected_project_only() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let user = store.capture(user_capture("用户内容")).unwrap();
        let project_a = store
            .capture(workspace_capture("project-a", "A 内容"))
            .unwrap();
        let project_b = store
            .capture(workspace_capture("project-b", "B 内容"))
            .unwrap();
        let result = store
            .export(MemoryExportInput {
                scope: MemoryExportScope::CurrentWorkspace,
                workspace_slug: Some("project-a".to_string()),
                workspace_names: None,
                format: MemoryExportFormat::Json,
                include_archived: false,
                include_history: true,
            })
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&result.content).unwrap();
        let ids: Vec<&str> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&user.entry.id.as_str()));
        assert!(ids.contains(&project_a.entry.id.as_str()));
        assert!(!ids.contains(&project_b.entry.id.as_str()));
        assert_eq!(result.revision_count, 2);
        assert_eq!(result.file_name, "copis-memory-project-a.json");
    }

    #[test]
    fn export_all_workspaces_markdown_groups_projects_and_archived_entries() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        store.capture(user_capture("用户内容")).unwrap();
        store
            .capture(workspace_capture("project-a", "A 内容"))
            .unwrap();
        let archived = store
            .capture(workspace_capture("project-b", "B 内容"))
            .unwrap();
        store
            .archive(&archived.entry.id, Some("project-b"))
            .unwrap();
        let result = store
            .export(MemoryExportInput {
                scope: MemoryExportScope::AllWorkspaces,
                workspace_slug: None,
                workspace_names: None,
                format: MemoryExportFormat::Markdown,
                include_archived: true,
                include_history: false,
            })
            .unwrap();
        assert!(result.content.contains("## 用户记忆"));
        assert!(result.content.contains("## 项目：project-a"));
        assert!(result.content.contains("## 项目：project-b"));
        assert!(result.content.contains("## 已归档"));
    }

    #[test]
    fn export_markdown_prefers_project_display_name_over_slug() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        store
            .capture(workspace_capture("project-a", "A 内容"))
            .unwrap();
        let mut workspace_names = BTreeMap::new();
        workspace_names.insert("project-a".to_string(), "Copis 文档项目".to_string());

        let result = store
            .export(MemoryExportInput {
                scope: MemoryExportScope::CurrentWorkspace,
                workspace_slug: Some("project-a".to_string()),
                workspace_names: Some(workspace_names),
                format: MemoryExportFormat::Markdown,
                include_archived: false,
                include_history: false,
            })
            .unwrap();

        assert!(result.content.contains("## 项目：Copis 文档项目"));
        assert!(!result.content.contains("## 项目：project-a"));
        assert!(result.content.contains("项目标识：project-a"));
    }
