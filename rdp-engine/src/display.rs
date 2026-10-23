//! Only Display Control is registered. Bound both channel fragmentation layers
//! before IronRDP's unbounded SVC/DVC reassemblers consume remote data.
use ironrdp::{
    core::{decode, Decode, ReadCursor},
    displaycontrol::{
        pdu::{DisplayControlMonitorLayout, DisplayControlPdu},
        CHANNEL_NAME,
    },
    dvc::{
        encode_dvc_messages,
        pdu::{DrdynvcDataPdu, DrdynvcServerPdu},
        DrdynvcClient, DvcClientProcessor, DvcMessage, DvcProcessor,
    },
    pdu::{
        pdu_other_err,
        rdp::vc::{ChannelControlFlags, ChannelPduHeader},
        PduResult,
    },
    session::ActiveStage,
    svc::ChannelFlags,
};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};

pub struct DisplayControl(pub Arc<AtomicU32>);
impl ironrdp::core::AsAny for DisplayControl {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
impl DvcClientProcessor for DisplayControl {}
impl DvcProcessor for DisplayControl {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }
    fn start(&mut self, _: u32) -> PduResult<Vec<DvcMessage>> {
        Ok(Vec::new())
    }
    fn process(&mut self, _: u32, bytes: &[u8]) -> PduResult<Vec<DvcMessage>> {
        // Decode the full PDU, including its 8-byte header. The upstream 0.8
        // client reads those bytes as capabilities and reports the wrong area.
        if bytes.len() != 20 || bytes[4..8] != 20u32.to_le_bytes() {
            return Err(pdu_other_err!("Invalid Display Control capabilities"));
        }
        let DisplayControlPdu::Caps(caps) =
            decode(bytes).map_err(|_| pdu_other_err!("Invalid Display Control capabilities"))?
        else {
            return Err(pdu_other_err!("Unexpected Display Control message"));
        };
        self.0.store(
            caps.max_monitor_area().min(1920 * 1080) as u32,
            Ordering::Release,
        );
        Ok(Vec::new())
    }
    fn close(&mut self, _: u32) {
        self.0.store(0, Ordering::Release);
    }
}

pub fn resize(
    stage: &mut ActiveStage,
    width: u16,
    height: u16,
    scale: u32,
) -> crate::Result<Vec<u8>> {
    let channel = stage
        .get_dvc::<DisplayControl>()
        .and_then(|dvc| dvc.channel_id())
        .ok_or("Display Control is unavailable")?;
    let pdu: DisplayControlPdu = DisplayControlMonitorLayout::new_single_primary_monitor(
        width.into(),
        height.into(),
        (scale != 0).then_some(scale),
        None,
    )
    .map_err(|_| "Invalid remote resolution")?
    .into();
    let messages = encode_dvc_messages(channel, vec![Box::new(pdu)], ChannelFlags::empty())
        .map_err(|_| "Invalid display request")?;
    stage
        .encode_dvc_messages(messages)
        .map_err(|_| "Display Control is unavailable")
}

const MAX_CHANNEL_BYTES: usize = 4096;
#[derive(Default)]
pub struct ChannelGuard {
    length: usize,
    bytes: Vec<u8>,
}
impl ChannelGuard {
    pub fn check(&mut self, payload: &[u8]) -> crate::Result<()> {
        let mut cursor = ReadCursor::new(payload);
        let header =
            ChannelPduHeader::decode(&mut cursor).map_err(|_| "Invalid display channel header")?;
        let flags = header.flags;
        let allowed = ChannelControlFlags::FLAG_FIRST
            | ChannelControlFlags::FLAG_LAST
            | ChannelControlFlags::FLAG_SHOW_PROTOCOL;
        if header.length == 0
            || header.length as usize > MAX_CHANNEL_BYTES
            || !(flags & !allowed).is_empty()
        {
            return Err("Unsupported display channel payload");
        }
        if flags.contains(ChannelControlFlags::FLAG_FIRST) {
            if self.length != 0 {
                return Err("Overlapping display channel fragments");
            }
            self.length = header.length as usize;
        }
        if self.length != header.length as usize
            || cursor.is_empty()
            || self.bytes.len() + cursor.len() > self.length
        {
            return Err("Invalid display channel fragment");
        }
        self.bytes.extend_from_slice(cursor.remaining());
        if flags.contains(ChannelControlFlags::FLAG_LAST) {
            if self.bytes.len() != self.length {
                return Err("Incomplete display channel message");
            }
            let message: DrdynvcServerPdu =
                decode(&self.bytes).map_err(|_| "Invalid dynamic channel message")?;
            if let DrdynvcServerPdu::Data(DrdynvcDataPdu::DataFirst(first)) = message {
                if first.length() == 0
                    || first.length() as usize > MAX_CHANNEL_BYTES
                    || first.data().len() > first.length() as usize
                {
                    return Err("Oversized dynamic channel message");
                }
            }
            self.length = 0;
            self.bytes.clear();
        }
        Ok(())
    }
}

