use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

#[allow(dead_code)]
pub const PAYMENT_WORKSPACE_ERROR_CODE: &str = "default_payment_workspace_unavailable";

const DEFAULT_PAYMENT_WORKSPACE_SLUG: &str = "default";
#[allow(dead_code)]
const PAYMENT_WORKSPACE_SLUG_ENV: &str = "COPIS_PAYMENT_WORKSPACE_SLUG";
#[allow(dead_code)]
const PAYMENT_WORKSPACE_PROJECT_ROOT_ENV: &str = "COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT";
#[allow(dead_code)]
const PAYMENT_WORKSPACE_CWD_ENV: &str = "COPIS_PAYMENT_WORKSPACE_CWD";
#[allow(dead_code)]
const PAYMENT_HOME_ROOT_ENV: &str = "COPIS_PAYMENT_HOME_ROOT";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentWorkspaceError {
    MissingEnvironmentVariable,
    InvalidSlug,
    InvalidProjectRoot,
    InvalidCwd,
    CwdOutsideProjectRoot,
    InvalidPaymentHomeRoot,
    #[allow(dead_code)]
    InvalidAccountId,
}

impl PaymentWorkspaceError {
    #[allow(dead_code)]
    pub fn code(&self) -> &'static str {
        PAYMENT_WORKSPACE_ERROR_CODE
    }
}

impl fmt::Display for PaymentWorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("默认支付工作区不可用")
    }
}

impl std::error::Error for PaymentWorkspaceError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentWorkspace {
    project_root: PathBuf,
    cwd: PathBuf,
    payment_home_root: PathBuf,
}

impl PaymentWorkspace {
    #[allow(dead_code)]
    pub fn from_environment() -> Result<Self, PaymentWorkspaceError> {
        let slug = read_environment(PAYMENT_WORKSPACE_SLUG_ENV)?;
        let project_root = read_environment(PAYMENT_WORKSPACE_PROJECT_ROOT_ENV)?;
        let cwd = read_environment(PAYMENT_WORKSPACE_CWD_ENV)?;
        let payment_home_root = read_environment(PAYMENT_HOME_ROOT_ENV)?;
        Self::parse(&slug, &project_root, &cwd, &payment_home_root)
    }

    pub fn parse(
        slug: &str,
        project_root: &str,
        cwd: &str,
        payment_home_root: &str,
    ) -> Result<Self, PaymentWorkspaceError> {
        if slug.is_empty()
            || project_root.is_empty()
            || cwd.is_empty()
            || payment_home_root.is_empty()
        {
            return Err(PaymentWorkspaceError::MissingEnvironmentVariable);
        }
        if slug != DEFAULT_PAYMENT_WORKSPACE_SLUG {
            return Err(PaymentWorkspaceError::InvalidSlug);
        }

        let canonical_project_root = fs::canonicalize(project_root)
            .map_err(|_| PaymentWorkspaceError::InvalidProjectRoot)?;
        if !fs::metadata(&canonical_project_root)
            .map_err(|_| PaymentWorkspaceError::InvalidProjectRoot)?
            .is_dir()
        {
            return Err(PaymentWorkspaceError::InvalidProjectRoot);
        }
        let canonical_cwd = fs::canonicalize(cwd).map_err(|_| PaymentWorkspaceError::InvalidCwd)?;
        if !fs::metadata(&canonical_cwd)
            .map_err(|_| PaymentWorkspaceError::InvalidCwd)?
            .is_dir()
        {
            return Err(PaymentWorkspaceError::InvalidCwd);
        }
        if canonical_cwd == canonical_project_root
            || canonical_cwd.strip_prefix(&canonical_project_root).is_err()
        {
            return Err(PaymentWorkspaceError::CwdOutsideProjectRoot);
        }

        let expected_payment_home_root = canonical_project_root.join(".copis").join("payment");
        let payment_home_path = Path::new(payment_home_root);
        let canonical_payment_home_path = canonicalize_with_missing_tail(payment_home_path)?;
        if canonical_payment_home_path != expected_payment_home_root {
            return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
        }
        validate_no_external_symlink(&canonical_project_root, &expected_payment_home_root)?;
        if fs::symlink_metadata(&expected_payment_home_root).is_ok() {
            let canonical_payment_home_root = fs::canonicalize(&expected_payment_home_root)
                .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
            if canonical_payment_home_root
                .strip_prefix(&canonical_project_root)
                .is_err()
            {
                return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
            }
            if !fs::metadata(&canonical_payment_home_root)
                .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?
                .is_dir()
            {
                return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
            }
        }

        Ok(Self {
            project_root: canonical_project_root,
            cwd: canonical_cwd,
            payment_home_root: expected_payment_home_root,
        })
    }

