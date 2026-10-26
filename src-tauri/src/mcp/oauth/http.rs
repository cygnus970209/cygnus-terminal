use super::*;
use axum::{
    extract::{DefaultBodyLimit, Path, Query},
    response::{Html, Redirect},
    routing::{get, post},
    Form, Json,
};
use serde_json::{json, Value};

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}
fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_request")
}
fn unavailable() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable")
}

pub(super) fn routes(state: Arc<OAuth>) -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(server_metadata),
        )
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/wait/{id}", get(wait))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn guard(State(state): State<Arc<OAuth>>, request: Request, next: Next) -> Response {
    // Bound to loopback, and reject DNS rebinding, cross-origin fetches and framing.
    // Normal browser navigations to the authorization page do not send Origin.
    let expected = state.origin.strip_prefix("http://").unwrap();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    if (host != Some(expected) && !(state.port == 80 && host == Some("127.0.0.1:80")))
        || request.headers().contains_key(header::ORIGIN)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.uri().path() == "/oauth/authorize"
        || request.uri().path().starts_with("/oauth/wait/")
    {
        // GET navigations and no-cors subresources may omit Origin. Native
        // clients open the browser directly; waiting-page refreshes are same-origin.
        // Absent fetch metadata remains supported for older browsers/native clients.
        let site = request.headers().get("sec-fetch-site");
        let destination = request.headers().get("sec-fetch-dest");
        if site.is_some_and(|value| value != "none" && value != "same-origin")
            || destination.is_some_and(|value| value != "document")
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if state.shutdown.is_cancelled() {
        return unavailable();
    }
    let Ok(_permit) = state.requests.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "slow_down");
    };
    let mut response = tokio::select! {
        biased;
        _ = state.shutdown.cancelled() => unavailable(),
        result = tokio::time::timeout(Duration::from_secs(15), next.run(request)) =>
            result.unwrap_or_else(|_| StatusCode::REQUEST_TIMEOUT.into_response()),
    };
    for (name, value) in [
        ("cache-control", "no-store"),
        ("pragma", "no-cache"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(name),
            axum::http::HeaderValue::from_static(value),
        );
    }
    response
}

async fn resource_metadata(State(state): State<Arc<OAuth>>) -> Json<Value> {
    Json(
        json!({"resource":state.resource,"authorization_servers":[state.origin],"scopes_supported":[SCOPE],"bearer_methods_supported":["header"]}),
    )
}
async fn server_metadata(State(state): State<Arc<OAuth>>) -> Json<Value> {
    Json(
        json!({"issuer":state.origin,"authorization_endpoint":format!("{}/oauth/authorize",state.origin),
        "token_endpoint":format!("{}/oauth/token",state.origin),"registration_endpoint":format!("{}/oauth/register",state.origin),
        "revocation_endpoint":format!("{}/oauth/revoke",state.origin),"response_types_supported":["code"],
        "grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],
        "code_challenge_methods_supported":["S256"],"scopes_supported":[SCOPE,"offline_access"],
        "authorization_response_iss_parameter_supported":true}),
    )
}

#[derive(Deserialize)]
struct Registration {
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}
fn valid_redirect(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    value.len() <= 1024
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.port_or_known_default().is_some_and(|port| port > 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.query().is_none()
}

fn redirect_matches(registered: &str, requested: &str) -> bool {
    if !valid_redirect(requested) {
        return false;
    }
    let (Ok(mut registered), Ok(mut requested)) = (Url::parse(registered), Url::parse(requested))
    else {
        return false;
    };
    // RFC 8252 §7.3: native clients choose a fresh callback port on each login.
    // Scheme, loopback host and path stay registered; the issued code is then
    // bound to the exact requested URI during the token exchange.
    let _ = registered.set_port(None);
    let _ = requested.set_port(None);
    registered == requested
}
async fn register(State(state): State<Arc<OAuth>>, Json(request): Json<Registration>) -> Response {
    let name = request.client_name.unwrap_or_else(|| "MCP client".into());
    if name.trim().is_empty()
        || name.len() > 120
        || name.chars().any(char::is_control)
        || request.redirect_uris.is_empty()
        || request.redirect_uris.len() > 8
        || request.redirect_uris.iter().any(|u| !valid_redirect(u))
        || request
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|m| m != "none")
        || request.grant_types.as_ref().is_some_and(|types| {
            types
                .iter()
                .any(|t| t != "authorization_code" && t != "refresh_token")
        })
        || request
            .response_types
            .as_ref()
            .is_some_and(|types| types.iter().any(|t| t != "code"))
    {
        return invalid();
    }
    let mut inner = state.inner.lock().await;
    if !inner.rate("register", 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "slow_down");
    }
    let mut next = inner.stored.clone();
    next.clients.retain(|c| {
        c.id == "cygnus-cursor-desktop"
            || c.ever_approved
            || c.created_at + 3600 > now()
            || next.grants.iter().any(|g| g.client_id == c.id)
    });
    if next.clients.len() >= 128 {
        return error(StatusCode::TOO_MANY_REQUESTS, "registration_limit");
    }
    let client = Client {
        id: random(),
        name,
        redirect_uris: request.redirect_uris,
        created_at: now(),
        ever_approved: false,
    };
    next.clients.push(client.clone());
    if store::save(&state.backend.db, &next).is_err() {
        return unavailable();
    }
    inner.stored = next;
    (StatusCode::CREATED, Json(json!({"client_id":client.id,"client_name":client.name,"client_id_issued_at":client.created_at,
        "redirect_uris":client.redirect_uris,"token_endpoint_auth_method":"none",
        "grant_types":["authorization_code","refresh_token"],"response_types":["code"]}))).into_response()
}

