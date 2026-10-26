//! Only Display Control is registered on drdynvc. Bound both channel fragmentation layers
//! before IronRDP's unbounded SVC/DVC reassemblers consume remote data.
use ironrdp::{
    core::{decode, encode_vec, AsAny},
    displaycontrol::{
        pdu::{DisplayControlMonitorLayout, DisplayControlPdu},
        CHANNEL_NAME,
    },
    dvc::{
        encode_dvc_messages,
        pdu::{CapabilitiesRequestPdu, CapsVersion, DrdynvcDataPdu, DrdynvcServerPdu},
        DrdynvcClient, DvcClientProcessor, DvcMessage, DvcProcessor,
    },
    pdu::{gcc::ChannelName, pdu_other_err, PduResult},
    session::ActiveStage,
    svc::{
        ChannelFlags, CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor,
        SvcProcessorMessages,
    },
};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};

/// ironrdp-dvc 0.8 echoes DVC V3 capabilities but cannot decode its compressed PDUs.
/// Negotiate V1/V2 only, while retaining bitmap bulk compression independently.
#[derive(Debug)]
pub struct DynamicChannels(DrdynvcClient);
impl DynamicChannels {
    pub fn new(area: Arc<AtomicU32>) -> Self {
        Self(DrdynvcClient::new().with_dynamic_channel(DisplayControl(area)))
    }
}
impl AsAny for DynamicChannels {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
impl SvcClientProcessor for DynamicChannels {}
impl SvcProcessor for DynamicChannels {
    fn channel_name(&self) -> ChannelName {
        self.0.channel_name()
    }
    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::Never
    }
    fn start(&mut self) -> PduResult<Vec<SvcMessage>> {
        self.0.start()
    }
    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        let message: DrdynvcServerPdu =
            decode(payload).map_err(|_| pdu_other_err!("Invalid dynamic channel message"))?;
        if let DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::V3 { charges, .. }) = message
        {
            let compatible = DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::new(
                CapsVersion::V2,
                Some(charges),
            ));
            let bytes = encode_vec(&compatible)
                .map_err(|_| pdu_other_err!("Invalid dynamic channel capabilities"))?;
            self.0.process(&bytes)
        } else {
            self.0.process(payload)
        }
    }
}

struct DisplayControl(Arc<AtomicU32>);
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
        .get_svc_processor::<DynamicChannels>()
        .and_then(|channels| channels.0.get_dvc_by_type_id::<DisplayControl>())
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
        .process_svc_processor_messages(SvcProcessorMessages::<DynamicChannels>::new(messages))
        .map_err(|_| "Display Control is unavailable")
}

#[derive(Default)]
pub struct ChannelGuard(crate::channel::Fragments<4096>);
impl ChannelGuard {
    pub fn check(&mut self, payload: &[u8]) -> crate::Result<()> {
        if let Some(bytes) = self.0.check(payload)? {
            let message: DrdynvcServerPdu =
                decode(&bytes).map_err(|_| "Invalid dynamic channel message")?;
            if let DrdynvcServerPdu::Data(DrdynvcDataPdu::DataFirst(first)) = message {
                if first.length() == 0
                    || first.length() > 4096
                    || first.data().len() > first.length() as usize
                {
                    return Err("Oversized dynamic channel message");
                }
            }
        }
        Ok(())
    }
}

pub fn channel_id(channels: &ironrdp::svc::StaticChannelSet) -> Option<u16> {
    channels.get_channel_id_by_type::<DynamicChannels>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::{
        displaycontrol::pdu::DisplayControlCapabilities,
        dvc::pdu::{
            CapabilitiesResponsePdu, CreateRequestPdu, DataFirstPdu, DataPdu, DrdynvcClientPdu,
        },
        pdu::{mcs::SendDataRequest, x224::X224},
        session::ActiveStageBuilder,
        svc::{make_channel_definition, StaticChannelSet},
    };

    fn chunk(bytes: &[u8], length: u32, flags: u32) -> Vec<u8> {
        let mut out = length.to_le_bytes().to_vec();
        out.extend(flags.to_le_bytes());
        out.extend(bytes);
        out
    }
    #[test]
    fn dynamic_channels_negotiate_only_supported_versions() {
        for (offered, expected) in [
            (CapsVersion::V1, CapsVersion::V1),
            (CapsVersion::V2, CapsVersion::V2),
            (CapsVersion::V3, CapsVersion::V2),
        ] {
            let mut channels = DynamicChannels::new(Arc::new(AtomicU32::new(0)));
            let request = DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::new(
                offered,
                Some([1, 2, 3, 4]),
            ));
            let replies = channels.process(&encode_vec(&request).unwrap()).unwrap();
            assert_eq!(replies.len(), 1);
            let bytes = replies[0].encode_unframed_pdu().unwrap();
            assert_eq!(
                decode::<DrdynvcClientPdu>(&bytes).unwrap(),
                DrdynvcClientPdu::Capabilities(CapabilitiesResponsePdu::new(expected))
            );
        }
    }
    #[test]
    fn wrapped_display_channel_preserves_lookup_capabilities_and_resize_routing() {
        let area = Arc::new(AtomicU32::new(0));
        let mut channels = StaticChannelSet::new();
        channels.insert(DynamicChannels::new(area.clone()));
        let channel = channels.get_by_type::<DynamicChannels>().unwrap();
        assert!(make_channel_definition(channel).options.is_empty());
        channels.attach_channel_id(std::any::TypeId::of::<DynamicChannels>(), 1005);
        assert_eq!(channel_id(&channels), Some(1005));
        let mut stage = ActiveStageBuilder {
            static_channels: channels,
            user_channel_id: 1001,
            io_channel_id: 1003,
            message_channel_id: None,
            share_id: 1,
            compression_type: None,
            enable_server_pointer: false,
            pointer_software_rendering: false,
        }
        .build();
        let channel = stage.get_svc_processor_mut::<DynamicChannels>().unwrap();
        channel
            .process(
                &encode_vec(&DrdynvcServerPdu::Create(CreateRequestPdu::new(
                    7,
                    CHANNEL_NAME.into(),
                )))
                .unwrap(),
            )
            .unwrap();
        let caps: DisplayControlPdu = DisplayControlCapabilities::new(1, 1920, 1080)
            .unwrap()
            .into();
        channel
            .process(
                &encode_vec(&DrdynvcServerPdu::Data(DrdynvcDataPdu::Data(DataPdu::new(
                    7,
                    encode_vec(&caps).unwrap(),
                ))))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(area.load(Ordering::Acquire), 1920 * 1080);
        let bytes = resize(&mut stage, 1280, 720, 150).unwrap();
        let request: X224<SendDataRequest<'_>> = decode(&bytes).unwrap();
        assert_eq!(request.0.channel_id, 1005);
        let data = crate::channel::Fragments::<4096>::default()
            .check(&request.0.user_data)
            .unwrap()
            .unwrap();
        let DrdynvcClientPdu::Data(data) = decode(&data).unwrap() else {
            panic!("expected dynamic channel data");
        };
        assert_eq!(data.channel_id(), 7);
        let DrdynvcDataPdu::Data(data) = data else {
            panic!("expected unfragmented display layout");
        };
        let DisplayControlPdu::MonitorLayout(layout) = decode(data.data()).unwrap() else {
            panic!("expected display layout");
        };
        assert_eq!(layout.monitors()[0].dimensions(), (1280, 720));
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
