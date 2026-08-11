use crate::agent_files::tokens_equal;
use getrandom::getrandom;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const PAYMENT_CAPABILITY_TOKEN_HEADER: &str = "x-copis-payment-capability";

#[derive(Debug)]
pub struct PaymentCapabilityError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}

impl PaymentCapabilityError {
    fn unavailable() -> Self {
        Self {
            status: 403,
            code: "payment_capability_invalid",
            message: "Pi 支付能力令牌无效",
        }
    }
}

#[derive(Debug)]
struct PaymentCapability {
    token: String,
    home: PathBuf,
    action: String,
}

#[derive(Default)]
pub struct PaymentCapabilityStore {
    capabilities: Mutex<HashMap<String, PaymentCapability>>,
}

impl PaymentCapabilityStore {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    pub fn register(
        &self,
        session_id: &str,
        account_home: &Path,
        action: &str,
    ) -> Result<String, PaymentCapabilityError> {
        if session_id.trim().is_empty()
            || session_id.len() > 512
            || action.trim().is_empty()
            || action.len() > 128
        {
            return Err(PaymentCapabilityError::unavailable());
        }
        let home =
            fs::canonicalize(account_home).map_err(|_| PaymentCapabilityError::unavailable())?;
        if !fs::metadata(&home)
            .map_err(|_| PaymentCapabilityError::unavailable())?
            .is_dir()
        {
            return Err(PaymentCapabilityError::unavailable());
        }
        let token = generate_token()?;
        let mut capabilities = self.capabilities.lock().unwrap();
        if capabilities.contains_key(session_id) {
            return Err(PaymentCapabilityError {
                status: 409,
                code: "payment_capability_conflict",
                message: "Pi 支付能力会话已存在",
            });
        }
        capabilities.insert(
            session_id.to_string(),
            PaymentCapability {
                token: token.clone(),
                home,
                action: action.to_string(),
            },
        );
        Ok(token)
    }

    pub fn resolve(
        &self,
        session_id: &str,
        token: &str,
        action: &str,
    ) -> Result<PathBuf, PaymentCapabilityError> {
        let capabilities = self.capabilities.lock().unwrap();
        let capability = capabilities
            .get(session_id)
            .ok_or_else(PaymentCapabilityError::unavailable)?;
        if !tokens_equal(&capability.token, token) || capability.action != action {
            return Err(PaymentCapabilityError::unavailable());
        }
        if !is_real_directory(&capability.home) {
            return Err(PaymentCapabilityError::unavailable());
        }
        Ok(capability.home.clone())
    }

    #[allow(dead_code)]
    pub fn remove(&self, session_id: &str) {
        self.capabilities.lock().unwrap().remove(session_id);
    }
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[allow(dead_code)]
fn generate_token() -> Result<String, PaymentCapabilityError> {
    let mut bytes = [0_u8; 32];
    getrandom(&mut bytes).map_err(|_| PaymentCapabilityError {
        status: 500,
        code: "payment_capability_unavailable",
        message: "无法创建 Pi 支付能力令牌",
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::PaymentCapabilityStore;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "copis-payment-capability-{}-{}",
                std::process::id(),
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn given_registered_payment_session_when_resolved_then_only_matching_token_returns_its_home() {
        let temp = TempDir::new();
        let store = PaymentCapabilityStore::new();
        let token = store
            .register("payment-session-1", &temp.path, "wallet.check")
            .unwrap();

        assert_eq!(
            store
                .resolve("payment-session-1", &token, "wallet.check")
                .unwrap(),
            fs::canonicalize(&temp.path).unwrap()
        );
        assert!(store
            .resolve("payment-session-1", "wrong-token", "wallet.check")
            .is_err());
        assert!(store
            .resolve("payment-session-2", &token, "wallet.check")
            .is_err());
    }

    #[test]
    fn given_removed_payment_session_when_resolved_then_capability_is_unavailable() {
        let temp = TempDir::new();
        let store = PaymentCapabilityStore::new();
        let token = store
            .register("payment-session-1", &temp.path, "wallet.check")
            .unwrap();

        store.remove("payment-session-1");

        assert!(store
            .resolve("payment-session-1", &token, "wallet.check")
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn given_registered_home_replaced_by_symlink_when_resolved_then_capability_is_invalid() {
        use std::os::unix::fs::symlink;

        let original = TempDir::new();
        let target = TempDir::new();
        let store = PaymentCapabilityStore::new();
        let token = store
            .register("payment-session-symlink", &original.path, "wallet.check")
            .unwrap();

        fs::remove_dir_all(&original.path).unwrap();
        symlink(&target.path, &original.path).unwrap();

        let result = store.resolve("payment-session-symlink", &token, "wallet.check");
        let _ = fs::remove_file(&original.path);
        assert!(result.is_err());
    }

    #[test]
    fn given_registered_home_replaced_by_file_when_resolved_then_capability_is_invalid() {
        let temp = TempDir::new();
        let store = PaymentCapabilityStore::new();
        let token = store
            .register("payment-session-file", &temp.path, "wallet.check")
            .unwrap();

        fs::remove_dir_all(&temp.path).unwrap();
        fs::write(&temp.path, "not a directory").unwrap();

        let result = store.resolve("payment-session-file", &token, "wallet.check");
        let _ = fs::remove_file(&temp.path);
        assert!(result.is_err());
    }
}
