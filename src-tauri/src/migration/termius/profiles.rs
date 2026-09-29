use super::Tables;
use crate::migration::{block, candidate, Candidate};
use serde_json::Value;
use std::collections::BTreeSet;

fn present(v: &Value) -> bool {
    !v.is_null() && v.as_str() != Some("")
}
fn enabled(v: &Value) -> bool {
    present(v) && v != false && v != &serde_json::json!([])
}
fn text(v: &Value) -> Result<String, String> {
    match v {
        Value::Null => Ok(String::new()),
        Value::String(s) => Ok(s.trim().to_owned()),
        _ => Err("Unsupported Termius text field".into()),
    }
}

fn resolve<'a>(
    tables: &'a Tables,
    table: &str,
    reference: &Value,
) -> Result<Option<&'a Value>, String> {
    if !present(reference) {
        return Ok(None);
    }
    let rows = tables.get(table).map(Vec::as_slice).unwrap_or(&[]);
    // Termius repositories use local_id for local relations. Fall back to the
    // remote id only when the local one is absent from this snapshot.
    for key in ["local_id", "id"] {
        if !present(&reference[key]) {
            continue;
        }
        let matches: Vec<_> = rows.iter().filter(|r| r[key] == reference[key]).collect();
        if matches.len() > 1 {
            return Err(format!("Ambiguous Termius {table} reference"));
        }
        if let Some(row) = matches.first() {
            return Ok(Some(row));
        }
    }
    Err(format!(
        "Missing Termius {table} reference — configure this connection manually"
    ))
}

fn effective<'a>(configs: &[&'a Value], field: &str) -> &'a Value {
    configs
        .iter()
        .find_map(|c| present(&c[field]).then_some(&c[field]))
        .unwrap_or(&Value::Null)
}

fn points_to(reference: &Value, row: &Value) -> bool {
    if reference.is_object() {
        for key in ["local_id", "id"] {
            if present(&reference[key]) && present(&row[key]) {
                return reference[key] == row[key];
            }
        }
        false
    } else if let Some(s) = reference.as_str() {
        if let Some(local) = s.strip_prefix("sshconfig_set/") {
            return row["local_id"].to_string() == local;
        }
        row["id"].to_string() == s
    } else {
        present(reference) && reference == &row["id"]
    }
}

fn config_identity<'a>(tables: &'a Tables, config: &Value) -> Result<Option<&'a Value>, String> {
    // 10.1.0 uses this join table. ssh_configs.identity is legacy data and
    // can be stale or null even when the connection has an assigned identity.
    let links: Vec<_> = tables
        .get("ssh_config_identities")
        .into_iter()
        .flatten()
        .filter(|r| points_to(&r["ssh_config"], config))
        .collect();
    if links.len() > 1 {
        return Err("Multiple Termius identities require manual setup".into());
    }
    match links.first() {
        Some(link) => resolve(tables, "ssh_identities", &link["identity"]),
        None => Ok(None),
    }
}

fn identity_empty(identity: &Value) -> bool {
    identity["is_visible"] == false
        && !enabled(&identity["has_password"])
        && ["username", "ssh_key", "hardware_key", "sshid_mode"]
            .iter()
            .all(|k| !present(&identity[*k]))
}

// Matches 10.1.0 MergedIdentity.shouldTakeValueFromParent: a visible identity
// with an empty username intentionally stops inheritance.
fn inherited_username(identities: &[Option<&Value>]) -> Result<String, String> {
    for (index, current) in identities.iter().enumerate() {
        let Some(current) = current else { continue };
        let value = text(&current["username"])?;
        if !value.is_empty() || current["is_visible"] == true {
            return Ok(value);
        }
        if !identity_empty(current)
            && identities
                .get(index + 1)
                .copied()
                .flatten()
                .is_some_and(|p| p["is_visible"] == true)
        {
            return Ok(String::new());
        }
    }
    Ok(String::new())
}

fn inherited_auth(identities: &[Option<&Value>]) -> Option<&'static str> {
    for (index, current) in identities.iter().enumerate() {
        let Some(current) = current else { continue };
        for field in ["sshid_mode", "hardware_key", "ssh_key"] {
            if present(&current[field]) {
                return Some(field);
            }
        }
        if current["is_visible"] == true
            || (!identity_empty(current)
                && identities
                    .get(index + 1)
                    .copied()
                    .flatten()
                    .is_some_and(|p| p["is_visible"] == true))
        {
            return None;
        }
    }
    None
}

