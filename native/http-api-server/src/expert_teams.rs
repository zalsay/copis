use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DATABASE_FILE: &str = "expert-teams.db";
const BUILTIN_SCHEMA_ID: &str = "ai-education-research-writer-reviewer";
const BUILTIN_TEMPLATE_VERSION: i64 = 3;
const MAX_SCHEMA_NAME: usize = 160;
const MAX_NODE_ID: usize = 128;
const MAX_WORKSPACE_SLUG: usize = 128;
static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum ExpertTeamError {
    Validation(String),
    NotFound(String),
    Conflict(String),
    Storage(String),
}

impl fmt::Display for ExpertTeamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Storage(message) => f.write_str(message),
        }
    }
}

#[derive(Debug)]
pub struct ExpertTeamResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertSchemaNodeInput {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default, alias = "depends_on")]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertSchemaInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub nodes: Vec<ExpertSchemaNodeInput>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBindingInput {
    #[serde(default)]
    pub schema_id: Option<String>,
    #[serde(default)]
    pub schema_revision: Option<i64>,
    #[serde(default)]
    pub schema_revision_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCreateInput {
    pub workspace_slug: String,
    #[serde(default)]
    pub schema_id: Option<String>,
    #[serde(default)]
    pub schema_revision: Option<i64>,
    #[serde(default)]
    pub schema_revision_id: Option<i64>,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaNodeSnapshot {
    id: String,
    role: String,
    prompt: Option<String>,
    depends_on: Vec<String>,
    path: Option<String>,
    config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaSnapshot {
    id: String,
    name: String,
    description: Option<String>,
    nodes: Vec<SchemaNodeSnapshot>,
    metadata: Value,
}

pub struct ExpertTeamStore {
    connection: Arc<Mutex<Connection>>,
}

fn builtin_schema_input() -> ExpertSchemaInput {
    ExpertSchemaInput {
        id: Some(BUILTIN_SCHEMA_ID.to_string()),
        name: "深入研究团队".to_string(),
        description: Some("Copis 专家团队资料搜集、总结和结果检验".to_string()),
        nodes: vec![
            ExpertSchemaNodeInput {
                id: "researcher".to_string(),
                role: "researcher".to_string(),
                prompt: Some(
                    "搜集与任务相关的可靠资料、来源和关键事实，整理为可读的 Markdown 资料文档。"
                        .to_string(),
                ),
                depends_on: vec![],
                path: Some("research/materials.md".to_string()),
                config: json!({"runtime":"pi"}),
            },
            ExpertSchemaNodeInput {
                id: "summary".to_string(),
                role: "writer".to_string(),
                prompt: Some(
                    "阅读 researcher 的资料文档，将资料提炼并总结为结构清晰的 Markdown 文档。"
                        .to_string(),
                ),
                depends_on: vec!["researcher".to_string()],
                path: Some("summary/summary.md".to_string()),
                config: json!({"runtime":"pi"}),
            },
            ExpertSchemaNodeInput {
                id: "reviewer".to_string(),
                role: "reviewer".to_string(),
                prompt: Some(
                    "检验前序研究与总结是否准确、完整、可追溯，输出 Markdown 检验报告。"
                        .to_string(),
                ),
                depends_on: vec!["summary".to_string()],
                path: Some("review/validation-report.md".to_string()),
                config: json!({"runtime":"pi"}),
            },
        ],
        metadata: json!({
            "source": "copis-builtin",
            "execution": "pi-only",
            "templateVersion": BUILTIN_TEMPLATE_VERSION,
        }),
    }
}

impl ExpertTeamStore {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self, ExpertTeamError> {
        let directory = directory.as_ref();
        fs::create_dir_all(directory).map_err(|error| {
            ExpertTeamError::Storage(format!("创建专家团队目录失败: {}", error))
        })?;
        let path = if directory.extension().is_some_and(|value| value == "db") {
            directory.to_path_buf()
        } else {
            directory.join(DATABASE_FILE)
        };
        let connection = Connection::open(&path).map_err(|error| {
            ExpertTeamError::Storage(format!("打开专家团队数据库失败: {}", error))
        })?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(storage_error)?;
        migrate(&connection)?;
        let store = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        store.ensure_builtin_schema()?;
        Ok(store)
    }

    fn ensure_builtin_schema(&self) -> Result<(), ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let snapshot_json: Option<String> = connection
            .query_row(
                "SELECT r.snapshot_json
                   FROM schemas s
                   JOIN schema_revisions r ON r.id = s.current_revision_id
                  WHERE s.id = ?",
                [BUILTIN_SCHEMA_ID],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        drop(connection);
        match snapshot_json {
            None => {
                self.publish_schema(builtin_schema_input())?;
            }
            Some(snapshot_json) => {
                let snapshot: Value = serde_json::from_str(&snapshot_json).map_err(|error| {
                    ExpertTeamError::Storage(format!("内置专家团队 schema 快照损坏: {}", error))
                })?;
                let metadata = snapshot.get("metadata").and_then(Value::as_object);
                let is_builtin = metadata
                    .and_then(|metadata| metadata.get("source"))
                    .and_then(Value::as_str)
                    == Some("copis-builtin");
                let template_version = metadata
                    .and_then(|metadata| metadata.get("templateVersion"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                if is_builtin && template_version < BUILTIN_TEMPLATE_VERSION {
                    self.publish_schema(builtin_schema_input())?;
                }
            }
        }
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<(), ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let result: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(storage_error)?;
        if result == "ok" {
            Ok(())
        } else {
            Err(ExpertTeamError::Storage(format!(
                "专家团队数据库完整性检查失败: {}",
                result
            )))
        }
    }

    pub fn list_schemas(&self) -> Result<Vec<Value>, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
                        r.id, r.revision, r.sha256, r.snapshot_json
                   FROM schemas s
                   JOIN schema_revisions r ON r.id = s.current_revision_id
                  ORDER BY s.updated_at DESC, s.id",
            )
            .map_err(storage_error)?;
        let rows = statement.query_map([], schema_row).map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    pub fn get_schema(&self, id: &str) -> Result<Value, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let summary = connection
            .query_row(
                "SELECT id, name, description, created_at, updated_at, current_revision_id
                   FROM schemas WHERE id = ?",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| ExpertTeamError::NotFound("专家团队 schema 不存在".to_string()))?;
        let mut revisions = connection
            .prepare(
                "SELECT id, revision, sha256, snapshot_json, created_at
                   FROM schema_revisions WHERE schema_id = ? ORDER BY revision DESC",
            )
            .map_err(storage_error)?;
        let revision_rows = revisions
            .query_map([&summary.0], |row| {
                let snapshot: Value =
                    serde_json::from_str(&row.get::<_, String>(3)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "revision": row.get::<_, i64>(1)?,
                    "sha256": row.get::<_, String>(2)?,
                    "snapshot": snapshot,
                    "createdAt": row.get::<_, i64>(4)?,
                }))
            })
            .map_err(storage_error)?;
        let revisions: Vec<Value> = revision_rows
            .map(|row| row.map_err(storage_error))
            .collect::<Result<_, _>>()?;
        Ok(json!({
            "id": summary.0,
            "name": summary.1,
            "description": summary.2,
            "createdAt": summary.3,
            "updatedAt": summary.4,
            "currentRevisionId": summary.5,
            "revisions": revisions,
        }))
    }

    pub fn publish_schema(&self, input: ExpertSchemaInput) -> Result<Value, ExpertTeamError> {
        validate_schema_input(&input)?;
        let id = input.id.clone().unwrap_or_else(|| new_id("schema"));
        validate_identifier(&id, "schema id", MAX_NODE_ID)?;
        let now = now_millis();
        let snapshot = SchemaSnapshot {
            id: id.clone(),
            name: input.name.trim().to_string(),
            description: input
                .description
                .clone()
                .map(|value| value.trim().to_string()),
            nodes: input
                .nodes
                .iter()
                .map(|node| SchemaNodeSnapshot {
                    id: node.id.clone(),
                    role: node.role.clone(),
                    prompt: node.prompt.clone(),
                    depends_on: node.depends_on.clone(),
                    path: node.path.clone(),
                    config: node.config.clone(),
                })
                .collect(),
            metadata: input.metadata.clone(),
        };
        let snapshot_json = serde_json::to_string(&snapshot).map_err(|error| {
            ExpertTeamError::Storage(format!("schema 快照序列化失败: {}", error))
        })?;
        let sha256 = sha256_hex(snapshot_json.as_bytes());
        let connection = self.connection.lock().unwrap();
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        let current_revision: Option<i64> = transaction
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM schema_revisions WHERE schema_id = ?",
                [&id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let revision = current_revision.unwrap_or(0) + 1;
        transaction
            .execute(
                "INSERT INTO schemas (id, name, description, created_at, updated_at, current_revision_id)
                 VALUES (?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
                   updated_at = excluded.updated_at",
                params![id, snapshot.name, snapshot.description, now, now],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO schema_revisions (schema_id, revision, snapshot_json, sha256, created_at)
                 VALUES (?, ?, ?, ?, ?)",
                params![id, revision, snapshot_json, sha256, now],
            )
            .map_err(storage_error)?;
        let revision_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "UPDATE schemas SET current_revision_id = ?, updated_at = ? WHERE id = ?",
                params![revision_id, now, id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(json!({
            "id": id,
            "revision": revision,
            "schemaRevisionId": revision_id,
            "sha256": sha256,
            "snapshot": snapshot,
            "createdAt": now,
        }))
    }

    pub fn validate_schema(&self, input: ExpertSchemaInput) -> Result<Value, ExpertTeamError> {
        validate_schema_input(&input)?;
        let node_count = input.nodes.len();
        let mut edges = Vec::new();
        for node in &input.nodes {
            for dep in &node.depends_on {
                edges.push(json!({ "from": dep, "to": node.id }));
            }
        }
        Ok(json!({
            "valid": true,
            "nodeCount": node_count,
            "edges": edges,
        }))
    }

    pub fn delete_schema(&self, id: &str) -> Result<Value, ExpertTeamError> {
        if id == BUILTIN_SCHEMA_ID {
            return Err(ExpertTeamError::Validation(
                "内置专家团队不能删除".to_string(),
            ));
        }
        let connection = self.connection.lock().unwrap();
        let exists: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT s.id, r.snapshot_json
                   FROM schemas s
                   LEFT JOIN schema_revisions r ON r.id = s.current_revision_id
                  WHERE s.id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let (schema_id, snapshot_json) = match exists {
            Some(res) => res,
            None => {
                return Err(ExpertTeamError::NotFound(
                    "专家团队 schema 不存在".to_string(),
                ))
            }
        };
        if let Some(snapshot_json) = snapshot_json {
            if let Ok(snapshot) = serde_json::from_str::<Value>(&snapshot_json) {
                if snapshot
                    .get("metadata")
                    .and_then(|m| m.get("source"))
                    .and_then(Value::as_str)
                    == Some("copis-builtin")
                {
                    return Err(ExpertTeamError::Validation(
                        "内置专家团队不能删除".to_string(),
                    ));
                }
            }
        }
        let active_runs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE schema_id = ? AND status IN ('queued', 'running')",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if active_runs > 0 {
            return Err(ExpertTeamError::Conflict(
                "存在正在运行的专家团队任务，无法删除".to_string(),
            ));
        }
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction
            .execute("DELETE FROM workspace_bindings WHERE schema_id = ?", [id])
            .map_err(storage_error)?;
        transaction
            .execute("DELETE FROM runs WHERE schema_id = ?", [id])
            .map_err(storage_error)?;
        transaction
            .execute("DELETE FROM schema_revisions WHERE schema_id = ?", [id])
            .map_err(storage_error)?;
        transaction
            .execute("DELETE FROM schemas WHERE id = ?", [id])
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(json!({ "deleted": true, "schemaId": schema_id }))
    }

    pub fn bind_workspace(
        &self,
        workspace_slug: &str,
        input: WorkspaceBindingInput,
    ) -> Result<Value, ExpertTeamError> {
        validate_workspace_slug(workspace_slug)?;
        let revision = self.resolve_revision(
            input.schema_id.as_deref(),
            input.schema_revision_id,
            input.schema_revision,
        )?;
        let connection = self.connection.lock().unwrap();
        let now = now_millis();
        connection
            .execute(
                "INSERT INTO workspace_bindings (workspace_slug, schema_id, schema_revision_id, bound_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(workspace_slug) DO UPDATE SET schema_id = excluded.schema_id,
                   schema_revision_id = excluded.schema_revision_id, bound_at = excluded.bound_at",
                params![workspace_slug, revision.schema_id, revision.id, now],
            )
            .map_err(storage_error)?;
        Ok(json!({
            "workspaceSlug": workspace_slug,
            "schemaId": revision.schema_id,
            "schemaRevisionId": revision.id,
            "revision": revision.revision,
            "sha256": revision.sha256,
            "boundAt": now,
        }))
    }

    pub fn unbind_workspace(&self, workspace_slug: &str) -> Result<Value, ExpertTeamError> {
        validate_workspace_slug(workspace_slug)?;
        let connection = self.connection.lock().unwrap();
        let rows = connection
            .execute(
                "DELETE FROM workspace_bindings WHERE workspace_slug = ?",
                [workspace_slug],
            )
            .map_err(storage_error)?;
        if rows == 0 {
            return Err(ExpertTeamError::NotFound(
                "工作区未绑定专家团队".to_string(),
            ));
        }
        Ok(json!({ "unbound": true, "workspaceSlug": workspace_slug }))
    }

    /// 只读返回 workspace 当前的 binding 与冻结 revision，未绑定时返回 NotFound。
    pub fn get_workspace_binding(&self, workspace_slug: &str) -> Result<Value, ExpertTeamError> {
        validate_workspace_slug(workspace_slug)?;
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT b.workspace_slug, b.schema_id, b.schema_revision_id, b.bound_at,
                        r.revision, r.sha256
                   FROM workspace_bindings b
                   JOIN schema_revisions r ON r.id = b.schema_revision_id
                  WHERE b.workspace_slug = ?",
                [workspace_slug],
                |row| {
                    Ok(json!({
                        "workspaceSlug": row.get::<_, String>(0)?,
                        "schemaId": row.get::<_, String>(1)?,
                        "schemaRevisionId": row.get::<_, i64>(2)?,
                        "boundAt": row.get::<_, i64>(3)?,
                        "revision": row.get::<_, i64>(4)?,
                        "sha256": row.get::<_, String>(5)?,
                    }))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| ExpertTeamError::NotFound("工作区尚未绑定专家团队 schema".to_string()))
    }

    pub fn create_run(&self, input: RunCreateInput) -> Result<Value, ExpertTeamError> {
        validate_workspace_slug(&input.workspace_slug)?;
        let revision = self.resolve_run_revision(
            &input.workspace_slug,
            input.schema_id.as_deref(),
            input.schema_revision_id,
            input.schema_revision,
        )?;
        let snapshot: SchemaSnapshot =
            serde_json::from_str(&revision.snapshot_json).map_err(|error| {
                ExpertTeamError::Storage(format!("schema revision 快照损坏: {}", error))
            })?;
        let run_id = new_id("run");
        let now = now_millis();
        let connection = self.connection.lock().unwrap();
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO runs (id, workspace_slug, schema_id, schema_revision_id, schema_sha256,
                   status, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
                params![
                    run_id,
                    input.workspace_slug,
                    revision.schema_id,
                    revision.id,
                    revision.sha256,
                    serde_json::to_string(&input.input).unwrap_or_else(|_| "null".to_string()),
                    now,
                    now
                ],
            )
            .map_err(storage_error)?;
        for node in snapshot.nodes {
            transaction
                .execute(
                    "INSERT INTO run_nodes (run_id, node_id, role, status, depends_on_json, snapshot_json)
                     VALUES (?, ?, ?, 'queued', ?, ?)",
                    params![
                        run_id,
                        node.id,
                        node.role,
                        serde_json::to_string(&node.depends_on).unwrap_or_else(|_| "[]".to_string()),
                        serde_json::to_string(&node).unwrap_or_else(|_| "{}".to_string())
                    ],
                )
                .map_err(storage_error)?;
        }
        transaction
            .execute(
                "INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at)
                 VALUES (?, 1, 'queued', '{}', ?)",
                params![run_id, now],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(json!({
            "id": run_id,
            "workspaceSlug": input.workspace_slug,
            "schemaId": revision.schema_id,
            "schemaRevisionId": revision.id,
            "schemaRevision": revision.revision,
            "schemaSha256": revision.sha256,
            "status": "queued",
            "input": input.input,
            "createdAt": now,
            "updatedAt": now,
        }))
    }

    pub fn get_run(&self, id: &str) -> Result<Value, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT id, workspace_slug, schema_id, schema_revision_id, schema_sha256, status,
                        input_json, created_at, updated_at, canceled_at
                   FROM runs WHERE id = ?",
                [id],
                run_row,
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| ExpertTeamError::NotFound("专家团队 run 不存在".to_string()))
    }

    /// 按工作区和 schema 返回最近的运行记录，供工作台重启后恢复展示。
    pub fn list_runs(
        &self,
        workspace_slug: Option<&str>,
        schema_id: Option<&str>,
    ) -> Result<Vec<Value>, ExpertTeamError> {
        if let Some(workspace_slug) = workspace_slug {
            validate_workspace_slug(workspace_slug)?;
        }
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT id, workspace_slug, schema_id, schema_revision_id, schema_sha256, status,
                        input_json, created_at, updated_at, canceled_at
                   FROM runs
                  WHERE (?1 IS NULL OR workspace_slug = ?1)
                    AND (?2 IS NULL OR schema_id = ?2)
                  ORDER BY created_at DESC
                  LIMIT 100",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![workspace_slug, schema_id], run_row)
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    pub fn list_run_events(&self, id: &str) -> Result<Vec<Value>, ExpertTeamError> {
        self.ensure_run_exists(id)?;
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("SELECT seq, event_type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([id], |row| {
                let payload: Value =
                    serde_json::from_str(&row.get::<_, String>(2)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(json!({
                    "seq": row.get::<_, i64>(0)?,
                    "type": row.get::<_, String>(1)?,
                    "payload": payload,
                    "createdAt": row.get::<_, i64>(3)?,
                }))
            })
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    pub fn cancel_run(&self, id: &str) -> Result<Value, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let current: Option<String> = connection
            .query_row("SELECT status FROM runs WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(storage_error)?;
        let status =
            current.ok_or_else(|| ExpertTeamError::NotFound("专家团队 run 不存在".to_string()))?;
        if status != "queued" && status != "cancelled" {
            return Err(ExpertTeamError::Conflict(
                "当前 run 状态不允许取消".to_string(),
            ));
        }
        let now = now_millis();
        if status == "queued" {
            connection
                .execute("UPDATE runs SET status = 'cancelled', canceled_at = ?, updated_at = ? WHERE id = ?", params![now, now, id])
                .map_err(storage_error)?;
            let seq: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?",
                    [id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            connection
                .execute("INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at) VALUES (?, ?, 'cancelled', '{}', ?)", params![id, seq, now])
                .map_err(storage_error)?;
        }
        drop(connection);
        self.get_run(id)
    }

    pub fn list_artifacts(&self, id: &str) -> Result<Vec<Value>, ExpertTeamError> {
        self.ensure_run_exists(id)?;
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("SELECT id, node_id, name, mime_type, path, sha256, size, created_at FROM run_artifacts WHERE run_id = ? ORDER BY id")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([id], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "nodeId": row.get::<_, Option<String>>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "mimeType": row.get::<_, Option<String>>(3)?,
                    "path": row.get::<_, String>(4)?,
                    "sha256": row.get::<_, Option<String>>(5)?,
                    "size": row.get::<_, Option<i64>>(6)?,
                    "createdAt": row.get::<_, i64>(7)?,
                }))
            })
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    /// Electron/Pi 执行层使用的内部状态接口；该模块本身不启动任何 Agent。
    pub fn claim_run(&self, id: &str) -> Result<Value, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let status: Option<String> = connection
            .query_row("SELECT status FROM runs WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(storage_error)?;
        let Some(status) = status else {
            return Err(ExpertTeamError::NotFound("专家团队 run 不存在".to_string()));
        };
        if status == "queued" {
            let now = now_millis();
            connection
                .execute(
                    "UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?",
                    params![now, id],
                )
                .map_err(storage_error)?;
            let seq: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?",
                    [id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            connection
                .execute("INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at) VALUES (?, ?, 'claimed', '{}', ?)", params![id, seq, now])
                .map_err(storage_error)?;
        } else if status != "running" {
            return Err(ExpertTeamError::Conflict(
                "run 当前状态不允许 claim".to_string(),
            ));
        }
        drop(connection);
        self.get_run(id)
    }

    pub fn append_run_event(
        &self,
        id: &str,
        event_type: &str,
        payload: Value,
    ) -> Result<Value, ExpertTeamError> {
        validate_identifier(event_type, "event type", 64)?;
        self.ensure_run_exists(id)?;
        let connection = self.connection.lock().unwrap();
        let seq: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let now = now_millis();
        connection
            .execute("INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)", params![id, seq, event_type, serde_json::to_string(&payload).map_err(storage_error)?, now])
            .map_err(storage_error)?;
        Ok(
            json!({ "runId": id, "seq": seq, "type": event_type, "payload": payload, "createdAt": now }),
        )
    }

    pub fn update_run_node(
        &self,
        id: &str,
        node_id: &str,
        input: Value,
    ) -> Result<Value, ExpertTeamError> {
        validate_identifier(node_id, "node id", MAX_NODE_ID)?;
        let status = input
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("running");
        if !matches!(
            status,
            "queued" | "running" | "succeeded" | "failed" | "cancelled"
        ) {
            return Err(ExpertTeamError::Validation(
                "node status 不正确".to_string(),
            ));
        }
        self.ensure_run_exists(id)?;
        let connection = self.connection.lock().unwrap();
        let changed = connection
            .execute("UPDATE run_nodes SET status = ?, input_json = COALESCE(?, input_json), output_json = COALESCE(?, output_json), started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at) WHERE run_id = ? AND node_id = ?", params![status, json_text(input.get("input")), json_text(input.get("output")), input.get("startedAt").and_then(Value::as_i64), input.get("completedAt").and_then(Value::as_i64), id, node_id])
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(ExpertTeamError::NotFound(
                "专家团队 run node 不存在".to_string(),
            ));
        }
        Ok(json!({ "runId": id, "nodeId": node_id, "status": status }))
    }

    pub fn add_artifact(&self, id: &str, input: Value) -> Result<Value, ExpertTeamError> {
        self.ensure_run_exists(id)?;
        let object = input.as_object().ok_or_else(|| {
            ExpertTeamError::Validation("artifact 请求必须是 JSON 对象".to_string())
        })?;
        let path = object
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ExpertTeamError::Validation("artifact path 不能为空".to_string()))?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| path.rsplit('/').next())
            .ok_or_else(|| ExpertTeamError::Validation("artifact name 不能为空".to_string()))?;
        let size = object
            .get("size")
            .or_else(|| object.get("sizeBytes"))
            .and_then(Value::as_i64);
        if let Some(sha256) = object.get("sha256").and_then(Value::as_str) {
            validate_sha256(sha256)?;
        }
        validate_relative_path(path)?;
        let now = now_millis();
        let connection = self.connection.lock().unwrap();
        connection.execute("INSERT INTO run_artifacts (run_id, node_id, name, mime_type, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params![id, object.get("nodeId").and_then(Value::as_str), name, object.get("mimeType").and_then(Value::as_str), path, object.get("sha256").and_then(Value::as_str), size, now]).map_err(storage_error)?;
        let artifact_id = connection.last_insert_rowid();
        Ok(
            json!({ "id": artifact_id, "runId": id, "nodeId": object.get("nodeId"), "name": name, "mimeType": object.get("mimeType"), "path": path, "sha256": object.get("sha256"), "size": size, "createdAt": now }),
        )
    }

    pub fn complete_run(&self, id: &str, status: &str) -> Result<Value, ExpertTeamError> {
        if !matches!(status, "succeeded" | "failed" | "cancelled") {
            return Err(ExpertTeamError::Validation(
                "run 完成状态必须为 succeeded/failed/cancelled".to_string(),
            ));
        }
        let connection = self.connection.lock().unwrap();
        let changed = connection.execute("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')", params![status, now_millis(), id]).map_err(storage_error)?;
        if changed == 0 {
            return Err(ExpertTeamError::Conflict("run 不存在或已完成".to_string()));
        }
        drop(connection);
        self.get_run(id)
    }

    fn ensure_run_exists(&self, id: &str) -> Result<(), ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        let exists: Option<i64> = connection
            .query_row("SELECT 1 FROM runs WHERE id = ?", [id], |row| row.get(0))
            .optional()
            .map_err(storage_error)?;
        if exists.is_some() {
            Ok(())
        } else {
            Err(ExpertTeamError::NotFound("专家团队 run 不存在".to_string()))
        }
    }

    fn resolve_revision(
        &self,
        schema_id: Option<&str>,
        revision_id: Option<i64>,
        revision: Option<i64>,
    ) -> Result<RevisionRow, ExpertTeamError> {
        let connection = self.connection.lock().unwrap();
        if let Some(revision_id) = revision_id {
            if revision_id <= 0 {
                return Err(ExpertTeamError::Validation(
                    "schemaRevisionId 必须为正整数".to_string(),
                ));
            }
            let row = if let Some(schema_id) = schema_id {
                connection
                    .query_row(
                        "SELECT id, schema_id, revision, sha256, snapshot_json FROM schema_revisions WHERE id = ? AND schema_id = ?",
                        params![revision_id, schema_id],
                        revision_row,
                    )
                    .optional()
                    .map_err(storage_error)?
            } else {
                connection
                    .query_row(
                        "SELECT id, schema_id, revision, sha256, snapshot_json FROM schema_revisions WHERE id = ?",
                        [revision_id],
                        revision_row,
                    )
                    .optional()
                    .map_err(storage_error)?
            };
            return row.ok_or_else(|| {
                ExpertTeamError::NotFound("schema revision 不存在或与 schemaId 不匹配".to_string())
            });
        }
        match (schema_id, revision) {
            (Some(schema_id), Some(revision)) => {
                if revision <= 0 {
                    return Err(ExpertTeamError::Validation(
                        "schemaRevision 必须为正整数".to_string(),
                    ));
                }
                connection
                    .query_row(
                        "SELECT id, schema_id, revision, sha256, snapshot_json FROM schema_revisions WHERE schema_id = ? AND revision = ?",
                        params![schema_id, revision],
                        revision_row,
                    )
                    .optional()
                    .map_err(storage_error)?
                    .ok_or_else(|| ExpertTeamError::NotFound("schema revision 不存在".to_string()))
            }
            (Some(schema_id), None) => {
                let current_revision_id = connection
                    .query_row(
                        "SELECT current_revision_id FROM schemas WHERE id = ?",
                        [schema_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()
                    .map_err(storage_error)?
                    .flatten()
                    .ok_or_else(|| {
                        ExpertTeamError::NotFound("schema 当前 revision 不存在".to_string())
                    })?;
                connection
                    .query_row(
                        "SELECT id, schema_id, revision, sha256, snapshot_json FROM schema_revisions WHERE id = ?",
                        [current_revision_id],
                        revision_row,
                    )
                    .optional()
                    .map_err(storage_error)?
                    .ok_or_else(|| ExpertTeamError::NotFound("schema revision 不存在".to_string()))
            }
            (None, Some(_)) => Err(ExpertTeamError::Validation(
                "使用 schemaRevision 版本号时必须同时提供 schemaId".to_string(),
            )),
            (None, None) => Err(ExpertTeamError::Validation(
                "必须提供 schemaRevisionId 或 schemaId + schemaRevision".to_string(),
            )),
        }
    }

    fn resolve_run_revision(
        &self,
        workspace_slug: &str,
        schema_id: Option<&str>,
        revision_id: Option<i64>,
        revision: Option<i64>,
    ) -> Result<RevisionRow, ExpertTeamError> {
        if schema_id.is_some() || revision_id.is_some() || revision.is_some() {
            return self.resolve_revision(schema_id, revision_id, revision);
        }
        let connection = self.connection.lock().unwrap();
        let revision_id: Option<i64> = connection
            .query_row(
                "SELECT schema_revision_id FROM workspace_bindings WHERE workspace_slug = ?",
                [workspace_slug],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        drop(connection);
        self.resolve_revision(None, revision_id, None)
    }
}

#[derive(Debug)]
struct RevisionRow {
    id: i64,
    schema_id: String,
    revision: i64,
    sha256: String,
    snapshot_json: String,
}

fn revision_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionRow> {
    Ok(RevisionRow {
        id: row.get(0)?,
        schema_id: row.get(1)?,
        revision: row.get(2)?,
        sha256: row.get(3)?,
        snapshot_json: row.get(4)?,
    })
}

fn schema_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let snapshot: Value = serde_json::from_str(&row.get::<_, String>(8)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "description": row.get::<_, Option<String>>(2)?,
        "createdAt": row.get::<_, i64>(3)?,
        "updatedAt": row.get::<_, i64>(4)?,
        "currentRevisionId": row.get::<_, i64>(5)?,
        "revision": row.get::<_, i64>(6)?,
        "sha256": row.get::<_, String>(7)?,
        "snapshot": snapshot,
    }))
}

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let input: Value = serde_json::from_str(&row.get::<_, String>(6)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "workspaceSlug": row.get::<_, String>(1)?,
        "schemaId": row.get::<_, String>(2)?,
        "schemaRevisionId": row.get::<_, i64>(3)?,
        "schemaSha256": row.get::<_, String>(4)?,
        "status": row.get::<_, String>(5)?,
        "input": input,
        "createdAt": row.get::<_, i64>(7)?,
        "updatedAt": row.get::<_, i64>(8)?,
        "canceledAt": row.get::<_, Option<i64>>(9)?,
    }))
}

