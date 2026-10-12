//! Bound packets before russh-sftp allocates their advertised length.
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::task::JoinHandle;

const MAX_PACKET_BYTES: u32 = 256 * 1024;

pub(super) struct StreamGuard(JoinHandle<()>);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The guard owns both halves of the SSH channel, even if the SFTP library has
/// detached tasks. Dropping a request closes the channel on every exit path.
pub(super) fn bounded_stream<S>(stream: S) -> (DuplexStream, StreamGuard)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (client, proxy) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(async move {
        let (mut remote_read, mut remote_write) = tokio::io::split(stream);
        let (mut local_read, mut local_write) = tokio::io::split(proxy);
        let inbound = async {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                let size = remote_read.read_u32().await?;
                if size == 0 || size > MAX_PACKET_BYTES {
                    return Err::<(), _>(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "SFTP packet exceeds limit",
                    ));
                }
                local_write.write_u32(size).await?;
                let mut remaining = size as usize;
                while remaining > 0 {
                    let count = remaining.min(buffer.len());
                    remote_read.read_exact(&mut buffer[..count]).await?;
                    local_write.write_all(&buffer[..count]).await?;
                    remaining -= count;
                }
            }
        };
        tokio::select! {
            _ = inbound => {},
            _ = tokio::io::copy(&mut local_read, &mut remote_write) => {},
        }
    });
    (client, StreamGuard(task))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn packet_limit_is_checked_before_forwarding_and_drop_closes_transport() {
        let (remote, mut peer) = tokio::io::duplex(64);
        let (mut client, guard) = bounded_stream(remote);
        peer.write_all(&[0, 0, 0, 3, 1, 2, 3]).await.unwrap();
        let mut packet = [0; 7];
        client.read_exact(&mut packet).await.unwrap();
        assert_eq!(packet, [0, 0, 0, 3, 1, 2, 3]);
        // A malicious 4 GiB length must not reach the allocating SFTP parser.
        peer.write_u32(u32::MAX).await.unwrap();
        assert!(client.read_u32().await.is_err());
        drop(guard);

        let (remote, mut peer) = tokio::io::duplex(64);
        let (_client, guard) = bounded_stream(remote);
        tokio::task::yield_now().await;
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
        })
        .await
        .unwrap();
    }
}
