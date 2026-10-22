//! Trust is granted explicitly for this live TLS connection before CredSSP starts.
//! TLS proof-of-possession signatures are always checked; no TLS key log is installed.
use cygnus_rdp_protocol::Event;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, Error, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::{client::TlsStream, rustls, TlsConnector};
use x509_cert::der::Decode;

#[derive(Debug)]
struct PendingTrust {
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl ServerCertVerifier for PendingTrust {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if cert.len() > 64 * 1024 || x509_cert::Certificate::from_der(cert).is_err() {
            return Err(Error::General("Invalid RDP certificate".into()));
        }
        // This only permits inspection of the certificate. The caller must await
        // an approval matching its SHA-256 before supplying any password to RDP.
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub async fn upgrade(
    stream: TcpStream,
    host: &str,
) -> Result<(TlsStream<TcpStream>, Vec<u8>, Event, String), &'static str> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS configuration failed")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PendingTrust { provider }))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let name = ServerName::try_from(host.to_owned()).map_err(|_| "Invalid RDP server name")?;
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|_| "RDP TLS handshake failed")?;
    let der = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or("RDP certificate is missing")?;
    let cert = x509_cert::Certificate::from_der(der).map_err(|_| "Invalid RDP certificate")?;
    let key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or("Invalid RDP certificate public key")?
        .to_vec();
    let fingerprint = Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    let event = Event::Certificate {
        fingerprint: fingerprint.clone(),
        subject: cert
            .tbs_certificate
            .subject
            .to_string()
            .chars()
            .take(1024)
            .collect(),
        issuer: cert
            .tbs_certificate
            .issuer
            .to_string()
            .chars()
            .take(1024)
            .collect(),
        valid_from: cert.tbs_certificate.validity.not_before.to_string(),
        valid_until: cert.tbs_certificate.validity.not_after.to_string(),
    };
    Ok((stream, key, event, fingerprint))
}