pub fn handle_request(
    store: &ExpertTeamStore,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<ExpertTeamResponse, ExpertTeamError> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let parts: Vec<String> = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(percent_decode)
        .collect::<Result<_, _>>()?;
    if parts.len() < 3 || parts[0] != "api" || parts[1] != "expert-teams" {
        return Err(ExpertTeamError::NotFound("专家团队路由不存在".to_string()));
    }
    match (method, parts.as_slice()) {
        ("GET", [_, _, resource]) if resource == "schemas" => Ok(ExpertTeamResponse {
            status: 200,
            body: json!({ "schemas": store.list_schemas()? }),
        }),
        ("POST", [_, _, resource]) if resource == "schemas" => {
            let input = parse_body::<ExpertSchemaInput>(body)?;
            Ok(ExpertTeamResponse {
                status: 201,
                body: store.publish_schema(input)?,
            })
        }
        ("POST", [_, _, resource, action]) if resource == "schemas" && action == "validate" => {
            let input = parse_body::<ExpertSchemaInput>(body)?;
            Ok(ExpertTeamResponse {
                status: 200,
                body: store.validate_schema(input)?,
            })
        }
        ("GET", [_, _, resource, id]) if resource == "schemas" => Ok(ExpertTeamResponse {
            status: 200,
            body: store.get_schema(id)?,
        }),
        ("DELETE", [_, _, resource, id]) if resource == "schemas" => Ok(ExpertTeamResponse {
            status: 200,
            body: store.delete_schema(id)?,
        }),
        ("POST", [_, _, resource, slug, action])
            if resource == "workspaces" && action == "binding" =>
        {
            let input = parse_body::<WorkspaceBindingInput>(body)?;
            Ok(ExpertTeamResponse {
                status: 200,
                body: store.bind_workspace(slug, input)?,
            })
        }
        ("GET", [_, _, resource, slug, action])
            if resource == "workspaces" && action == "binding" =>
        {
            Ok(ExpertTeamResponse {
                status: 200,
                body: store.get_workspace_binding(slug)?,
            })
        }
        ("DELETE", [_, _, resource, slug, action])
            if resource == "workspaces" && action == "binding" =>
        {
            Ok(ExpertTeamResponse {
                status: 200,
                body: store.unbind_workspace(slug)?,
            })
        }
        ("POST", [_, _, resource]) if resource == "runs" => {
            let input = parse_body::<RunCreateInput>(body)?;
            Ok(ExpertTeamResponse {
                status: 201,
                body: store.create_run(input)?,
            })
        }
        ("GET", [_, _, resource]) if resource == "runs" => {
            let workspace_slug = query_parameter(query, "workspaceSlug")?;
            let schema_id = query_parameter(query, "schemaId")?;
            Ok(ExpertTeamResponse {
                status: 200,
                body: json!({ "runs": store.list_runs(workspace_slug.as_deref(), schema_id.as_deref())? }),
            })
        }
        ("GET", [_, _, resource, id]) if resource == "runs" => Ok(ExpertTeamResponse {
            status: 200,
            body: store.get_run(id)?,
        }),
        ("GET", [_, _, resource, id, action]) if resource == "runs" && action == "events" => {
            Ok(ExpertTeamResponse {
                status: 200,
                body: json!({ "events": store.list_run_events(id)? }),
            })
        }
        ("POST", [_, _, resource, id, action]) if resource == "runs" && action == "cancel" => {
            Ok(ExpertTeamResponse {
                status: 200,
                body: store.cancel_run(id)?,
            })
        }
        ("GET", [_, _, resource, id, action]) if resource == "runs" && action == "artifacts" => {
            Ok(ExpertTeamResponse {
                status: 200,
                body: json!({ "artifacts": store.list_artifacts(id)? }),
            })
        }
        _ => {
            let _ = query;
            Err(ExpertTeamError::NotFound("专家团队路由不存在".to_string()))
        }
    }
}

