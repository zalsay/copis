use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

const DEFAULT_BACKEND_URL: &str = "https://edu-api.meetlife.com.cn:9001";
const MAX_PACKAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: usize = 50 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 512;
const MAX_REMOTE_BODY_BYTES: u64 = 10 * 1024 * 1024;
const MARKET_SOURCE_FILE: &str = ".market.json";

#[derive(Debug, PartialEq, Eq)]
pub enum SkillMarketRoute {
    List {
        workspace_slug: String,
    },
    Install {
        workspace_slug: String,
        skill_id: String,
    },
    Uninstall {
        workspace_slug: String,
        skill_id: String,
    },
}

#[derive(Debug)]
pub struct SkillMarketError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl SkillMarketError {
    pub(crate) fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}

pub struct SkillMarketResponse {
    pub status: u16,
    pub body: Option<Value>,
}

pub struct SkillMarketState {
    access_token: Mutex<Option<String>>,
    install_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

#[cfg(test)]
pub(crate) fn backend_env_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

impl SkillMarketState {
    pub fn new(initial_token: Option<String>) -> Self {
        Self {
            access_token: Mutex::new(initial_token.filter(|value| !value.trim().is_empty())),
            install_locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_access_token(&self, token: Option<String>) {
        *self.access_token.lock().unwrap() = token.filter(|value| !value.trim().is_empty());
    }

    pub(crate) fn access_token(&self) -> Option<String> {
        self.access_token.lock().unwrap().clone()
    }

    fn install_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.install_locks.lock().unwrap();
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[derive(Debug, Clone)]
struct LocalMarketSkill {
    id: Value,
    slug: String,
    version: String,
}

#[derive(Debug, Clone)]
struct RuntimeSkillPackage {
    slug: String,
    name: String,
    description: String,
    version: String,
    instructions: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size: Option<usize>,
}

pub fn parse_skill_market_route(method: &str, target: &str) -> Result<SkillMarketRoute, String> {
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let parts: Vec<&str> = raw_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 3 || parts[0] != "api" || parts[1] != "working" || parts[2] != "skill-market" {
        return Err("技能市场路由不存在".to_string());
    }

    let workspace_slug = query_value(raw_query, "workspaceSlug")
        .ok_or_else(|| "工作区 slug 不能为空".to_string())?;
    validate_workspace_slug(&workspace_slug)?;

    match (method, parts.as_slice()) {
        ("GET", ["api", "working", "skill-market"]) => {
            Ok(SkillMarketRoute::List { workspace_slug })
        }
        ("POST", ["api", "working", "skill-market", skill_id, "install"]) => {
            Ok(SkillMarketRoute::Install {
                workspace_slug,
                skill_id: percent_decode(skill_id)?,
            })
        }
        ("DELETE", ["api", "working", "skill-market", skill_id, "install"]) => {
            Ok(SkillMarketRoute::Uninstall {
                workspace_slug,
                skill_id: percent_decode(skill_id)?,
            })
        }
        _ => Err("技能市场请求方法不支持".to_string()),
    }
}

pub fn validate_skill_slug(slug: &str) -> Result<(), String> {
    let value = slug.trim();
    if value.is_empty() || value.len() > 96 {
        return Err("技能 slug 无效".to_string());
    }
    let bytes = value.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return Err("技能 slug 无效".to_string());
    }
    let mut previous_dash = false;
    for byte in bytes {
        if *byte == b'-' {
            if previous_dash {
                return Err("技能 slug 无效".to_string());
            }
            previous_dash = true;
        } else if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_dash = false;
        } else {
            return Err("技能 slug 无效".to_string());
        }
    }
    Ok(())
}

pub fn handle_request(
    state: &SkillMarketState,
    method: &str,
    target: &str,
    _body: &[u8],
) -> Result<SkillMarketResponse, SkillMarketError> {
    let route = parse_skill_market_route(method, target)
        .map_err(|message| SkillMarketError::new(400, "invalid_skill_market_request", message))?;
    let token = state
        .access_token()
        .ok_or_else(|| SkillMarketError::new(401, "unauthorized", "请先登录 Copis Working"))?;

    match route {
        SkillMarketRoute::List { workspace_slug } => list_market(state, &token, &workspace_slug),
        SkillMarketRoute::Install {
            workspace_slug,
            skill_id,
        } => install_market(state, &token, &workspace_slug, &skill_id),
        SkillMarketRoute::Uninstall {
            workspace_slug,
            skill_id,
        } => uninstall_market(state, &token, &workspace_slug, &skill_id),
    }
}

pub fn extract_skill_archive(archive: &[u8], destination: &Path) -> Result<PathBuf, String> {
    if archive.is_empty() || archive.len() > MAX_PACKAGE_BYTES {
        return Err("技能包大小无效".to_string());
    }
    fs::create_dir_all(destination).map_err(|_| "创建技能包临时目录失败".to_string())?;
    let mut zip =
        ZipArchive::new(Cursor::new(archive)).map_err(|_| "技能包不是有效 ZIP".to_string())?;
    if zip.is_empty() || zip.len() > MAX_PACKAGE_FILES {
        return Err("技能包文件数量无效".to_string());
    }

    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    let mut skill_files = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|_| "读取技能包条目失败".to_string())?;
        let normalized = normalize_archive_entry(entry.name())?;
        if !seen.insert(normalized.clone()) {
            return Err("技能包包含重复路径".to_string());
        }
        if entry.is_symlink() {
            return Err("技能包不允许软链接".to_string());
        }

