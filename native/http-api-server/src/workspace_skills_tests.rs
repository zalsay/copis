use super::*;
use std::fs;
use std::path::PathBuf;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "copis-workspace-skills-test-{}-{}",
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

fn store(directory: &TestDirectory) -> WorkspaceSkillsStore {
    WorkspaceSkillsStore::open(directory.0.clone())
}

#[test]
fn lists_enabled_skills_with_frontmatter_metadata() {
    let directory = TestDirectory::new();
    let skills_dir = directory
        .0
        .join("agent-workspaces")
        .join("project-a")
        .join(".agents")
        .join("skills");
    fs::create_dir_all(&skills_dir).unwrap();
    fs::create_dir_all(skills_dir.join("weekly-report")).unwrap();
    fs::create_dir_all(skills_dir.join("code-review")).unwrap();
    fs::write(
        skills_dir.join("weekly-report/SKILL.md"),
        "---\nname: 周报\ndescription: 整理每周工作周报\nversion: 1.2.0\n---\n内容\n",
    )
    .unwrap();
    fs::write(
        skills_dir.join("code-review/SKILL.md"),
        "---\ndisplayName: \"代码审查\"\ndescription: >\n  审查代码质量\n  并给出建议\n---\n内容\n",
    )
    .unwrap();

    let skills = store(&directory).list_skills("project-a").unwrap();
    let items = skills.as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["slug"], "code-review");
    assert_eq!(items[0]["name"], "代码审查");
    assert_eq!(items[0]["description"], "审查代码质量 并给出建议");
    assert_eq!(items[0]["enabled"], true);
    assert_eq!(items[1]["slug"], "weekly-report");
    assert_eq!(items[1]["name"], "周报");
    assert_eq!(items[1]["description"], "整理每周工作周报");
}

#[test]
fn missing_skills_dir_returns_empty_array() {
    let directory = TestDirectory::new();
    let skills = store(&directory).list_skills("project-b").unwrap();
    assert_eq!(skills, json!([]));
}

#[test]
fn skips_entries_without_skill_md() {
    let directory = TestDirectory::new();
    let skills_dir = directory
        .0
        .join("agent-workspaces")
        .join("project-c")
        .join(".agents")
        .join("skills");
    fs::create_dir_all(&skills_dir.join("not-a-skill")).unwrap();
    fs::write(skills_dir.join("plain-file"), "text").unwrap();

    let skills = store(&directory).list_skills("project-c").unwrap();
    assert_eq!(skills, json!([]));
}

#[test]
fn unsafe_slug_is_rejected() {
    let directory = TestDirectory::new();
    assert!(matches!(
        store(&directory).list_skills("../escape"),
        Err(WorkspaceSkillsError::InvalidWorkspace)
    ));
}
