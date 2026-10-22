//! Length limits are checked before growing buffers, including CredSSP ASN.1 hints.
use ironrdp::{connector::Sequence, core::WriteBuf, pdu::PduHint};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_PDU: usize = 4 * 1024 * 1024;
pub struct Framed<S> {
    pub stream: S,
    buffer: Vec<u8>,
}
impl<S: AsyncRead + AsyncWrite + Unpin> Framed<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
        }
    }
    pub fn into_stream(self) -> Result<S, &'static str> {
        if !self.buffer.is_empty() {
            return Err("Unexpected data before TLS upgrade");
        }
        Ok(self.stream)
    }
    pub async fn read(&mut self, hint: &dyn PduHint) -> Result<Vec<u8>, &'static str> {
        loop {
            if let Some((matched, length)) = hint
                .find_size(&self.buffer)
                .map_err(|_| "Invalid RDP frame")?
            {
                if length == 0 || length > MAX_PDU {
                    return Err("RDP frame exceeds the size limit");
                }
                if self.buffer.len() >= length {
                    let remaining = self.buffer.split_off(length);
                    let frame = std::mem::replace(&mut self.buffer, remaining);
                    if matched {
                        return Ok(frame);
                    }
                    continue;
                }
            }
            if self.buffer.len() >= MAX_PDU {
                return Err("RDP frame exceeds the size limit");
            }
            let mut chunk = [0u8; 8192];
            let capacity = chunk.len().min(MAX_PDU - self.buffer.len());
            let count = self
                .stream
                .read(&mut chunk[..capacity])
                .await
                .map_err(|_| "RDP connection interrupted")?;
            if count == 0 {
                return Err("RDP server closed the connection");
            }
            self.buffer.extend_from_slice(&chunk[..count]);
        }
    }
    pub async fn write(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            self.stream.write_all(bytes).await?;
            self.stream.flush().await
        })
        .await
        .map_err(|_| "RDP write timed out")?
        .map_err(|_| "RDP write failed")
    }
    pub async fn step(&mut self, sequence: &mut impl Sequence) -> Result<(), &'static str> {
        let bytes = match sequence.next_pdu_hint() {
            Some(hint) => self.read(hint).await?,
            None => Vec::new(),
        };
        let mut out = WriteBuf::new();
        let written = sequence
            .step(&bytes, &mut out)
            .map_err(|_| "RDP negotiation failed")?;
        if let Some(length) = written.size() {
            self.write(&out[..length]).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::{core::DecodeResult, pdu::RDP_HINT};
    use std::time::Duration;

    #[derive(Debug)]
    struct MaliciousLength;
    impl PduHint for MaliciousLength {
        fn find_size(&self, _: &[u8]) -> DecodeResult<Option<(bool, usize)>> {
            Ok(Some((true, usize::MAX)))
        }
    }

    #[tokio::test]
    async fn rejects_unbounded_length_before_reading_or_allocating() {
        let (_writer, reader) = tokio::io::duplex(64);
        let mut framed = Framed::new(reader);
        assert_eq!(
            framed.read(&MaliciousLength).await.unwrap_err(),
            "RDP frame exceeds the size limit"
        );
        assert_eq!(framed.buffer.capacity(), 0);
    }

    #[tokio::test]
    async fn cancelled_partial_read_preserves_frame_boundaries() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut framed = Framed::new(reader);
        writer.write_all(&[3, 0, 0, 8, 1]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), framed.read(&RDP_HINT))
                .await
                .is_err()
        );
        writer
            .write_all(&[2, 3, 4, 3, 0, 0, 8, 5, 6, 7, 8])
            .await
            .unwrap();
        assert_eq!(
            framed.read(&RDP_HINT).await.unwrap(),
            [3, 0, 0, 8, 1, 2, 3, 4]
        );
        assert_eq!(
            framed.read(&RDP_HINT).await.unwrap(),
            [3, 0, 0, 8, 5, 6, 7, 8]
        );
    }

    #[tokio::test]
    async fn refuses_unconsumed_bytes_at_tls_upgrade() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut framed = Framed::new(reader);
        writer
            .write_all(&[3, 0, 0, 8, 1, 2, 3, 4, 42])
            .await
            .unwrap();
        framed.read(&RDP_HINT).await.unwrap();
        assert!(framed.into_stream().is_err());
    }
}