        let declared_size = usize::try_from(entry.size()).unwrap_or(usize::MAX);
        if declared_size > MAX_UNCOMPRESSED_BYTES.saturating_sub(total_bytes) {
            return Err("技能包解压后过大".to_string());
        }

        let target = destination.join(&normalized);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|_| "创建技能包目录失败".to_string())?;
            continue;
        }

        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|_| "读取技能包文件失败".to_string())?;
        total_bytes = total_bytes.saturating_add(data.len());
        if total_bytes > MAX_UNCOMPRESSED_BYTES {
            return Err("技能包解压后过大".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "创建技能包父目录失败".to_string())?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "写入技能包文件失败".to_string())?;
        file.write_all(&data)
            .map_err(|_| "写入技能包文件失败".to_string())?;
        if target
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("skill.md"))
            .unwrap_or(false)
        {
            skill_files.push(target);
        }
    }

    if skill_files.len() != 1 {
        return Err(if skill_files.is_empty() {
            "技能包缺少 SKILL.md".to_string()
        } else {
            "技能包必须只包含一个 Skill 根目录".to_string()
        });
    }
    let skill_md = skill_files.remove(0);
    let root = skill_md
        .parent()
        .ok_or_else(|| "技能包根目录无效".to_string())?
        .to_path_buf();
    let canonical = root.join("SKILL.md");
    if skill_md != canonical {
        fs::rename(&skill_md, &canonical).map_err(|_| "规范化 SKILL.md 文件名失败".to_string())?;
    }
    Ok(root)
}

fn list_market(
    _state: &SkillMarketState,
    token: &str,
    workspace_slug: &str,
) -> Result<SkillMarketResponse, SkillMarketError> {
    ensure_workspace(workspace_slug)?;
    let remote = remote_json("GET", "/api/working/expert-skills", token, None)?;
    let items = remote.as_array().ok_or_else(|| {
        SkillMarketError::new(
            502,
            "invalid_skill_market_response",
            "技能市场响应格式不正确",
        )
    })?;
    let local = scan_local_market_skills(workspace_slug)?;
    let body = items
        .iter()
        .map(|item| merge_local_status(item, &local))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SkillMarketResponse {
        status: 200,
        body: Some(Value::Array(body)),
    })
}

