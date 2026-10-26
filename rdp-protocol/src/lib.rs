//! Bounded private pipe protocol shared by the app and bundled RDP engine.
use serde::{Deserialize, Serialize};

pub const MAX_WIDTH: u16 = 1920;
pub const MAX_HEIGHT: u16 = 1080;
pub const MAX_FRAME_BYTES: usize = 16 + MAX_WIDTH as usize * MAX_HEIGHT as usize * 4;
pub const MAX_CONTROL_BYTES: usize = 16 * 1024;
pub const MAX_INPUT_BATCH: usize = 64;
pub const MAX_TEXT_UNITS: usize = 256;
pub const MAX_CLIPBOARD_UNITS: usize = 2048;
pub const WIRE_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub domain: String,
    pub width: u16,
    pub height: u16,
    /// Zero preserves the server default for existing profiles/backups.
    #[serde(default)]
    pub desktop_scale_factor: u32,
}
impl ConnectConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.host.is_empty()
            || self.host.len() > 253
            || self
                .host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#".contains(c))
            || self.port == 0
        {
            return Err("Enter a hostname or IP address and a valid port");
        }
        if self.username.is_empty()
            || self.username.len() > 256
            || self.username.chars().any(char::is_control)
            || self.domain.len() > 256
            || self.domain.chars().any(char::is_control)
        {
            return Err("Enter a valid RDP username and domain");
        }
        if self.width < 640
            || self.height < 480
            || self.width > MAX_WIDTH
            || self.height > MAX_HEIGHT
        {
            return Err("RDP desktop size must be between 640×480 and 1920×1080");
        }
        if self.desktop_scale_factor != 0 && !(100..=500).contains(&self.desktop_scale_factor) {
            return Err("RDP Windows scale must be between 100% and 500%");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopSize {
    pub width: u16,
    pub height: u16,
}
impl DesktopSize {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(640..=MAX_WIDTH).contains(&self.width)
            || !(480..=MAX_HEIGHT).contains(&self.height)
            || self.width % 2 != 0
        {
            return Err("RDP resolution must be 640×480 to 1920×1080 with an even width");
        }
        Ok(())
    }
    pub fn area(&self) -> u32 {
        u32::from(self.width) * u32::from(self.height)
    }
}

/// Plain Unicode text only; CR/LF/TAB are data, never keyboard actions.
pub fn valid_clipboard_text(text: &str) -> bool {
    !text.is_empty()
        && text.encode_utf16().count() <= MAX_CLIPBOARD_UNITS
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClipboardAction {
    Enable,
    Disable,
    Send { text: String },
    Read,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClipboardOutcome {
    Enabled,
    Disabled,
    Offered,
    Received { text: String },
    Unavailable,
}

// Intentionally no Debug: authentication/input must never appear in diagnostics.
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Connect {
        config: ConnectConfig,
    },
    Authenticate {
        fingerprint: String,
        password: String,
    },
    Input {
        events: Vec<Input>,
    },
    Resize {
        size: DesktopSize,
    },
    Clipboard {
        request_id: u32,
        action: ClipboardAction,
    },
    Frame,
    Disconnect,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Text {
        text: String,
    },
    Key {
        code: u16,
        down: bool,
    },
    Pointer {
        x: u16,
        y: u16,
        button: Option<u8>,
        down: bool,
    },
    Wheel {
        x: u16,
        y: u16,
        delta: i16,
    },
    ReleaseAll,
}
impl Input {
    pub fn validate(&self) -> bool {
        match self {
            Self::Text { text } => {
                !text.is_empty()
                    && text.encode_utf16().count() <= MAX_TEXT_UNITS
                    && !text
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            }
            Self::Key { code, .. } => {
                (*code > 0 && *code <= 0x7f) || (*code > 0x100 && *code <= 0x17f)
            }
            Self::Pointer { x, y, button, .. } => {
                *x < MAX_WIDTH && *y < MAX_HEIGHT && button.is_none_or(|b| b <= 2)
            }
            Self::Wheel { x, y, delta } => {
                *x < MAX_WIDTH && *y < MAX_HEIGHT && (-255..=255).contains(delta)
            }
            Self::ReleaseAll => true,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Connecting,
    Certificate {
        fingerprint: String,
        subject: String,
        issuer: String,
        valid_from: String,
        valid_until: String,
    },
    Authenticating,
    Connected {
        width: u16,
        height: u16,
    },
    DisplayControl {
        max_area: u32,
    },
    ResizeResult {
        applied: bool,
    },
    ClipboardState {
        available: bool,
        remote_text: bool,
    },
    ClipboardResult {
        request_id: u32,
        outcome: ClipboardOutcome,
    },
    Ended,
    Error {
        message: String,
    },
}

/// Frame response = version, width, height, sequence (u32 LE), then RGBA bytes.
pub fn frame_header(bytes: &[u8]) -> Option<(u16, u16, u32)> {
    if bytes.len() < 16 || bytes.len() > MAX_FRAME_BYTES {
        return None;
    }
    let read = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let (version, width, height, sequence) = (read(0), read(4), read(8), read(12));
    if version != WIRE_VERSION
        || width == 0
        || height == 0
        || width > u32::from(MAX_WIDTH)
        || height > u32::from(MAX_HEIGHT)
        || bytes.len() != 16 + width as usize * height as usize * 4
    {
        return None;
    }
    Some((width as u16, height as u16, sequence))
}
