use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::path::PathBuf;

use crate::workspace_mcp::is_safe_workspace_slug;

#[derive(Debug)]
pub enum WorkspaceSkillsError {
    InvalidWorkspace,
    Io(String),
}

impl fmt::Display for WorkspaceSkillsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWorkspace => formatter.write_str("工作区 slug 不正确"),
            Self::Io(message) => formatter.write_str(message),
        }
    }
}

/// 工作区可用 Skills 只读存储：扫描 `agent-workspaces/<slug>/.agents/skills/`。
///
/// 与 Electron 主进程共用同一目录（Agent 编排仍从该目录加载 Skill），
/// 渲染层通过 Rust HTTP API 读取，不再通过 Electron IPC 获取可用 Skills。
pub struct WorkspaceSkillsStore {
    config_dir: PathBuf,
}

impl WorkspaceSkillsStore {
    pub fn open(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    fn workspace_skills_dir(&self, slug: &str) -> Result<PathBuf, WorkspaceSkillsError> {
        if !is_safe_workspace_slug(slug) {
            return Err(WorkspaceSkillsError::InvalidWorkspace);
        }
        Ok(self
            .config_dir
            .join("agent-workspaces")
            .join(slug)
            .join(".agents")
            .join("skills"))
    }

    /// 列出工作区启用的 Skills；目录不存在时返回空数组。
    pub fn list_skills(&self, slug: &str) -> Result<Value, WorkspaceSkillsError> {
        let dir = self.workspace_skills_dir(slug)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!([]));
            }
            Err(_) => {
                return Err(WorkspaceSkillsError::Io(format!(
                    "读取 Skills 目录失败: {}",
                    dir.display()
                )));
            }
        };

        let mut skills = Vec::new();
        for entry in entries.flatten() {
            let skill_dir = entry.path();
            if !skill_dir.is_dir() {
                continue;
            }
            let skill_md = skill_dir.join("SKILL.md");
            let Ok(content) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let slug_name = entry.file_name().to_string_lossy().into_owned();
            let (name, description) = parse_skill_frontmatter(&content, &slug_name);
            skills.push((
                slug_name.clone(),
                json!({
                    "slug": slug_name,
                    "name": name,
                    "description": description,
                    "enabled": true,
                }),
            ));
        }

        skills.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(Value::Array(
            skills.into_iter().map(|(_, skill)| skill).collect(),
        ))
    }
}

/// 解析 SKILL.md 的 YAML frontmatter，仅提取 name/displayName/description。
///
/// 与 Electron 主进程 `parseSkillFrontmatter` 行为保持一致：支持单行值、
/// `|` / `>` 块标量与多行缩进；解析失败时回退为 slug 作为名称。
fn parse_skill_frontmatter(content: &str, slug: &str) -> (String, String) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content.strip_prefix("---\n") else {
        return (slug.to_string(), String::new());
    };
    let Some(end) = rest.find("\n---") else {
        return (slug.to_string(), String::new());
    };

    let mut name: Option<String> = None;
    let mut description = String::new();
    let mut current_key: Option<&'static str> = None;
    let mut folded = false;

    for line in rest[..end].lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            if let Some(key) = current_key {
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                match key {
                    "name" => {
                        append_line(name.get_or_insert_with(|| slug.to_string()), text, folded)
                    }
                    "description" => append_line(&mut description, text, folded),
                    _ => {}
                }
            }
            continue;
        }

        let Some(colon) = line.find(':') else {
            current_key = None;
            continue;
        };
        let key = line[..colon].trim();
        let raw = line[colon + 1..].trim();
        match key {
            "name" | "displayName" => {
                current_key = Some("name");
                folded = raw == ">";
                if raw != "|" && raw != ">" && !raw.is_empty() {
                    name = Some(unquote(raw).to_string());
                } else {
                    name.get_or_insert_with(|| slug.to_string());
                }
            }
            "description" => {
                current_key = Some("description");
                folded = raw == ">";
                if raw != "|" && raw != ">" && !raw.is_empty() {
                    description = unquote(raw).to_string();
                }
            }
            _ => current_key = None,
        }
    }

    (name.unwrap_or_else(|| slug.to_string()), description)
}

fn append_line(target: &mut String, text: &str, folded: bool) {
    let separator = if folded && !target.is_empty() {
        " "
    } else {
        "\n"
    };
    if target.is_empty() {
        target.push_str(text);
    } else {
        target.push_str(separator);
        target.push_str(text);
    }
}

fn unquote(value: &str) -> &str {
    value.trim_matches(|character| character == '"' || character == '\'')
}

#[cfg(test)]
#[path = "workspace_skills_tests.rs"]
mod tests;
