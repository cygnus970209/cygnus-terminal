//! Keep transport cancellation independent of a library's connection task lifetime.
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// Wakes pending I/O on cancellation and drops the underlying stream before
/// returning an error, including when the library has detached its task.
pub(crate) struct CancellableIo<T> {
    inner: Option<T>,
    // Read and write can be polled by different tasks after splitting the stream.
    read_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    write_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl<T> CancellableIo<T> {
    pub(crate) fn new(inner: T, cancellation: CancellationToken) -> Self {
        Self {
            inner: Some(inner),
            read_cancelled: Box::pin(cancellation.clone().cancelled_owned()),
            write_cancelled: Box::pin(cancellation.cancelled_owned()),
        }
    }

    fn check_cancelled(&mut self, cx: &mut Context<'_>, writing: bool) -> io::Result<()> {
        let cancelled = if writing {
            &mut self.write_cancelled
        } else {
            &mut self.read_cancelled
        };
        if cancelled.as_mut().poll(cx).is_ready() {
            self.inner.take();
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Transport cancelled",
            ));
        }
        Ok(())
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for CancellableIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.check_cancelled(cx, false)?;
        Pin::new(this.inner.as_mut().expect("live transport")).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for CancellableIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        this.check_cancelled(cx, true)?;
        Pin::new(this.inner.as_mut().expect("live transport")).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.check_cancelled(cx, true)?;
        Pin::new(this.inner.as_mut().expect("live transport")).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.check_cancelled(cx, true)?;
        Pin::new(this.inner.as_mut().expect("live transport")).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn cancellation_wakes_both_halves_and_closes_the_underlying_stream() {
        let (stream, mut peer) = tokio::io::duplex(1);
        let cancellation = CancellationToken::new();
        let (mut reader, mut writer) =
            tokio::io::split(CancellableIo::new(stream, cancellation.clone()));
        writer.write_all(b"x").await.unwrap();
        let reading = tokio::spawn(async move { reader.read_u8().await });
        let writing = tokio::spawn(async move { writer.write_all(b"y").await });
        tokio::task::yield_now().await;
        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), async {
            assert_eq!(
                reading.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            assert_eq!(
                writing.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            let mut received = Vec::new();
            peer.read_to_end(&mut received).await.unwrap();
            assert_eq!(received, b"x");
        })
        .await
        .expect("cancellation must wake independent read and write tasks");
    }
}