fn parse_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, ExpertTeamError> {
    serde_json::from_slice(body)
        .map_err(|_| ExpertTeamError::Validation("请求体不是有效的专家团队 JSON".to_string()))
}

fn query_parameter(query: &str, name: &str) -> Result<Option<String>, ExpertTeamError> {
    query
        .split('&')
        .filter_map(|part| part.split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
        .map(percent_decode)
        .transpose()
}

fn json_text(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| serde_json::to_string(value).ok())
}

fn validate_schema_input(input: &ExpertSchemaInput) -> Result<(), ExpertTeamError> {
    if input.name.trim().is_empty() || input.name.trim().len() > MAX_SCHEMA_NAME {
        return Err(ExpertTeamError::Validation(
            "schema name 不能为空或过长".to_string(),
        ));
    }
    if !(1..=32).contains(&input.nodes.len()) {
        return Err(ExpertTeamError::Validation(
            "schema nodes 数量必须在 1 到 32 之间".to_string(),
        ));
    }
    let mut ids = HashSet::new();
    for node in &input.nodes {
        validate_identifier(&node.id, "node id", MAX_NODE_ID)?;
        if !ids.insert(node.id.clone()) {
            return Err(ExpertTeamError::Validation(
                "schema node id 必须唯一".to_string(),
            ));
        }
        if !matches!(
            node.role.as_str(),
            "researcher"
                | "writer"
                | "reviewer"
                | "executor"
                | "explore"
                | "research"
                | "implement"
                | "review"
                | "custom"
        ) {
            return Err(ExpertTeamError::Validation(
                "node role 仅支持 researcher/writer/reviewer/executor/explore/implement/custom 等角色".to_string(),
            ));
        }
        if let Some(path) = node.path.as_deref() {
            validate_relative_path(path)?;
        }
    }
    let mut graph = HashMap::new();
    for node in &input.nodes {
        for dependency in &node.depends_on {
            if !ids.contains(dependency) {
                return Err(ExpertTeamError::Validation(format!(
                    "node {} 的依赖不存在",
                    node.id
                )));
            }
        }
        graph.insert(
            node.id.as_str(),
            node.depends_on
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        );
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in graph.keys() {
        if has_cycle(id, &graph, &mut visiting, &mut visited) {
            return Err(ExpertTeamError::Validation(
                "schema nodes 依赖不能形成循环".to_string(),
            ));
        }
    }
    Ok(())
}

fn has_cycle<'a>(
    id: &'a str,
    graph: &HashMap<&'a str, Vec<&'a str>>,
    visiting: &mut HashSet<&'a str>,
    visited: &mut HashSet<&'a str>,
) -> bool {
    if visiting.contains(id) {
        return true;
    }
    if visited.contains(id) {
        return false;
    }
    visiting.insert(id);
    if let Some(dependencies) = graph.get(id) {
        if dependencies
            .iter()
            .any(|dependency| has_cycle(dependency, graph, visiting, visited))
        {
            return true;
        }
    }
    visiting.remove(id);
    visited.insert(id);
    false
}

