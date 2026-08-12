use std::sync::Arc;

use super::automation::AutomationStore;
use super::automation_scheduler::AutomationScheduler;
use super::pi_rpc::PiWorkerManager;
use super::Bridge;

#[test]
fn given_task_is_reserved_when_second_run_is_requested_then_it_is_rejected() {
    let config_dir = std::env::temp_dir().join(format!(
        "copis-automation-scheduler-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&config_dir);
    std::fs::create_dir_all(&config_dir).unwrap();
    let scheduler = AutomationScheduler::new(
        Arc::new(AutomationStore::open(config_dir.clone())),
        Arc::new(Bridge::new()),
        Arc::new(PiWorkerManager::new()),
    );

    assert!(scheduler.try_reserve("automation-1"));
    assert!(!scheduler.try_reserve("automation-1"));
    scheduler.release("automation-1");
    assert!(scheduler.try_reserve("automation-1"));

    let _ = std::fs::remove_dir_all(config_dir);
}
