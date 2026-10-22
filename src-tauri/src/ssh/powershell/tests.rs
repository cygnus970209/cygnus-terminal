use super::*;
use serde_json::json;

fn frame(value: &serde_json::Value) -> String {
    format!(
        "{FRAME}{}",
        STANDARD.encode(serde_json::to_vec(value).unwrap())
    )
}

#[test]
fn fixed_commands_are_shell_safe_and_fit_cmd_line_limit() {
    for engine in [PowerShellEngine::PowerShell, PowerShellEngine::Pwsh] {
        for query in [
            Query::Probe,
            Query::Snapshot,
            Query::IisOverview,
            Query::IisLog { site_id: u32::MAX },
            Query::WindowsEvents,
        ] {
            let command = command(engine, query);
            assert!(
                command.len() < 8000,
                "CMD limit must include room for its wrapper: {} bytes",
                command.len()
            );
            let encoded = command.split_whitespace().last().unwrap();
            assert!(encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)));
            let bytes = STANDARD.decode(encoded).unwrap();
            let utf16: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let script = String::from_utf16(&utf16).unwrap();
            assert!(script.contains("ConvertTo-Json -InputObject $result"));
            assert!(script.contains("catch{exit 1}"));
            assert!(command.contains("-NoProfile -NonInteractive"));
            assert!(!command.contains("ExecutionPolicy"));
            assert!(!script.contains("-ComputerName") && !script.contains("-Credential"));
            assert!(!script.contains("CommandLine") && !script.contains("ExecutablePath"));
            for method in [".Start(", ".Stop(", ".Recycle(", ".CommitChanges("] {
                assert!(!script.contains(method));
            }
        }
    }
}

#[test]
fn frame_preserves_korean_and_literal_shell_metacharacters() {
    let expected = json!({"name":"서비스 ' \" ; $(whoami) & <script> \\ 서버"});
    let encoded = frame(&expected);
    assert!(encoded.is_ascii());
    assert_eq!(
        decode::<serde_json::Value>(&format!("\u{feff}{encoded}\r\n")).unwrap(),
        expected
    );
}

#[test]
fn rejects_contaminated_duplicate_invalid_or_oversized_frames() {
    let valid = frame(&json!({"schema":1}));
    for bad in [
        String::new(),
        "#< CLIXML".into(),
        format!("banner\n{valid}"),
        format!("{valid}\n{valid}"),
        format!("{FRAME}@@"),
        format!("{FRAME}{}", "a".repeat(65537)),
        format!("{FRAME}{}", STANDARD.encode(b"{\"schema\":")),
    ] {
        assert!(decode::<serde_json::Value>(&bad).is_err());
    }
    assert!(decode::<Probe>(&frame(
        &json!({"schema":1,"os":"Win32NT","version":"5.1","cim":true,"extra":"private"})
    ))
    .is_err());
}

#[test]
fn validates_runtime_os_engine_and_version_independently() {
    for (engine, version, os, expected) in [
        (PowerShellEngine::PowerShell, "5.1.20348.1", "Win32NT", true),
        (PowerShellEngine::Pwsh, "7.5.1", "Win32NT", true),
        (PowerShellEngine::PowerShell, "5.0", "Win32NT", false),
        (PowerShellEngine::Pwsh, "6.2.1", "Win32NT", false),
        (PowerShellEngine::PowerShell, "7.5.1", "Win32NT", false),
        (PowerShellEngine::Pwsh, "7.5.1", "Unix", false),
        (PowerShellEngine::Pwsh, "7;whoami", "Win32NT", false),
    ] {
        assert_eq!(
            validate_runtime(
                engine,
                Probe {
                    schema: 1,
                    os: os.into(),
                    version: version.into(),
                    cim: true
                }
            )
            .is_some(),
            expected
        );
    }
}
