//! Read-only parsers. Never invoke ssh, a shell, or commands found in source files.
use crate::db::export::ExportProfile;
use serde::Serialize;
use std::collections::BTreeMap;

pub mod termius;

#[derive(Serialize)]
pub struct Candidate {
    pub profile: ExportProfile,
    pub warnings: Vec<String>,
    pub blocked: bool,
    pub duplicate: bool,
}

fn candidate(name: &str) -> Candidate {
    Candidate {
        profile: ExportProfile {
            protocol: "ssh".into(),
            baud_rate: None,
            name: name.into(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_type: "password".into(),
            key_path: None,
            group_name: "Imported".into(),
        },
        warnings: vec![],
        blocked: false,
        duplicate: false,
    }
}
fn block(c: &mut Candidate, message: impl Into<String>) {
    c.blocked = true;
    c.warnings.push(message.into());
}

// OpenSSH uses # comments outside quotes; shell_words alone doesn't remove them.
fn words(line: &str) -> Result<Vec<String>, String> {
    let mut quote = None;
    let mut escape = false;
    let mut end = line.len();
    for (i, ch) in line.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escape = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && (ch == '"' || ch == '\'') {
            quote = Some(ch);
        } else if quote.is_none() && ch == '#' {
            end = i;
            break;
        }
    }
    shell_words::split(&line[..end]).map_err(|_| "Unclosed quote in configuration".into())
}
#[derive(Default)]
pub struct SshConfig {
    blocks: Vec<(Vec<String>, Vec<(String, String)>)>,
    errors: Vec<String>,
}
impl SshConfig {
    pub fn parse(text: &str) -> Self {
        let mut config = Self {
            blocks: vec![(vec!["*".into()], vec![])],
            errors: vec![],
        };
        for (i, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let split = line
                .find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(line.len());
            let key = line[..split].to_ascii_lowercase();
            let value = line[split..]
                .trim_start()
                .trim_start_matches('=')
                .trim_start();
            let args = match words(value) {
                Ok(v) if !v.is_empty() => v,
                _ => {
                    config
                        .errors
                        .push(format!("Line {}: invalid configuration", i + 1));
                    continue;
                }
            };
            match key.as_str() {
                "host" => config.blocks.push((args, vec![])),
                "include" | "match" => config.errors.push(format!(
                    "{} requires manual configuration (line {})",
                    key,
                    i + 1
                )),
                _ => config
                    .blocks
                    .last_mut()
                    .unwrap()
                    .1
                    .push((key, args.join(" "))),
            }
        }
        config
    }
    fn matches(patterns: &[String], host: &str) -> bool {
        let matches = |p: &str| {
            glob::Pattern::new(p)
                .map(|p| p.matches(host))
                .unwrap_or(false)
        };
        !patterns
            .iter()
            .any(|p| p.strip_prefix('!').is_some_and(matches))
            && patterns.iter().any(|p| !p.starts_with('!') && matches(p))
    }
    fn options(&self, alias: &str) -> BTreeMap<String, String> {
        let mut options = BTreeMap::new();
        for (patterns, values) in &self.blocks {
            if Self::matches(patterns, alias) {
                for (key, value) in values {
                    options.entry(key.clone()).or_insert(value.clone());
                }
            }
        }
        options
    }
    pub fn diagnostics(&self) -> &[String] {
        &self.errors
    }
    pub fn profiles(&self) -> Vec<Candidate> {
        let mut aliases = vec![];
        for (patterns, _) in &self.blocks {
            for alias in patterns {
                if !alias.contains(['*', '?', '[', '!', '%', '$']) && !aliases.contains(alias) {
                    aliases.push(alias.clone());
                }
            }
        }
        aliases
            .iter()
            .map(|alias| self.resolve(alias, BTreeMap::new()))
            .collect()
    }
    fn resolve(&self, alias: &str, overrides: BTreeMap<String, String>) -> Candidate {
        let mut c = candidate(alias);
        c.profile.host = alias.into();
        let identity_count = self
            .blocks
            .iter()
            .filter(|(patterns, _)| Self::matches(patterns, alias))
            .flat_map(|(_, values)| values)
            .filter(|(key, _)| key == "identityfile")
            .count();
        if identity_count > 1 {
            c.warnings
                .push("Multiple identity files: only the first is migrated".into());
        }
        let mut options = self.options(alias);
        options.extend(overrides);
        for error in &self.errors {
            block(&mut c, error.clone());
        }
        if let Some(host) = options.get("hostname") {
            c.profile.host = host.replace("%h", alias);
        }
        c.profile.username = options.get("user").cloned().unwrap_or_default();
        if let Some(port) = options.get("port") {
            match port.parse::<u16>() {
                Ok(n) if n > 0 => c.profile.port = n,
                _ => block(&mut c, "Invalid port"),
            }
        }
        if let Some(key) = options.get("identityfile").filter(|k| k.as_str() != "none") {
            // Keep tilde paths portable; only check file existence later, without reading keys.
            c.profile.key_path = Some(key.clone());
            c.profile.auth_type = "key".into();
        }
        for (key, value) in &options {
            match key.as_str() {
                "hostname" | "user" | "port" | "identityfile" => {}
                "proxyjump" | "proxycommand" if value == "none" => {}
                "proxyjump"
                | "proxycommand"
                | "remotecommand"
                | "localcommand"
                | "certificatefile"
                | "canonicalizehostname"
                | "hostnamecanonicalization" => {
                    block(&mut c, format!("{key} requires manual configuration"))
                }
                _ => c.warnings.push(format!("Setting not migrated: {key}")),
            }
        }
        if c.profile.host.is_empty()
            || c.profile.host.starts_with('-')
            || c.profile
                .host
                .contains(|ch: char| ch.is_whitespace() || "%$`;/|&".contains(ch))
        {
            block(&mut c, "Unsupported host expression");
        }
        if c.profile.username.contains(['%', '$', '`']) {
            block(&mut c, "Unsupported username expression");
        }
        if c.profile
            .key_path
            .as_ref()
            .is_some_and(|k| k.contains(['%', '$', '`']))
        {
            block(&mut c, "Key path uses unsupported substitutions");
        }
        if c.profile.username.is_empty() {
            c.warnings
                .push("Username required — edit before connecting".into());
        }
        if c.profile.key_path.is_none() {
            c.warnings.push(
                "Authentication required — password and SSH agent credentials are not imported"
                    .into(),
            );
        }
        c
    }
}

