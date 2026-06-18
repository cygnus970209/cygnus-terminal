use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

/// mpsc command 채널 기반 세션 공용 레지스트리.
///
/// telnet/serial 처럼 세션 상태가 command sender 하나뿐인 매니저의
/// lock → get → send → error mapping 보일러플레이트를 통합한다.
/// (ssh 는 세션에 russh handle 을 함께 보관하고 tail/sftp 가 이를 공유하므로 제외)
pub struct CommandRegistry<C> {
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<C>>>>,
}

impl<C> Default for CommandRegistry<C> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C> CommandRegistry<C> {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, session_id: &str, tx: mpsc::Sender<C>) {
        self.sessions.lock().await.insert(session_id.to_string(), tx);
    }

    pub async fn send(&self, session_id: &str, cmd: C) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let tx = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        tx.send(cmd)
            .await
            .map_err(|e| format!("Send error: {e}"))
    }

    /// 세션을 제거하고 종료 command 를 전달한다. 세션이 없으면 no-op.
    pub async fn remove_and_send(&self, session_id: &str, cmd: C) {
        let tx = self.sessions.lock().await.remove(session_id);
        if let Some(tx) = tx {
            let _ = tx.send(cmd).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn send_to_missing_session_fails() {
        let registry: CommandRegistry<u8> = CommandRegistry::new();
        let err = registry.send("nope", 1).await.unwrap_err();
        assert!(err.contains("Session not found"));
    }

    #[tokio::test]
    async fn insert_send_and_remove() {
        let registry: CommandRegistry<u8> = CommandRegistry::new();
        let (tx, mut rx) = mpsc::channel::<u8>(4);
        registry.insert("s1", tx).await;

        registry.send("s1", 7).await.unwrap();
        assert_eq!(rx.recv().await, Some(7));

        registry.remove_and_send("s1", 9).await;
        assert_eq!(rx.recv().await, Some(9));
        assert!(registry.send("s1", 1).await.is_err());

        // 제거된 세션에 다시 remove_and_send 해도 no-op
        registry.remove_and_send("s1", 1).await;
    }
}
