//! Check lengths and ordering before the library's SVC reassembler allocates.
use ironrdp::{
    core::{Decode, ReadCursor},
    pdu::rdp::vc::{ChannelControlFlags as Flags, ChannelPduHeader},
};
use zeroize::Zeroizing;
#[derive(Default)]
pub struct Fragments<const LIMIT: usize> {
    length: usize,
    bytes: Zeroizing<Vec<u8>>,
}
impl<const LIMIT: usize> Fragments<LIMIT> {
    pub fn check(&mut self, payload: &[u8]) -> crate::Result<Option<Zeroizing<Vec<u8>>>> {
        let mut cursor = ReadCursor::new(payload);
        let header =
            ChannelPduHeader::decode(&mut cursor).map_err(|_| "Invalid virtual channel header")?;
        let flags = header.flags;
        let allowed = Flags::FLAG_FIRST | Flags::FLAG_LAST | Flags::FLAG_SHOW_PROTOCOL;
        if header.length == 0 || header.length as usize > LIMIT || !(flags & !allowed).is_empty() {
            return Err("Unsupported virtual channel payload");
        }
        if flags.contains(Flags::FLAG_FIRST) {
            if self.length != 0 {
                return Err("Overlapping virtual channel fragments");
            }
            self.length = header.length as usize;
        }
        if self.length != header.length as usize
            || cursor.is_empty()
            || self.bytes.len() + cursor.len() > self.length
        {
            return Err("Invalid virtual channel fragment");
        }
        self.bytes.extend_from_slice(cursor.remaining());
        if flags.contains(Flags::FLAG_LAST) {
            if self.bytes.len() != self.length {
                return Err("Incomplete virtual channel message");
            }
            self.length = 0;
            return Ok(Some(std::mem::take(&mut self.bytes)));
        }
        Ok(None)
    }
}
