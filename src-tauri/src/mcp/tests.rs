use super::*;
use crate::execution::tests::Fixture;
use crate::execution::ExecutionStatus;
use rmcp::model::CallToolRequestParams;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::ServiceExt;
use serde_json::{json, Value};

pub(super) fn manager(f: &Fixture) -> McpManager {
    McpManager::new(
        f.db.clone(),
        f.crypto.clone(),
        f.manager.clone(),
        f.ssh.clone(),
    )
}

pub(super) fn config(f: &Fixture, execution: bool) -> McpConfig {
    McpConfig {
        port: 0,
        profile_ids: vec![f.profile_id],
        allow_execution: execution,
        allow_sftp_read: false,
        allow_sftp_write: false,
    }
}

fn request(status: &McpStatus, body: Value) -> reqwest::RequestBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(status.endpoint.as_ref().unwrap())
        .bearer_auth(status.token.as_ref().unwrap())
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-11-25")
        .json(&body)
}

pub(super) async fn rpc(status: &McpStatus, method: &str, params: Value) -> Value {
    let response = request(
        status,
        json!({"jsonrpc":"2.0", "id":1, "method":method, "params":params}),
    )
    .send()
    .await
    .unwrap();
    let code = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(code, reqwest::StatusCode::OK, "{body}");
    serde_json::from_str(&body).unwrap()
}

pub(super) async fn call(status: &McpStatus, name: &str, arguments: Value) -> Value {
    rpc(
        status,
        "tools/call",
        json!({"name":name,"arguments":arguments}),
    )
    .await
}

#[tokio::test]
async fn initialize_and_list_tools_work_with_legacy_streamable_http() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    assert!(!m.status().await.running);
    let status = m.start(config(&f, true)).await.unwrap();
    let initialized = rpc(&status, "initialize", json!({"protocolVersion":"2025-11-25", "capabilities":{}, "clientInfo":{"name":"test","version":"1"}})).await;
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "cygnus-terminal"
    );
    let listed = rpc(&status, "tools/list", json!({})).await;
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 5);
    let execute = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "cygnus_execute")
        .unwrap();
    assert_eq!(execute["annotations"]["destructiveHint"], true);
    assert_eq!(execute["annotations"]["idempotentHint"], false);
    assert_eq!(execute["inputSchema"]["additionalProperties"], false);
    m.stop().await;
    assert!(!m.status().await.running);
}

#[tokio::test]
async fn authentication_origin_host_and_body_limits_are_enforced() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    let response = request(&status, body.clone())
        .header("Authorization", "Bearer wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(response.headers().contains_key("www-authenticate"));
    let wrong_token = McpStatus {
        token: Some("wrong-token".into()),
        ..status.clone()
    };
    assert_eq!(
        request(&wrong_token, body.clone())
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let response = reqwest::Client::new()
        .get(status.endpoint.as_ref().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    for (name, value) in [
        ("Origin", "https://malicious.example"),
        ("Origin", "null"),
        ("Host", "malicious.example"),
    ] {
        let response = request(&status, body.clone())
            .header(name, value)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN, "{name}");
    }
    let response = request(&status, body)
        .body("x".repeat(128 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    assert!(f.manager.list(100, 0).await.unwrap().is_empty());
    m.stop().await;
}

#[tokio::test]
async fn readonly_mode_does_not_advertise_or_allow_execution() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, false)).await.unwrap();
    let tools = rpc(&status, "tools/list", json!({})).await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 3);
    let result = call(
        &status,
        "cygnus_execute",
        json!({"profile_id":f.profile_id,"command":"success"}),
    )
    .await;
    assert!(result.get("error").is_some());
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
    m.stop().await;
}

#[tokio::test]
async fn shared_profile_and_job_boundaries_do_not_leak_credentials_or_history() {
    let f = Fixture::new(true).await;
    f.db.conn().execute("INSERT INTO profiles(name,host,username,auth_type) VALUES('Hidden','hidden.invalid','other','key')", []).unwrap();
    let hidden = f.db.conn().last_insert_rowid();
    let local_job = f.start("success").await;
    f.finished(&local_job).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let result = call(&status, "cygnus_list_servers", json!({})).await;
    let servers = result["result"]["structuredContent"]["servers"]
        .as_array()
        .unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["id"], f.profile_id);
    for forbidden in [
        "password",
        "key_path",
        "jump_host",
        "test-only-secret",
        "Hidden",
    ] {
        assert!(!result.to_string().contains(forbidden));
    }
    let result = call(
        &status,
        "cygnus_execute",
        json!({"profile_id":hidden,"command":"success"}),
    )
    .await;
    assert_eq!(result["result"]["isError"], true);
    for tool in ["cygnus_get_job", "cygnus_cancel_job"] {
        let result = call(&status, tool, json!({"job_id":local_job})).await;
        assert_eq!(result["result"]["isError"], true);
    }
    let result = call(&status, "cygnus_list_jobs", json!({})).await;
    assert_eq!(result["result"]["structuredContent"]["jobs"], json!([]));
    m.stop().await;
}