fn install_market(
    state: &SkillMarketState,
    token: &str,
    workspace_slug: &str,
    skill_id: &str,
) -> Result<SkillMarketResponse, SkillMarketError> {
    ensure_workspace(workspace_slug)?;
    if skill_id.trim().is_empty() {
        return Err(SkillMarketError::new(
            400,
            "invalid_skill_id",
            "技能市场 ID 不能为空",
        ));
    }
    let lock = state.install_lock(&format!("{}:{}", workspace_slug, skill_id));
    let _guard = lock.lock().unwrap();

    // 记录安装前本地是否已存在该 Skill，用于失败回滚时判断远端安装是否需要撤销
    let had_local = find_local_market_skill(workspace_slug, skill_id)
        .map(|path| path.is_some())
        .unwrap_or(false);

    let path = format!(
        "/api/working/expert-skills/{}/install",
        encode_path_component(skill_id)
    );
    let market_skill = remote_json("POST", &path, token, Some("{}"))?;
    let slug = string_value(&market_skill, &["slug"]).ok_or_else(|| {
        SkillMarketError::new(502, "invalid_skill_response", "安装响应缺少 Skill slug")
    })?;
    validate_skill_slug(&slug)
        .map_err(|message| SkillMarketError::new(502, "invalid_skill_response", message))?;

    let install_result = (|| -> Result<Value, SkillMarketError> {
        let runtime_payload =
            remote_json("GET", "/api/working/expert-skills/runtime", token, None)?;
        let runtime_items = runtime_payload.as_array().ok_or_else(|| {
            SkillMarketError::new(
                502,
                "invalid_skill_response",
                "Working runtime 响应格式不正确",
            )
        })?;
        let runtime = runtime_items
            .iter()
            .find(|item| string_value(item, &["slug"]).as_deref() == Some(slug.as_str()))
            .map(runtime_package);
        let runtime = runtime.ok_or_else(|| {
            SkillMarketError::new(
                502,
                "runtime_skill_not_found",
                format!("Working runtime 未返回已安装 Skill: {}", slug),
            )
        })?;

        let archive = match runtime.download_url.as_deref() {
            Some(url) => Some(download_archive(
                url,
                runtime.size,
                runtime.sha256.as_deref(),
            )?),
            None => None,
        };
        install_into_workspace(workspace_slug, &market_skill, &runtime, archive.as_deref())
    })();
    let meta = match install_result {
        Ok(meta) => meta,
        Err(error) => {
            // 远端安装已成功而本地安装失败：若此前本地没有该 Skill 且其他工作区也没有，
            // 回滚远端安装状态，避免两端不一致；无法判断时保守不回滚。
            let other_workspace_has =
                market_skill_in_other_workspace(workspace_slug, skill_id).unwrap_or(true);
            if !had_local && !other_workspace_has {
                match remote_json("DELETE", &path, token, None) {
                    Ok(_) => eprintln!("[skill-market] 本地安装失败，已回滚远端安装状态: {}", slug),
                    Err(rollback_error) => eprintln!(
                        "[skill-market] 本地安装失败且远端回滚失败: {} ({})",
                        rollback_error.message, rollback_error.code
                    ),
                }
            }
            return Err(error);
        }
    };
    Ok(SkillMarketResponse {
        status: 200,
        body: Some(meta),
    })
}

fn uninstall_market(
    state: &SkillMarketState,
    token: &str,
    workspace_slug: &str,
    skill_id: &str,
) -> Result<SkillMarketResponse, SkillMarketError> {
    ensure_workspace(workspace_slug)?;
    if skill_id.trim().is_empty() {
        return Err(SkillMarketError::new(
            400,
            "invalid_skill_id",
            "技能市场 ID 不能为空",
        ));
    }
    let lock = state.install_lock(&format!("{}:{}", workspace_slug, skill_id));
    let _guard = lock.lock().unwrap();

    remove_local_market_skill(workspace_slug, skill_id)?;
    if !market_skill_in_other_workspace(workspace_slug, skill_id)? {
        let path = format!(
            "/api/working/expert-skills/{}/install",
            encode_path_component(skill_id)
        );
        remote_json("DELETE", &path, token, None)?;
    }
    Ok(SkillMarketResponse {
        status: 204,
        body: None,
    })
}

fn runtime_package(value: &Value) -> RuntimeSkillPackage {
    RuntimeSkillPackage {
        slug: string_value(value, &["slug"]).unwrap_or_default(),
        name: string_value(value, &["name"]).unwrap_or_default(),
        description: string_value(value, &["description"]).unwrap_or_default(),
        version: string_value(value, &["version"]).unwrap_or_else(|| "1.0.0".to_string()),
        instructions: string_value(value, &["instructions"]).unwrap_or_default(),
        download_url: string_value(value, &["download_url", "downloadUrl"]),
        sha256: string_value(value, &["sha256"]),
        size: number_value(value, &["size"]),
    }
}