fn convert_host(host: &Value, tables: &Tables) -> Result<Candidate, String> {
    let mut c = candidate("Termius connection");
    c.profile.group_name = "Termius".into();
    let address = match &host["address"] {
        Value::Number(n) => n
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .map(|v| std::net::Ipv4Addr::from(v).to_string())
            .ok_or("Invalid Termius IPv4 address")?,
        other => text(other)?,
    };
    c.profile.host = address
        .parse::<u32>()
        .map(|v| std::net::Ipv4Addr::from(v).to_string())
        .unwrap_or(address);
    let label = text(&host["label"])?;
    c.profile.name = if label.is_empty() {
        c.profile.host.clone()
    } else {
        label
    };
    if c.profile.name.is_empty() {
        c.profile.name = "Termius connection".into();
    }
    if c.profile.host.is_empty()
        || c.profile.host.chars().any(char::is_whitespace)
        || c.profile.host.chars().any(char::is_control)
    {
        block(&mut c, "Missing or invalid Termius server address");
    }

    let mut entities = vec![host];
    let mut seen = BTreeSet::new();
    let mut reference = &host["group"];
    let mut labels = vec![];
    while let Some(group) = resolve(tables, "groups", reference)? {
        let id = (group["local_id"].to_string(), group["id"].to_string());
        if !seen.insert(id) || entities.len() > 64 {
            return Err("Cyclic or excessively deep Termius group inheritance".into());
        }
        labels.push(text(&group["label"])?);
        entities.push(group);
        reference = &group["parent_group"];
    }
    if !labels.is_empty() {
        labels.reverse();
        c.profile.group_name = labels
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
    }
    let mut configs = vec![];
    let mut identities = vec![];
    for entity in &entities {
        if entity["is_shared"] == true || present(&entity["encrypted_with"]) {
            block(&mut c, "Shared and team vaults require manual setup");
        }
        if present(&entity["credentials_mode"]) {
            block(
                &mut c,
                "Termius vault credential policies require manual setup",
            );
        }
        let config = resolve(tables, "ssh_configs", &entity["ssh_config"])?;
        let identity = match config {
            Some(cfg) => config_identity(tables, cfg)?,
            None => None,
        };
        identities.push(identity);
        if let Some(config) = config {
            configs.push(config);
        }
    }
    if configs.is_empty() {
        block(
            &mut c,
            "No SSH configuration — Telnet and cloud-only connections require manual setup",
        );
    }
    let port = effective(&configs, "port");
    if present(port) {
        c.profile.port = match port {
            Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()),
            Value::String(s) => s.parse::<u16>().ok(),
            _ => None,
        }
        .filter(|p| *p > 0)
        .ok_or("Invalid Termius SSH port")?;
    }
    c.profile.username = inherited_username(&identities)?;
    if c.profile.username.is_empty() {
        c.warnings
            .push("Username missing — set it in Edit connection".into());
    }
    let auth = inherited_auth(&identities);
    if matches!(auth, Some("ssh_key" | "hardware_key")) {
        c.profile.auth_type = "key".into();
        c.warnings
            .push("Termius SSH key is not copied — choose a key in Edit connection".into());
    }
    if auth == Some("sshid_mode") {
        block(
            &mut c,
            "Termius SSH ID requires manual authentication setup",
        );
    }
    for field in [
        "proxycommand",
        "proxy",
        "host_chain",
        "startup_snippet",
        "use_mosh",
    ] {
        if enabled(effective(&configs, field)) {
            block(&mut c, format!("Termius {field} requires manual setup"));
        }
    }
    for table in ["host_chains", "ssh_config_identities_shared"] {
        for link in tables.get(table).into_iter().flatten() {
            if configs
                .iter()
                .any(|cfg| points_to(&link["ssh_config"], cfg))
            {
                block(&mut c, format!("Termius {table} requires manual setup"));
            }
        }
    }
    for field in ["agent_forwarding", "is_forward_ports", "env_variables"] {
        let value = effective(&configs, field);
        if enabled(value) && value.as_str() != Some("{}") && value.as_str() != Some("[]") {
            c.warnings.push(format!("Termius {field} is not migrated"));
        }
    }
    c.warnings.push(
        "Passwords, keys, snippets, port-forward rules and terminal appearance are not copied"
            .into(),
    );
    Ok(c)
}