    #[allow(dead_code)]
    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    #[allow(dead_code)]
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    #[allow(dead_code)]
    pub fn payment_home_root(&self) -> &Path {
        &self.payment_home_root
    }

    #[allow(dead_code)]
    pub fn ensure_account_home(
        &self,
        server_account_id: &str,
    ) -> Result<PathBuf, PaymentWorkspaceError> {
        let account_id = server_account_id.trim();
        if account_id.is_empty() {
            return Err(PaymentWorkspaceError::InvalidAccountId);
        }

        let account_hash = sha256_hex(account_id.as_bytes());
        let account_path = self.payment_home_root.join(account_hash);
        validate_no_external_symlink(&self.project_root, &account_path)?;
        fs::create_dir_all(&account_path)
            .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
        validate_no_external_symlink(&self.project_root, &account_path)?;

        #[cfg(unix)]
        set_private_directory_permissions(&account_path)?;

        let canonical_account_path = fs::canonicalize(&account_path)
            .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
        if canonical_account_path
            .strip_prefix(&self.project_root)
            .is_err()
        {
            return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
        }

        Ok(canonical_account_path)
    }
}

#[allow(dead_code)]
fn read_environment(name: &str) -> Result<String, PaymentWorkspaceError> {
    env::var(name).map_err(|_| PaymentWorkspaceError::MissingEnvironmentVariable)
}

#[allow(dead_code)]
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 末级目录尚未创建时，先解析已有祖先以统一文件系统保留的路径大小写。
fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, PaymentWorkspaceError> {
    let mut missing_tail = Vec::<OsString>::new();
    let mut ancestor = path;

    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut canonical = fs::canonicalize(ancestor)
                    .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
                for component in missing_tail.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = ancestor
                    .file_name()
                    .ok_or(PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
                missing_tail.push(component.to_os_string());
                ancestor = ancestor
                    .parent()
                    .ok_or(PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
            }
            Err(_) => return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot),
        }
    }
}

#[allow(dead_code)]
fn validate_no_external_symlink(
    project_root: &Path,
    target: &Path,
) -> Result<(), PaymentWorkspaceError> {
    let relative = target
        .strip_prefix(project_root)
        .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)?;
    let mut current = project_root.to_path_buf();

    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
                } else if !metadata.is_dir() {
                    return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(_) => return Err(PaymentWorkspaceError::InvalidPaymentHomeRoot),
        }
    }

    Ok(())
}

#[cfg(unix)]
#[allow(dead_code)]
fn set_private_directory_permissions(path: &Path) -> Result<(), PaymentWorkspaceError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| PaymentWorkspaceError::InvalidPaymentHomeRoot)
}

