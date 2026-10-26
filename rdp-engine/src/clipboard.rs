//! Manual, bounded CF_UNICODETEXT exchange. No OS clipboard access, file formats,
//! automatic fetch, or logging of data. The app must authorize every operation.
use cygnus_rdp_protocol::{
    valid_clipboard_text, ClipboardAction, ClipboardOutcome, Event, MAX_CLIPBOARD_UNITS,
};
use ironrdp::{
    cliprdr::pdu::{
        Capabilities, ClipboardFormat, ClipboardFormatId as Format,
        ClipboardGeneralCapabilityFlags as Flags, ClipboardPdu as Pdu, ClipboardProtocolVersion,
        FormatDataRequest, FormatDataResponse, FormatList, FormatListResponse,
    },
    core::{decode, AsAny},
    pdu::{gcc::ChannelName, pdu_other_err, PduResult},
    svc::{CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor},
};
use std::{
    any::Any,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub const CHANNEL_NAME: ChannelName = ChannelName::from_static(b"cliprdr\0");
#[derive(Clone, Copy)]
enum Waiting {
    Enable,
    Send,
    Read,
}
struct Pending {
    id: u32,
    kind: Waiting,
    since: Instant,
}
#[derive(Default)]
pub struct ManualClipboard {
    initialized: bool,
    ready: bool,
    enabled: bool,
    blocked: bool,
    long_names: bool,
    remote_text: bool,
    offered: Option<Zeroizing<String>>,
    pending: Option<Pending>,
    events: Vec<Event>,
}
impl std::fmt::Debug for ManualClipboard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ManualClipboard([redacted])")
    }
}
impl AsAny for ManualClipboard {
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
impl SvcClientProcessor for ManualClipboard {}
fn message(pdu: Pdu<'static>) -> SvcMessage {
    SvcMessage::from(pdu)
}
impl ManualClipboard {
    pub fn state(&self) -> (bool, bool) {
        (self.ready && !self.blocked, self.remote_text)
    }
    pub fn events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }
    fn result(&mut self, id: u32, outcome: ClipboardOutcome) {
        self.events.push(Event::ClipboardResult {
            request_id: id,
            outcome,
        });
    }
    fn formats(&self, text: bool) -> crate::Result<SvcMessage> {
        let formats = if text {
            vec![ClipboardFormat::new(Format::CF_UNICODETEXT)]
        } else {
            Vec::new()
        };
        Ok(message(Pdu::FormatList(
            FormatList::new_unicode(&formats, self.long_names)
                .map_err(|_| "Invalid clipboard format")?,
        )))
    }
    // CLIPRDR has no request IDs. On timeout/cancellation, quarantine this channel
    // until reconnect so a late wire response cannot satisfy a newer request.
    fn cancel_pending(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.blocked = true;
            self.enabled = false;
            self.offered = None;
            self.result(pending.id, ClipboardOutcome::Unavailable);
        }
    }
    pub fn tick(&mut self) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.since.elapsed() >= Duration::from_secs(10))
        {
            self.cancel_pending();
        }
    }
    pub fn action(&mut self, id: u32, action: ClipboardAction) -> crate::Result<Vec<SvcMessage>> {
        if matches!(action, ClipboardAction::Disable) {
            self.cancel_pending();
            self.enabled = false;
            self.offered = None;
            self.result(id, ClipboardOutcome::Disabled);
            return Ok(Vec::new());
        }
        if !self.state().0 || self.pending.is_some() {
            self.result(id, ClipboardOutcome::Unavailable);
            return Ok(Vec::new());
        }
        if matches!(action, ClipboardAction::Enable) {
            self.enabled = false;
            self.offered = None;
            self.remote_text = false;
            self.pending = Some(Pending {
                id,
                kind: Waiting::Enable,
                since: Instant::now(),
            });
            return Ok(vec![self.formats(false)?]);
        }
        if !self.enabled {
            self.result(id, ClipboardOutcome::Unavailable);
            return Ok(Vec::new());
        }
        match action {
            ClipboardAction::Send { text } => {
                let text = Zeroizing::new(text);
                if !valid_clipboard_text(&text) {
                    self.result(id, ClipboardOutcome::Unavailable);
                    return Ok(Vec::new());
                }
                let formats = self.formats(true)?;
                self.offered = Some(text);
                self.remote_text = false;
                self.pending = Some(Pending {
                    id,
                    kind: Waiting::Send,
                    since: Instant::now(),
                });
                Ok(vec![formats])
            }
            ClipboardAction::Read if self.remote_text => {
                self.pending = Some(Pending {
                    id,
                    kind: Waiting::Read,
                    since: Instant::now(),
                });
                Ok(vec![message(Pdu::FormatDataRequest(FormatDataRequest {
                    format: Format::CF_UNICODETEXT,
                }))])
            }
            _ => {
                self.result(id, ClipboardOutcome::Unavailable);
                Ok(Vec::new())
            }
        }
    }
    fn process_message(&mut self, bytes: &[u8]) -> crate::Result<Vec<SvcMessage>> {
        if bytes.len() < 8
            || bytes.len() > 16 * 1024
            || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize != bytes.len() - 8
        {
            return Err("Invalid clipboard message length");
        }
        // File, image, lock and directory operations are never negotiated or parsed.
        if !matches!(u16::from_le_bytes([bytes[0], bytes[1]]), 1..=5 | 7) {
            return Ok(Vec::new());
        }
        let pdu: Pdu<'_> = decode(bytes).map_err(|_| "Invalid clipboard message")?;
        match pdu {
            Pdu::Capabilities(caps) if !self.initialized => {
                self.long_names = caps.flags().contains(Flags::USE_LONG_FORMAT_NAMES);
            }
            Pdu::MonitorReady if !self.initialized => {
                self.initialized = true;
                self.ready = true;
                let flags = if self.long_names {
                    Flags::USE_LONG_FORMAT_NAMES
                } else {
                    Flags::empty()
                };
                // Defer the initial format advertisement until explicit consent. Even an
                // empty FormatList can replace the server's clipboard ownership.
                return Ok(vec![message(Pdu::Capabilities(Capabilities::new(
                    ClipboardProtocolVersion::V2,
                    flags,
                )))]);
            }
            Pdu::FormatListResponse(response) if self.initialized => {
                let success = matches!(response, FormatListResponse::Ok);
                if self
                    .pending
                    .as_ref()
                    .is_some_and(|p| matches!(p.kind, Waiting::Enable))
                {
                    let pending = self.pending.take().unwrap();
                    self.enabled = success;
                    self.result(
                        pending.id,
                        if success {
                            ClipboardOutcome::Enabled
                        } else {
                            ClipboardOutcome::Unavailable
                        },
                    );
                } else if self
                    .pending
                    .as_ref()
                    .is_some_and(|p| matches!(p.kind, Waiting::Send))
                {
                    let pending = self.pending.take().unwrap();
                    if success && self.offered.is_some() {
                        self.result(pending.id, ClipboardOutcome::Offered);
                    } else {
                        self.offered = None;
                        self.result(pending.id, ClipboardOutcome::Unavailable);
                    }
                }
            }
            Pdu::FormatList(list) => {
                let formats = list
                    .get_formats(self.long_names)
                    .map_err(|_| "Invalid remote clipboard formats")?;
                self.remote_text = formats.iter().any(|f| f.id == Format::CF_UNICODETEXT);
                self.offered = None;
                return Ok(vec![message(Pdu::FormatListResponse(
                    FormatListResponse::Ok,
                ))]);
            }
            Pdu::FormatDataRequest(request) => {
                let response =
                    if self.enabled && !self.blocked && request.format == Format::CF_UNICODETEXT {
                        self.offered
                            .as_ref()
                            .map(|text| FormatDataResponse::new_unicode_string(text))
                            .unwrap_or_else(FormatDataResponse::new_error)
                    } else {
                        FormatDataResponse::new_error()
                    };
                return Ok(vec![message(Pdu::FormatDataResponse(response))]);
            }
            Pdu::FormatDataResponse(response)
                if self
                    .pending
                    .as_ref()
                    .is_some_and(|p| matches!(p.kind, Waiting::Read)) =>
            {
                let pending = self.pending.take().unwrap();
                let text = if response.is_error() {
                    None
                } else {
                    decode_text(response.data())
                };
                self.result(
                    pending.id,
                    match text {
                        Some(text) if self.enabled && !self.blocked => {
                            ClipboardOutcome::Received { text }
                        }
                        _ => ClipboardOutcome::Unavailable,
                    },
                );
            }
            _ => {}
        }
        Ok(Vec::new())
    }
}
impl SvcProcessor for ManualClipboard {
    fn channel_name(&self) -> ChannelName {
        CHANNEL_NAME
    }
    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::Never
    }
    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        self.process_message(payload)
            .map_err(|_| pdu_other_err!("Invalid clipboard channel data"))
    }
}
fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2
        || bytes.len() > (MAX_CLIPBOARD_UNITS + 1) * 2
        || !bytes.len().is_multiple_of(2)
        || !bytes.ends_with(&[0, 0])
    {
        return None;
    }
    let units = Zeroizing::new(
        bytes[..bytes.len() - 2]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect::<Vec<_>>(),
    );
    let text = String::from_utf16(&units).ok()?;
    valid_clipboard_text(&text).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::core::encode_vec;
    fn receive(clip: &mut ManualClipboard, pdu: Pdu<'_>) -> Vec<SvcMessage> {
        clip.process_message(&encode_vec(&pdu).unwrap()).unwrap()
    }
    fn fixture() -> ManualClipboard {
        let mut clip = ManualClipboard::default();
        receive(
            &mut clip,
            Pdu::Capabilities(Capabilities::new(
                ClipboardProtocolVersion::V2,
                Flags::USE_LONG_FORMAT_NAMES | Flags::STREAM_FILECLIP_ENABLED,
            )),
        );
        let replies = receive(&mut clip, Pdu::MonitorReady);
        assert_eq!(replies.len(), 1, "Never advertise local formats on connect");
        let bytes = replies[0].encode_unframed_pdu().unwrap();
        let Pdu::Capabilities(caps) = decode(&bytes).unwrap() else {
            panic!("capabilities expected")
        };
        assert_eq!(caps.flags(), Flags::USE_LONG_FORMAT_NAMES);
        assert_eq!(clip.state(), (true, false));
        clip
    }
    fn enable(clip: &mut ManualClipboard) {
        let messages = clip.action(1, ClipboardAction::Enable).unwrap();
        assert_eq!(messages.len(), 1);
        receive(clip, Pdu::FormatListResponse(FormatListResponse::Ok));
    }
    fn response(messages: &[SvcMessage]) -> Vec<u8> {
        messages[0].encode_unframed_pdu().unwrap()
    }
    #[test]
    fn sharing_is_off_and_consent_initializes_without_sharing_text() {
        let mut clip = fixture();
        assert!(clip.action(1, ClipboardAction::Read).unwrap().is_empty());
        assert!(matches!(
            &clip.events()[0],
            Event::ClipboardResult {
                outcome: ClipboardOutcome::Unavailable,
                ..
            }
        ));
        let replies = receive(
            &mut clip,
            Pdu::FormatDataRequest(FormatDataRequest {
                format: Format::CF_UNICODETEXT,
            }),
        );
        assert!(
            matches!(decode::<Pdu<'_>>(&response(&replies)).unwrap(), Pdu::FormatDataResponse(pdu) if pdu.is_error())
        );
        enable(&mut clip);
        assert!(matches!(
            &clip.events()[0],
            Event::ClipboardResult {
                outcome: ClipboardOutcome::Enabled,
                ..
            }
        ));
    }
    #[test]
    fn only_explicit_text_is_served_and_disabling_revokes_future_requests() {
        let mut clip = fixture();
        enable(&mut clip);
        clip.events();
        let text = "한글🙂\r\nsecond\tline";
        let formats = clip
            .action(2, ClipboardAction::Send { text: text.into() })
            .unwrap();
        let bytes = response(&formats);
        let Pdu::FormatList(formats) = decode(&bytes).unwrap() else {
            panic!()
        };
        assert_eq!(
            formats.get_formats(true).unwrap(),
            vec![ClipboardFormat::new(Format::CF_UNICODETEXT)]
        );
        receive(&mut clip, Pdu::FormatListResponse(FormatListResponse::Ok));
        assert!(matches!(
            &clip.events()[0],
            Event::ClipboardResult {
                outcome: ClipboardOutcome::Offered,
                ..
            }
        ));
        let bytes = response(&receive(
            &mut clip,
            Pdu::FormatDataRequest(FormatDataRequest {
                format: Format::CF_UNICODETEXT,
            }),
        ));
        let Pdu::FormatDataResponse(data) = decode(&bytes).unwrap() else {
            panic!()
        };
        assert_eq!(decode_text(data.data()).unwrap(), text);
        let other = response(&receive(
            &mut clip,
            Pdu::FormatDataRequest(FormatDataRequest {
                format: Format::CF_HDROP,
            }),
        ));
        assert!(
            matches!(decode::<Pdu<'_>>(&other).unwrap(), Pdu::FormatDataResponse(pdu) if pdu.is_error())
        );
        clip.action(3, ClipboardAction::Disable).unwrap();
        assert!(clip.offered.is_none());
        let denied = response(&receive(
            &mut clip,
            Pdu::FormatDataRequest(FormatDataRequest {
                format: Format::CF_UNICODETEXT,
            }),
        ));
        assert!(
            matches!(decode::<Pdu<'_>>(&denied).unwrap(), Pdu::FormatDataResponse(pdu) if pdu.is_error())
        );
    }
    #[test]
    fn remote_text_is_fetched_only_on_request_and_unsolicited_data_is_ignored() {
        let mut clip = fixture();
        let list =
            FormatList::new_unicode(&[ClipboardFormat::new(Format::CF_UNICODETEXT)], true).unwrap();
        let replies = receive(&mut clip, Pdu::FormatList(list));
        assert_eq!(replies.len(), 1); // acknowledgment, never a data request
        assert!(clip.events().is_empty());
        receive(
            &mut clip,
            Pdu::FormatDataResponse(FormatDataResponse::new_unicode_string("unsolicited")),
        );
        assert!(clip.events().is_empty());
        enable(&mut clip);
        clip.events();
        receive(
            &mut clip,
            Pdu::FormatList(
                FormatList::new_unicode(&[ClipboardFormat::new(Format::CF_UNICODETEXT)], true)
                    .unwrap(),
            ),
        );
        assert_eq!(clip.action(2, ClipboardAction::Read).unwrap().len(), 1);
        receive(
            &mut clip,
            Pdu::FormatDataResponse(FormatDataResponse::new_unicode_string("한글\nremote")),
        );
        assert!(
            matches!(&clip.events()[0], Event::ClipboardResult { request_id: 2, outcome: ClipboardOutcome::Received { text } } if text == "한글\nremote")
        );
    }
    #[test]
    fn timeout_and_cancel_quarantine_late_responses_until_reconnect() {
        for timeout in [false, true] {
            let mut clip = fixture();
            enable(&mut clip);
            clip.events();
            clip.remote_text = true;
            clip.action(2, ClipboardAction::Read).unwrap();
            if timeout {
                clip.pending.as_mut().unwrap().since = Instant::now() - Duration::from_secs(11);
                clip.tick();
            } else {
                clip.action(3, ClipboardAction::Disable).unwrap();
            }
            assert!(!clip.state().0);
            clip.events();
            receive(
                &mut clip,
                Pdu::FormatDataResponse(FormatDataResponse::new_unicode_string("late secret")),
            );
            assert!(clip.events().is_empty());
            assert!(clip.action(4, ClipboardAction::Enable).unwrap().is_empty());
            assert!(matches!(
                &clip.events()[0],
                Event::ClipboardResult {
                    outcome: ClipboardOutcome::Unavailable,
                    ..
                }
            ));
        }
    }
    #[test]
    fn unicode_length_terminators_and_control_bytes_are_strict() {
        for bytes in [
            vec![0],
            vec![0, 0],
            vec![65, 0],
            vec![0, 0xd8, 0, 0],
            vec![0, 0, 65, 0, 0, 0],
            vec![27, 0, 0, 0],
            vec![65; (MAX_CLIPBOARD_UNITS + 2) * 2],
        ] {
            assert!(decode_text(&bytes).is_none());
        }
        let good = FormatDataResponse::new_unicode_string(&"가".repeat(MAX_CLIPBOARD_UNITS));
        assert!(decode_text(good.data()).is_some());
        let mut clip = fixture();
        let mut malformed = encode_vec(&Pdu::MonitorReady).unwrap();
        malformed[4] = 255;
        assert!(clip.process_message(&malformed).is_err());
    }
    #[test]
    fn remote_copy_or_rejected_advertisement_clears_local_offer() {
        for reject in [false, true] {
            let mut clip = fixture();
            enable(&mut clip);
            clip.events();
            clip.action(
                2,
                ClipboardAction::Send {
                    text: "secret".into(),
                },
            )
            .unwrap();
            if reject {
                receive(&mut clip, Pdu::FormatListResponse(FormatListResponse::Fail));
            } else {
                receive(
                    &mut clip,
                    Pdu::FormatList(FormatList::new_unicode(&[], true).unwrap()),
                );
            }
            assert!(clip.offered.is_none());
        }
    }
}
