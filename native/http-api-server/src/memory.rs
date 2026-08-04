use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_LIST_LIMIT: usize = 20;
pub const MAX_LIST_LIMIT: usize = 50;
pub const DEFAULT_RECALL_LIMIT: usize = 8;
pub const MAX_RECALL_LIMIT: usize = 8;

const MAX_TITLE_BYTES: usize = 512;
const MAX_CONTENT_BYTES: usize = 256 * 1024;
const MAX_TAGS: usize = 32;
const MAX_TAG_BYTES: usize = 128;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    User,
    Workspace,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Fact,
    Preference,
    Decision,
    Project,
    Scratch,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    Agent,
    User,
    Import,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryOperation {
    Capture,
    Rewrite,
    Restore,
    Archive,
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
    pub revision: u64,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRevision {
    pub memory_id: String,
    pub revision: u64,
    pub operation: MemoryOperation,
    pub snapshot: MemoryEntry,
    pub created_at: u64,
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureResponse {
    pub entry: MemoryEntry,
    pub deduplicated: bool,
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

#[derive(Clone, Debug)]
pub enum MemoryError {
    Validation(String),
    NotFound,
    Conflict(MemoryEntry),
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
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct MemoryState {
    entries: Vec<MemoryEntry>,
    revisions: Vec<MemoryRevision>,
}

pub struct MemoryStore {
    directory: PathBuf,
    state: Mutex<MemoryState>,
}

impl MemoryStore {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self, MemoryError> {
        let directory = directory.as_ref().to_path_buf();
        fs::create_dir_all(&directory).map_err(storage_error)?;
        let entries = read_json_file::<Vec<MemoryEntry>>(&directory.join("entries.json"))?
            .unwrap_or_default();
        let revisions = read_json_lines::<MemoryRevision>(&directory.join("revisions.jsonl"))?;
        Ok(Self {
            directory,
            state: Mutex::new(MemoryState { entries, revisions }),
        })
    }

    pub fn capture(&self, input: MemoryCaptureInput) -> Result<MemoryCaptureResponse, MemoryError> {
        let input = normalize_capture_input(input)?;
        let mut state = self.lock_state()?;
        let normalized_content = normalize_for_match(&input.content);
        if let Some(entry) = state.entries.iter().find(|entry| {
            !entry.archived
                && same_scope(entry, &input.scope, input.workspace_slug.as_deref())
                && normalize_for_match(&entry.content) == normalized_content
        }) {
            return Ok(MemoryCaptureResponse {
                entry: entry.clone(),
                deduplicated: true,
            });
        }

        let now = now_millis();
        let entry = MemoryEntry {
            id: format!("memory-{}-{}", now, NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            scope: input.scope,
            workspace_slug: input.workspace_slug,
            kind: input.kind,
            title: input.title,
            content: input.content,
            tags: input.tags,
            source: input.source,
            created_at: now,
            updated_at: now,
            revision: 1,
            archived: false,
        };
        let previous = state.clone();
        state.entries.push(entry.clone());
        push_revision(&mut state, &entry, MemoryOperation::Capture);
        if let Err(error) = self.persist_state(&state) {
            *state = previous;
            return Err(error);
        }

        Ok(MemoryCaptureResponse {
            entry,
            deduplicated: false,
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

        let state = self.lock_state()?;
        let mut entries: Vec<MemoryEntry> = state
            .entries
            .iter()
            .filter(|entry| is_visible(entry, workspace_slug))
            .filter(|entry| include_archived || !entry.archived)
            .filter(|entry| scope.as_ref().is_none_or(|value| &entry.scope == value))
            .filter(|entry| kind.as_ref().is_none_or(|value| &entry.kind == value))
            .filter(|entry| {
                query
                    .as_deref()
                    .is_none_or(|value| matches_query(entry, value))
            })
            .cloned()
            .collect();
        entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let total = entries.len();
        entries.truncate(limit);
        Ok(MemoryListResponse {
            entries,
            total,
            limit,
        })
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

    pub fn get(&self, id: &str, workspace_slug: Option<&str>) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let state = self.lock_state()?;
        state
            .entries
            .iter()
            .find(|entry| entry.id == id && is_visible(entry, workspace_slug))
            .cloned()
            .ok_or(MemoryError::NotFound)
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
        let title = input.title.map(|value| validate_title(value)).transpose()?;
        let content = input
            .content
            .map(|value| validate_content(value))
            .transpose()?;
        let tags = input.tags.map(validate_tags).transpose()?;
        let mut state = self.lock_state()?;
        let index = state
            .entries
            .iter()
            .position(|entry| entry.id == id && is_visible(entry, input.workspace_slug.as_deref()))
            .ok_or(MemoryError::NotFound)?;
        if state.entries[index].archived {
            return Err(MemoryError::NotFound);
        }
        if state.entries[index].revision != input.expected_revision {
            return Err(MemoryError::Conflict(state.entries[index].clone()));
        }

        let previous = state.clone();
        let entry = &mut state.entries[index];
        if let Some(title) = title {
            entry.title = title;
        }
        if let Some(content) = content {
            entry.content = content;
        }
        if let Some(kind) = input.kind {
            entry.kind = kind;
        }
        if let Some(tags) = tags {
            entry.tags = tags;
        }
        entry.updated_at = now_millis();
        entry.revision += 1;
        let updated = entry.clone();
        push_revision(&mut state, &updated, MemoryOperation::Rewrite);
        if let Err(error) = self.persist_state(&state) {
            *state = previous;
            return Err(error);
        }
        Ok(updated)
    }

    pub fn archive(
        &self,
        id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let mut state = self.lock_state()?;
        let index = state
            .entries
            .iter()
            .position(|entry| entry.id == id && is_visible(entry, workspace_slug))
            .ok_or(MemoryError::NotFound)?;
        if state.entries[index].archived {
            return Err(MemoryError::NotFound);
        }

        let previous = state.clone();
        let entry = &mut state.entries[index];
        entry.archived = true;
        entry.updated_at = now_millis();
        entry.revision += 1;
        let archived = entry.clone();
        push_revision(&mut state, &archived, MemoryOperation::Archive);
        if let Err(error) = self.persist_state(&state) {
            *state = previous;
            return Err(error);
        }
        Ok(archived)
    }

    pub fn history(
        &self,
        id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<Vec<MemoryRevision>, MemoryError> {
        let entry = self.get(id, workspace_slug)?;
        let state = self.lock_state()?;
        let mut revisions: Vec<MemoryRevision> = state
            .revisions
            .iter()
            .filter(|revision| revision.memory_id == entry.id)
            .cloned()
            .collect();
        revisions.sort_by(|left, right| right.revision.cmp(&left.revision));
        Ok(revisions)
    }

    pub fn restore(&self, id: &str, input: MemoryRestoreInput) -> Result<MemoryEntry, MemoryError> {
        validate_workspace_context(input.workspace_slug.as_deref())?;
        if input.revision == 0 {
            return Err(MemoryError::Validation("revision 必须大于 0".to_string()));
        }
        let mut state = self.lock_state()?;
        let index = state
            .entries
            .iter()
            .position(|entry| entry.id == id && is_visible(entry, input.workspace_slug.as_deref()))
            .ok_or(MemoryError::NotFound)?;
        let snapshot = state
            .revisions
            .iter()
            .find(|revision| revision.memory_id == id && revision.revision == input.revision)
            .map(|revision| revision.snapshot.clone())
            .ok_or(MemoryError::NotFound)?;

        let previous = state.clone();
        let current_revision = state.entries[index].revision;
        let entry = &mut state.entries[index];
        entry.kind = snapshot.kind;
        entry.title = snapshot.title;
        entry.content = snapshot.content;
        entry.tags = snapshot.tags;
        entry.source = snapshot.source;
        entry.archived = false;
        entry.updated_at = now_millis();
        entry.revision = current_revision + 1;
        let restored = entry.clone();
        push_revision(&mut state, &restored, MemoryOperation::Restore);
        if let Err(error) = self.persist_state(&state) {
            *state = previous;
            return Err(error);
        }
        Ok(restored)
    }

    pub fn stats(&self, workspace_slug: Option<&str>) -> Result<MemoryStats, MemoryError> {
        validate_workspace_context(workspace_slug)?;
        let state = self.lock_state()?;
        let mut stats = MemoryStats {
            user_count: 0,
            workspace_count: 0,
            archived_count: 0,
        };
        for entry in state
            .entries
            .iter()
            .filter(|entry| is_visible(entry, workspace_slug))
        {
            if entry.archived {
                stats.archived_count += 1;
            } else if entry.scope == MemoryScope::User {
                stats.user_count += 1;
            } else {
                stats.workspace_count += 1;
            }
        }
        Ok(stats)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, MemoryState>, MemoryError> {
        self.state
            .lock()
            .map_err(|_| MemoryError::Storage("记忆存储锁已损坏".to_string()))
    }

    fn persist_state(&self, state: &MemoryState) -> Result<(), MemoryError> {
        let entries = serde_json::to_vec_pretty(&state.entries).map_err(storage_error)?;
        let revisions = state
            .revisions
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map(|lines| {
                if lines.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", lines.join("\n"))
                }
            })
            .map_err(storage_error)?;
        write_atomic(&self.directory.join("entries.json"), &entries).map_err(storage_error)?;
        write_atomic(
            self.directory.join("revisions.jsonl").as_path(),
            revisions.as_bytes(),
        )
        .map_err(storage_error)
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

fn matches_query(entry: &MemoryEntry, query: &str) -> bool {
    let haystack = normalize_for_match(&format!(
        "{} {} {}",
        entry.title,
        entry.content,
        entry.tags.join(" ")
    ));
    query.split_whitespace().all(|word| haystack.contains(word))
}

fn same_scope(entry: &MemoryEntry, scope: &MemoryScope, workspace_slug: Option<&str>) -> bool {
    &entry.scope == scope && entry.workspace_slug.as_deref() == workspace_slug
}

fn is_visible(entry: &MemoryEntry, workspace_slug: Option<&str>) -> bool {
    match entry.scope {
        MemoryScope::User => true,
        MemoryScope::Workspace => entry.workspace_slug.as_deref() == workspace_slug,
    }
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
        scope: entry.scope.clone(),
        workspace_slug: entry.workspace_slug.clone(),
        kind: entry.kind.clone(),
        title: entry.title.clone(),
        excerpt,
        tags: entry.tags.clone(),
        updated_at: entry.updated_at,
        revision: entry.revision,
    }
}

fn push_revision(state: &mut MemoryState, entry: &MemoryEntry, operation: MemoryOperation) {
    state.revisions.push(MemoryRevision {
        memory_id: entry.id.clone(),
        revision: entry.revision,
        operation,
        snapshot: entry.clone(),
        created_at: now_millis(),
    });
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

fn write_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    let temp_path = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let write_result = (|| {
        let mut file = File::create(&temp_path)?;
        file.write_all(content)?;
        file.sync_all()?;
        match fs::rename(&temp_path, path) {
            Ok(()) => Ok(()),
            Err(error) if path.exists() => {
                fs::remove_file(path)?;
                fs::rename(&temp_path, path).map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
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
mod tests {
    use super::*;
    use std::fs;

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
    fn empty_notebook_capture_persists_entries_with_revision_one() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let result = store
            .capture(workspace_capture("project-a", "Rust API"))
            .unwrap();

        assert_eq!(result.entry.revision, 1);
        let entries: Vec<MemoryEntry> =
            serde_json::from_str(&fs::read_to_string(directory.0.join("entries.json")).unwrap())
                .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, result.entry.id);
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
                title: Some("不应覆盖".to_string()),
                content: None,
                kind: None,
                tags: None,
                expected_revision: 0,
            },
        );
        assert!(matches!(result, Err(MemoryError::Conflict(_))));
        assert_eq!(
            store.get(&captured.entry.id, None).unwrap().title,
            "用户偏好"
        );
    }

    #[test]
    fn restore_旧_revision_会创建新_revision并保留历史() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("第一版")).unwrap();
        let rewritten = store
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
                &captured.entry.id,
                MemoryRestoreInput {
                    workspace_slug: None,
                    revision: 1,
                },
            )
            .unwrap();

        assert_eq!(rewritten.revision, 2);
        assert_eq!(restored.revision, 3);
        assert_eq!(restored.content, "第一版");
        assert_eq!(store.history(&captured.entry.id, None).unwrap().len(), 3);
    }

    #[test]
    fn archived_entries_are_hidden_unless_requested() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("待归档")).unwrap();
        store.archive(&captured.entry.id, None).unwrap();

        assert!(store
            .list(None, None, None, None, false, 20)
            .unwrap()
            .entries
            .is_empty());
        let archived = store
            .list(None, None, None, None, true, 20)
            .unwrap()
            .entries;
        assert_eq!(archived.len(), 1);
        assert!(archived[0].archived);
    }

    #[test]
    fn 重新打开同一目录可以恢复_entries和_revisions() {
        let directory = TestDirectory::new();
        let store = MemoryStore::open(&directory.0).unwrap();
        let captured = store.capture(user_capture("重启后仍在")).unwrap();
        drop(store);

        let reopened = MemoryStore::open(&directory.0).unwrap();
        assert_eq!(
            reopened.get(&captured.entry.id, None).unwrap().content,
            "重启后仍在"
        );
        assert_eq!(reopened.history(&captured.entry.id, None).unwrap().len(), 1);
    }
}