pub fn channel_id(channels: &ironrdp::svc::StaticChannelSet) -> Option<u16> {
    channels.get_channel_id_by_type::<DrdynvcClient>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::{
        core::encode_vec,
        displaycontrol::pdu::DisplayControlCapabilities,
        dvc::pdu::{CapabilitiesRequestPdu, CapsVersion, DataFirstPdu},
    };

    fn chunk(bytes: &[u8], length: u32, flags: u32) -> Vec<u8> {
        let mut out = length.to_le_bytes().to_vec();
        out.extend(flags.to_le_bytes());
        out.extend(bytes);
        out
    }
    #[test]
    fn capabilities_decode_header_validate_length_and_clear_on_close() {
        let area = Arc::new(AtomicU32::new(0));
        let mut display = DisplayControl(area.clone());
        let caps: DisplayControlPdu = DisplayControlCapabilities::new(1, 800, 600).unwrap().into();
        let mut bytes = encode_vec(&caps).unwrap();
        display.process(1, &bytes).unwrap();
        assert_eq!(area.load(Ordering::Acquire), 480_000);
        bytes[4] = 19;
        assert!(display.process(1, &bytes).is_err());
        assert!(display.process(1, &bytes[8..]).is_err());
        display.close(1);
        assert_eq!(area.load(Ordering::Acquire), 0);
    }
    #[test]
    fn caps_are_clamped_to_the_frame_limit() {
        let area = Arc::new(AtomicU32::new(0));
        let mut display = DisplayControl(area.clone());
        let caps: DisplayControlPdu = DisplayControlCapabilities::new(1, 3840, 2400)
            .unwrap()
            .into();
        display.process(1, &encode_vec(&caps).unwrap()).unwrap();
        assert_eq!(area.load(Ordering::Acquire), 1920 * 1080);
    }
    #[test]
    fn channel_reassembly_checks_both_advertised_and_accumulated_length() {
        let bytes = encode_vec(&DrdynvcServerPdu::Capabilities(
            CapabilitiesRequestPdu::new(CapsVersion::V1, None),
        ))
        .unwrap();
        let mut guard = ChannelGuard::default();
        guard
            .check(&chunk(&bytes[..2], bytes.len() as u32, 1))
            .unwrap();
        guard
            .check(&chunk(&bytes[2..], bytes.len() as u32, 2))
            .unwrap();
        assert!(ChannelGuard::default()
            .check(&chunk(&[0], 4097, 1))
            .is_err());
        assert!(ChannelGuard::default()
            .check(&chunk(&[0; 2], 1, 3))
            .is_err());
        assert!(ChannelGuard::default().check(&chunk(&[0], 2, 3)).is_err());
        assert!(ChannelGuard::default()
            .check(&chunk(&[0], 1, 0x200003))
            .is_err());
        assert!(ChannelGuard::default().check(&chunk(&[0], 1, 2)).is_err());
        let mut guard = ChannelGuard::default();
        guard.check(&chunk(&[0], 2, 1)).unwrap();
        assert!(guard.check(&chunk(&[0], 2, 1)).is_err());
    }
    #[test]
    fn oversized_nested_dynamic_message_is_rejected_before_reassembly() {
        let bytes = encode_vec(&DrdynvcServerPdu::Data(DrdynvcDataPdu::DataFirst(
            DataFirstPdu::new(1, u32::MAX, vec![0]),
        )))
        .unwrap();
        assert!(ChannelGuard::default()
            .check(&chunk(&bytes, bytes.len() as u32, 3))
            .is_err());
    }
}