fn validate_identifier(value: &str, label: &str, maximum: usize) -> Result<(), ExpertTeamError> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ExpertTeamError::Validation(format!("{} 不正确", label)));
    }
    Ok(())
}

fn validate_workspace_slug(value: &str) -> Result<(), ExpertTeamError> {
    validate_identifier(value, "workspace slug", MAX_WORKSPACE_SLUG)
}

fn validate_relative_path(value: &str) -> Result<(), ExpertTeamError> {
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    if value.trim().is_empty()
        || path.is_absolute()
        || value.as_bytes().contains(&0)
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || path.components().any(|component| {
            component == Component::ParentDir
                || component == Component::RootDir
                || matches!(component, Component::Prefix(_))
        })
    {
        return Err(ExpertTeamError::Validation(
            "路径必须是工作区内的相对路径".to_string(),
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), ExpertTeamError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ExpertTeamError::Validation(
            "artifact sha256 不正确".to_string(),
        ));
    }
    Ok(())
}

fn migrate(connection: &Connection) -> Result<(), ExpertTeamError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > 1 {
        return Err(ExpertTeamError::Storage(format!(
            "不支持的专家团队数据库版本: {}",
            version
        )));
    }
    if version == 0 {
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schemas (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, current_revision_id INTEGER
             );
             CREATE TABLE IF NOT EXISTS schema_revisions (
               id INTEGER PRIMARY KEY AUTOINCREMENT, schema_id TEXT NOT NULL REFERENCES schemas(id) ON DELETE RESTRICT,
               revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
               UNIQUE(schema_id, revision)
             );
             CREATE INDEX IF NOT EXISTS schema_revisions_schema_idx ON schema_revisions(schema_id, revision DESC);
             CREATE TABLE IF NOT EXISTS workspace_bindings (
               workspace_slug TEXT PRIMARY KEY, schema_id TEXT NOT NULL REFERENCES schemas(id) ON DELETE RESTRICT,
               schema_revision_id INTEGER NOT NULL REFERENCES schema_revisions(id) ON DELETE RESTRICT, bound_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS runs (
               id TEXT PRIMARY KEY, workspace_slug TEXT NOT NULL, schema_id TEXT NOT NULL,
               schema_revision_id INTEGER NOT NULL REFERENCES schema_revisions(id) ON DELETE RESTRICT,
               schema_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
               input_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, canceled_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS runs_workspace_idx ON runs(workspace_slug, created_at DESC);
             CREATE TABLE IF NOT EXISTS run_nodes (
               id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
               node_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, depends_on_json TEXT NOT NULL,
               snapshot_json TEXT NOT NULL, input_json TEXT, output_json TEXT, started_at INTEGER, completed_at INTEGER,
               UNIQUE(run_id, node_id)
             );
             CREATE TABLE IF NOT EXISTS run_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
               UNIQUE(run_id, seq)
             );
             CREATE TABLE IF NOT EXISTS run_artifacts (
               id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
               node_id TEXT, name TEXT NOT NULL, mime_type TEXT, path TEXT NOT NULL, sha256 TEXT, size INTEGER, created_at INTEGER NOT NULL
             );
             PRAGMA user_version = 1;",
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    Ok(())
}

fn storage_error(error: impl fmt::Display) -> ExpertTeamError {
    ExpertTeamError::Storage(format!("专家团队数据库读写失败: {}", error))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id(prefix: &str) -> String {
    format!(
        "{}-{}-{}",
        prefix,
        now_millis(),
        ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn percent_decode(value: &str) -> Result<String, ExpertTeamError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(ExpertTeamError::Validation(
                    "URL 路径编码不正确".to_string(),
                ));
            }
            let high = (bytes[index + 1] as char)
                .to_digit(16)
                .ok_or_else(|| ExpertTeamError::Validation("URL 路径编码不正确".to_string()))?;
            let low = (bytes[index + 2] as char)
                .to_digit(16)
                .ok_or_else(|| ExpertTeamError::Validation("URL 路径编码不正确".to_string()))?;
            output.push((high * 16 + low) as u8);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output)
        .map_err(|_| ExpertTeamError::Validation("URL 路径不是有效 UTF-8".to_string()))
}

#[cfg(test)]
#[path = "expert_teams_tests.rs"]
mod tests;