pub fn iterm_profiles(value: serde_json::Value, ssh: &SshConfig) -> Result<Vec<Candidate>, String> {
    let profiles = value
        .get("Profiles")
        .or_else(|| value.get("New Bookmarks"))
        .and_then(|v| v.as_array())
        .ok_or("No iTerm2 Profiles or New Bookmarks array found")?;
    let mut result = vec![];
    for p in profiles {
        let name = p
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed profile");
        let command = p.get("Command").and_then(|v| v.as_str()).unwrap_or("");
        let initial_text = p.get("Initial Text").and_then(|v| v.as_str()).unwrap_or("");
        let command_mode = p.get("Custom Command").and_then(|v| v.as_str());
        // Login-shell profiles execute Initial Text, not the (possibly stale) Command field.
        // Parse only a single SSH command; never execute startup text to discover its target.
        let use_initial_text =
            command_mode == Some("No") || (command_mode.is_none() && command.trim().is_empty());
        let parsed = if command_mode.is_some_and(|mode| !matches!(mode, "Yes" | "No")) {
            Err("Unsupported iTerm2 command mode".into())
        } else {
            parse_command(
                if use_initial_text {
                    initial_text.trim()
                } else {
                    command.trim()
                },
                ssh,
            )
        };
        let mut c = match parsed {
            Ok(c) => c,
            Err(error) => {
                let mut c = candidate(name);
                block(&mut c, error);
                c
            }
        };
        c.profile.name = name.into();
        c.profile.group_name = p
            .get("Tags")
            .and_then(|v| v.as_array())
            .and_then(|tags| tags.first())
            .and_then(|v| v.as_str())
            .unwrap_or("iTerm2")
            .into();
        if p.get("Dynamic Profile Parent Name").is_some()
            || p.get("Dynamic Profile Parent GUID").is_some()
        {
            block(
                &mut c,
                "Inherited profile settings require manual configuration",
            );
        }
        if !use_initial_text && !initial_text.is_empty() {
            c.warnings.push("Startup text is not migrated".into());
        }
        result.push(c);
    }
    Ok(result)
}
fn parse_command(command: &str, ssh: &SshConfig) -> Result<Candidate, String> {
    if command.contains(['\n', '\r', '$', '`', ';', '|', '&', '<', '>']) {
        return Err("Shell expressions require manual configuration".into());
    }
    let args = shell_words::split(command).map_err(|_| "Invalid command quoting")?;
    if !matches!(
        args.first().map(String::as_str),
        Some("ssh" | "/usr/bin/ssh")
    ) {
        return Err("Not a supported SSH command".into());
    }
    let mut options = BTreeMap::new();
    let mut i = 1;
    while i < args.len() && args[i].starts_with('-') {
        let arg = &args[i];
        if arg == "--" {
            i += 1;
            break;
        }
        let key = match arg.chars().nth(1) {
            Some('p') => "port",
            Some('l') => "user",
            Some('i') => "identityfile",
            _ => return Err("SSH command contains unsupported options".into()),
        };
        let value = if arg.len() > 2 {
            arg[2..].to_string()
        } else {
            i += 1;
            args.get(i).ok_or("Missing SSH option value")?.clone()
        };
        options.entry(key.into()).or_insert(value);
        i += 1;
    }
    let destination = args.get(i).ok_or("Missing SSH destination")?;
    if i + 1 != args.len() {
        return Err("Remote commands require manual configuration".into());
    }
    let host = if let Some((user, host)) = destination.rsplit_once('@') {
        options.entry("user".into()).or_insert(user.into());
        host
    } else {
        destination
    };
    Ok(ssh.resolve(host, options))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iterm_login_shell_startup_ssh_uses_address_not_display_name() {
        let rows = iterm_profiles(
            serde_json::json!({"New Bookmarks": [{
                "Name": "73번 서버", "Custom Command": "No", "Command": "",
                "Initial Text": "ssh admin@192.0.2.73"
            }]}),
            &SshConfig::default(),
        )
        .unwrap();
        assert!(!rows[0].blocked);
        assert_eq!(rows[0].profile.name, "73번 서버");
        assert_eq!(rows[0].profile.host, "192.0.2.73");
        assert_eq!(rows[0].profile.username, "admin");
    }
    #[test]
    fn iterm_startup_mode_respects_active_command_and_alias_settings() {
        let ssh = SshConfig::parse("Host prod\nHostName 192.0.2.73\nUser deploy\nPort 2200");
        let rows = iterm_profiles(serde_json::json!({"Profiles": [
            {"Name":"Startup", "Custom Command":"No", "Command":"ssh wrong.example", "Initial Text":"ssh -i '~/.ssh/my key' prod\r\n"},
            {"Name":"Custom", "Custom Command":"Yes", "Command":"ssh root@custom.example", "Initial Text":"ssh other.example"},
            {"Name":"Empty", "Custom Command":"No", "Command":"ssh stale.example", "Initial Text":""},
            {"Name":"Multiline", "Custom Command":"No", "Initial Text":"ssh prod\nwhoami"},
            {"Name":"Shell", "Custom Command":"Yes", "Command":"/bin/zsh", "Initial Text":"ssh prod"}
        ]}), &ssh).unwrap();
        assert!(!rows[0].blocked);
        assert_eq!(rows[0].profile.host, "192.0.2.73");
        assert_eq!(rows[0].profile.port, 2200);
        assert_eq!(rows[0].profile.key_path.as_deref(), Some("~/.ssh/my key"));
        assert!(!rows[0].warnings.iter().any(|w| w.contains("Startup text")));
        assert_eq!(rows[1].profile.host, "custom.example");
        assert!(rows[1].warnings.iter().any(|w| w.contains("Startup text")));
        for row in &rows[2..] {
            assert!(row.blocked);
            assert!(row.profile.host.is_empty());
        }
    }
    #[test]
    fn unresolved_iterm_profile_never_fabricates_an_endpoint() {
        let rows = iterm_profiles(
            serde_json::json!({"Profiles": [{
                "Name": "73번 서버", "Custom Command": "No", "Command": "",
                "Initial Text": "echo hello; ssh admin@192.0.2.73"
            }]}),
            &SshConfig::default(),
        )
        .unwrap();
        assert!(rows[0].blocked);
        assert!(rows[0].profile.host.is_empty());
    }
    #[test]
    fn precedence_patterns_comments_and_aliases() {
        let config = SshConfig::parse("Host api other\n HostName=example.org # comment\n User deploy\n IdentityFile \"~/.ssh/my key\"\nHost * !other\n Port 2222\nHost *\n User fallback\n Port 22");
        let rows = config.profiles();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].profile.port, 2222);
        assert_eq!(rows[1].profile.port, 22);
        assert_eq!(rows[0].profile.username, "deploy");
        assert_eq!(rows[0].profile.key_path.as_deref(), Some("~/.ssh/my key"));
        assert!(!rows[0].blocked);
    }
    #[test]
    fn unsafe_or_incomplete_config_is_blocked() {
        for text in [
            "Include extra\nHost api",
            "Host api\nProxyJump bastion",
            "Host api\nMatch exec touch\nUser root",
            "Host api\nPort 99999",
            "Host api\nIdentityFile %d/key",
            "Host api\nUser \"unclosed",
        ] {
            assert!(
                SshConfig::parse(text).profiles().iter().all(|c| c.blocked),
                "{text}"
            );
        }
    }
    #[test]
    fn iterm_resolves_alias_and_command_overrides() {
        let config = SshConfig::parse("Host prod\nHostName 10.0.0.1\nPort 22\nUser root");
        let rows = iterm_profiles(serde_json::json!({"Profiles":[{"Name":"API","Command":"ssh -p2200 -i '~/.ssh/a b' deploy@prod","Tags":["Production"]},{"Name":"Local","Command":"/bin/zsh"}]}), &config).unwrap();
        assert_eq!(rows[0].profile.host, "10.0.0.1");
        assert_eq!(rows[0].profile.port, 2200);
        assert_eq!(rows[0].profile.username, "deploy");
        assert_eq!(rows[0].profile.group_name, "Production");
        assert!(rows[1].blocked);
    }
    #[test]
    fn commands_are_not_shell_programs() {
        let config = SshConfig::default();
        for cmd in [
            "ssh host; touch /tmp/no",
            "ssh $(whoami)",
            "ssh -oProxyCommand=evil host",
            "ssh host uname",
            "ssh -J jump host",
            "ssh host | cat",
        ] {
            assert!(parse_command(cmd, &config).is_err(), "{cmd}");
        }
    }
}