#[derive(Deserialize)]
struct Authorization {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    state: Option<String>,
    resource: Option<String>,
    scope: Option<String>,
}
fn valid_scope(scope: Option<&str>) -> bool {
    scope.is_none_or(|scope| {
        scope
            .split_whitespace()
            .all(|s| s == SCOPE || s == "offline_access")
    })
}
async fn authorize(
    State(state): State<Arc<OAuth>>,
    Query(request): Query<Authorization>,
) -> Response {
    if request.response_type != "code"
        || request.code_challenge_method != "S256"
        || URL_SAFE_NO_PAD.decode(&request.code_challenge).is_err()
        || request.code_challenge.len() != 43
        || request
            .resource
            .as_ref()
            .is_some_and(|r| r != &state.resource)
        || request.state.as_ref().is_some_and(|s| s.len() > 1024)
        || !valid_scope(request.scope.as_deref())
    {
        return invalid();
    }
    let mut inner = state.inner.lock().await;
    inner.clean();
    if !inner.rate("authorize", 12) || inner.pending.len() >= 8 {
        return error(StatusCode::TOO_MANY_REQUESTS, "slow_down");
    }
    let Some(client) = inner
        .stored
        .clients
        .iter()
        .find(|c| {
            c.id == request.client_id
                && c.redirect_uris.iter().any(|uri| {
                    if c.id == "cygnus-cursor-desktop" {
                        uri == &request.redirect_uri
                    } else {
                        redirect_matches(uri, &request.redirect_uri)
                    }
                })
        })
        .cloned()
    else {
        return invalid();
    };
    let wait_id = random();
    let code = random()[..8].to_uppercase();
    let approval = Approval {
        id: random(),
        client_name: client.name.clone(),
        redirect_uri: request.redirect_uri.clone(),
        verification_code: code.clone(),
        expires_at: now() + APPROVAL_TTL,
        profile_ids: state.config.profile_ids.clone(),
        allow_execution: state.config.allow_execution,
        allow_sftp_read: state.config.allow_sftp_read,
        allow_sftp_write: state.config.allow_sftp_write,
    };
    inner.pending.insert(
        wait_id.clone(),
        Pending {
            approval,
            client,
            redirect_uri: request.redirect_uri,
            state: request.state,
            challenge: request.code_challenge,
            decision: None,
        },
    );
    if state
        .notify
        .as_ref()
        .is_some_and(|notify| notify().is_err())
    {
        inner.pending.remove(&wait_id);
        return unavailable();
    }
    waiting_page(&wait_id, &code)
}

fn waiting_page(id: &str, code: &str) -> Response {
    // Only server-generated URL-safe characters are interpolated. No client-controlled HTML.
    Html(format!("<!doctype html><html lang=en><meta charset=utf-8><meta http-equiv=refresh content=\"1;url=/oauth/wait/{id}\"><title>Approve in Cygnus Terminal</title><h1>Approve this connection in Cygnus Terminal</h1><p>Switch to Cygnus and match this code before approving:</p><h2>{code}</h2><p>This page will return to your AI client after approval. The request expires in five minutes.</p></html>")).into_response()
}

async fn wait(State(state): State<Arc<OAuth>>, Path(id): Path<String>) -> Response {
    let mut inner = state.inner.lock().await;
    inner.clean();
    let Some(pending) = inner.pending.get(&id) else {
        return (
            StatusCode::GONE,
            Html("Authorization expired or completed. Start authentication again in your client."),
        )
            .into_response();
    };
    let Some(accepted) = pending.decision else {
        return waiting_page(&id, &pending.approval.verification_code);
    };
    let pending = inner.pending.remove(&id).expect("present pending");
    let mut redirect = Url::parse(&pending.redirect_uri).expect("validated redirect");
    if let Some(value) = &pending.state {
        redirect.query_pairs_mut().append_pair("state", value);
    }
    redirect.query_pairs_mut().append_pair("iss", &state.origin);
    if accepted {
        if inner.codes.len() >= 32 {
            return unavailable();
        }
        let code = random();
        redirect.query_pairs_mut().append_pair("code", &code);
        inner.codes.insert(
            hash(&code),
            Code {
                pending,
                expires_at: now() + CODE_TTL,
            },
        );
    } else {
        redirect
            .query_pairs_mut()
            .append_pair("error", "access_denied");
    }
    Redirect::to(redirect.as_str()).into_response()
}

