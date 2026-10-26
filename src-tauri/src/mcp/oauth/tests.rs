use super::*;
use crate::execution::tests::Fixture;
use crate::mcp::tests::{call, config, manager, rpc};
use serde_json::{json, Value};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}
fn origin(status: &McpStatus) -> String {
    status
        .endpoint
        .as_ref()
        .unwrap()
        .trim_end_matches("/mcp")
        .to_owned()
}
const REDIRECT: &str = "http://127.0.0.1:54321/callback";
const VERIFIER: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

#[tokio::test]
#[ignore = "requires node and CYGNUS_QA_MCP_SDK pointing to the official TypeScript SDK"]
async fn official_typescript_sdk_interoperability() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let mut child = tokio::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/qa/mcp-oauth-sdk.mjs"),
        )
        .arg(status.endpoint.as_ref().unwrap())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            for pending in m.oauth_approvals().await {
                assert_eq!(pending.client_name, "Official SDK fixture");
                assert!(!pending.allow_execution);
                m.oauth_respond(&pending.id, true).await.unwrap();
            }
            if let Some(result) = child.try_wait().unwrap() {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("SDK test deadline");
    assert!(completed.success());
    m.stop().await;
}

async fn register(status: &McpStatus, name: &str) -> String {
    let response = http()
        .post(format!("{}/oauth/register", origin(status)))
        .json(&json!({
            "client_name":name,"redirect_uris":[REDIRECT],"token_endpoint_auth_method":"none",
            "grant_types":["authorization_code","refresh_token"],"response_types":["code"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json::<Value>().await.unwrap()["client_id"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn authorize(status: &McpStatus, client: &str) -> String {
    authorize_at(status, client, REDIRECT).await
}
async fn authorize_at(status: &McpStatus, client: &str, redirect: &str) -> String {
    let response = http()
        .get(format!("{}/oauth/authorize", origin(status)))
        .query(&[
            ("client_id", client),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("code_challenge", &hash(VERIFIER)),
            ("code_challenge_method", "S256"),
            ("state", "original-client-state"),
            ("resource", status.endpoint.as_ref().unwrap()),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let html = response.text().await.unwrap();
    html.split("/oauth/wait/")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_owned()
}
async fn exchange(
    status: &McpStatus,
    client: &str,
    code: &str,
    verifier: &str,
) -> reqwest::Response {
    http()
        .post(format!("{}/oauth/token", origin(status)))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client),
            ("code", code),
            ("redirect_uri", REDIRECT),
            ("code_verifier", verifier),
            ("resource", status.endpoint.as_ref().unwrap()),
        ])
        .send()
        .await
        .unwrap()
}
async fn approve_code(m: &McpManager, status: &McpStatus, client: &str) -> String {
    let wait = authorize(status, client).await;
    let pending = m.oauth_approvals().await;
    assert_eq!(pending.len(), 1);
    let before = http()
        .get(format!("{}/oauth/wait/{wait}", origin(status)))
        .send()
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK);
    assert!(before
        .text()
        .await
        .unwrap()
        .contains(&pending[0].verification_code));
    m.oauth_respond(&pending[0].id, true).await.unwrap();
    let response = http()
        .get(format!("{}/oauth/wait/{wait}", origin(status)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let redirect = Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    let query: HashMap<_, _> = redirect.query_pairs().into_owned().collect();
    assert_eq!(query["state"], "original-client-state");
    assert_eq!(query["iss"], origin(status));
    query["code"].clone()
}
async fn login(m: &McpManager, status: &McpStatus, name: &str) -> (String, Value) {
    let client = register(status, name).await;
    let code = approve_code(m, status, &client).await;
    let response = exchange(status, &client, &code, VERIFIER).await;
    assert_eq!(response.status(), StatusCode::OK);
    (client, response.json().await.unwrap())
}
fn access_status(status: &McpStatus, token: &Value) -> McpStatus {
    McpStatus {
        endpoint: status.endpoint.clone(),
        token: Some(token["access_token"].as_str().unwrap().into()),
        ..Default::default()
    }
}
async fn refresh(status: &McpStatus, client: &str, token: &Value) -> reqwest::Response {
    http()
        .post(format!("{}/oauth/token", origin(status)))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client),
            ("refresh_token", token["refresh_token"].as_str().unwrap()),
        ])
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn discovery_and_registration_enforce_local_transport_boundaries() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let response = http()
        .get(status.endpoint.as_ref().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers()["www-authenticate"]
        .to_str()
        .unwrap()
        .contains("resource_metadata="));
    let metadata = http()
        .get(format!(
            "{}/.well-known/oauth-authorization-server",
            origin(&status)
        ))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        metadata["code_challenge_methods_supported"],
        json!(["S256"])
    );
    assert_eq!(metadata["issuer"], origin(&status));
    for path in [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
    ] {
        for (header, value) in [
            ("Origin", "https://attacker.invalid"),
            ("Host", "attacker.invalid"),
        ] {
            assert_eq!(
                http()
                    .get(format!("{}{path}", origin(&status)))
                    .header(header, value)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
    }
    for redirect in [
        "https://attacker.invalid/callback",
        "http://127.0.0.1.evil:123/callback",
        "http://user@localhost:123/callback",
        "http://localhost:123/callback#fragment",
        "file:///callback",
        "http://localhost:0/callback",
    ] {
        assert_eq!(
            http()
                .post(format!("{}/oauth/register", origin(&status)))
                .json(&json!({"redirect_uris":[redirect]}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    m.stop().await;
}

#[tokio::test]
async fn browser_fetch_metadata_blocks_unsolicited_authorization_and_wait_requests() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let authorization = || {
        http()
            .get(format!("{}/oauth/authorize", origin(&status)))
            .query(&[
                ("client_id", "cygnus-cursor-desktop"),
                ("redirect_uri", "http://localhost:8787/callback"),
                ("response_type", "code"),
                ("code_challenge", hash(VERIFIER).as_str()),
                ("code_challenge_method", "S256"),
            ])
    };
    for (site, destination) in [
        (Some("cross-site"), "document"),
        (Some("same-site"), "document"),
        (Some("cross-site"), "image"),
        (Some("same-origin"), "empty"),
        (Some("none"), "empty"),
        (None, "image"),
        (None, ""),
    ] {
        let mut request = authorization().header("Sec-Fetch-Dest", destination);
        if let Some(site) = site {
            request = request.header("Sec-Fetch-Site", site);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "site={site:?}, destination={destination:?}"
        );
        assert!(m.oauth_approvals().await.is_empty());
    }
    assert_eq!(
        authorization()
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Fetch-Dest", "document")
            .header("Origin", "https://attacker.invalid")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert!(m.oauth_approvals().await.is_empty());
    for (index, request) in [
        authorization(), // Native SDKs and older browsers may omit fetch metadata.
        authorization()
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Fetch-Dest", "document"),
    ]
    .into_iter()
    .enumerate()
    {
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let html = response.text().await.unwrap();
        let wait = html
            .split("/oauth/wait/")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let url = format!("{}/oauth/wait/{wait}", origin(&status));
        for (site, destination, expected) in [
            ("cross-site", "document", StatusCode::FORBIDDEN),
            ("same-site", "document", StatusCode::FORBIDDEN),
            ("same-origin", "image", StatusCode::FORBIDDEN),
            ("same-origin", "document", StatusCode::OK),
        ] {
            assert_eq!(
                http()
                    .get(&url)
                    .header("Sec-Fetch-Site", site)
                    .header("Sec-Fetch-Dest", destination)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        assert_eq!(
            http().get(&url).send().await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(m.oauth_approvals().await.len(), index + 1);
    }
    m.stop().await;
}

#[tokio::test]
async fn default_http_port_keeps_canonical_metadata_and_authenticated_routing() {
    use axum::body::{to_bytes, Body};

    let f = Fixture::new(true).await;
    let m = manager(&f);
    let cfg = McpConfig {
        port: 80,
        ..config(&f, false)
    };
    // Exercise port 80 entirely through routers; no privileged socket is opened.
    let oauth = OAuth::new(
        m.backend.clone(),
        cfg.clone(),
        80,
        CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(oauth.origin, "http://127.0.0.1");
    for host in ["127.0.0.1", "127.0.0.1:80"] {
        for (path, field, expected) in [
            (
                "/.well-known/oauth-protected-resource/mcp",
                "resource",
                "http://127.0.0.1/mcp",
            ),
            (
                "/.well-known/oauth-authorization-server",
                "issuer",
                "http://127.0.0.1",
            ),
        ] {
            let response = oauth
                .routes()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("Host", host)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let metadata: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap())
                    .unwrap();
            assert_eq!(metadata[field], expected);
        }
    }
    {
        let mut inner = oauth.inner.lock().await;
        inner.stored.grants.push(Grant {
            id: "port-80-grant".into(),
            client_id: "fixture-client".into(),
            client_name: "Fixture".into(),
            resource: "http://127.0.0.1/mcp".into(),
            config: cfg,
            approved_at: now(),
            expires_at: now() + REFRESH_TTL,
            refresh_hash: hash("fixture-refresh"),
            used_refresh_hashes: Vec::new(),
        });
        inner.tokens.insert(
            hash("fixture-access"),
            AccessToken {
                grant_id: "port-80-grant".into(),
                expires_at: now() + ACCESS_TTL,
            },
        );
    }
    assert!(oauth.authorized_router("invalid-access").await.is_none());
    let router = oauth
        .authorized_router("fixture-access")
        .await
        .expect("valid OAuth token at default HTTP port");
    for (host, expected) in [
        ("127.0.0.1", StatusCode::OK),
        ("127.0.0.1:80", StatusCode::OK),
        ("attacker.invalid", StatusCode::FORBIDDEN),
        ("127.0.0.1:81", StatusCode::FORBIDDEN),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("Host", host)
                    .header("Accept", "application/json, text/event-stream")
                    .header("Content-Type", "application/json")
                    .header("MCP-Protocol-Version", "2025-11-25")
                    .body(Body::from(
                        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "MCP Host {host}");
        if expected == StatusCode::OK {
            let result: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                    .unwrap();
            assert!(result["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "cygnus_list_servers"));
        } else {
            let response = oauth
                .routes()
                .oneshot(
                    Request::builder()
                        .uri("/.well-known/oauth-authorization-server")
                        .header("Host", host)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "OAuth Host {host}"
            );
        }
    }
    oauth.stop().await;
}

#[tokio::test]
async fn consent_code_pkce_and_client_binding_are_required_and_single_use() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let client = register(&status, "Synthetic client").await;
    let code = approve_code(&m, &status, &client).await;
    assert_eq!(
        exchange(&status, &client, &code, &"x".repeat(43))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        exchange(&status, "wrong-client", &code, VERIFIER)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let response = exchange(&status, &client, &code, VERIFIER).await;
    assert_eq!(response.status(), StatusCode::OK);
    let tokens: Value = response.json().await.unwrap();
    assert_eq!(tokens["expires_in"], ACCESS_TTL);
    assert_eq!(
        exchange(&status, &client, &code, VERIFIER).await.status(),
        StatusCode::BAD_REQUEST
    );
    let result = call(
        &access_status(&status, &tokens),
        "cygnus_list_servers",
        json!({}),
    )
    .await;
    assert_eq!(
        result["result"]["structuredContent"]["servers"][0]["id"],
        f.profile_id
    );
    let saved = serde_json::to_string(&store::load(&f.db).unwrap()).unwrap();
    assert!(!saved.contains(tokens["access_token"].as_str().unwrap()));
    assert!(!saved.contains(tokens["refresh_token"].as_str().unwrap()));
    assert!(!saved.contains(&code));
    m.stop().await;
}

#[tokio::test]
async fn rejection_expiry_and_stopping_cannot_complete_authorization() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let client = register(&status, "Client").await;
    let wait_id = authorize(&status, &client).await;
    let id = m.oauth_approvals().await[0].id.clone();
    m.oauth_respond(&id, false).await.unwrap();
    assert!(m.oauth_respond(&id, true).await.is_err());
    let response = http()
        .get(format!("{}/oauth/wait/{wait_id}", origin(&status)))
        .send()
        .await
        .unwrap();
    assert!(response.headers()["location"]
        .to_str()
        .unwrap()
        .contains("error=access_denied"));
    assert!(m.oauth_clients().await.unwrap().is_empty());
    let wait_id = authorize(&status, &client).await;
    {
        let running = m.running.lock().await;
        running
            .as_ref()
            .unwrap()
            .oauth
            .inner
            .lock()
            .await
            .pending
            .get_mut(&wait_id)
            .unwrap()
            .approval
            .expires_at = 0;
    }
    assert!(m.oauth_approvals().await.is_empty());
    assert_eq!(
        http()
            .get(format!("{}/oauth/wait/{wait_id}", origin(&status)))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::GONE
    );
    let _ = authorize(&status, &client).await;
    let id = m.oauth_approvals().await[0].id.clone();
    m.stop().await;
    assert!(m.oauth_respond(&id, true).await.is_err());
}

#[tokio::test]
async fn refresh_survives_restart_rotates_and_revokes_on_replay() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let (client, tokens) = login(&m, &status, "Persistent client").await;
    let old_access = access_status(&status, &tokens);
    let port = Url::parse(status.endpoint.as_ref().unwrap())
        .unwrap()
        .port()
        .unwrap();
    m.stop().await;
    drop(m);
    let m = manager(&f);
    assert_eq!(m.oauth_clients().await.unwrap().len(), 1);
    assert_eq!(m.status().await.saved_config.unwrap().port, port);
    let mut cfg = config(&f, false);
    cfg.port = port;
    let status = m.start(cfg).await.unwrap();
    assert_eq!(
        http()
            .get(old_access.endpoint.unwrap())
            .bearer_auth(old_access.token.unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = refresh(&status, &client, &tokens).await;
    assert_eq!(response.status(), StatusCode::OK);
    let rotated: Value = response.json().await.unwrap();
    assert_ne!(rotated["refresh_token"], tokens["refresh_token"]);
    assert_eq!(
        refresh(&status, &client, &tokens).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        refresh(&status, &client, &rotated).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert!(m.oauth_clients().await.unwrap().is_empty());
    m.stop().await;
}

#[tokio::test]
async fn clients_have_isolated_jobs_and_independent_revocation() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let (_, a) = login(&m, &status, "Client A").await;
    let (_, b) = login(&m, &status, "Client B").await;
    let a_status = access_status(&status, &a);
    let b_status = access_status(&status, &b);
    let result = call(
        &a_status,
        "cygnus_execute",
        json!({"profile_id":f.profile_id,"command":"printf hello"}),
    )
    .await;
    let id = result["result"]["structuredContent"]["job_id"]
        .as_str()
        .expect("job id");
    let blocked = call(&b_status, "cygnus_get_job", json!({"job_id":id})).await;
    assert_eq!(blocked["result"]["isError"], true);
    let grant = m
        .oauth_clients()
        .await
        .unwrap()
        .into_iter()
        .find(|g| g.name == "Client A")
        .unwrap();
    m.oauth_revoke(&grant.id).await.unwrap();
    assert_eq!(
        http()
            .get(status.endpoint.as_ref().unwrap())
            .bearer_auth(a["access_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let result = call(&b_status, "cygnus_list_servers", json!({})).await;
    assert!(result["result"]["structuredContent"]["servers"].is_array());
    let result = rpc(&status, "tools/list", json!({})).await;
    assert!(result["result"]["tools"].is_array());
    m.stop().await;
}

#[tokio::test]
async fn public_revocation_binds_client_and_cancels_only_its_grant() {
    for token_kind in ["access_token", "refresh_token"] {
        let f = Fixture::new(true).await;
        let m = manager(&f);
        let status = m.start(config(&f, true)).await.unwrap();
        let (client_a, a) = login(&m, &status, "Client A").await;
        let (client_b, b) = login(&m, &status, "Client B").await;
        let mut jobs = Vec::new();
        for tokens in [&a, &b] {
            let result = call(
                &access_status(&status, tokens),
                "cygnus_execute",
                json!({"profile_id":f.profile_id,"command":"hang"}),
            )
            .await;
            let id = result["result"]["structuredContent"]["job_id"]
                .as_str()
                .unwrap()
                .to_owned();
            f.has_output(&id).await;
            jobs.push(id);
        }
        // RFC 7009 returns success for unknown/wrong-client tokens without revoking anything.
        for (client, token) in [
            (client_b.as_str(), a[token_kind].as_str().unwrap()),
            (client_a.as_str(), "unknown-fixture-token"),
        ] {
            assert_eq!(
                http()
                    .post(format!("{}/oauth/revoke", origin(&status)))
                    .form(&[("client_id", client), ("token", token)])
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        assert_eq!(m.oauth_clients().await.unwrap().len(), 2);
        let result = call(
            &access_status(&status, &a),
            "cygnus_list_servers",
            json!({}),
        )
        .await;
        assert!(result["result"]["structuredContent"]["servers"].is_array());
        assert_eq!(
            http()
                .post(format!("{}/oauth/revoke", origin(&status)))
                .form(&[
                    ("client_id", client_a.as_str()),
                    ("token", a[token_kind].as_str().unwrap()),
                ])
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            f.finished(&jobs[0]).await.summary.status,
            crate::execution::ExecutionStatus::Cancelled
        );
        assert!(!f
            .manager
            .get(&jobs[1])
            .await
            .unwrap()
            .summary
            .status
            .is_terminal());
        assert_eq!(m.oauth_clients().await.unwrap().len(), 1);
        assert_eq!(
            http()
                .get(status.endpoint.as_ref().unwrap())
                .bearer_auth(a["access_token"].as_str().unwrap())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            refresh(&status, &client_a, &a).await.status(),
            StatusCode::BAD_REQUEST
        );
        let result = call(
            &access_status(&status, &b),
            "cygnus_get_job",
            json!({"job_id":jobs[1]}),
        )
        .await;
        assert_ne!(result["result"]["isError"], true);
        assert!(result.get("error").is_none());
        assert_eq!(
            refresh(&status, &client_b, &b).await.status(),
            StatusCode::OK
        );
        m.stop().await;
    }
}

#[tokio::test]
async fn profiles_and_sftp_permissions_intersect_approval_with_restarted_settings() {
    // (approved read/write/execute, current read/write/execute, shrinking allowlist)
    for (approved, current, narrowing) in [
        ((false, false, false), (true, true, true), false),
        ((true, false, false), (true, true, true), false),
        ((true, true, true), (false, false, false), true),
    ] {
        let f = Fixture::new(true).await;
        let second =
            f.db.create_profile(
                serde_json::from_value(json!({
                    "name":"Second fixture", "host":"second.invalid", "port":22,
                    "username":"tester", "auth_type":"password", "protocol":"ssh"
                }))
                .unwrap(),
                &f.crypto,
            )
            .unwrap();
        let m = manager(&f);
        let mut initial = config(&f, approved.2);
        initial.allow_sftp_read = approved.0;
        initial.allow_sftp_write = approved.1;
        if narrowing {
            initial.profile_ids.push(second.id);
        }
        let status = m.start(initial).await.unwrap();
        let (client, tokens) = login(&m, &status, "Bounded approval").await;
        let port = Url::parse(status.endpoint.as_ref().unwrap())
            .unwrap()
            .port()
            .unwrap();
        m.stop().await;
        let mut next = config(&f, current.2);
        next.port = port;
        next.allow_sftp_read = current.0;
        next.allow_sftp_write = current.1;
        next.profile_ids = if narrowing {
            vec![second.id]
        } else {
            vec![f.profile_id, second.id]
        };
        let status = m.start(next).await.unwrap();
        let response = refresh(&status, &client, &tokens).await;
        assert_eq!(response.status(), StatusCode::OK);
        let tokens: Value = response.json().await.unwrap();
        let authorized = access_status(&status, &tokens);
        let servers = call(&authorized, "cygnus_list_servers", json!({})).await;
        let ids: Vec<i64> = servers["result"]["structuredContent"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|server| server["id"].as_i64().unwrap())
            .collect();
        assert_eq!(ids, vec![if narrowing { second.id } else { f.profile_id }]);
        let tools = rpc(&authorized, "tools/list", json!({})).await;
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.contains(&"cygnus_sftp_read"), approved.0 && current.0);
        assert_eq!(
            names.contains(&"cygnus_sftp_write"),
            approved.1 && current.1
        );
        assert_eq!(names.contains(&"cygnus_execute"), approved.2 && current.2);
        for (tool, args) in [
            (
                "cygnus_execute",
                json!({"profile_id":ids[0],"command":"must not execute"}),
            ),
            (
                "cygnus_sftp_write",
                json!({"profile_id":ids[0],"path":"/denied","content":"must not write"}),
            ),
        ] {
            let blocked = call(&authorized, tool, args).await;
            assert!(
                blocked.get("error").is_some() || blocked["result"]["isError"] == true,
                "{blocked}"
            );
        }
        m.stop().await;
    }
}

#[tokio::test]
async fn restarting_with_more_permissions_does_not_expand_an_old_approval() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let (client, tokens) = login(&m, &status, "Read only").await;
    let port = Url::parse(status.endpoint.as_ref().unwrap())
        .unwrap()
        .port()
        .unwrap();
    m.stop().await;
    let mut cfg = config(&f, true);
    cfg.port = port;
    let status = m.start(cfg).await.unwrap();
    let tokens: Value = refresh(&status, &client, &tokens)
        .await
        .json()
        .await
        .unwrap();
    let tools = rpc(&access_status(&status, &tokens), "tools/list", json!({})).await;
    assert!(!tools.to_string().contains("cygnus_execute"));
    m.stop().await;
}

#[tokio::test]
async fn invalid_resource_redirect_and_plain_pkce_do_not_create_approvals() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let client = register(&status, "Client").await;
    for (key, value) in [
        ("resource", "https://other.invalid/mcp"),
        ("redirect_uri", "http://127.0.0.1:54321/unregistered-path"),
        ("code_challenge_method", "plain"),
        ("response_type", "token"),
        ("scope", "admin"),
    ] {
        let mut params = HashMap::from([
            ("client_id", client.clone()),
            ("redirect_uri", REDIRECT.into()),
            ("response_type", "code".into()),
            ("code_challenge", hash(VERIFIER)),
            ("code_challenge_method", "S256".into()),
            ("resource", status.endpoint.clone().unwrap()),
        ]);
        params.insert(key, value.into());
        assert_eq!(
            http()
                .get(format!("{}/oauth/authorize", origin(&status)))
                .query(&params)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert!(m.oauth_approvals().await.is_empty());
    let client = login(&m, &status, "Valid client").await;
    assert_eq!(
        http()
            .post(format!("{}/oauth/token", origin(&status)))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client.0.as_str()),
                ("refresh_token", client.1["refresh_token"].as_str().unwrap()),
                ("resource", "https://other.invalid/mcp"),
            ])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        http()
            .post(format!("{}/oauth/token", origin(&status)))
            .header("Origin", origin(&status))
            .body("grant_type=refresh_token")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    m.stop().await;
}

#[tokio::test]
async fn expired_access_and_failed_persistence_fail_closed_without_consuming_refresh() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let (client, tokens) = login(&m, &status, "Client").await;
    {
        let running = m.running.lock().await;
        let mut inner = running.as_ref().unwrap().oauth.inner.lock().await;
        inner
            .tokens
            .get_mut(&hash(tokens["access_token"].as_str().unwrap()))
            .unwrap()
            .expires_at = 0;
    }
    assert_eq!(
        http()
            .get(status.endpoint.as_ref().unwrap())
            .bearer_auth(tokens["access_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    f.db.conn().execute_batch("CREATE TRIGGER fail_oauth_save BEFORE UPDATE ON mcp_oauth_state BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    assert_eq!(
        refresh(&status, &client, &tokens).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    f.db.conn()
        .execute_batch("DROP TRIGGER fail_oauth_save;")
        .unwrap();
    assert_eq!(
        refresh(&status, &client, &tokens).await.status(),
        StatusCode::OK
    );
    m.stop().await;
    let id = m.oauth_clients().await.unwrap()[0].id.clone();
    m.oauth_revoke(&id).await.unwrap();
    assert!(m.oauth_clients().await.unwrap().is_empty());
}

#[tokio::test]
async fn approval_capacity_and_request_limits_bound_unauthenticated_work() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    assert_eq!(
        http()
            .post(format!("{}/oauth/register", origin(&status)))
            .header("Content-Type", "application/json")
            .body("x".repeat(17 * 1024))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let client = register(&status, "Client").await;
    for _ in 0..8 {
        let _ = authorize(&status, &client).await;
    }
    assert_eq!(
        http()
            .get(format!("{}/oauth/authorize", origin(&status)))
            .query(&[
                ("client_id", client.as_str()),
                ("redirect_uri", REDIRECT),
                ("response_type", "code"),
                ("code_challenge", hash(VERIFIER).as_str()),
                ("code_challenge_method", "S256"),
            ])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(m.oauth_approvals().await.len(), 8);
    m.stop().await;
}

#[tokio::test]
async fn revoked_clients_can_reauthorize_without_registering_again() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let (client, _) = login(&m, &status, "Returning client").await;
    let port = Url::parse(status.endpoint.as_ref().unwrap())
        .unwrap()
        .port()
        .unwrap();
    m.stop().await;
    let id = m.oauth_clients().await.unwrap()[0].id.clone();
    m.oauth_revoke(&id).await.unwrap();
    let mut stored = store::load(&f.db).unwrap();
    stored
        .clients
        .iter_mut()
        .find(|c| c.id == client)
        .unwrap()
        .created_at = 0;
    store::save(&f.db, &stored).unwrap();
    let mut cfg = config(&f, false);
    cfg.port = port;
    let status = m.start(cfg).await.unwrap();
    let code = approve_code(&m, &status, &client).await;
    assert_eq!(
        exchange(&status, &client, &code, VERIFIER).await.status(),
        StatusCode::OK
    );
    m.stop().await;
}

#[tokio::test]
async fn native_callback_port_can_change_but_code_exchange_requires_the_exact_requested_uri() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let client = register(&status, "Native client").await;
    let redirect = "http://127.0.0.1:54322/callback";
    let wait = authorize_at(&status, &client, redirect).await;
    let pending = m.oauth_approvals().await.remove(0);
    assert_eq!(pending.redirect_uri, redirect);
    m.oauth_respond(&pending.id, true).await.unwrap();
    let response = http()
        .get(format!("{}/oauth/wait/{wait}", origin(&status)))
        .send()
        .await
        .unwrap();
    let callback = Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(callback.port(), Some(54322));
    let code = callback
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        exchange(&status, &client, &code, VERIFIER).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        http()
            .post(format!("{}/oauth/token", origin(&status)))
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", redirect),
                ("code_verifier", VERIFIER),
            ])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    m.stop().await;
}

#[tokio::test]
async fn stalled_oauth_bodies_are_bounded_and_cancelled_on_stop() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let address = origin(&status).trim_start_matches("http://").to_owned();
    let oauth = m.running.lock().await.as_ref().unwrap().oauth.clone();
    let mut sockets = Vec::new();
    for _ in 0..16 {
        let mut socket = tokio::net::TcpStream::connect(&address).await.unwrap();
        socket.write_all(format!("POST /oauth/token HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\n").as_bytes()).await.unwrap();
        sockets.push(socket);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while oauth.requests.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        http()
            .get(format!(
                "{}/.well-known/oauth-authorization-server",
                origin(&status)
            ))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    m.stop().await;
    for mut socket in sockets {
        let mut bytes = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut bytes))
            .await
            .expect("accepted socket must close");
    }
}
