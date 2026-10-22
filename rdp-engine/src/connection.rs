use crate::transport::Framed;
use cygnus_rdp_protocol::ConnectConfig;
use ironrdp::connector::credssp::CredsspSequence;
use ironrdp::connector::sspi::generator::GeneratorState;
use ironrdp::connector::{
    self, ClientConnector, ClientConnectorState, ConnectionResult, Credentials,
};
use ironrdp::core::WriteBuf;
use ironrdp::pdu::{
    gcc::KeyboardType,
    rdp::{
        capability_sets::MajorPlatformType,
        client_info::{CompressionType, PerformanceFlags, TimezoneInfo},
    },
};
use tokio::io::{AsyncRead, AsyncWrite};
use zeroize::Zeroize;

pub fn config(params: &ConnectConfig) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: params.username.clone(),
            password: String::new(),
        },
        domain: (!params.domain.is_empty()).then(|| params.domain.clone()),
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0x0409,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: params.width,
            height: params.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "Cygnus".into(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".into(),
        platform: if cfg!(windows) {
            MajorPlatformType::WINDOWS
        } else if cfg!(target_os = "macos") {
            MajorPlatformType::MACINTOSH
        } else {
            MajorPlatformType::UNIX
        },
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: Some(CompressionType::Rdp61),
        pointer_software_rendering: false,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

/// Drive CredSSP using bounded framing. No Kerberos/KDC, gateway, or secondary network client.
/// Based on IronRDP's public connect_finalize / CredsspSequence contract.
pub async fn finalize<S: AsyncRead + AsyncWrite + Unpin>(
    mut connector: ClientConnector,
    framed: &mut Framed<S>,
    host: &str,
    public_key: Vec<u8>,
) -> Result<ConnectionResult, &'static str> {
    let protocol = match connector.state {
        ClientConnectorState::Credssp { selected_protocol } => selected_protocol,
        _ => return Err("The server must support Network Level Authentication (NLA)"),
    };
    let (mut sequence, mut request) = CredsspSequence::init(
        connector.config.credentials.clone(),
        connector.config.domain.as_deref(),
        protocol,
        host.to_owned().into(),
        public_key,
        None,
    )
    .map_err(|_| "RDP authentication could not start")?;
    loop {
        let result =
            {
                let mut generator = sequence.process_ts_request(request);
                match generator.start() {
                    GeneratorState::Completed(result) => result.map_err(|_| {
                        "RDP authentication failed. Check credentials and NLA/NTLM policy."
                    })?,
                    GeneratorState::Suspended(_) => return Err(
                        "This authentication method requires an unsupported secondary connection",
                    ),
                }
            };
        let mut output = WriteBuf::new();
        let written = sequence
            .handle_process_result(result, &mut output)
            .map_err(|_| "RDP authentication failed")?;
        if let Some(length) = written.size() {
            framed.write(&output[..length]).await?;
        }
        let Some(hint) = sequence.next_pdu_hint() else {
            break;
        };
        let bytes = framed.read(hint).await?;
        match sequence
            .decode_server_message(&bytes)
            .map_err(|_| "RDP authentication was rejected")?
        {
            Some(next) => request = next,
            None => break,
        }
    }
    connector.mark_credssp_as_done();
    loop {
        framed.step(&mut connector).await?;
        if let ClientConnectorState::Connected { result } = connector.state {
            if let Credentials::UsernamePassword { password, .. } =
                &mut connector.config.credentials
            {
                password.zeroize();
            }
            return Ok(result);
        }
    }
}