fn install_into_workspace(
    workspace_slug: &str,
    market_skill: &Value,
    runtime: &RuntimeSkillPackage,
    archive: Option<&[u8]>,
) -> Result<Value, SkillMarketError> {
    let slug = string_value(market_skill, &["slug"]).unwrap_or_else(|| runtime.slug.clone());
    validate_skill_slug(&slug)
        .map_err(|message| SkillMarketError::new(502, "invalid_skill_response", message))?;
    if !runtime.slug.is_empty() && runtime.slug != slug {
        return Err(SkillMarketError::new(
            502,
            "invalid_skill_response",
            "市场 Skill slug 不一致",
        ));
    }

    let workspace_root = workspace_dir(workspace_slug)?;
    let active_dir = workspace_root.join(".agents").join("skills");
    let inactive_dir = workspace_root.join(".agents").join("skills-inactive");
    let legacy_active_dir = workspace_root.join("skills");
    let legacy_inactive_dir = workspace_root.join("skills-inactive");
    let active_path = active_dir.join(&slug);
    let inactive_path = inactive_dir.join(&slug);
    let legacy_active_path = legacy_active_dir.join(&slug);
    let legacy_inactive_path = legacy_inactive_dir.join(&slug);

    let existing = [
        (&active_path, true),
        (&inactive_path, false),
        (&legacy_active_path, true),
        (&legacy_inactive_path, false),
    ]
    .into_iter()
    .find(|(path, _)| path.exists());
    if let Some((path, _)) = existing {
        if read_market_source(path).is_none() {
            return Err(SkillMarketError::new(
                409,
                "skill_name_conflict",
                format!("当前项目已存在同名本地 Skill: {}", slug),
            ));
        }
    }

    let (target_parent, enabled) = match existing {
        Some((path, enabled)) => (path.parent().unwrap_or(&active_dir).to_path_buf(), enabled),
        None => (active_dir.clone(), true),
    };
    fs::create_dir_all(&target_parent)
        .map_err(|_| SkillMarketError::new(500, "skill_install_failed", "创建 Skill 目录失败"))?;
    let target = target_parent.join(&slug);
    let temporary = target_parent.join(format!(".copis-market-skill-{}", unique_suffix()));
    if temporary.exists() {
        remove_path(&temporary)?;
    }

    let install_result = (|| -> Result<Value, SkillMarketError> {
        let extracted_root = if let Some(data) = archive {
            extract_skill_archive(data, &temporary)
                .map_err(|message| SkillMarketError::new(422, "invalid_skill_package", message))?
        } else {
            fs::create_dir_all(&temporary).map_err(|_| {
                SkillMarketError::new(500, "skill_install_failed", "创建临时 Skill 目录失败")
            })?;
            if runtime.instructions.trim().is_empty() {
                return Err(SkillMarketError::new(
                    422,
                    "invalid_skill_package",
                    format!("技能 {} 没有可安装的 instructions", slug),
                ));
            }
            let markdown = format_generated_skill_markdown(market_skill, runtime, &slug);
            fs::write(temporary.join("SKILL.md"), markdown).map_err(|_| {
                SkillMarketError::new(500, "skill_install_failed", "写入 Skill 文件失败")
            })?;
            temporary.clone()
        };

        let source = json!({
            "id": market_skill.get("id").cloned().unwrap_or(Value::String(String::new())),
            "slug": slug,
            "version": runtime.version,
            "sourceProvider": string_value(market_skill, &["sourceProvider", "source_provider"]).unwrap_or_else(|| "platform".to_string()),
            "installedAt": now_iso_like(),
        });
        let backup =
            target_parent.join(format!("{}.copis-market-backup-{}", slug, unique_suffix()));
        if target.exists() {
            fs::rename(&target, &backup).map_err(|_| {
                SkillMarketError::new(500, "skill_install_failed", "备份现有 Skill 失败")
            })?;
        }
        let replace_result = (|| -> Result<(), SkillMarketError> {
            fs::rename(&extracted_root, &target).map_err(|_| {
                SkillMarketError::new(500, "skill_install_failed", "替换 Skill 目录失败")
            })?;
            fs::write(
                target.join(MARKET_SOURCE_FILE),
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&source).unwrap_or_default()
                ),
            )
            .map_err(|_| {
                SkillMarketError::new(500, "skill_install_failed", "写入 Skill 来源标记失败")
            })?;
            if backup.exists() {
                remove_path(&backup)?;
            }
            Ok(())
        })();
        if let Err(error) = replace_result {
            if target.exists() {
                let _ = remove_path(&target);
            }
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error);
        }

        Ok(json!({
            "slug": slug,
            "name": string_value(market_skill, &["name"]).unwrap_or_else(|| runtime.name.clone()),
            "description": string_value(market_skill, &["description"]).unwrap_or_else(|| runtime.description.clone()),
            "version": runtime.version,
            "enabled": enabled,
            "marketSource": source,
        }))
    })();
    let _ = if temporary.exists() {
        remove_path(&temporary)
    } else {
        Ok(())
    };
    install_result
}

