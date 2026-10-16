use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const MAX_ACTIVE_BINDINGS: usize = 32;
const MAX_SOURCE_ENTRIES: usize = 256;
const MAX_REVOKED_OWNERS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChatroomOrigin {
    pub client_generation: u64,
    pub socket_generation: u64,
    pub auth_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatroomExecutionBinding {
    pub room_id: String,
    pub invocation_id: String,
    pub target_agent_id: String,
    pub session_id: String,
    pub worker_run_id: String,
    pub origin: ChatroomOrigin,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SourceKey {
    room_id: String,
    invocation_id: String,
}

#[derive(Clone, Debug)]
struct SourceRecord {
    target_agent_id: String,
    origin: ChatroomOrigin,
    revoked: bool,
}

#[derive(Default)]
struct State {
    sources: HashMap<SourceKey, SourceRecord>,
    bindings: HashMap<SourceKey, ChatroomExecutionBinding>,
    revoked_bindings: HashMap<SourceKey, ChatroomExecutionBinding>,
    revoked_owners: HashSet<(String, String)>,
}

#[derive(Default)]
pub struct ChatroomExecutionRegistry {
    state: Mutex<State>,
}

impl ChatroomExecutionRegistry {
    pub fn record_source(
        &self,
        room_id: &str,
        invocation_id: &str,
        target_agent_id: &str,
        origin: ChatroomOrigin,
    ) -> bool {
        if origin.socket_generation == 0 {
            return false;
        }
        let key = SourceKey {
            room_id: room_id.into(),
            invocation_id: invocation_id.into(),
        };
        let mut state = self.state.lock().unwrap();
        if state.sources.contains_key(&key) {
            // 同一 invocation 的重播不能重复进入 Main；新代际需先完成旧 source 撤销与回收。
            return false;
        }
        if state.sources.len() >= MAX_SOURCE_ENTRIES {
            return false;
        }
        state.sources.insert(
            key,
            SourceRecord {
                target_agent_id: target_agent_id.into(),
                origin,
                revoked: false,
            },
        );
        true
    }

    pub fn bind(&self, binding: ChatroomExecutionBinding) -> bool {
        if binding.session_id.is_empty() || binding.worker_run_id.is_empty() {
            return false;
        }
        let key = SourceKey {
            room_id: binding.room_id.clone(),
            invocation_id: binding.invocation_id.clone(),
        };
        let mut state = self.state.lock().unwrap();
        let Some(source) = state.sources.get(&key) else {
            return false;
        };
        if source.revoked
            || source.origin != binding.origin
            || source.target_agent_id != binding.target_agent_id
            || state
                .revoked_owners
                .contains(&(binding.session_id.clone(), binding.worker_run_id.clone()))
        {
            return false;
        }
        if let Some(existing) = state.bindings.get(&key) {
            return existing == &binding;
        }
        if state.bindings.len() >= MAX_ACTIVE_BINDINGS
            || state
                .bindings
                .values()
                .any(|existing| existing.session_id == binding.session_id)
        {
            return false;
        }
        state.bindings.insert(key, binding);
        true
    }

    #[cfg(test)]
    pub fn binding(&self, room_id: &str, invocation_id: &str) -> Option<ChatroomExecutionBinding> {
        self.state
            .lock()
            .unwrap()
            .bindings
            .get(&SourceKey {
                room_id: room_id.into(),
                invocation_id: invocation_id.into(),
            })
            .cloned()
    }

    pub fn binding_for_owner(
        &self,
        session_id: &str,
        worker_run_id: &str,
    ) -> Option<ChatroomExecutionBinding> {
        self.state
            .lock()
            .unwrap()
            .bindings
            .values()
            .find(|binding| {
                binding.session_id == session_id && binding.worker_run_id == worker_run_id
            })
            .cloned()
    }

    pub fn owner_is_revoked(&self, session_id: &str, worker_run_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .revoked_owners
            .contains(&(session_id.into(), worker_run_id.into()))
    }

    /// 在 source fence 锁内安装启动预留或 Worker owner，避免撤权与迟到启动竞态。
    pub fn with_live_binding<T>(
        &self,
        room_id: &str,
        invocation_id: &str,
        session_id: &str,
        worker_run_id: &str,
        action: impl FnOnce() -> T,
    ) -> Option<T> {
        let state = self.state.lock().unwrap();
        let key = SourceKey {
            room_id: room_id.into(),
            invocation_id: invocation_id.into(),
        };
        let binding = state.bindings.get(&key)?;
        let source = state.sources.get(&key)?;
        if source.revoked
            || binding.session_id != session_id
            || binding.worker_run_id != worker_run_id
            || binding.origin != source.origin
            || state
                .revoked_owners
                .contains(&(session_id.into(), worker_run_id.into()))
        {
            return None;
        }
        Some(action())
    }

    pub fn revoke_invocation(
        &self,
        room_id: &str,
        invocation_id: &str,
    ) -> Option<ChatroomExecutionBinding> {
        let key = SourceKey {
            room_id: room_id.into(),
            invocation_id: invocation_id.into(),
        };
        let mut state = self.state.lock().unwrap();
        if let Some(source) = state.sources.get_mut(&key) {
            source.revoked = true;
        }
        if let Some(binding) = state.revoked_bindings.get(&key) {
            return Some(binding.clone());
        }
        let Some(binding) = state.bindings.remove(&key) else {
            // 没有 Native owner 可停时，终态本身已封死未来 bind，可直接回收 source 槽。
            state.sources.remove(&key);
            return None;
        };
        if state.revoked_owners.len() >= MAX_REVOKED_OWNERS {
            // owner tombstone 容量已满时保留撤销态 binding，继续阻止迟到启动。
            state.bindings.insert(key, binding.clone());
            return Some(binding);
        }
        state
            .revoked_owners
            .insert((binding.session_id.clone(), binding.worker_run_id.clone()));
        state.revoked_bindings.insert(key, binding.clone());
        Some(binding)
    }

    pub fn release(&self, expected: &ChatroomExecutionBinding) -> bool {
        let key = SourceKey {
            room_id: expected.room_id.clone(),
            invocation_id: expected.invocation_id.clone(),
        };
        let mut state = self.state.lock().unwrap();
        if state.bindings.get(&key) == Some(expected) {
            state.bindings.remove(&key);
            state.sources.remove(&key);
            return true;
        }
        if state.revoked_bindings.get(&key) == Some(expected) {
            state.revoked_bindings.remove(&key);
            state.sources.remove(&key);
            state
                .revoked_owners
                .remove(&(expected.session_id.clone(), expected.worker_run_id.clone()));
            return true;
        }
        if !state.bindings.contains_key(&key)
            && !state.revoked_bindings.contains_key(&key)
            && state.sources.get(&key).is_some_and(|source| {
                source.target_agent_id == expected.target_agent_id
                    && source.origin == expected.origin
            })
        {
            state.sources.remove(&key);
            state
                .revoked_owners
                .remove(&(expected.session_id.clone(), expected.worker_run_id.clone()));
            return true;
        }
        false
    }

    pub fn confirm_native_stop(&self, expected: &ChatroomExecutionBinding) -> bool {
        let key = SourceKey {
            room_id: expected.room_id.clone(),
            invocation_id: expected.invocation_id.clone(),
        };
        let mut state = self.state.lock().unwrap();
        if state.revoked_bindings.get(&key) == Some(expected) {
            state.revoked_bindings.remove(&key);
            state.sources.remove(&key);
            state
                .revoked_owners
                .remove(&(expected.session_id.clone(), expected.worker_run_id.clone()));
            return true;
        }
        if state.bindings.get(&key) == Some(expected)
            && state.sources.get(&key).is_some_and(|source| source.revoked)
        {
            state.bindings.remove(&key);
            state.sources.remove(&key);
            state
                .revoked_owners
                .remove(&(expected.session_id.clone(), expected.worker_run_id.clone()));
            return true;
        }
        false
    }

    pub fn revoke_origin(&self, origin: ChatroomOrigin) -> Vec<ChatroomExecutionBinding> {
        let mut state = self.state.lock().unwrap();
        let keys = state
            .sources
            .iter_mut()
            .filter_map(|(key, source)| {
                if source.origin == origin {
                    source.revoked = true;
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let mut revoked = Vec::new();
        for key in keys {
            if let Some(binding) = state.revoked_bindings.get(&key) {
                revoked.push(binding.clone());
                continue;
            }
            if let Some(binding) = state.bindings.remove(&key) {
                if state.revoked_owners.len() >= MAX_REVOKED_OWNERS {
                    state.bindings.insert(key, binding.clone());
                    revoked.push(binding);
                    continue;
                }
                state
                    .revoked_owners
                    .insert((binding.session_id.clone(), binding.worker_run_id.clone()));
                state.revoked_bindings.insert(key, binding.clone());
                revoked.push(binding);
            } else {
                state.sources.remove(&key);
            }
        }
        revoked
    }

    pub fn revoke_stale_sources(
        &self,
        client_generation: u64,
        socket_generation: u64,
    ) -> Vec<ChatroomExecutionBinding> {
        let origins = {
            let state = self.state.lock().unwrap();
            state
                .sources
                .values()
                .filter_map(|source| {
                    (source.origin.client_generation != client_generation
                        || source.origin.socket_generation != socket_generation)
                        .then_some(source.origin)
                })
                .collect::<HashSet<_>>()
        };
        origins
            .into_iter()
            .flat_map(|origin| self.revoke_origin(origin))
            .collect()
    }

    pub fn revoke_all(&self) -> Vec<ChatroomExecutionBinding> {
        let origins = self
            .state
            .lock()
            .unwrap()
            .sources
            .values()
            .map(|source| source.origin)
            .collect::<HashSet<_>>();
        origins
            .into_iter()
            .flat_map(|origin| self.revoke_origin(origin))
            .collect()
    }
}