#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    client_id: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    resource: Option<String>,
    scope: Option<String>,
}
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
}
async fn token(State(state): State<Arc<OAuth>>, Form(request): Form<TokenRequest>) -> Response {
    if request
        .resource
        .as_ref()
        .is_some_and(|r| r != &state.resource)
        || !valid_scope(request.scope.as_deref())
    {
        return invalid();
    }
    let mut inner = state.inner.lock().await;
    inner.clean();
    if !inner.rate("token", 120) || inner.tokens.len() >= 512 {
        return error(StatusCode::TOO_MANY_REQUESTS, "slow_down");
    }
    let mut next = inner.stored.clone();
    next.grants.retain(|g| g.expires_at > now());
    let refresh = Zeroizing::new(random());
    let grant_id;
    let mut used_code = None;
    match request.grant_type.as_str() {
        "authorization_code" => {
            let code_hash = hash(request.code.as_deref().unwrap_or(""));
            let Some(code) = inner.codes.get(&code_hash) else {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            let verifier = request.code_verifier.as_deref().unwrap_or("");
            if request.client_id != code.pending.client.id
                || request.redirect_uri.as_deref() != Some(&code.pending.redirect_uri)
                || !valid_verifier(verifier)
                || !equal(&hash(verifier), &code.pending.challenge)
            {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            if next.grants.len() >= 64 {
                return error(StatusCode::BAD_REQUEST, "authorization_limit");
            }
            grant_id = random();
            if let Some(client) = next.clients.iter_mut().find(|c| c.id == request.client_id) {
                client.ever_approved = true;
            }
            next.grants.push(Grant {
                id: grant_id.clone(),
                client_id: request.client_id,
                client_name: code.pending.client.name.clone(),
                resource: state.resource.clone(),
                config: state.config.clone(),
                approved_at: now(),
                expires_at: now() + REFRESH_TTL,
                refresh_hash: hash(&refresh),
                used_refresh_hashes: Vec::new(),
            });
            used_code = Some(code_hash);
        }
        "refresh_token" => {
            let refresh_hash = hash(request.refresh_token.as_deref().unwrap_or(""));
            // Reuse of a rotated refresh token revokes that authorization family.
            if let Some(grant) = next.grants.iter().find(|g| {
                g.client_id == request.client_id
                    && g.used_refresh_hashes
                        .iter()
                        .any(|h| equal(h, &refresh_hash))
            }) {
                let id = grant.id.clone();
                drop(inner);
                return if state.revoke(&id).await.is_ok() {
                    error(StatusCode::BAD_REQUEST, "invalid_grant")
                } else {
                    unavailable()
                };
            }
            let Some(grant) = next.grants.iter_mut().find(|g| {
                g.client_id == request.client_id
                    && g.resource == state.resource
                    && g.expires_at > now()
                    && equal(&g.refresh_hash, &refresh_hash)
            }) else {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            grant_id = grant.id.clone();
            grant.used_refresh_hashes.push(grant.refresh_hash.clone());
            if grant.used_refresh_hashes.len() > 128 {
                grant.used_refresh_hashes.remove(0);
            }
            grant.refresh_hash = hash(&refresh);
            grant.expires_at = now() + REFRESH_TTL;
        }
        _ => return error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
    }
    if store::save(&state.backend.db, &next).is_err() {
        return unavailable();
    }
    inner.stored = next;
    if let Some(code) = used_code {
        inner.codes.remove(&code);
    }
    let access = Zeroizing::new(random());
    inner.tokens.insert(
        hash(&access),
        AccessToken {
            grant_id,
            expires_at: now() + ACCESS_TTL,
        },
    );
    Json(json!({"access_token":access.as_str(),"token_type":"Bearer","expires_in":ACCESS_TTL,"refresh_token":refresh.as_str(),"scope":SCOPE})).into_response()
}

#[derive(Deserialize)]
struct Revocation {
    token: String,
    client_id: String,
}
async fn revoke(State(state): State<Arc<OAuth>>, Form(request): Form<Revocation>) -> Response {
    let inner = state.inner.lock().await;
    let digest = hash(&request.token);
    let id = inner
        .stored
        .grants
        .iter()
        .find(|g| {
            g.client_id == request.client_id
                && (equal(&g.refresh_hash, &digest)
                    || g.used_refresh_hashes.iter().any(|h| equal(h, &digest))
                    || inner
                        .tokens
                        .get(&digest)
                        .is_some_and(|t| t.grant_id == g.id))
        })
        .map(|g| g.id.clone());
    drop(inner);
    if let Some(id) = id {
        if state.revoke(&id).await.is_err() {
            return unavailable();
        }
    }
    StatusCode::OK.into_response()
}