fn list_workspace_slugs() -> Result<Vec<String>, SkillMarketError> {
    let path = config_dir()?.join("agent-workspaces.json");
    let content = fs::read_to_string(path).map_err(|_| {
        SkillMarketError::new(500, "workspace_index_unavailable", "读取工作区索引失败")
    })?;
    let value: Value = serde_json::from_str(&content).map_err(|_| {
        SkillMarketError::new(500, "workspace_index_invalid", "工作区索引格式不正确")
    })?;
    Ok(value
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("slug").and_then(Value::as_str).map(str::to_string))
        .collect())
}

fn ensure_workspace(slug: &str) -> Result<(), SkillMarketError> {
    validate_workspace_slug(slug)
        .map_err(|message| SkillMarketError::new(400, "invalid_workspace_slug", message))?;
    if !list_workspace_slugs()?.iter().any(|item| item == slug) {
        return Err(SkillMarketError::new(
            404,
            "workspace_not_found",
            "工作区不存在",
        ));
    }
    Ok(())
}

fn workspace_dir(slug: &str) -> Result<PathBuf, SkillMarketError> {
    ensure_workspace(slug)?;
    Ok(config_dir()?.join("agent-workspaces").join(slug))
}

fn config_dir() -> Result<PathBuf, SkillMarketError> {
    std::env::var("COPIS_CONFIG_DIR")
        .map(PathBuf::from)
        .map_err(|_| SkillMarketError::new(500, "config_dir_unavailable", "Copis 配置目录未设置"))
}