#[tokio::test]
async fn official_sdk_client_can_execute_and_retrieve_an_ssh_result() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let mut transport_config =
        StreamableHttpClientTransportConfig::with_uri(status.endpoint.clone().unwrap());
    transport_config.auth_header = status.token.clone();
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::builder().no_proxy().build().unwrap(),
        transport_config,
    );
    let client = ().serve(transport).await.unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 5);
    let result = client
        .call_tool(
            CallToolRequestParams::new("cygnus_execute").with_arguments(
                json!({"profile_id": f.profile_id, "command":"success"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_ne!(result.is_error, Some(true));
    let id = result.structured_content.unwrap()["job_id"]
        .as_str()
        .unwrap()
        .to_string();
    f.finished(&id).await;
    let result = client
        .call_tool(
            CallToolRequestParams::new("cygnus_get_job")
                .with_arguments(json!({"job_id":id}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    let job = result.structured_content.unwrap();
    assert_eq!(job["status"], "succeeded");
    assert_eq!(job["stdout"], "hello\n");
    assert_eq!(job["stderr"], "diagnostic\n");
    assert_eq!(job["exit_code"], 0);
    client.cancel().await.unwrap();
    m.stop().await;
}

#[tokio::test]
async fn stopping_revokes_access_cancels_jobs_and_rotates_the_token() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let first = m.start(config(&f, true)).await.unwrap();
    let result = call(
        &first,
        "cygnus_execute",
        json!({"profile_id":f.profile_id,"command":"hang"}),
    )
    .await;
    let id = result["result"]["structuredContent"]["job_id"]
        .as_str()
        .unwrap()
        .to_string();
    f.has_output(&id).await;
    m.stop().await;
    assert_eq!(
        f.finished(&id).await.summary.status,
        ExecutionStatus::Cancelled
    );
    let second = m.start(config(&f, true)).await.unwrap();
    assert_ne!(first.token, second.token);
    let revoked = McpStatus {
        token: first.token.clone(),
        ..second.clone()
    };
    let response = request(
        &revoked,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(&second, "cygnus_get_job", json!({"job_id":id})).await["result"]["isError"],
        true
    );
    m.stop().await;
}

#[tokio::test]
async fn locked_credentials_return_an_actionable_error_without_starting_a_job() {
    let f = Fixture::new(true).await;
    let m = McpManager::new(
        f.db.clone(),
        CryptoManager::new(),
        f.manager.clone(),
        f.ssh.clone(),
    );
    let status = m.start(config(&f, true)).await.unwrap();
    let result = call(
        &status,
        "cygnus_execute",
        json!({"profile_id":f.profile_id,"command":"success"}),
    )
    .await;
    assert_eq!(result["result"]["isError"], true);
    assert!(result["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Unlock saved credentials"));
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
    m.stop().await;
}

#[tokio::test]
async fn invalid_config_arguments_and_duplicate_start_do_not_expand_access() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    assert!(m
        .start(McpConfig {
            port: 0,
            profile_ids: vec![],
            allow_execution: true,
            allow_sftp_read: false,
            allow_sftp_write: false,
        })
        .await
        .is_err());
    assert!(m
        .start(McpConfig {
            port: 0,
            profile_ids: vec![999999],
            allow_execution: true,
            allow_sftp_read: false,
            allow_sftp_write: false,
        })
        .await
        .is_err());
    let status = m.start(config(&f, true)).await.unwrap();
    assert!(m.start(config(&f, false)).await.is_err());
    let result = call(
        &status,
        "cygnus_execute",
        json!({"profile_id":f.profile_id,"command":"success","password":"should-not-be-accepted"}),
    )
    .await;
    assert!(result.get("error").is_some() || result["result"]["isError"] == true);
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
    m.stop().await;
}

async fn stopping_closes_incomplete_http_request(incomplete_body: bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let address = status
        .endpoint
        .as_ref()
        .unwrap()
        .strip_prefix("http://")
        .unwrap()
        .strip_suffix("/mcp")
        .unwrap();
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!("POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 100\r\n", status.token.as_ref().unwrap());
    socket.write_all(headers.as_bytes()).await.unwrap();
    if incomplete_body {
        socket.write_all(b"\r\n{\"jsonrpc\":").await.unwrap();
    }
    // Give the server time to accept and start reading; no real servers/keychain involved.
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::timeout(Duration::from_secs(3), m.stop())
        .await
        .expect("MCP stop must be bounded");
    assert!(!m.status().await.running);
    let mut response = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut response))
        .await
        .expect("MCP stop must close pending HTTP connections");
    if let Err(error) = closed {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ),
            "{error}"
        );
    }
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn stopping_closes_incomplete_http_body() {
    stopping_closes_incomplete_http_request(true).await;
}

#[tokio::test]
async fn stopping_closes_incomplete_http_headers() {
    stopping_closes_incomplete_http_request(false).await;
}

#[tokio::test]
async fn deleted_results_do_not_break_mcp_listing_or_pagination() {
    let f = Fixture::new(true).await;
    let m = manager(&f);
    let status = m.start(config(&f, true)).await.unwrap();
    let execute = || {
        call(
            &status,
            "cygnus_execute",
            json!({"profile_id":f.profile_id,"command":"success"}),
        )
    };
    let response = execute().await;
    let old = response["result"]["structuredContent"]["job_id"]
        .as_str()
        .unwrap();
    f.finished(old).await;
    f.manager.clear_history().await.unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let response = execute().await;
        let id = response["result"]["structuredContent"]["job_id"]
            .as_str()
            .unwrap()
            .to_string();
        f.finished(&id).await;
        ids.push(id);
    }
    let listed = call(&status, "cygnus_list_jobs", json!({})).await;
    assert_eq!(
        listed["result"]["structuredContent"]["jobs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let page = call(&status, "cygnus_list_jobs", json!({"limit":1,"offset":1})).await;
    assert_eq!(page["result"]["structuredContent"]["jobs"][0]["id"], ids[0]);
    let deleted = call(&status, "cygnus_get_job", json!({"job_id":old})).await;
    assert_eq!(deleted["result"]["isError"], true);
    assert!(deleted.to_string().contains("do not automatically repeat"));
    m.stop().await;
}
