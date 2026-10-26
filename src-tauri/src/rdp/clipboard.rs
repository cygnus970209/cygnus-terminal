//! Permission and request correlation at the application boundary.
use cygnus_rdp_protocol::{valid_clipboard_text, ClipboardAction, ClipboardOutcome, Request};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use zeroize::Zeroize;
#[derive(Clone, Copy)]
enum Kind {
    Enable,
    Disable,
    Send,
    Read,
}
struct Pending {
    id: u32,
    kind: Kind,
    since: Instant,
}
#[derive(Default)]
pub(super) struct ClipboardGate {
    pub available: bool,
    enabled: bool,
    last_id: u32,
    pending: Option<Pending>,
}
impl ClipboardGate {
    pub fn set_available(&mut self, available: bool) {
        self.available = available;
        if !available {
            self.enabled = false;
        }
    }
    pub fn expired(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| p.since.elapsed() > Duration::from_secs(35))
    }
    pub fn queue(
        &mut self,
        tx: &mpsc::Sender<Request>,
        id: u32,
        mut action: ClipboardAction,
    ) -> Result<(), String> {
        let result = self.validate(id, &action);
        if let Err(error) = result {
            if let ClipboardAction::Send { text } = &mut action {
                text.zeroize();
            }
            return Err(error.into());
        }
        let kind = match action {
            ClipboardAction::Enable => Kind::Enable,
            ClipboardAction::Disable => Kind::Disable,
            ClipboardAction::Send { .. } => Kind::Send,
            ClipboardAction::Read => Kind::Read,
        };
        if matches!(kind, Kind::Disable) {
            self.enabled = false;
        }
        if let Err(error) = tx.try_send(Request::Clipboard {
            request_id: id,
            action,
        }) {
            let mut request = error.into_inner();
            if let Request::Clipboard {
                action: ClipboardAction::Send { text },
                ..
            } = &mut request
            {
                text.zeroize();
            }
            return Err("Clipboard request could not be queued".into());
        }
        self.last_id = id;
        self.pending = Some(Pending {
            id,
            kind,
            since: Instant::now(),
        });
        Ok(())
    }
    fn validate(&self, id: u32, action: &ClipboardAction) -> Result<(), &'static str> {
        if id == 0 || id <= self.last_id {
            return Err("Invalid clipboard request");
        }
        if matches!(action, ClipboardAction::Disable) {
            return Ok(());
        }
        if !self.available || self.pending.is_some() {
            return Err("Clipboard is unavailable or busy");
        }
        if !matches!(action, ClipboardAction::Enable) && !self.enabled {
            return Err("Clipboard sharing is disabled");
        }
        if let ClipboardAction::Send { text } = action {
            if !valid_clipboard_text(text) {
                return Err("Use at most 2048 UTF-16 units of plain text");
            }
        }
        Ok(())
    }
    pub fn accept(&mut self, id: u32, outcome: &ClipboardOutcome) -> Result<bool, &'static str> {
        let Some(pending) = &self.pending else {
            return Ok(false);
        };
        if pending.id != id {
            return Ok(false);
        }
        let valid = match (pending.kind, outcome) {
            (_, ClipboardOutcome::Unavailable) => true,
            (Kind::Enable, ClipboardOutcome::Enabled) => self.available,
            (Kind::Disable, ClipboardOutcome::Disabled) => true,
            (Kind::Send, ClipboardOutcome::Offered) => self.enabled,
            (Kind::Read, ClipboardOutcome::Received { text }) => {
                self.enabled && valid_clipboard_text(text)
            }
            _ => false,
        };
        if !valid {
            return Err("Invalid clipboard response");
        }
        self.pending = None;
        if matches!(outcome, ClipboardOutcome::Enabled) {
            self.enabled = true;
        }
        Ok(true)
    }
}
