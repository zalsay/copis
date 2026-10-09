use crate::chatroom_protocol::PrivateCommandAck;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

const MAX_PENDING_ACKS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConfirmedCommand {
    pub room_id: String,
    pub request_id: String,
    pub command: String,
    pub invocation_id: Option<String>,
    pub status: Option<String>,
    pub generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AckError {
    Full,
    DuplicateRequest,
    Timeout,
    Disconnected,
    MismatchedAck,
    Rejected(String),
}

struct Pending {
    generation: u64,
    room_id: String,
    command: String,
    invocation_id: Option<String>,
    sender: SyncSender<Result<PrivateCommandAck, AckError>>,
}

/// 连接专属 ACK 关联表。锁只覆盖短暂 map 操作，不在网络或等待期间持有。
#[derive(Default)]
pub(crate) struct PendingCommandAcks {
    entries: Mutex<HashMap<String, Pending>>,
}

impl PendingCommandAcks {
    pub fn contains(&self, generation: u64, request_id: &str) -> bool {
        self.entries
            .lock()
            .expect("chatroom ACK map poisoned")
            .get(request_id)
            .is_some_and(|pending| pending.generation == generation)
    }
    pub fn register(
        &self,
        generation: u64,
        room_id: &str,
        request_id: &str,
        command: &str,
        invocation_id: Option<&str>,
    ) -> Result<Receiver<Result<PrivateCommandAck, AckError>>, AckError> {
        let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
        if entries.contains_key(request_id) {
            return Err(AckError::DuplicateRequest);
        }
        if entries.len() >= MAX_PENDING_ACKS {
            return Err(AckError::Full);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        entries.insert(
            request_id.to_string(),
            Pending {
                generation,
                room_id: room_id.to_string(),
                command: command.to_string(),
                invocation_id: invocation_id.map(str::to_string),
                sender,
            },
        );
        Ok(receiver)
    }

    pub fn resolve(&self, generation: u64, ack: PrivateCommandAck) -> Result<(), AckError> {
        let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
        let Some(pending) = entries.get(&ack.request_id) else {
            return Err(AckError::MismatchedAck);
        };
        if pending.generation != generation
            || pending.room_id != ack.room_id
            || pending.command != ack.command
            || pending.invocation_id.as_deref() != ack.invocation_id.as_deref()
        {
            return Err(AckError::MismatchedAck);
        }
        let pending = entries
            .remove(&ack.request_id)
            .expect("pending entry exists");
        let result = if ack.ok {
            Ok(ack.clone())
        } else {
            Err(AckError::Rejected(
                ack.error_code
                    .clone()
                    .unwrap_or_else(|| "command_rejected".into()),
            ))
        };
        let _ = pending.sender.try_send(result);
        Ok(())
    }

    pub fn invalidate_generation(&self, generation: u64) {
        let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
        let stale = entries
            .iter()
            .filter_map(|(key, value)| (value.generation == generation).then_some(key.clone()))
            .collect::<Vec<_>>();
        for key in stale {
            if let Some(pending) = entries.remove(&key) {
                let _ = pending.sender.try_send(Err(AckError::Disconnected));
            }
        }
    }

    pub fn invalidate_all(&self) {
        let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
        for (_, pending) in entries.drain() {
            let _ = pending.sender.try_send(Err(AckError::Disconnected));
        }
    }

    pub fn cancel(&self, generation: u64, request_id: &str) {
        let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
        if entries
            .get(request_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            if let Some(pending) = entries.remove(request_id) {
                let _ = pending.sender.try_send(Err(AckError::Disconnected));
            }
        }
    }

    pub fn wait(
        &self,
        request_id: &str,
        generation: u64,
        receiver: Receiver<Result<PrivateCommandAck, AckError>>,
        timeout: Duration,
    ) -> Result<ConfirmedCommand, AckError> {
        let result = match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(AckError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(AckError::Disconnected),
        };
        if matches!(result, Err(AckError::Timeout)) {
            let mut entries = self.entries.lock().expect("chatroom ACK map poisoned");
            if entries
                .get(request_id)
                .is_some_and(|pending| pending.generation == generation)
            {
                entries.remove(request_id);
            }
        }
        let ack = result?;
        Ok(ConfirmedCommand {
            room_id: ack.room_id,
            request_id: ack.request_id,
            command: ack.command,
            invocation_id: ack.invocation_id,
            status: ack.status,
            generation,
        })
    }

    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.entries
            .lock()
            .expect("chatroom ACK map poisoned")
            .len()
    }
}

#[cfg(test)]
#[path = "chatroom_ack_tests.rs"]
mod tests;