#[cfg(test)]
mod tests {
    use super::{PaymentWorkspace, PaymentWorkspaceError};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let raw = std::env::temp_dir().join(format!(
                "copis-payment-workspace-{label}-{}-{}",
                std::process::id(),
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&raw).unwrap();
            let path = fs::canonicalize(&raw).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn given_valid_default_payment_workspace_when_parsed_then_succeeds() {
        let temp = TempDir::new("valid");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();
        let canonical_root = fs::canonicalize(&project_root).unwrap();
        let canonical_cwd = fs::canonicalize(&cwd).unwrap();

        assert_eq!(workspace.project_root(), canonical_root);
        assert_eq!(workspace.cwd(), canonical_cwd);
        assert_eq!(
            workspace.payment_home_root(),
            canonical_root.join(".copis").join("payment")
        );
        assert!(!workspace.payment_home_root().exists());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn given_case_mismatched_payment_home_on_case_insensitive_filesystem_when_parsed_then_succeeds()
    {
        let temp = TempDir::new("case-mismatch");
        let project_root = temp.path().join("DefaultWorkspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let case_mismatched_home_root = temp
            .path()
            .join("defaultworkspace")
            .join(".copis")
            .join("payment");

        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            case_mismatched_home_root.to_str().unwrap(),
        )
        .unwrap();

        assert_eq!(
            workspace.payment_home_root(),
            fs::canonicalize(project_root)
                .unwrap()
                .join(".copis")
                .join("payment")
        );
    }

    #[test]
    fn given_any_payment_variable_missing_when_parsed_then_unavailable() {
        let temp = TempDir::new("missing");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let root_text = project_root.to_string_lossy().into_owned();
        let cwd_text = cwd.to_string_lossy().into_owned();
        let home_text = home_root.to_string_lossy().into_owned();
        let cases = [
            (
                "",
                root_text.as_str(),
                cwd_text.as_str(),
                home_text.as_str(),
            ),
            ("default", "", cwd_text.as_str(), home_text.as_str()),
            ("default", root_text.as_str(), "", home_text.as_str()),
            ("default", root_text.as_str(), cwd_text.as_str(), ""),
        ];

        for (slug, root, cwd, home) in cases {
            let error = PaymentWorkspace::parse(slug, root, cwd, home).unwrap_err();
            assert_eq!(error.code(), "default_payment_workspace_unavailable");
            assert!(matches!(
                error,
                PaymentWorkspaceError::MissingEnvironmentVariable
            ));
        }
    }

    #[test]
    fn given_non_default_slug_when_parsed_then_unavailable() {
        let temp = TempDir::new("slug");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let error = PaymentWorkspace::parse(
            "other",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_cwd_equal_to_project_root_when_parsed_then_unavailable() {
        let temp = TempDir::new("cwd-root");
        let project_root = temp.path().join("default-workspace");
        fs::create_dir_all(&project_root).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let root_text = project_root.to_string_lossy().into_owned();
        let home_text = home_root.to_string_lossy().into_owned();

        let error = PaymentWorkspace::parse(
            "default",
            root_text.as_str(),
            root_text.as_str(),
            home_text.as_str(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_cwd_is_regular_file_inside_project_root_when_parsed_then_unavailable() {
        let temp = TempDir::new("cwd-file");
        let project_root = temp.path().join("default-workspace");
        fs::create_dir_all(&project_root).unwrap();
        let cwd = project_root.join("project-file");
        fs::write(&cwd, "not a directory").unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_cwd_outside_project_root_when_parsed_then_unavailable() {
        let temp = TempDir::new("cwd-outside");
        let project_root = temp.path().join("default-workspace");
        let cwd = temp.path().join("sibling");
        fs::create_dir_all(&project_root).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_cwd_is_parent_of_project_root_when_parsed_then_unavailable() {
        let temp = TempDir::new("cwd-parent");
        let project_root = temp.path().join("default-workspace");
        fs::create_dir_all(&project_root).unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_payment_home_root_not_under_exact_path_when_parsed_then_unavailable() {
        let temp = TempDir::new("home-wrong");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let wrong_home = project_root.join(".copis").join("other");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            wrong_home.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_payment_home_root_is_regular_file_when_parsed_then_unavailable() {
        let temp = TempDir::new("home-file");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        fs::create_dir_all(home_root.parent().unwrap()).unwrap();
        fs::write(&home_root, "not a directory").unwrap();

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[cfg(unix)]
    #[test]
    fn given_cwd_symlink_escapes_project_root_when_parsed_then_unavailable() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("cwd-symlink");
        let project_root = temp.path().join("default-workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&project_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = project_root.join("project-link");
        symlink(&outside, &link).unwrap();
        let home_root = project_root.join(".copis").join("payment");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            link.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[cfg(unix)]
    #[test]
    fn given_existing_payment_home_symlink_escapes_when_parsed_then_unavailable() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("home-symlink");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        let outside = temp.path().join("home-outside");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        fs::create_dir_all(home_root.parent().unwrap()).unwrap();
        symlink(&outside, &home_root).unwrap();

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[cfg(unix)]
    #[test]
    fn given_copis_symlink_within_project_root_when_payment_missing_when_parsed_then_unavailable() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("parse-copis-symlink-inside");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        let inside_copis = project_root.join("inside-copis");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&inside_copis).unwrap();
        let copis_link = project_root.join(".copis");
        symlink(&inside_copis, &copis_link).unwrap();
        let home_root = copis_link.join("payment");

        let error = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
    }

    #[test]
    fn given_valid_payment_workspace_when_ensuring_account_home_then_creates_hashed_canonical_directory(
    ) {
        let temp = TempDir::new("account-home");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();

        let account_path = workspace
            .ensure_account_home("working-account-001")
            .unwrap();
        let canonical_root = fs::canonicalize(&project_root).unwrap();
        let expected = canonical_root
            .join(".copis")
            .join("payment")
            .join("81853c2f2dd8927d103d685b69ccbe8d6a3bcad906684f9bf1f510380f188e27");

        assert_eq!(account_path, expected);
        assert_eq!(account_path, fs::canonicalize(&account_path).unwrap());
        assert!(account_path.is_dir());
        assert!(account_path.strip_prefix(&canonical_root).is_ok());

        let directory_name = account_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(directory_name.len(), 64);
        assert!(directory_name
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert_eq!(directory_name, directory_name.to_ascii_lowercase());
    }

    #[test]
    fn given_two_accounts_when_ensuring_account_home_then_directories_are_distinct() {
        let temp = TempDir::new("account-home-distinct");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();

        let first = workspace
            .ensure_account_home("working-account-001")
            .unwrap();
        let second = workspace
            .ensure_account_home("working-account-002")
            .unwrap();

        assert_eq!(
            first.file_name().unwrap().to_str(),
            Some("81853c2f2dd8927d103d685b69ccbe8d6a3bcad906684f9bf1f510380f188e27")
        );
        assert_eq!(
            second.file_name().unwrap().to_str(),
            Some("1e3ae4f936894b16338c2f75eae1e1f2d8e1711758fc54dff8a2f35aebdc323b")
        );
        assert_ne!(first, second);
        assert!(first.is_dir());
        assert!(second.is_dir());
    }


    #[test]
    fn given_blank_account_when_ensuring_account_home_then_unavailable() {
        let temp = TempDir::new("account-home-blank");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();

        for account_id in ["", "   ", "\t"] {
            let error = workspace.ensure_account_home(account_id).unwrap_err();
            assert_eq!(error.code(), "default_payment_workspace_unavailable");
            assert!(matches!(error, PaymentWorkspaceError::InvalidAccountId));
        }
    }

    #[cfg(unix)]
    #[test]
    fn given_copis_symlink_escapes_project_root_when_ensuring_account_home_then_rejected_without_creating_external(
    ) {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("account-home-copis-symlink");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();
        let outside = temp.path().join("outside-copis");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, project_root.join(".copis")).unwrap();

        let error = workspace
            .ensure_account_home("sensitive-account-123")
            .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
        assert_eq!(error.to_string(), "默认支付工作区不可用");
        assert!(!error.to_string().contains("sensitive-account-123"));
        assert!(!error
            .to_string()
            .contains("4594240ef7a777fc80e2fe157f681a80fe7a645169006836243aecbb67222ee2"));
        assert!(!outside.join("payment").exists());
    }

    #[cfg(unix)]
    #[test]
    fn given_payment_home_symlink_escapes_project_root_when_ensuring_account_home_then_rejected() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("account-home-payment-symlink");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();
        let outside = temp.path().join("outside-payment");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(home_root.parent().unwrap()).unwrap();
        symlink(&outside, &home_root).unwrap();

        let error = workspace
            .ensure_account_home("sensitive-account-123")
            .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
        assert!(!outside
            .join("81853c2f2dd8927d103d685b69ccbe8d6a3bcad906684f9bf1f510380f188e27")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn given_account_home_symlink_escapes_project_root_when_ensuring_account_home_then_rejected() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("account-home-account-symlink");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();
        let outside = temp.path().join("outside-account");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&home_root).unwrap();
        let account_path =
            home_root.join("4594240ef7a777fc80e2fe157f681a80fe7a645169006836243aecbb67222ee2");
        symlink(&outside, &account_path).unwrap();

        let error = workspace
            .ensure_account_home("sensitive-account-123")
            .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
        assert_eq!(error.to_string(), "默认支付工作区不可用");
        assert!(!error.to_string().contains("sensitive-account-123"));
        assert!(!error
            .to_string()
            .contains("4594240ef7a777fc80e2fe157f681a80fe7a645169006836243aecbb67222ee2"));
    }

    #[cfg(unix)]
    #[test]
    fn given_account_home_symlink_targets_another_account_when_ensuring_then_rejects_shared_pi_home(
    ) {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("account-home-internal-symlink");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();
        let first_account = workspace
            .ensure_account_home("working-account-001")
            .unwrap();
        let second_account =
            home_root.join("1e3ae4f936894b16338c2f75eae1e1f2d8e1711758fc54dff8a2f35aebdc323b");
        symlink(&first_account, &second_account).unwrap();

        let error = workspace
            .ensure_account_home("working-account-002")
            .unwrap_err();

        assert_eq!(error.code(), "default_payment_workspace_unavailable");
        assert_eq!(fs::read_link(second_account).unwrap(), first_account);
    }

    #[cfg(unix)]
    #[test]
    fn given_created_account_home_when_ensuring_then_mode_is_0700() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("account-home-mode");
        let project_root = temp.path().join("default-workspace");
        let cwd = project_root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let home_root = project_root.join(".copis").join("payment");
        let workspace = PaymentWorkspace::parse(
            "default",
            project_root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            home_root.to_str().unwrap(),
        )
        .unwrap();

        let account_path = workspace
            .ensure_account_home("working-account-001")
            .unwrap();
        let mode = fs::metadata(&account_path).unwrap().permissions().mode();

        assert_eq!(mode & 0o777, 0o700);
    }
}
