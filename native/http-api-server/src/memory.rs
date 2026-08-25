use rusqlite::{
    params, params_from_iter, types::Value, Connection, OptionalExtension, Row, Transaction,
    TransactionBehavior,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_LIST_LIMIT: usize = 20;
pub const MAX_LIST_LIMIT: usize = 50;
pub const DEFAULT_RECALL_LIMIT: usize = 8;
pub const MAX_RECALL_LIMIT: usize = 8;
pub const DEFAULT_CONTEXT_MAX_CHARS: usize = 6_000;
pub const MAX_CONTEXT_MAX_CHARS: usize = 12_000;
pub const SCRATCH_RETENTION_MS: u64 = 14 * 24 * 60 * 60 * 1_000;
pub const SCRATCH_CONTEXT_WINDOW_MS: u64 = 2 * 24 * 60 * 60 * 1_000;

const SCHEMA_VERSION: i64 = 1;
const MAX_TITLE_BYTES: usize = 512;
const MAX_CONTENT_BYTES: usize = 256 * 1024;
const MAX_TAGS: usize = 32;
const MAX_TAG_BYTES: usize = 128;
const ENTRY_COLUMNS: &str = "id, scope, workspace_slug, kind, title, content, tags_json, source, created_at, updated_at, captured_at, revision, archived, expires_at";
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace')),
  workspace_slug TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'project', 'scratch')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('agent', 'user', 'import')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  expires_at INTEGER,
  CHECK (
    (scope = 'user' AND workspace_slug IS NULL)
    OR (scope = 'workspace' AND workspace_slug IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS memory_entries_visible_idx
  ON memory_entries(scope, workspace_slug, archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_scratch_retention_idx
  ON memory_entries(kind, captured_at, archived);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation TEXT NOT NULL CHECK (operation IN ('capture', 'rewrite', 'restore', 'archive', 'promote', 'consolidate')),
  snapshot_json TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision)
);
CREATE INDEX IF NOT EXISTS memory_revisions_memory_idx
  ON memory_revisions(memory_id, revision DESC);
CREATE TABLE IF NOT EXISTS memory_maintenance_state (
  scope_key TEXT PRIMARY KEY,
  capture_count INTEGER NOT NULL DEFAULT 0,
  last_consolidated_capture_count INTEGER NOT NULL DEFAULT 0,
  last_promoted_at INTEGER,
  last_cleanup_at INTEGER,
  legacy_imported_at INTEGER,
  updated_at INTEGER NOT NULL
);
"#;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    User,
    Workspace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Fact,
    Preference,
    Decision,
    Project,
    Scratch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    Agent,
    User,
    Import,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryOperation {
    Capture,
    Rewrite,
    Restore,
    Archive,
    Promote,
    Consolidate,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_slug: Option<String>,
    pub kind: MemoryKind,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub captured_at: u64,
    pub revision: u64,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRevision {
    pub memory_id: String,
    pub revision: u64,
    pub operation: MemoryOperation,
    pub snapshot: MemoryEntry,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryExportScope {
    CurrentWorkspace,
    AllWorkspaces,
    User,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryExportFormat {
    Json,
    Markdown,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportInput {
    pub scope: MemoryExportScope,
    pub workspace_slug: Option<String>,
    #[serde(default)]
    pub workspace_names: Option<BTreeMap<String, String>>,
    pub format: MemoryExportFormat,
    pub include_archived: bool,
    pub include_history: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportResponse {
    pub file_name: String,
    pub mime_type: String,
    pub content: String,
    pub entry_count: usize,
    pub revision_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureInput {
    pub workspace_slug: Option<String>,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source: MemorySource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRewriteInput {
    pub workspace_slug: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub kind: Option<MemoryKind>,
    pub tags: Option<Vec<String>>,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRestoreInput {
    pub workspace_slug: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContextInput {
    pub workspace_slug: Option<String>,
    pub query: Option<String>,
    pub max_chars: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureBatchItem {
    pub kind: MemoryKind,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureBatchInput {
    pub workspace_slug: String,
    pub items: Vec<MemoryCaptureBatchItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureResponse {
    pub entry: MemoryEntry,
    pub deduplicated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureBatchResponse {
    pub entries: Vec<MemoryEntry>,
    pub added: usize,
    pub deduplicated: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportItemInput {
    pub kind: MemoryKind,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportInput {
    pub scope: MemoryScope,
    #[serde(default)]
    pub workspace_slug: Option<String>,
    pub items: Vec<MemoryImportItemInput>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportResponse {
    pub entries: Vec<MemoryEntry>,
    pub imported: usize,
    pub deduplicated: usize,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResponse {
    pub entries: Vec<MemoryEntry>,
    pub total: usize,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub user_count: usize,
    pub workspace_count: usize,
    pub archived_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallItem {
    pub id: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_slug: Option<String>,
    pub kind: MemoryKind,
    pub title: String,
    pub excerpt: String,
    pub tags: Vec<String>,
    pub updated_at: u64,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallResponse {
    pub entries: Vec<MemoryRecallItem>,
    pub total: usize,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContextResponse {
    pub text: String,
    pub entries: Vec<MemoryRecallItem>,
    pub generated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaintenanceState {
    pub workspace_slug: String,
    pub capture_count: u64,
    pub last_consolidated_capture_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_promoted_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_cleanup_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum MemoryMaintenanceAction {
    Promote {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
        kind: MemoryKind,
    },
    Rewrite {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
        title: Option<String>,
        content: Option<String>,
        tags: Option<Vec<String>>,
        kind: Option<MemoryKind>,
    },
    Archive {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Capture {
        kind: MemoryKind,
        title: String,
        content: String,
        tags: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaintenanceApplyInput {
    pub workspace_slug: String,
    pub expected_capture_count: u64,
    pub actions: Vec<MemoryMaintenanceAction>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaintenanceApplyResponse {
    pub entries: Vec<MemoryEntry>,
    pub state: MemoryMaintenanceState,
}

#[derive(Clone, Debug)]
pub enum MemoryError {
    Validation(String),
    NotFound,
    Conflict(Box<MemoryEntry>),
    MaintenanceConflict(Box<MemoryMaintenanceState>),
    Storage(String),
}

impl fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("记忆条目不存在或不在当前可见范围"),
            Self::Conflict(entry) => {
                write!(formatter, "记忆 revision 冲突（当前为 {}）", entry.revision)
            }
            Self::MaintenanceConflict(state) => write!(
                formatter,
                "记忆维护状态冲突（当前 captureCount 为 {}）",
                state.capture_count
            ),
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

pub struct MemoryStore {
    connection: Mutex<Connection>,
}

impl MemoryStore {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self, MemoryError> {
        let directory = directory.as_ref().to_path_buf();
        fs::create_dir_all(&directory).map_err(storage_error)?;
        let database_path = directory.join("memory.db");
        let mut connection = Connection::open(&database_path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(storage_error)?;
        initialize_database(&mut connection, &directory)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn integrity_check(&self) -> Result<(), MemoryError> {
        let connection = self.lock_connection()?;
        let result: String = connection
            .pragma_query_value(None, "integrity_check", |row| row.get(0))
            .map_err(storage_error)?;
        if result == "ok" {
            Ok(())
        } else {
            Err(MemoryError::Storage(format!(
                "SQLite integrity_check 失败: {}",
                result
            )))
        }
    }

    pub fn capture(&self, input: MemoryCaptureInput) -> Result<MemoryCaptureResponse, MemoryError> {
        let input = normalize_capture_input(input)?;
        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if let Some(entry) = find_duplicate(&transaction, &input)? {
            transaction.commit().map_err(storage_error)?;
            return Ok(MemoryCaptureResponse {
                entry,
                deduplicated: true,
            });
        }

        let entry = new_entry(
            input.scope,
            input.workspace_slug,
            input.kind,
            input.title,
            input.content,
            input.tags,
            input.source,
        );
        insert_entry(&transaction, &entry)?;
        insert_revision(&transaction, &entry, MemoryOperation::Capture, None)?;
        increment_capture_count_if_scratch(&transaction, &entry)?;
        transaction.commit().map_err(storage_error)?;
        Ok(MemoryCaptureResponse {
            entry,
            deduplicated: false,
        })
    }

    pub fn capture_batch(
        &self,
        input: MemoryCaptureBatchInput,
    ) -> Result<MemoryCaptureBatchResponse, MemoryError> {
        let workspace_slug = normalize_workspace_slug(Some(input.workspace_slug))?
            .ok_or_else(|| MemoryError::Validation("workspaceSlug 参数不正确".to_string()))?;
        if input.items.is_empty() {
            return Err(MemoryError::Validation("items 不能为空".to_string()));
        }
        if input.items.len() > MAX_LIST_LIMIT {
            return Err(MemoryError::Validation("items 数量过多".to_string()));
        }

        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut entries = Vec::with_capacity(input.items.len());
        let mut added = 0;
        let mut deduplicated = 0;
        for item in input.items {
            let normalized = MemoryCaptureInput {
                workspace_slug: Some(workspace_slug.clone()),
                scope: MemoryScope::Workspace,
                kind: item.kind,
                title: item.title,
                content: item.content,
                tags: item.tags,
                source: MemorySource::Agent,
            };
            let normalized = normalize_capture_input(normalized)?;
            if let Some(existing) = find_duplicate(&transaction, &normalized)? {
                deduplicated += 1;
                entries.push(existing);
                continue;
            }
            let entry = new_entry(
                normalized.scope,
                normalized.workspace_slug,
                normalized.kind,
                normalized.title,
                normalized.content,
                normalized.tags,
                normalized.source,
            );
            insert_entry(&transaction, &entry)?;
            insert_revision(&transaction, &entry, MemoryOperation::Capture, None)?;
            increment_capture_count_if_scratch(&transaction, &entry)?;
            added += 1;
            entries.push(entry);
        }
        transaction.commit().map_err(storage_error)?;
        Ok(MemoryCaptureBatchResponse {
            entries,
            added,
            deduplicated,
        })
    }

    pub fn import(&self, input: MemoryImportInput) -> Result<MemoryImportResponse, MemoryError> {
        let workspace_slug = match input.scope {
            MemoryScope::Workspace => {
                let slug = normalize_workspace_slug(input.workspace_slug)?
                    .ok_or_else(|| MemoryError::Validation("workspace scope 必须提供 workspaceSlug".to_string()))?;
                Some(slug)
            }
            MemoryScope::User => {
                if let Some(slug) = input.workspace_slug {
                    normalize_workspace_slug(Some(slug))?;
                }
                None
            }
        };

        if input.items.is_empty() {
            return Err(MemoryError::Validation("items 不能为空".to_string()));
        }
        const MAX_IMPORT_ITEMS: usize = 500;
        if input.items.len() > MAX_IMPORT_ITEMS {
            return Err(MemoryError::Validation("单次导入数量不能超过 500 条".to_string()));
        }

        let total = input.items.len();
        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut entries = Vec::with_capacity(total);
        let mut imported = 0;
        let mut deduplicated = 0;

        for item in input.items {
            let normalized = MemoryCaptureInput {
                workspace_slug: workspace_slug.clone(),
                scope: input.scope,
                kind: item.kind,
                title: item.title,
                content: item.content,
                tags: item.tags,
                source: MemorySource::Import,
            };
            let normalized = normalize_capture_input(normalized)?;
            if let Some(existing) = find_duplicate(&transaction, &normalized)? {
                deduplicated += 1;
                entries.push(existing);
                continue;
            }
            let entry = new_entry(
                normalized.scope,
                normalized.workspace_slug,
                normalized.kind,
                normalized.title,
                normalized.content,
                normalized.tags,
                normalized.source,
            );
            insert_entry(&transaction, &entry)?;
            insert_revision(&transaction, &entry, MemoryOperation::Capture, None)?;
            increment_capture_count_if_scratch(&transaction, &entry)?;
            imported += 1;
            entries.push(entry);
        }

        transaction.commit().map_err(storage_error)?;
        Ok(MemoryImportResponse {
            entries,
            imported,
            deduplicated,
            total,
        })
    }

    pub fn list(
        &self,
        workspace_slug: Option<&str>,
        query: Option<&str>,
        scope: Option<MemoryScope>,
        kind: Option<MemoryKind>,
        include_archived: bool,
        limit: usize,
    ) -> Result<MemoryListResponse, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        validate_limit(limit, MAX_LIST_LIMIT)?;
        let query = query.map(normalize_query).transpose()?;
        if matches!(scope, Some(MemoryScope::Workspace)) && workspace_slug.is_none() {
            return Err(MemoryError::Validation(
                "workspace scope 必须提供 workspaceSlug".to_string(),
            ));
        }

        let connection = self.lock_connection()?;
        let mut sql = format!("SELECT {} FROM memory_entries WHERE 1=1", ENTRY_COLUMNS);
        let mut values = Vec::<Value>::new();
        if let Some(workspace_slug) = workspace_slug {
            sql.push_str(" AND (scope = 'user' OR (scope = 'workspace' AND workspace_slug = ?))");
            values.push(Value::Text(workspace_slug.to_string()));
        } else {
            sql.push_str(" AND scope = 'user'");
        }
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        if let Some(scope) = scope {
            sql.push_str(" AND scope = ?");
            values.push(Value::Text(scope_name(scope).to_string()));
        }
        if let Some(kind) = kind {
            sql.push_str(" AND kind = ?");
            values.push(Value::Text(kind_name(kind).to_string()));
        }
        sql.push_str(" ORDER BY updated_at DESC, id DESC");

        let mut statement = connection.prepare(&sql).map_err(storage_error)?;
        let rows = statement
            .query_map(params_from_iter(values), entry_from_row)
            .map_err(storage_error)?;
        let mut entries = Vec::new();
        for row in rows {
            let entry = row.map_err(storage_error)?;
            if query
                .as_deref()
                .is_none_or(|value| matches_query(&entry, value))
            {
                entries.push(entry);
            }
        }
        let total = entries.len();
        entries.truncate(limit);
        Ok(MemoryListResponse {
            entries,
            total,
            limit,
        })
    }

    pub fn export(&self, input: MemoryExportInput) -> Result<MemoryExportResponse, MemoryError> {
        let workspace_names = input.workspace_names.as_ref();
        let workspace_slug = match input.scope {
            MemoryExportScope::CurrentWorkspace => normalize_workspace_slug(input.workspace_slug)?
                .ok_or_else(|| MemoryError::Validation("workspaceSlug 参数不正确".to_string()))?,
            MemoryExportScope::AllWorkspaces | MemoryExportScope::User => {
                if let Some(value) = input.workspace_slug {
                    normalize_workspace_slug(Some(value))?;
                }
                String::new()
            }
        };

        let entries = self.export_entries(
            input.scope,
            (!workspace_slug.is_empty()).then_some(workspace_slug.as_str()),
            input.include_archived,
        )?;
        let revisions = if input.include_history {
            self.export_revisions(&entries)?
        } else {
            Vec::new()
        };
        let exported_at = now_millis();
        let (content, mime_type, extension) = match input.format {
            MemoryExportFormat::Json => (
                serde_json::to_string_pretty(&serde_json::json!({
                    "schemaVersion": 1,
                    "exportedAt": exported_at,
                    "scope": input.scope,
                    "workspaceSlug": (!workspace_slug.is_empty()).then_some(workspace_slug.as_str()),
                    "entries": entries,
                    "revisions": revisions,
                }))
                .map_err(storage_error)?,
                "application/json",
                "json",
            ),
            MemoryExportFormat::Markdown => (
                render_markdown_export(
                    input.scope,
                    (!workspace_slug.is_empty()).then_some(workspace_slug.as_str()),
                    workspace_names,
                    &entries,
                    &revisions,
                ),
                "text/markdown",
                "md",
            ),
        };

        Ok(MemoryExportResponse {
            file_name: export_file_name(
                input.scope,
                (!workspace_slug.is_empty()).then_some(workspace_slug.as_str()),
                extension,
            ),
            mime_type: mime_type.to_string(),
            content,
            entry_count: entries.len(),
            revision_count: revisions.len(),
        })
    }

    fn export_entries(
        &self,
        scope: MemoryExportScope,
        workspace_slug: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<MemoryEntry>, MemoryError> {
        let connection = self.lock_connection()?;
        let mut sql = format!("SELECT {} FROM memory_entries WHERE ", ENTRY_COLUMNS);
        let mut values = Vec::<Value>::new();
        match scope {
            MemoryExportScope::CurrentWorkspace => {
                let workspace_slug = workspace_slug.ok_or_else(|| {
                    MemoryError::Validation("workspaceSlug 参数不正确".to_string())
                })?;
                sql.push_str("(scope = 'user' OR (scope = 'workspace' AND workspace_slug = ?))");
                values.push(Value::Text(workspace_slug.to_string()));
            }
            MemoryExportScope::AllWorkspaces => sql.push_str("1 = 1"),
            MemoryExportScope::User => sql.push_str("scope = 'user'"),
        }
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        sql.push_str(
            " ORDER BY CASE WHEN scope = 'user' THEN 0 ELSE 1 END,
                      workspace_slug ASC, kind ASC, updated_at DESC, id DESC",
        );
        let mut statement = connection.prepare(&sql).map_err(storage_error)?;
        let rows = statement
            .query_map(params_from_iter(values), entry_from_row)
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    fn export_revisions(
        &self,
        entries: &[MemoryEntry],
    ) -> Result<Vec<MemoryRevision>, MemoryError> {
        let connection = self.lock_connection()?;
        let mut revisions = Vec::new();
        let mut statement = connection
            .prepare(
                "SELECT memory_id, revision, operation, snapshot_json, author, created_at
                 FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC",
            )
            .map_err(storage_error)?;
        for entry in entries {
            let rows = statement
                .query_map(params![entry.id], revision_from_row)
                .map_err(storage_error)?;
            for row in rows {
                revisions.push(row.map_err(storage_error)?);
            }
        }
        Ok(revisions)
    }

    pub fn recall(
        &self,
        workspace_slug: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<MemoryRecallResponse, MemoryError> {
        if query.trim().is_empty() {
            return Err(MemoryError::Validation("recall query 不能为空".to_string()));
        }
        validate_limit(limit, MAX_RECALL_LIMIT)?;
        let list = self.list(workspace_slug, Some(query), None, None, false, limit)?;
        Ok(MemoryRecallResponse {
            entries: list.entries.iter().map(to_recall_item).collect(),
            total: list.total,
            limit: list.limit,
        })
    }

    pub fn context(&self, input: MemoryContextInput) -> Result<MemoryContextResponse, MemoryError> {
        validate_workspace_context(input.workspace_slug.as_deref())?;
        let max_chars = input.max_chars.unwrap_or(DEFAULT_CONTEXT_MAX_CHARS);
        if max_chars == 0 || max_chars > MAX_CONTEXT_MAX_CHARS {
            return Err(MemoryError::Validation(format!(
                "maxChars 必须在 1 到 {} 之间",
                MAX_CONTEXT_MAX_CHARS
            )));
        }
        let query = input.query.as_deref().map(normalize_query).transpose()?;
        let list = self.list(
            input.workspace_slug.as_deref(),
            query.as_deref(),
            None,
            None,
            false,
            MAX_LIST_LIMIT,
        )?;
        let now = now_millis();
        let mut entries: Vec<MemoryEntry> = list
            .entries
            .into_iter()
            .filter(|entry| {
                entry.kind != MemoryKind::Scratch
                    || now.saturating_sub(entry.captured_at) <= SCRATCH_CONTEXT_WINDOW_MS
            })
            .collect();
        entries.sort_by_key(|entry| {
            (
                entry.kind == MemoryKind::Scratch,
                std::cmp::Reverse(entry.updated_at),
            )
        });

        let mut text = String::new();
        let mut included = Vec::new();
        for entry in entries {
            let line = format!(
                "- [{}] {}: {}",
                kind_name(entry.kind),
                entry.title,
                normalize_for_display(&entry.content),
            );
            let next_len =
                text.chars().count() + line.chars().count() + usize::from(!text.is_empty());
            if next_len > max_chars {
                break;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&line);
            included.push(to_recall_item(&entry));
        }
        Ok(MemoryContextResponse {
            text,
            entries: included,
            generated_at: now,
        })
    }

    pub fn get(&self, id: &str, workspace_slug: Option<&str>) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let connection = self.lock_connection()?;
        query_entry(&connection, id, workspace_slug, true)?.ok_or(MemoryError::NotFound)
    }

    pub fn rewrite(&self, id: &str, input: MemoryRewriteInput) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(input.workspace_slug.as_deref())?;
        if input.title.is_none()
            && input.content.is_none()
            && input.kind.is_none()
            && input.tags.is_none()
        {
            return Err(MemoryError::Validation(
                "至少提供一个需要修改的字段".to_string(),
            ));
        }
        let title = input.title.map(validate_title).transpose()?;
        let content = input.content.map(validate_content).transpose()?;
        let tags = input.tags.map(validate_tags).transpose()?;
        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut entry =
            query_entry_transaction(&transaction, id, input.workspace_slug.as_deref(), true)?
                .ok_or(MemoryError::NotFound)?;
        if entry.archived {
            return Err(MemoryError::NotFound);
        }
        if entry.revision != input.expected_revision {
            return Err(MemoryError::Conflict(Box::new(entry)));
        }
        if let Some(title) = title {
            entry.title = title;
        }
        if let Some(content) = content {
            entry.content = content;
        }
        if let Some(kind) = input.kind {
            entry.kind = kind;
            entry.expires_at = expires_at_for(kind, entry.captured_at);
        }
        if let Some(tags) = tags {
            entry.tags = tags;
        }
        entry.updated_at = now_millis();
        entry.revision += 1;
        update_entry(&transaction, &entry)?;
        insert_revision(&transaction, &entry, MemoryOperation::Rewrite, None)?;
        transaction.commit().map_err(storage_error)?;
        Ok(entry)
    }

    pub fn archive(
        &self,
        id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut entry = query_entry_transaction(&transaction, id, workspace_slug, true)?
            .ok_or(MemoryError::NotFound)?;
        if entry.archived {
            return Err(MemoryError::NotFound);
        }
        entry.archived = true;
        entry.updated_at = now_millis();
        entry.revision += 1;
        update_entry(&transaction, &entry)?;
        insert_revision(&transaction, &entry, MemoryOperation::Archive, None)?;
        transaction.commit().map_err(storage_error)?;
        Ok(entry)
    }

    pub fn history(
        &self,
        id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<Vec<MemoryRevision>, MemoryError> {
        let entry = self.get(id, workspace_slug)?;
        let connection = self.lock_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT memory_id, revision, operation, snapshot_json, author, created_at
                 FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![entry.id], revision_from_row)
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    pub fn restore(&self, id: &str, input: MemoryRestoreInput) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(input.workspace_slug.as_deref())?;
        if input.revision == 0 {
            return Err(MemoryError::Validation("revision 必须大于 0".to_string()));
        }
        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut entry =
            query_entry_transaction(&transaction, id, input.workspace_slug.as_deref(), true)?
                .ok_or(MemoryError::NotFound)?;
        let snapshot = transaction
            .query_row(
                "SELECT snapshot_json FROM memory_revisions WHERE memory_id = ? AND revision = ?",
                params![id, input.revision as i64],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(MemoryError::NotFound)
            .and_then(|value| serde_json::from_str::<MemoryEntry>(&value).map_err(storage_error))?;

        entry.kind = snapshot.kind;
        entry.title = snapshot.title;
        entry.content = snapshot.content;
        entry.tags = snapshot.tags;
        entry.source = snapshot.source;
        entry.archived = false;
        entry.expires_at = expires_at_for(entry.kind, entry.captured_at);
        entry.updated_at = now_millis();
        entry.revision += 1;
        update_entry(&transaction, &entry)?;
        insert_revision(&transaction, &entry, MemoryOperation::Restore, None)?;
        transaction.commit().map_err(storage_error)?;
        Ok(entry)
    }

    pub fn stats(&self, workspace_slug: Option<&str>) -> Result<MemoryStats, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let connection = self.lock_connection()?;
        let mut sql = String::from(
            "SELECT \
                 COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN archived = 0 AND scope = 'user' THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN archived = 0 AND scope = 'workspace' THEN 1 ELSE 0 END), 0) \
             FROM memory_entries WHERE 1=1",
        );
        let mut values = Vec::<Value>::new();
        if let Some(workspace_slug) = workspace_slug {
            sql.push_str(" AND (scope = 'user' OR (scope = 'workspace' AND workspace_slug = ?))");
            values.push(Value::Text(workspace_slug.to_string()));
        } else {
            sql.push_str(" AND scope = 'user'");
        }
        let (archived_count, user_count, workspace_count) = connection
            .query_row(&sql, params_from_iter(values), |row| {
                Ok((
                    row.get::<_, i64>(0)? as usize,
                    row.get::<_, i64>(1)? as usize,
                    row.get::<_, i64>(2)? as usize,
                ))
            })
            .map_err(storage_error)?;
        Ok(MemoryStats {
            user_count,
            workspace_count,
            archived_count,
        })
    }

    pub fn maintenance_state(
        &self,
        workspace_slug: &str,
    ) -> Result<MemoryMaintenanceState, MemoryError> {
        let workspace_slug = normalize_workspace_slug(Some(workspace_slug.to_string()))?
            .ok_or_else(|| MemoryError::Validation("workspaceSlug 参数不正确".to_string()))?;
        let connection = self.lock_connection()?;
        read_maintenance_state_connection(&connection, &workspace_slug)
    }

    pub fn apply_maintenance(
        &self,
        input: MemoryMaintenanceApplyInput,
    ) -> Result<MemoryMaintenanceApplyResponse, MemoryError> {
        let workspace_slug = normalize_workspace_slug(Some(input.workspace_slug))?
            .ok_or_else(|| MemoryError::Validation("workspaceSlug 参数不正确".to_string()))?;
        if input.actions.len() > MAX_LIST_LIMIT {
            return Err(MemoryError::Validation("维护 actions 数量过多".to_string()));
        }

        let mut connection = self.lock_connection_mut()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current_state = read_maintenance_state_transaction(&transaction, &workspace_slug)?;
        if current_state.capture_count != input.expected_capture_count {
            return Err(MemoryError::MaintenanceConflict(Box::new(current_state)));
        }

        let mut affected = Vec::new();
        for action in input.actions {
            match action {
                MemoryMaintenanceAction::Promote {
                    id,
                    expected_revision,
                    kind,
                } => {
                    if kind == MemoryKind::Scratch {
                        return Err(MemoryError::Validation(
                            "promotion 不能将条目提升为 scratch".to_string(),
                        ));
                    }
                    let mut entry = maintenance_entry(&transaction, &id, &workspace_slug)?;
                    check_revision(&entry, expected_revision)?;
                    entry.kind = kind;
                    entry.expires_at = None;
                    entry.updated_at = now_millis();
                    entry.revision += 1;
                    update_entry(&transaction, &entry)?;
                    insert_revision(
                        &transaction,
                        &entry,
                        MemoryOperation::Promote,
                        Some("system"),
                    )?;
                    affected.push(entry);
                }
                MemoryMaintenanceAction::Rewrite {
                    id,
                    expected_revision,
                    title,
                    content,
                    tags,
                    kind,
                } => {
                    if title.is_none() && content.is_none() && tags.is_none() && kind.is_none() {
                        return Err(MemoryError::Validation(
                            "维护 rewrite 至少需要一个字段".to_string(),
                        ));
                    }
                    let title = title.map(validate_title).transpose()?;
                    let content = content.map(validate_content).transpose()?;
                    let tags = tags.map(validate_tags).transpose()?;
                    let mut entry = maintenance_entry(&transaction, &id, &workspace_slug)?;
                    check_revision(&entry, expected_revision)?;
                    if let Some(title) = title {
                        entry.title = title;
                    }
                    if let Some(content) = content {
                        entry.content = content;
                    }
                    if let Some(tags) = tags {
                        entry.tags = tags;
                    }
                    if let Some(kind) = kind {
                        entry.kind = kind;
                        entry.expires_at = expires_at_for(kind, entry.captured_at);
                    }
                    entry.updated_at = now_millis();
                    entry.revision += 1;
                    update_entry(&transaction, &entry)?;
                    insert_revision(
                        &transaction,
                        &entry,
                        MemoryOperation::Consolidate,
                        Some("system"),
                    )?;
                    affected.push(entry);
                }
                MemoryMaintenanceAction::Archive {
                    id,
                    expected_revision,
                } => {
                    let mut entry = maintenance_entry(&transaction, &id, &workspace_slug)?;
                    check_revision(&entry, expected_revision)?;
                    entry.archived = true;
                    entry.updated_at = now_millis();
                    entry.revision += 1;
                    update_entry(&transaction, &entry)?;
                    insert_revision(
                        &transaction,
                        &entry,
                        MemoryOperation::Archive,
                        Some("system"),
                    )?;
                    affected.push(entry);
                }
                MemoryMaintenanceAction::Capture {
                    kind,
                    title,
                    content,
                    tags,
                } => {
                    if kind == MemoryKind::Scratch {
                        return Err(MemoryError::Validation(
                            "维护 capture 不能创建 scratch，请使用 capture-batch".to_string(),
                        ));
                    }
                    let input = normalize_capture_input(MemoryCaptureInput {
                        workspace_slug: Some(workspace_slug.clone()),
                        scope: MemoryScope::Workspace,
                        kind,
                        title,
                        content,
                        tags,
                        source: MemorySource::Agent,
                    })?;
                    if let Some(existing) = find_duplicate(&transaction, &input)? {
                        affected.push(existing);
                        continue;
                    }
                    let entry = new_entry(
                        input.scope,
                        input.workspace_slug,
                        input.kind,
                        input.title,
                        input.content,
                        input.tags,
                        input.source,
                    );
                    insert_entry(&transaction, &entry)?;
                    insert_revision(
                        &transaction,
                        &entry,
                        MemoryOperation::Consolidate,
                        Some("system"),
                    )?;
                    affected.push(entry);
                }
            }
        }

        let now = now_millis();
        let expired = expired_scratch_entries(&transaction, &workspace_slug, now)?;
        for mut entry in expired {
            entry.archived = true;
            entry.updated_at = now;
            entry.revision += 1;
            update_entry(&transaction, &entry)?;
            insert_revision(
                &transaction,
                &entry,
                MemoryOperation::Archive,
                Some("system"),
            )?;
            affected.push(entry);
        }

        let scope_key = workspace_scope_key(&workspace_slug);
        transaction
            .execute(
                "UPDATE memory_maintenance_state SET last_consolidated_capture_count = ?,
                 last_promoted_at = ?, last_cleanup_at = ?, updated_at = ? WHERE scope_key = ?",
                params![
                    input.expected_capture_count as i64,
                    now as i64,
                    now as i64,
                    now as i64,
                    scope_key,
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        drop(connection);

        let state = self.maintenance_state(&workspace_slug)?;
        Ok(MemoryMaintenanceApplyResponse {
            entries: affected,
            state,
        })
    }

    fn lock_connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MemoryError> {
        self.connection
            .lock()
            .map_err(|_| MemoryError::Storage("记忆存储锁已损坏".to_string()))
    }

    fn lock_connection_mut(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MemoryError> {
        self.lock_connection()
    }
}

fn initialize_database(connection: &mut Connection, directory: &Path) -> Result<(), MemoryError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > SCHEMA_VERSION {
        return Err(MemoryError::Storage(format!(
            "Memory SQLite schema 版本 {} 高于当前版本 {}",
            version, SCHEMA_VERSION
        )));
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    transaction
        .execute_batch(SCHEMA_SQL)
        .map_err(storage_error)?;
    let existing_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM memory_entries", [], |row| row.get(0))
        .map_err(storage_error)?;
    let imported_at: Option<i64> = transaction
        .query_row(
            "SELECT legacy_imported_at FROM memory_maintenance_state WHERE scope_key = '__global__'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .flatten();

    if existing_count == 0 && imported_at.is_none() {
        let legacy_entries = read_json_file::<Vec<MemoryEntry>>(&directory.join("entries.json"))?
            .unwrap_or_default();
        let legacy_revisions =
            read_json_lines::<MemoryRevision>(&directory.join("revisions.jsonl"))?;
        let now = now_millis();
        for mut entry in legacy_entries {
            normalize_legacy_entry(&mut entry, now);
            insert_entry(&transaction, &entry)?;
        }
        for mut revision in legacy_revisions {
            normalize_legacy_entry(&mut revision.snapshot, now);
            insert_revision_record(&transaction, &revision)?;
        }
    }

    let now = now_millis();
    transaction
        .execute(
            "INSERT INTO memory_maintenance_state
             (scope_key, capture_count, last_consolidated_capture_count, legacy_imported_at, updated_at)
             VALUES ('__global__', 0, 0, ?, ?)
             ON CONFLICT(scope_key) DO UPDATE SET
               legacy_imported_at = COALESCE(memory_maintenance_state.legacy_imported_at, excluded.legacy_imported_at),
               updated_at = excluded.updated_at",
            params![now as i64, now as i64],
        )
        .map_err(storage_error)?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}

fn normalize_legacy_entry(entry: &mut MemoryEntry, now: u64) {
    if entry.captured_at == 0 {
        entry.captured_at = if entry.created_at > 0 {
            entry.created_at
        } else {
            now
        };
    }
    if entry.expires_at.is_none() {
        entry.expires_at = expires_at_for(entry.kind, entry.captured_at);
    }
}

fn new_entry(
    scope: MemoryScope,
    workspace_slug: Option<String>,
    kind: MemoryKind,
    title: String,
    content: String,
    tags: Vec<String>,
    source: MemorySource,
) -> MemoryEntry {
    let now = now_millis();
    MemoryEntry {
        id: format!("memory-{}-{}", now, NEXT_ID.fetch_add(1, Ordering::Relaxed)),
        scope,
        workspace_slug,
        kind,
        title,
        content,
        tags,
        source,
        created_at: now,
        updated_at: now,
        captured_at: now,
        revision: 1,
        archived: false,
        expires_at: expires_at_for(kind, now),
    }
}

fn insert_entry(transaction: &Transaction<'_>, entry: &MemoryEntry) -> Result<(), MemoryError> {
    let tags_json = serde_json::to_string(&entry.tags).map_err(storage_error)?;
    transaction
        .execute(
            &format!(
                "INSERT INTO memory_entries ({}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ENTRY_COLUMNS
            ),
            params![
                entry.id,
                scope_name(entry.scope),
                entry.workspace_slug,
                kind_name(entry.kind),
                entry.title,
                entry.content,
                tags_json,
                source_name(entry.source),
                entry.created_at as i64,
                entry.updated_at as i64,
                entry.captured_at as i64,
                entry.revision as i64,
                i64::from(entry.archived),
                entry.expires_at.map(|value| value as i64),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn update_entry(transaction: &Transaction<'_>, entry: &MemoryEntry) -> Result<(), MemoryError> {
    let tags_json = serde_json::to_string(&entry.tags).map_err(storage_error)?;
    transaction
        .execute(
            "UPDATE memory_entries SET scope = ?, workspace_slug = ?, kind = ?, title = ?, content = ?,
             tags_json = ?, source = ?, created_at = ?, updated_at = ?, captured_at = ?, revision = ?,
             archived = ?, expires_at = ? WHERE id = ?",
            params![
                scope_name(entry.scope),
                entry.workspace_slug,
                kind_name(entry.kind),
                entry.title,
                entry.content,
                tags_json,
                source_name(entry.source),
                entry.created_at as i64,
                entry.updated_at as i64,
                entry.captured_at as i64,
                entry.revision as i64,
                i64::from(entry.archived),
                entry.expires_at.map(|value| value as i64),
                entry.id,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn insert_revision(
    transaction: &Transaction<'_>,
    entry: &MemoryEntry,
    operation: MemoryOperation,
    author: Option<&str>,
) -> Result<(), MemoryError> {
    let snapshot_json = serde_json::to_string(entry).map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO memory_revisions (memory_id, revision, operation, snapshot_json, author, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                entry.id,
                entry.revision as i64,
                operation_name(operation),
                snapshot_json,
                author,
                now_millis() as i64,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn insert_revision_record(
    transaction: &Transaction<'_>,
    revision: &MemoryRevision,
) -> Result<(), MemoryError> {
    let snapshot_json = serde_json::to_string(&revision.snapshot).map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO memory_revisions (memory_id, revision, operation, snapshot_json, author, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                revision.memory_id,
                revision.revision as i64,
                operation_name(revision.operation),
                snapshot_json,
                revision.author,
                revision.created_at as i64,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn read_maintenance_state_connection(
    connection: &Connection,
    workspace_slug: &str,
) -> Result<MemoryMaintenanceState, MemoryError> {
    let scope_key = workspace_scope_key(workspace_slug);
    let row = connection
        .query_row(
            "SELECT capture_count, last_consolidated_capture_count, last_promoted_at, last_cleanup_at
             FROM memory_maintenance_state WHERE scope_key = ?",
            params![scope_key],
            maintenance_state_row,
        )
        .optional()
        .map_err(storage_error)?
        .unwrap_or((0, 0, None, None));
    Ok(memory_maintenance_state(workspace_slug, row))
}

fn read_maintenance_state_transaction(
    transaction: &Transaction<'_>,
    workspace_slug: &str,
) -> Result<MemoryMaintenanceState, MemoryError> {
    let scope_key = workspace_scope_key(workspace_slug);
    let row = transaction
        .query_row(
            "SELECT capture_count, last_consolidated_capture_count, last_promoted_at, last_cleanup_at
             FROM memory_maintenance_state WHERE scope_key = ?",
            params![scope_key],
            maintenance_state_row,
        )
        .optional()
        .map_err(storage_error)?
        .unwrap_or((0, 0, None, None));
    Ok(memory_maintenance_state(workspace_slug, row))
}

fn maintenance_state_row(row: &Row<'_>) -> rusqlite::Result<(u64, u64, Option<u64>, Option<u64>)> {
    Ok((
        row.get::<_, i64>(0)? as u64,
        row.get::<_, i64>(1)? as u64,
        row.get::<_, Option<i64>>(2)?.map(|value| value as u64),
        row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
    ))
}

fn memory_maintenance_state(
    workspace_slug: &str,
    row: (u64, u64, Option<u64>, Option<u64>),
) -> MemoryMaintenanceState {
    MemoryMaintenanceState {
        workspace_slug: workspace_slug.to_string(),
        capture_count: row.0,
        last_consolidated_capture_count: row.1,
        last_promoted_at: row.2,
        last_cleanup_at: row.3,
    }
}

fn maintenance_entry(
    transaction: &Transaction<'_>,
    id: &str,
    workspace_slug: &str,
) -> Result<MemoryEntry, MemoryError> {
    let entry = query_entry_from_transaction(transaction, id, Some(workspace_slug), true)?
        .ok_or(MemoryError::NotFound)?;
    if entry.scope != MemoryScope::Workspace
        || entry.workspace_slug.as_deref() != Some(workspace_slug)
    {
        return Err(MemoryError::NotFound);
    }
    Ok(entry)
}

fn check_revision(entry: &MemoryEntry, expected_revision: u64) -> Result<(), MemoryError> {
    if entry.archived {
        return Err(MemoryError::NotFound);
    }
    if entry.revision != expected_revision {
        return Err(MemoryError::Conflict(Box::new(entry.clone())));
    }
    Ok(())
}

fn expired_scratch_entries(
    transaction: &Transaction<'_>,
    workspace_slug: &str,
    now: u64,
) -> Result<Vec<MemoryEntry>, MemoryError> {
    let mut statement = transaction
        .prepare(&format!(
            "SELECT {} FROM memory_entries
             WHERE scope = 'workspace' AND workspace_slug = ? AND kind = 'scratch'
               AND archived = 0 AND expires_at IS NOT NULL AND expires_at <= ?",
            ENTRY_COLUMNS
        ))
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![workspace_slug, now as i64], entry_from_row)
        .map_err(storage_error)?;
    rows.map(|row| row.map_err(storage_error)).collect()
}

fn increment_capture_count_if_scratch(
    transaction: &Transaction<'_>,
    entry: &MemoryEntry,
) -> Result<(), MemoryError> {
    if entry.kind != MemoryKind::Scratch {
        return Ok(());
    }
    let scope_key = match entry.scope {
        MemoryScope::User => "user".to_string(),
        MemoryScope::Workspace => workspace_scope_key(
            entry
                .workspace_slug
                .as_deref()
                .ok_or_else(|| MemoryError::Validation("workspaceSlug 参数不正确".to_string()))?,
        ),
    };
    let now = now_millis() as i64;
    transaction
        .execute(
            "INSERT INTO memory_maintenance_state
             (scope_key, capture_count, last_consolidated_capture_count, updated_at)
             VALUES (?, 1, 0, ?)
             ON CONFLICT(scope_key) DO UPDATE SET
               capture_count = memory_maintenance_state.capture_count + 1,
               updated_at = excluded.updated_at",
            params![scope_key, now],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn find_duplicate(
    transaction: &Transaction<'_>,
    input: &MemoryCaptureInput,
) -> Result<Option<MemoryEntry>, MemoryError> {
    let mut statement = transaction
        .prepare(&format!(
            "SELECT {} FROM memory_entries
             WHERE archived = 0 AND scope = ? AND workspace_slug IS ?
             ORDER BY updated_at DESC",
            ENTRY_COLUMNS
        ))
        .map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![scope_name(input.scope), input.workspace_slug.as_deref()],
            entry_from_row,
        )
        .map_err(storage_error)?;
    let normalized_content = normalize_for_match(&input.content);
    for row in rows {
        let entry = row.map_err(storage_error)?;
        if normalize_for_match(&entry.content) == normalized_content {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

fn query_entry(
    connection: &Connection,
    id: &str,
    workspace_slug: Option<&str>,
    include_archived: bool,
) -> Result<Option<MemoryEntry>, MemoryError> {
    query_entry_from_connection(connection, id, workspace_slug, include_archived)
}

fn query_entry_transaction(
    transaction: &Transaction<'_>,
    id: &str,
    workspace_slug: Option<&str>,
    include_archived: bool,
) -> Result<Option<MemoryEntry>, MemoryError> {
    query_entry_from_transaction(transaction, id, workspace_slug, include_archived)
}

fn query_entry_from_connection(
    connection: &Connection,
    id: &str,
    workspace_slug: Option<&str>,
    include_archived: bool,
) -> Result<Option<MemoryEntry>, MemoryError> {
    let mut sql = format!("SELECT {} FROM memory_entries WHERE id = ?", ENTRY_COLUMNS);
    if let Some(workspace_slug) = workspace_slug {
        sql.push_str(" AND (scope = 'user' OR (scope = 'workspace' AND workspace_slug = ?))");
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        connection
            .query_row(&sql, params![id, workspace_slug], entry_from_row)
            .optional()
            .map_err(storage_error)
    } else {
        sql.push_str(" AND scope = 'user'");
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        connection
            .query_row(&sql, params![id], entry_from_row)
            .optional()
            .map_err(storage_error)
    }
}

fn query_entry_from_transaction(
    transaction: &Transaction<'_>,
    id: &str,
    workspace_slug: Option<&str>,
    include_archived: bool,
) -> Result<Option<MemoryEntry>, MemoryError> {
    let mut sql = format!("SELECT {} FROM memory_entries WHERE id = ?", ENTRY_COLUMNS);
    if let Some(workspace_slug) = workspace_slug {
        sql.push_str(" AND (scope = 'user' OR (scope = 'workspace' AND workspace_slug = ?))");
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        transaction
            .query_row(&sql, params![id, workspace_slug], entry_from_row)
            .optional()
            .map_err(storage_error)
    } else {
        sql.push_str(" AND scope = 'user'");
        if !include_archived {
            sql.push_str(" AND archived = 0");
        }
        transaction
            .query_row(&sql, params![id], entry_from_row)
            .optional()
            .map_err(storage_error)
    }
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryEntry> {
    let scope = parse_scope(&row.get::<_, String>(1)?)?;
    let kind = parse_kind(&row.get::<_, String>(3)?)?;
    let source = parse_source(&row.get::<_, String>(7)?)?;
    let tags_json: String = row.get(6)?;
    let archived: i64 = row.get(12)?;
    Ok(MemoryEntry {
        id: row.get(0)?,
        scope,
        workspace_slug: row.get(2)?,
        kind,
        title: row.get(4)?,
        content: row.get(5)?,
        tags: serde_json::from_str(&tags_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        source,
        created_at: row.get::<_, i64>(8)? as u64,
        updated_at: row.get::<_, i64>(9)? as u64,
        captured_at: row.get::<_, i64>(10)? as u64,
        revision: row.get::<_, i64>(11)? as u64,
        archived: archived != 0,
        expires_at: row.get::<_, Option<i64>>(13)?.map(|value| value as u64),
    })
}

fn revision_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryRevision> {
    let operation = parse_operation(&row.get::<_, String>(2)?)?;
    let snapshot_json: String = row.get(3)?;
    let snapshot = serde_json::from_str(&snapshot_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(MemoryRevision {
        memory_id: row.get(0)?,
        revision: row.get::<_, i64>(1)? as u64,
        operation,
        snapshot,
        author: row.get(4)?,
        created_at: row.get::<_, i64>(5)? as u64,
    })
}

fn parse_scope(value: &str) -> rusqlite::Result<MemoryScope> {
    match value {
        "user" => Ok(MemoryScope::User),
        "workspace" => Ok(MemoryScope::Workspace),
        _ => Err(rusqlite::Error::InvalidColumnType(
            1,
            "scope".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn parse_kind(value: &str) -> rusqlite::Result<MemoryKind> {
    match value {
        "fact" => Ok(MemoryKind::Fact),
        "preference" => Ok(MemoryKind::Preference),
        "decision" => Ok(MemoryKind::Decision),
        "project" => Ok(MemoryKind::Project),
        "scratch" => Ok(MemoryKind::Scratch),
        _ => Err(rusqlite::Error::InvalidColumnType(
            3,
            "kind".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn parse_source(value: &str) -> rusqlite::Result<MemorySource> {
    match value {
        "agent" => Ok(MemorySource::Agent),
        "user" => Ok(MemorySource::User),
        "import" => Ok(MemorySource::Import),
        _ => Err(rusqlite::Error::InvalidColumnType(
            7,
            "source".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn parse_operation(value: &str) -> rusqlite::Result<MemoryOperation> {
    match value {
        "capture" => Ok(MemoryOperation::Capture),
        "rewrite" => Ok(MemoryOperation::Rewrite),
        "restore" => Ok(MemoryOperation::Restore),
        "archive" => Ok(MemoryOperation::Archive),
        "promote" => Ok(MemoryOperation::Promote),
        "consolidate" => Ok(MemoryOperation::Consolidate),
        _ => Err(rusqlite::Error::InvalidColumnType(
            2,
            "operation".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn scope_name(scope: MemoryScope) -> &'static str {
    match scope {
        MemoryScope::User => "user",
        MemoryScope::Workspace => "workspace",
    }
}

fn kind_name(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Fact => "fact",
        MemoryKind::Preference => "preference",
        MemoryKind::Decision => "decision",
        MemoryKind::Project => "project",
        MemoryKind::Scratch => "scratch",
    }
}

fn source_name(source: MemorySource) -> &'static str {
    match source {
        MemorySource::Agent => "agent",
        MemorySource::User => "user",
        MemorySource::Import => "import",
    }
}

fn operation_name(operation: MemoryOperation) -> &'static str {
    match operation {
        MemoryOperation::Capture => "capture",
        MemoryOperation::Rewrite => "rewrite",
        MemoryOperation::Restore => "restore",
        MemoryOperation::Archive => "archive",
        MemoryOperation::Promote => "promote",
        MemoryOperation::Consolidate => "consolidate",
    }
}

fn normalize_capture_input(
    mut input: MemoryCaptureInput,
) -> Result<MemoryCaptureInput, MemoryError> {
    input.workspace_slug = normalize_workspace_slug(input.workspace_slug)?;
    if input.scope == MemoryScope::User && input.workspace_slug.is_some() {
        return Err(MemoryError::Validation(
            "user scope 不能带 workspaceSlug".to_string(),
        ));
    }
    if input.scope == MemoryScope::Workspace && input.workspace_slug.is_none() {
        return Err(MemoryError::Validation(
            "workspace scope 必须提供 workspaceSlug".to_string(),
        ));
    }
    input.title = validate_title(input.title)?;
    input.content = validate_content(input.content)?;
    input.tags = validate_tags(input.tags)?;
    Ok(input)
}

fn validate_title(value: String) -> Result<String, MemoryError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(MemoryError::Validation("title 不能为空".to_string()));
    }
    if value.len() > MAX_TITLE_BYTES {
        return Err(MemoryError::Validation("title 过长".to_string()));
    }
    Ok(value)
}

fn validate_content(value: String) -> Result<String, MemoryError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(MemoryError::Validation("content 不能为空".to_string()));
    }
    if value.len() > MAX_CONTENT_BYTES {
        return Err(MemoryError::Validation("content 过长".to_string()));
    }
    Ok(value)
}

fn validate_tags(tags: Vec<String>) -> Result<Vec<String>, MemoryError> {
    if tags.len() > MAX_TAGS {
        return Err(MemoryError::Validation("tags 数量过多".to_string()));
    }
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_string();
        if tag.is_empty() {
            continue;
        }
        if tag.len() > MAX_TAG_BYTES {
            return Err(MemoryError::Validation("tag 过长".to_string()));
        }
        if !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    Ok(normalized)
}

fn normalize_workspace_slug(value: Option<String>) -> Result<Option<String>, MemoryError> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > 128 {
        return Err(MemoryError::Validation(
            "workspaceSlug 参数不正确".to_string(),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(MemoryError::Validation(
            "workspaceSlug 参数不正确".to_string(),
        ));
    }
    Ok(Some(value))
}

fn validate_workspace_context(value: Option<&str>) -> Result<(), MemoryError> {
    normalize_workspace_slug(value.map(str::to_string)).map(|_| ())
}

fn validate_limit(limit: usize, maximum: usize) -> Result<(), MemoryError> {
    if limit == 0 || limit > maximum {
        return Err(MemoryError::Validation(format!(
            "limit 必须在 1 到 {} 之间",
            maximum
        )));
    }
    Ok(())
}

fn normalize_query(value: &str) -> Result<String, MemoryError> {
    let value = value.trim().to_lowercase();
    if value.is_empty() {
        return Err(MemoryError::Validation("query 不能为空".to_string()));
    }
    Ok(value)
}

fn normalize_for_match(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalize_for_display(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn matches_query(entry: &MemoryEntry, query: &str) -> bool {
    let haystack = normalize_for_match(&format!(
        "{} {} {}",
        entry.title,
        entry.content,
        entry.tags.join(" ")
    ));
    query.split_whitespace().all(|word| haystack.contains(word))
}

fn to_recall_item(entry: &MemoryEntry) -> MemoryRecallItem {
    let excerpt = entry
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();
    MemoryRecallItem {
        id: entry.id.clone(),
        scope: entry.scope,
        workspace_slug: entry.workspace_slug.clone(),
        kind: entry.kind,
        title: entry.title.clone(),
        excerpt,
        tags: entry.tags.clone(),
        updated_at: entry.updated_at,
        revision: entry.revision,
    }
}

fn render_markdown_export(
    scope: MemoryExportScope,
    workspace_slug: Option<&str>,
    workspace_names: Option<&BTreeMap<String, String>>,
    entries: &[MemoryEntry],
    revisions: &[MemoryRevision],
) -> String {
    let mut output = String::from("# Copis Memory Export\n\n");
    output.push_str(&format!("- 导出范围：{}\n", export_scope_label(scope)));
    if let Some(workspace_slug) = workspace_slug {
        output.push_str(&format!(
            "- 项目：{}\n- 项目标识：{}\n",
            export_workspace_name(workspace_slug, workspace_names),
            workspace_slug,
        ));
    }
    output.push_str(&format!(
        "- 条目数量：{}\n- 修订数量：{}\n\n",
        entries.len(),
        revisions.len()
    ));

    let active_entries: Vec<&MemoryEntry> =
        entries.iter().filter(|entry| !entry.archived).collect();
    let user_entries: Vec<&MemoryEntry> = active_entries
        .iter()
        .copied()
        .filter(|entry| entry.scope == MemoryScope::User)
        .collect();
    append_markdown_group(&mut output, "用户记忆", &user_entries);

    let mut projects = BTreeMap::<String, Vec<&MemoryEntry>>::new();
    for entry in active_entries
        .iter()
        .copied()
        .filter(|entry| entry.scope == MemoryScope::Workspace)
    {
        if let Some(slug) = entry.workspace_slug.as_deref() {
            projects.entry(slug.to_string()).or_default().push(entry);
        }
    }
    if let Some(workspace_slug) = workspace_slug {
        projects.entry(workspace_slug.to_string()).or_default();
    }
    for (slug, project_entries) in projects {
        output.push_str(&format!(
            "## 项目：{}\n\n",
            export_workspace_name(&slug, workspace_names)
        ));
        append_markdown_entries(&mut output, &project_entries);
    }

    let archived_entries: Vec<&MemoryEntry> =
        entries.iter().filter(|entry| entry.archived).collect();
    if !archived_entries.is_empty() {
        output.push_str("## 已归档\n\n");
        for entry in archived_entries {
            let group = entry
                .workspace_slug
                .as_deref()
                .map(|slug| format!("项目：{}", export_workspace_name(slug, workspace_names)))
                .unwrap_or_else(|| "用户记忆".to_string());
            output.push_str(&format!(
                "### {} · {}\n\n#### {}\n\n{}\n\n",
                group,
                memory_kind_label(entry.kind),
                entry.title,
                entry.content,
            ));
        }
    }

    if !revisions.is_empty() {
        output.push_str("## 修订历史\n\n");
        for revision in revisions {
            output.push_str(&format!(
                "- `{}` v{} · {} · {}\n",
                revision.memory_id,
                revision.revision,
                operation_name(revision.operation),
                revision.created_at,
            ));
        }
        output.push('\n');
    }

    output
}

fn export_workspace_name(slug: &str, workspace_names: Option<&BTreeMap<String, String>>) -> String {
    let candidate = workspace_names
        .and_then(|names| names.get(slug))
        .map(|name| normalize_for_display(name))
        .filter(|name| !name.is_empty());
    candidate.unwrap_or_else(|| slug.to_string())
}

fn append_markdown_group(output: &mut String, title: &str, entries: &[&MemoryEntry]) {
    output.push_str(&format!("## {}\n\n", title));
    append_markdown_entries(output, entries);
}

fn append_markdown_entries(output: &mut String, entries: &[&MemoryEntry]) {
    if entries.is_empty() {
        output.push_str("_暂无条目。_\n\n");
        return;
    }

    let mut by_kind = BTreeMap::<String, Vec<&MemoryEntry>>::new();
    for entry in entries {
        by_kind
            .entry(memory_kind_label(entry.kind).to_string())
            .or_default()
            .push(*entry);
    }
    for (kind, kind_entries) in by_kind {
        output.push_str(&format!("### {}\n\n", kind));
        for entry in kind_entries {
            output.push_str(&format!("#### {}\n\n{}\n\n", entry.title, entry.content));
            if !entry.tags.is_empty() {
                output.push_str(&format!("标签：{}\n\n", entry.tags.join("、")));
            }
        }
    }
}

fn memory_kind_label(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Fact => "事实",
        MemoryKind::Preference => "偏好",
        MemoryKind::Decision => "决策",
        MemoryKind::Project => "项目",
        MemoryKind::Scratch => "草稿",
    }
}

fn export_scope_label(scope: MemoryExportScope) -> &'static str {
    match scope {
        MemoryExportScope::CurrentWorkspace => "当前项目",
        MemoryExportScope::AllWorkspaces => "全部项目",
        MemoryExportScope::User => "用户记忆",
    }
}

fn export_file_name(
    scope: MemoryExportScope,
    workspace_slug: Option<&str>,
    extension: &str,
) -> String {
    let target = match scope {
        MemoryExportScope::CurrentWorkspace => workspace_slug.unwrap_or("current").to_string(),
        MemoryExportScope::AllWorkspaces => "all-projects".to_string(),
        MemoryExportScope::User => "user".to_string(),
    };
    format!(
        "copis-memory-{}.{}",
        sanitize_export_component(&target),
        extension
    )
}

fn sanitize_export_component(value: &str) -> String {
    let sanitized: String = value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
                byte as char
            } else {
                '-'
            }
        })
        .collect();
    sanitized.trim_matches('-').to_string()
}

fn workspace_scope_key(workspace_slug: &str) -> String {
    format!("workspace:{}", workspace_slug)
}

fn expires_at_for(kind: MemoryKind, captured_at: u64) -> Option<u64> {
    (kind == MemoryKind::Scratch).then_some(captured_at.saturating_add(SCRATCH_RETENTION_MS))
}

fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, MemoryError> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(storage_error)?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&content)
        .map(Some)
        .map_err(storage_error)
}

fn read_json_lines<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>, MemoryError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(storage_error)?;
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(storage_error))
        .collect()
}

fn storage_error(error: impl fmt::Display) -> MemoryError {
    MemoryError::Storage(format!("记忆存储读写失败: {}", error))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
