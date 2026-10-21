//! Gmail for the workspace Emails panel: sign-in, inbox, threads, and replies.
//!
//! OAuth uses PKCE with a loopback redirect (adapted from EEMail). Tokens live
//! in Windows Credential Manager and never reach the webview; every Gmail
//! request runs here, so the UI only receives parsed message data.
use base64::Engine;
use futures::future::join_all;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
// gmail.modify covers reading, marking read, and sending replies.
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/gmail.modify";
const KEYRING_SERVICE: &str = "com.anupa.wallp";
const KEYRING_USER: &str = "google-oauth";
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);
const PAGE_SIZE: &str = "30";

/// Full record persisted in the OS credential store.
#[derive(Serialize, Deserialize)]
struct StoredAccount {
    email: String,
    name: Option<String>,
    refresh_token: String,
    access_token: String,
    expires_at: u64,
}

/// The only account shape returned to the webview.
#[derive(Serialize)]
pub struct Account {
    email: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Address {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    email: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    id: String,
    thread_id: String,
    from: Address,
    to: Vec<Address>,
    subject: String,
    snippet: String,
    /// Milliseconds since the Unix epoch.
    date: i64,
    unread: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_html: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    messages: Vec<Message>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailMessage {
    id: String,
    thread_id: String,
    label_ids: Option<Vec<String>>,
    snippet: Option<String>,
    internal_date: Option<String>,
    payload: Option<GmailPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailPart {
    mime_type: Option<String>,
    headers: Option<Vec<GmailHeader>>,
    body: Option<GmailBody>,
    parts: Option<Vec<GmailPart>>,
}

#[derive(Deserialize)]
struct GmailHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct GmailBody {
    data: Option<String>,
}

impl GmailMessage {
    fn header(&self, name: &str) -> String {
        self.payload
            .as_ref()
            .and_then(|p| p.headers.as_ref())
            .and_then(|hs| hs.iter().find(|h| h.name.eq_ignore_ascii_case(name)))
            .map(|h| h.value.clone())
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Credentials and tokens
// ---------------------------------------------------------------------------

fn client() -> Result<(&'static str, &'static str), String> {
    let (id, secret) = (env!("GOOGLE_CLIENT_ID"), env!("GOOGLE_CLIENT_SECRET"));
    if id.is_empty() || secret.is_empty() {
        return Err(
            "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and rebuild wallp.".into(),
        );
    }
    Ok((id, secret))
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn load_stored() -> Result<Option<StoredAccount>, String> {
    match keyring_entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("Stored Google credentials are corrupt: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save_stored(account: &StoredAccount) -> Result<(), String> {
    let json = serde_json::to_string(account).map_err(|e| e.to_string())?;
    keyring_entry()?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Waits for Google's redirect on the loopback listener and returns the
/// authorization code after checking `state`.
async fn wait_for_redirect(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..n]).into_owned();
        let Some(path) = request.split_whitespace().nth(1) else {
            continue;
        };
        // Browsers also request /favicon.ico; only handle the redirect itself.
        let Ok(url) = url::Url::parse(&format!("http://localhost{path}")) else {
            continue;
        };
        let (mut code, mut state, mut error) = (None, None, None);
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }
        if code.is_none() && error.is_none() {
            continue;
        }
        let message = match &error {
            Some(e) => format!("Sign-in failed: {e}. You can close this tab."),
            None => "Signed in. You can close this tab and return to wallp.".into(),
        };
        let body = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>wallp</title></head>\
             <body style=\"font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#ccc\">\
             <p>{message}</p></body></html>"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;

        if let Some(e) = error {
            return Err(format!("Google returned an error: {e}"));
        }
        if state.as_deref() != Some(expected_state) {
            return Err("Sign-in failed a security check. Please try again.".into());
        }
        return code.ok_or_else(|| "Google did not return a sign-in code.".into());
    }
}

async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let res = reqwest::Client::new()
        .post(TOKEN_URI)
        .form(form)
        .send()
        .await
        .map_err(|_| "Could not reach Google. Check your connection.".to_owned())?;
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Google rejected the token request: {body}"));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Returns a valid access token, refreshing it if it expires within 60s.
async fn access_token() -> Result<String, String> {
    let mut account = load_stored()?.ok_or("Connect a Google account first.")?;
    if account.expires_at > now_unix() + 60 {
        return Ok(account.access_token);
    }
    let (id, secret) = client()?;
    let tokens = token_request(&[
        ("client_id", id),
        ("client_secret", secret),
        ("refresh_token", account.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    account.access_token = tokens.access_token;
    account.expires_at = now_unix() + tokens.expires_in;
    if let Some(rt) = tokens.refresh_token {
        account.refresh_token = rt;
    }
    save_stored(&account)?;
    Ok(account.access_token)
}

#[tauri::command]
pub fn email_account() -> Result<Option<Account>, String> {
    Ok(load_stored()?.map(|a| Account {
        email: a.email,
        name: a.name,
    }))
}

/// Opens the system browser and waits until the user finishes (or abandons)
/// Google's consent screen, then stores the tokens.
#[tauri::command]
pub async fn email_connect(app: tauri::AppHandle) -> Result<Account, String> {
    let (id, secret) = client()?;
    let verifier = random_urlsafe(48);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let state = random_urlsafe(24);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Couldn't start the sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{port}");
    let auth_url = url::Url::parse_with_params(
        AUTH_URI,
        &[
            ("client_id", id),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;

    let code = tokio::time::timeout(AUTH_TIMEOUT, wait_for_redirect(listener, &state))
        .await
        .map_err(|_| "Sign-in timed out. Please try again.".to_owned())??;
    let tokens = token_request(&[
        ("code", code.as_str()),
        ("client_id", id),
        ("client_secret", secret),
        ("redirect_uri", redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier.as_str()),
    ])
    .await?;
    let refresh_token = tokens
        .refresh_token
        .ok_or("Google did not return a refresh token.")?;
    let user = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    let email = user["email"]
        .as_str()
        .ok_or("Google did not share the account email.")?;
    let account = StoredAccount {
        email: email.to_owned(),
        name: user["name"].as_str().map(str::to_owned),
        refresh_token,
        access_token: tokens.access_token,
        expires_at: now_unix() + tokens.expires_in,
    };
    save_stored(&account)?;
    Ok(Account {
        email: account.email,
        name: account.name,
    })
}

#[tauri::command]
pub fn email_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    crate::mail_cache::clear(&app)?;
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Gmail requests and parsing
// ---------------------------------------------------------------------------

async fn api(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = request
        .send()
        .await
        .map_err(|_| "Could not reach Gmail. Check your connection.".to_owned())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(match status.as_u16() {
            401 | 403 => format!("Gmail denied access. Reconnect your account. ({body})"),
            _ => format!("Gmail returned HTTP {}: {body}", status.as_u16()),
        });
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Splits an address header on commas outside quoted names, so
/// `"Doe, Jane" <jane@x.com>, bob@y.com` yields two entries.
fn split_addresses(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut in_quotes, mut start) = (false, 0);
    for (i, c) in value.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                parts.push(&value[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&value[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_address(raw: &str) -> Address {
    if let (Some(lt), Some(gt)) = (raw.find('<'), raw.rfind('>')) {
        if lt < gt {
            let name = raw[..lt].trim().trim_matches('"').trim();
            return Address {
                name: (!name.is_empty()).then(|| name.to_owned()),
                email: raw[lt + 1..gt].trim().to_owned(),
            };
        }
    }
    Address {
        name: None,
        email: raw.trim().to_owned(),
    }
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#34;", "\"")
        .replace("&amp;", "&")
}

/// Depth-first search for the first part of a MIME type with inline data.
fn find_part(part: &GmailPart, mime: &str) -> Option<String> {
    if part
        .mime_type
        .as_deref()
        .is_some_and(|m| m.eq_ignore_ascii_case(mime))
    {
        if let Some(data) = part.body.as_ref().and_then(|b| b.data.as_deref()) {
            if let Ok(bytes) =
                base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(data.trim_end_matches('='))
            {
                return Some(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }
    part.parts
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find_map(|child| find_part(child, mime))
}

fn to_message(msg: GmailMessage, full: bool) -> Message {
    let labels = msg.label_ids.as_deref().unwrap_or(&[]);
    let subject = msg.header("Subject");
    let (body, body_html) = match (full, msg.payload.as_ref()) {
        (true, Some(payload)) => (
            find_part(payload, "text/plain").map(|t| t.trim().to_owned()),
            find_part(payload, "text/html"),
        ),
        _ => (None, None),
    };
    Message {
        from: parse_address(&msg.header("From")),
        to: split_addresses(&msg.header("To"))
            .into_iter()
            .map(parse_address)
            .collect(),
        subject: if subject.is_empty() {
            "(no subject)".into()
        } else {
            subject
        },
        snippet: decode_entities(msg.snippet.as_deref().unwrap_or("")),
        date: msg
            .internal_date
            .as_deref()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0),
        unread: labels.iter().any(|l| l == "UNREAD"),
        body,
        body_html,
        id: msg.id,
        thread_id: msg.thread_id,
    }
}

fn account_email() -> Result<String, String> {
    Ok(load_stored()?
        .ok_or("Connect a Google account first.")?
        .email)
}

const META_QUERY: &str =
    "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject";

/// Listing metadata for many messages in one HTTP round trip via Gmail's
/// multipart batch endpoint, falling back to parallel requests if rejected.
/// Results keep the order of `ids`; failed lookups are skipped.
async fn fetch_metas(http: &reqwest::Client, token: &str, ids: &[String]) -> Vec<Message> {
    if ids.is_empty() {
        return Vec::new();
    }
    let mut found = match fetch_metas_batch(http, token, ids).await {
        Ok(found) => found,
        Err(_) => join_all(ids.iter().map(|id| {
            api(http
                .get(format!("{GMAIL}/messages/{id}?{META_QUERY}"))
                .bearer_auth(token))
        }))
        .await
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|v| serde_json::from_value::<GmailMessage>(v).ok())
        .map(|m| to_message(m, false))
        .collect(),
    };
    let position = |id: &str| ids.iter().position(|i| i == id).unwrap_or(usize::MAX);
    found.sort_by_key(|m| position(&m.id));
    found
}

async fn fetch_metas_batch(
    http: &reqwest::Client,
    token: &str,
    ids: &[String],
) -> Result<Vec<Message>, String> {
    let boundary = "wallp_batch";
    let mut body = String::new();
    for (i, id) in ids.iter().enumerate() {
        body.push_str(&format!(
            "--{boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-{i}>\r\n\r\n\
             GET /gmail/v1/users/me/messages/{id}?{META_QUERY}\r\n\r\n"
        ));
    }
    body.push_str(&format!("--{boundary}--\r\n"));
    let res = http
        .post("https://www.googleapis.com/batch/gmail/v1")
        .bearer_auth(token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/mixed; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Gmail batch error ({status})"));
    }
    let delimiter = content_type
        .split(';')
        .find_map(|p| p.trim().strip_prefix("boundary="))
        .map(|b| format!("--{}", b.trim_matches('"')))
        .ok_or("Gmail batch response has no boundary")?;
    // Each part: part headers, then an HTTP status line, headers, and a JSON body.
    let messages: Vec<Message> = text
        .split(&delimiter)
        .filter_map(|part| {
            let response = &part[part.find("HTTP/")?..];
            let json = &response[response.find('{')?..=response.rfind('}')?];
            serde_json::from_str::<GmailMessage>(json).ok()
        })
        .map(|m| to_message(m, false))
        .collect();
    // A batch where every item failed (e.g. rate limited) should use the fallback.
    if messages.is_empty() {
        return Err("Gmail batch returned no messages".into());
    }
    Ok(messages)
}

fn cached_inbox(app: &tauri::AppHandle, account: &str) -> Option<InboxPage> {
    crate::mail_cache::load_inbox(app, account).and_then(|data| serde_json::from_str(&data).ok())
}

fn save_inbox(app: &tauri::AppHandle, account: &str, inbox: &InboxPage) {
    if let Ok(data) = serde_json::to_string(inbox) {
        let _ = crate::mail_cache::save_inbox(app, account, &data);
    }
}

fn save_thread(app: &tauri::AppHandle, account: &str, thread_id: &str, messages: &[Message]) {
    if let Ok(data) = serde_json::to_string(messages) {
        let _ = crate::mail_cache::save_thread(app, account, thread_id, &data);
    }
}

#[tauri::command]
pub fn email_cached_inbox(app: tauri::AppHandle) -> Result<Option<InboxPage>, String> {
    Ok(cached_inbox(&app, &account_email()?))
}

/// Syncs the inbox and returns the whole merged listing. With no page token
/// it refreshes the newest page while keeping older pages already loaded;
/// with one it appends the next older page.
#[tauri::command]
pub async fn email_inbox(
    app: tauri::AppHandle,
    page_token: Option<String>,
) -> Result<InboxPage, String> {
    let account = account_email()?;
    let token = access_token().await?;
    let http = reqwest::Client::new();
    let mut query = vec![("maxResults", PAGE_SIZE), ("labelIds", "INBOX")];
    if let Some(pt) = page_token.as_deref() {
        query.push(("pageToken", pt));
    }
    let list = api(http
        .get(format!("{GMAIL}/messages"))
        .query(&query)
        .bearer_auth(&token))
    .await?;
    let ids: Vec<String> = list["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let fresh = fetch_metas(&http, &token, &ids).await;
    // Don't let a mostly failed sync wipe rows from the cached listing.
    if fresh.len() < ids.len() / 2 {
        return Err("Gmail didn't return your messages. Retrying shortly.".into());
    }
    let next = list["nextPageToken"].as_str().map(str::to_owned);
    let cached = cached_inbox(&app, &account).unwrap_or_default();

    let inbox = if page_token.is_some() {
        let mut messages = cached.messages;
        let known: std::collections::HashSet<String> =
            messages.iter().map(|m| m.id.clone()).collect();
        messages.extend(fresh.into_iter().filter(|m| !known.contains(&m.id)));
        InboxPage {
            messages,
            next_page_token: next,
        }
    } else {
        // Everything newer than the oldest fresh row comes from Gmail (so
        // archived mail disappears); older cached pages stay below it.
        let oldest = fresh.last().map_or(i64::MAX, |m| m.date);
        let kept: Vec<Message> = cached
            .messages
            .into_iter()
            .filter(|m| m.date < oldest && !ids.contains(&m.id))
            .collect();
        let next_page_token = if kept.is_empty() || next.is_none() {
            next
        } else {
            cached.next_page_token
        };
        let mut messages = fresh;
        messages.extend(kept);
        InboxPage {
            messages,
            next_page_token,
        }
    };
    save_inbox(&app, &account, &inbox);
    Ok(inbox)
}

#[tauri::command]
pub fn email_cached_thread(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<Option<Vec<Message>>, String> {
    let account = account_email()?;
    Ok(crate::mail_cache::load_thread(&app, &account, &thread_id)
        .and_then(|data| serde_json::from_str(&data).ok()))
}

/// Fetches a whole conversation, oldest first, and caches it.
async fn sync_thread(
    app: &tauri::AppHandle,
    account: &str,
    http: &reqwest::Client,
    token: &str,
    thread_id: &str,
) -> Result<Vec<Message>, String> {
    let value = api(http
        .get(format!("{GMAIL}/threads/{thread_id}"))
        .query(&[("format", "full")])
        .bearer_auth(token))
    .await?;
    let mut messages: Vec<Message> = value["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value::<GmailMessage>(v).ok())
        .map(|m| to_message(m, true))
        .collect();
    messages.sort_by_key(|m| m.date);
    save_thread(app, account, thread_id, &messages);
    Ok(messages)
}

/// Syncs a conversation and marks it read, in Gmail and in both caches.
#[tauri::command]
pub async fn email_thread(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<Vec<Message>, String> {
    let account = account_email()?;
    let token = access_token().await?;
    let http = reqwest::Client::new();
    let mut messages = sync_thread(&app, &account, &http, &token, &thread_id).await?;
    if messages.iter().any(|m| m.unread) {
        api(http
            .post(format!("{GMAIL}/threads/{thread_id}/modify"))
            .bearer_auth(&token)
            .json(&json!({ "removeLabelIds": ["UNREAD"] })))
        .await?;
        messages.iter_mut().for_each(|m| m.unread = false);
        save_thread(&app, &account, &thread_id, &messages);
    }
    if let Some(mut inbox) = cached_inbox(&app, &account) {
        if inbox
            .messages
            .iter()
            .any(|m| m.thread_id == thread_id && m.unread)
        {
            inbox
                .messages
                .iter_mut()
                .filter(|m| m.thread_id == thread_id)
                .for_each(|m| m.unread = false);
            save_inbox(&app, &account, &inbox);
        }
    }
    Ok(messages)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchTarget {
    thread_id: String,
    latest_id: String,
}

/// Caches conversations in the background, without marking them read, so
/// opening them is instant. Skips any whose cache already has `latest_id`.
#[tauri::command]
pub async fn email_prefetch(
    app: tauri::AppHandle,
    targets: Vec<PrefetchTarget>,
) -> Result<(), String> {
    let account = account_email()?;
    let stale: Vec<PrefetchTarget> = targets
        .into_iter()
        .take(25)
        .filter(|t| {
            crate::mail_cache::load_thread(&app, &account, &t.thread_id)
                .and_then(|data| serde_json::from_str::<Vec<Message>>(&data).ok())
                .is_none_or(|cached| !cached.iter().any(|m| m.id == t.latest_id))
        })
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    let token = access_token().await?;
    let http = reqwest::Client::new();
    for chunk in stale.chunks(4) {
        join_all(
            chunk
                .iter()
                .map(|t| sync_thread(&app, &account, &http, &token, &t.thread_id)),
        )
        .await;
    }
    Ok(())
}

/// RFC 2047 encode non-ASCII header values.
fn encode_header(value: &str) -> String {
    if value.bytes().all(|b| (32..127).contains(&b)) {
        return value.to_owned();
    }
    format!(
        "=?UTF-8?B?{}?=",
        base64::engine::general_purpose::STANDARD.encode(value)
    )
}

/// Replies to `message_id` in its thread, addressed to its Reply-To or sender
/// (or its recipients when replying to your own message).
#[tauri::command]
pub async fn email_reply(message_id: String, body: String) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("Write a reply first.".into());
    }
    let account = load_stored()?.ok_or("Connect a Google account first.")?;
    let token = access_token().await?;
    let http = reqwest::Client::new();
    let value = api(http
        .get(format!("{GMAIL}/messages/{message_id}"))
        .query(&[
            ("format", "metadata"),
            ("metadataHeaders", "From"),
            ("metadataHeaders", "To"),
            ("metadataHeaders", "Reply-To"),
            ("metadataHeaders", "Subject"),
            ("metadataHeaders", "Message-ID"),
            ("metadataHeaders", "References"),
        ])
        .bearer_auth(&token))
    .await?;
    let original: GmailMessage =
        serde_json::from_value(value).map_err(|e| format!("Unexpected Gmail message: {e}"))?;

    let from = original.header("From");
    let mine = parse_address(&from)
        .email
        .eq_ignore_ascii_case(&account.email);
    let to = match (mine, original.header("Reply-To")) {
        (true, _) => original.header("To"),
        (false, reply_to) if !reply_to.trim().is_empty() => reply_to,
        _ => from,
    };
    if to.trim().is_empty() {
        return Err("This message has no address to reply to.".into());
    }
    let subject = original.header("Subject");
    let subject = if subject.to_ascii_lowercase().starts_with("re:") {
        subject
    } else {
        format!("Re: {subject}")
    };
    let mut headers = vec![
        format!("From: {}", account.email),
        format!("To: {to}"),
        format!("Subject: {}", encode_header(&subject)),
    ];
    let message_ref = original.header("Message-ID");
    if !message_ref.is_empty() {
        let references = original.header("References");
        let references = format!("{references} {message_ref}");
        headers.push(format!("In-Reply-To: {message_ref}"));
        headers.push(format!("References: {}", references.trim()));
    }
    headers.extend([
        "MIME-Version: 1.0".into(),
        "Content-Type: text/plain; charset=\"UTF-8\"".into(),
        "Content-Transfer-Encoding: 8bit".into(),
    ]);
    let body = body.replace("\r\n", "\n").replace('\n', "\r\n");
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{}\r\n\r\n{body}", headers.join("\r\n")));
    api(http
        .post(format!("{GMAIL}/messages/send"))
        .bearer_auth(&token)
        .json(&json!({ "raw": raw, "threadId": original.thread_id })))
    .await?;
    Ok(())
}