fn scan_local_market_skills(
    workspace_slug: &str,
) -> Result<Vec<LocalMarketSkill>, SkillMarketError> {
    let root = workspace_dir(workspace_slug)?;
    let directories = [
        root.join(".agents").join("skills"),
        root.join(".agents").join("skills-inactive"),
        root.join("skills"),
        root.join("skills-inactive"),
    ];
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for directory in directories {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(source) = read_market_source(&path) else {
                continue;
            };
            let slug = source
                .get("slug")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if slug.is_empty() || !seen.insert(slug.clone()) {
                continue;
            }
            results.push(LocalMarketSkill {
                id: source.get("id").cloned().unwrap_or(Value::Null),
                slug,
                version: source
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    Ok(results)
}

fn merge_local_status(item: &Value, local: &[LocalMarketSkill]) -> Result<Value, SkillMarketError> {
    let mut object = item.as_object().cloned().ok_or_else(|| {
        SkillMarketError::new(
            502,
            "invalid_skill_market_response",
            "技能市场返回项格式不正确",
        )
    })?;
    let slug = string_value(item, &["slug"]).unwrap_or_default();
    let id = item
        .get("id")
        .or_else(|| item.get("ID"))
        .cloned()
        .unwrap_or(Value::Null);
    let local_skill = local
        .iter()
        .find(|entry| entry.slug == slug || same_id(&entry.id, &id));
    object.insert(
        "localInstalled".to_string(),
        Value::Bool(local_skill.is_some()),
    );
    if let Some(skill) = local_skill {
        object.insert(
            "localVersion".to_string(),
            Value::String(skill.version.clone()),
        );
    } else {
        object.remove("localVersion");
    }
    Ok(Value::Object(object))
}

fn remove_local_market_skill(workspace_slug: &str, skill_id: &str) -> Result<(), SkillMarketError> {
    if let Some(path) = find_local_market_skill(workspace_slug, skill_id)? {
        remove_path(&path)?;
    }
    Ok(())
}

fn find_local_market_skill(
    workspace_slug: &str,
    skill_id: &str,
) -> Result<Option<PathBuf>, SkillMarketError> {
    let root = workspace_dir(workspace_slug)?;
    for directory in [
        root.join(".agents").join("skills"),
        root.join(".agents").join("skills-inactive"),
        root.join("skills"),
        root.join("skills-inactive"),
    ] {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(source) = read_market_source(&path) else {
                continue;
            };
            if source
                .get("id")
                .map(|value| same_id(value, &Value::String(skill_id.to_string())))
                .unwrap_or(false)
            {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn market_skill_in_other_workspace(
    current_slug: &str,
    skill_id: &str,
) -> Result<bool, SkillMarketError> {
    for slug in list_workspace_slugs()? {
        if slug == current_slug {
            continue;
        }
        if find_local_market_skill(&slug, skill_id)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_market_source(skill_dir: &Path) -> Option<Value> {
    let content = fs::read_to_string(skill_dir.join(MARKET_SOURCE_FILE)).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let object = value.as_object()?;
    if object
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty()
        || object
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
    {
        return None;
    }
    Some(value)
}

fn download_archive(
    url: &str,
    expected_size: Option<usize>,
    expected_sha: Option<&str>,
) -> Result<Vec<u8>, SkillMarketError> {
    let parsed = url.trim();
    if !(parsed.starts_with("https://") || is_local_http_url(parsed)) {
        return Err(SkillMarketError::new(
            422,
            "invalid_download_url",
            "技能下载地址必须使用 HTTPS",
        ));
    }
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent
        .get(parsed)
        .header("Accept", "application/octet-stream")
        .call()
        .map_err(|error| {
            SkillMarketError::new(
                502,
                "skill_download_failed",
                format!("技能包下载失败: {}", error),
            )
        })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(SkillMarketError::new(
            502,
            "skill_download_failed",
            format!("技能包下载失败（HTTP {}）", status),
        ));
    }
    let data = response
        .body_mut()
        .with_config()
        .limit(MAX_PACKAGE_BYTES as u64)
        .read_to_vec()
        .map_err(|error| {
            SkillMarketError::new(
                502,
                "skill_download_failed",
                format!("读取技能包失败: {}", error),
            )
        })?;
    if data.is_empty() || data.len() > MAX_PACKAGE_BYTES {
        return Err(SkillMarketError::new(
            422,
            "invalid_skill_package",
            "技能包大小无效",
        ));
    }
    if let Some(size) = expected_size.filter(|value| *value > 0) {
        if data.len() != size {
            return Err(SkillMarketError::new(
                422,
                "invalid_skill_package",
                "技能包大小校验失败",
            ));
        }
    }
    if let Some(expected) = expected_sha.filter(|value| !value.trim().is_empty()) {
        let expected = expected.to_ascii_lowercase();
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(SkillMarketError::new(
                422,
                "invalid_skill_package",
                "技能包 SHA-256 格式无效",
            ));
        }
        let actual = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{:02x}", byte))
            .collect::<String>();
        if actual != expected {
            return Err(SkillMarketError::new(
                422,
                "invalid_skill_package",
                "技能包 SHA-256 校验失败",
            ));
        }
    }
    Ok(data)
}

fn is_local_http_url(value: &str) -> bool {
    let Some(authority) = value
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
    else {
        return false;
    };
    let host = authority
        .strip_prefix('[')
        .and_then(|rest| rest.split(']').next())
        .or_else(|| authority.rsplit_once(':').map(|(host, _)| host))
        .unwrap_or(authority);
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

pub(crate) fn remote_json(
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
) -> Result<Value, SkillMarketError> {
    Ok(unwrap_data(remote_json_raw(method, path, token, body)?))
}

pub(crate) fn remote_json_raw(
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
) -> Result<Value, SkillMarketError> {
    let base = std::env::var("COPIS_BACKEND_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}{}", base, path);
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = match method {
        "GET" => agent
            .get(&url)
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .call(),
        "POST" => agent
            .post(&url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .send(body.unwrap_or("{}")),
        "DELETE" => agent
            .delete(&url)
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .call(),
        _ => {
            return Err(SkillMarketError::new(
                405,
                "method_not_allowed",
                "技能市场请求方法不支持",
            ))
        }
    }
    .map_err(|error| {
        SkillMarketError::new(
            502,
            "working_backend_unavailable",
            format!("Working 后端请求失败: {}", error),
        )
    })?;

    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_REMOTE_BODY_BYTES)
        .read_to_string()
        .map_err(|error| {
            SkillMarketError::new(
                502,
                "working_backend_unavailable",
                format!("读取 Working 响应失败: {}", error),
            )
        })?;
    let payload = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()))
    };
    if !(200..300).contains(&status) {
        return Err(remote_error(status, &payload));
    }
    Ok(payload)
}

fn remote_error(status: u16, payload: &Value) -> SkillMarketError {
    let message = string_value(payload, &["error", "message"])
        .unwrap_or_else(|| format!("Working 后端请求失败（HTTP {}）", status));
    let code =
        string_value(payload, &["code"]).unwrap_or_else(|| "working_backend_error".to_string());
    SkillMarketError::new(status, code, message)
}

fn unwrap_data(value: Value) -> Value {
    if let Some(data) = value.get("data") {
        data.clone()
    } else {
        value
    }
}

fn format_generated_skill_markdown(
    market: &Value,
    runtime: &RuntimeSkillPackage,
    slug: &str,
) -> String {
    let description = string_value(market, &["description"])
        .unwrap_or_else(|| runtime.description.clone())
        .replace(['\r', '\n'], " ");
    let name = string_value(market, &["name"])
        .unwrap_or_else(|| runtime.name.clone())
        .replace(['\r', '\n'], " ");
    format!(
        "---\nname: {}\ndescription: {:?}\nmetadata:\n  version: {:?}\n---\n\n# {}\n\n{}\n",
        slug,
        description,
        runtime.version,
        if name.is_empty() { slug } else { &name },
        runtime.instructions.trim(),
    )
}

fn normalize_archive_entry(name: &str) -> Result<String, String> {
    let raw = name.replace('\\', "/");
    if raw.is_empty() || raw.starts_with('/') {
        return Err("技能包包含不安全路径".to_string());
    }
    let mut parts = Vec::new();
    for segment in raw.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err("技能包包含不安全路径".to_string());
        }
        parts.push(segment);
    }
    if parts.is_empty() {
        return Err("技能包包含不安全路径".to_string());
    }
    let joined = parts.join("/");
    let path = Path::new(&joined);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("技能包包含不安全路径".to_string());
    }
    Ok(parts.join("/"))
}

fn validate_workspace_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.len() > 128 || slug == "." || slug == ".." {
        return Err("工作区 slug 不正确".to_string());
    }
    if !slug
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("工作区 slug 不正确".to_string());
    }
    Ok(())
}