pub(super) fn convert(tables: &Tables) -> Result<Vec<Candidate>, String> {
    let hosts = tables.get("hosts").map(Vec::as_slice).unwrap_or(&[]);
    if hosts.len() > 5000 {
        return Err("Import at most 5,000 profiles at a time".into());
    }
    let mut rows = vec![];
    for host in hosts {
        let c = convert_host(host, tables).unwrap_or_else(|error| {
            let label = host["label"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Termius connection");
            let mut c = candidate(label);
            block(&mut c, error);
            c
        });
        rows.push(c);
    }
    rows.sort_by(|a, b| {
        (
            &a.profile.name,
            &a.profile.host,
            &a.profile.username,
            a.profile.port,
        )
            .cmp(&(
                &b.profile.name,
                &b.profile.host,
                &b.profile.username,
                b.profile.port,
            ))
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Tables {
        serde_json::from_value(json!({
            "hosts":[{"id":1,"label":"운영","address":"host.test","group":{"id":2},"ssh_config":{"id":3}}],
            "groups":[{"id":2,"label":"Production","ssh_config":{"id":4}}],
            "ssh_configs":[{"id":3,"port":null},{"id":4,"port":2222,"identity":{"local_id":5}}],
            "ssh_identities":[{"local_id":5,"username":"deploy","is_visible":true,"ssh_key":{"id":6}}],
            "ssh_config_identities":[{"ssh_config":{"id":4},"identity":{"local_id":5}}]
        })).unwrap()
    }
    #[test]
    fn resolves_inherited_port_user_and_key_requirement() {
        let rows = convert(&fixture()).unwrap();
        let c = &rows[0];
        assert!(!c.blocked);
        assert_eq!(
            (
                c.profile.port,
                c.profile.username.as_str(),
                c.profile.group_name.as_str()
            ),
            (2222, "deploy", "Production")
        );
        assert_eq!(c.profile.auth_type, "key");
        assert!(c.profile.key_path.is_none());
    }
    #[test]
    fn missing_refs_cycles_and_proxy_are_blocked() {
        let mut tables = fixture();
        tables.get_mut("groups").unwrap()[0]["parent_group"] = json!({"id":2});
        assert!(convert(&tables).unwrap()[0].blocked);
        let mut tables = fixture();
        tables.get_mut("ssh_configs").unwrap()[0]["proxycommand"] = json!({"id":9});
        assert!(convert(&tables).unwrap()[0].blocked);
        let mut tables = fixture();
        tables.remove("ssh_identities");
        assert!(convert(&tables).unwrap()[0].blocked);
    }
    #[test]
    fn visible_empty_identity_does_not_inherit_parent_username() {
        let mut tables = fixture();
        tables.get_mut("ssh_configs").unwrap()[0]["identity"] = json!({"local_id":7});
        tables
            .get_mut("ssh_identities")
            .unwrap()
            .push(json!({"local_id":7,"is_visible":true,"username":""}));
        tables
            .get_mut("ssh_config_identities")
            .unwrap()
            .push(json!({"ssh_config":{"id":3},"identity":{"local_id":7}}));
        assert_eq!(convert(&tables).unwrap()[0].profile.username, "");
        assert_eq!(convert(&tables).unwrap()[0].profile.auth_type, "password");
    }
    #[test]
    fn join_table_overrides_stale_identity_and_invalid_ports_are_blocked() {
        let mut tables = fixture();
        tables.get_mut("ssh_configs").unwrap()[1]["identity"] = json!({"local_id":999});
        assert_eq!(convert(&tables).unwrap()[0].profile.username, "deploy");
        tables.get_mut("ssh_configs").unwrap()[0]["port"] = json!(65536);
        assert!(convert(&tables).unwrap()[0].blocked);
        tables.get_mut("ssh_configs").unwrap()[0]["port"] = json!(2200);
        assert_eq!(convert(&tables).unwrap()[0].profile.port, 2200);
        tables.get_mut("ssh_configs").unwrap()[0]["use_mosh"] = json!(true);
        assert!(convert(&tables).unwrap()[0].blocked);
    }
    #[test]
    fn shared_vault_and_host_chains_require_manual_setup() {
        let mut tables = fixture();
        tables.get_mut("hosts").unwrap()[0]["is_shared"] = json!(true);
        assert!(convert(&tables).unwrap()[0].blocked);
        let mut tables = fixture();
        tables.insert(
            "host_chains".into(),
            vec![json!({"ssh_config":3,"hosts_chain":[1]})],
        );
        assert!(convert(&tables).unwrap()[0].blocked);
    }
}