fn string_value(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match value.get(*key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    })
}

fn number_value(value: &Value, keys: &[&str]) -> Option<usize> {
    keys.iter().find_map(|key| match value.get(*key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|value| usize::try_from(value).ok()),
        Some(Value::String(text)) => text.trim().parse::<usize>().ok(),
        _ => None,
    })
}

fn same_id(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b,
        _ => left.to_string().trim_matches('"') == right.to_string().trim_matches('"'),
    }
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (raw_key, raw_value) = pair.split_once('=')?;
        if percent_decode(raw_key).ok()?.eq_ignore_ascii_case(key) {
            percent_decode(raw_value).ok()
        } else {
            None
        }
    })
}

pub(crate) fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("路径编码不正确".to_string());
            }
            let high = hex_value(bytes[index + 1]).ok_or_else(|| "路径编码不正确".to_string())?;
            let low = hex_value(bytes[index + 2]).ok_or_else(|| "路径编码不正确".to_string())?;
            output.push((high << 4) | low);
            index += 3;
        } else if bytes[index] == b'+' {
            output.push(b' ');
            index += 1;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| "路径编码不是有效 UTF-8".to_string())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_path_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{:02X}", byte)
            }
        })
        .collect()
}

fn remove_path(path: &Path) -> Result<(), SkillMarketError> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|_| SkillMarketError::new(500, "skill_install_failed", "清理 Skill 临时目录失败"))
}

fn unique_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}", std::process::id(), millis)
}

fn now_iso_like() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs();
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_date_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let millis = duration.subsec_millis();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

// 将 Unix epoch 天数转换为 Gregorian UTC 日期，避免为单个时间戳引入额外依赖。
fn civil_date_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted / 146_097
    } else {
        (shifted - 146_096) / 146_097
    };
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
#[path = "skill_market_tests.rs"]
mod tests;
