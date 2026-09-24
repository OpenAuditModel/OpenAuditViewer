//! Kafka sources: the saved connections, their passwords, and one read at a
//! time.
//!
//! The webview renders untrusted log content, so the design assumes a script
//! in it could call any command here, and asks what that script could do:
//!
//! * **It cannot point the viewer at a new broker.** A source is saved only
//!   after a native confirmation dialog, drawn by the operating system, names
//!   the brokers, the protection and the user. A script cannot click it.
//! * **It cannot send a stored password anywhere new.** A password is saved
//!   in the system keychain against one source, and a source whose brokers,
//!   protection, mechanism, user or CA change loses it unless the password is
//!   entered again in the same save — which the dialog then shows. The
//!   password never returns to the webview after it is entered.
//! * **It can read from a saved source**, which is what the user saved it for,
//!   and nothing a read does is visible to the broker's owner beyond a
//!   connection: no group is joined, no offset committed, no topic created
//!   (see the `oav-kafka` crate).
//!
//! The source list itself is a file in the app's configuration directory,
//! written here and never by the webview. It holds no secret.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oav_kafka::connection::{count_pem_certificates, validate_topic};
use oav_kafka::{
    fetch, Connection, End, Event, FetchReport, Filter, Record, Sasl, SaslMechanism, Security,
    Select, Start, Window, MAX_WINDOW_EVENTS,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The keychain service every stored password is filed under; the account is
/// the source's identifier.
const KEYCHAIN_SERVICE: &str = "org.openauditmodel.viewer.kafka";

/// The file the source list lives in, inside the app's configuration directory.
const SOURCES_FILE: &str = "kafka-sources.json";

/// Most sources kept. A list longer than this is not one a person maintains.
const MAX_SOURCES: usize = 64;

/// Longest source name, in characters.
const MAX_NAME_CHARS: usize = 80;

/// Longest user name or CA label, in characters.
const MAX_LABEL_CHARS: usize = 255;

/// Text the confirmation dialog will show, checked so that it cannot carry
/// lines of its own: a name with a newline in it could print a second,
/// invented "connects to …" beneath the real one.
fn one_line(what: &str, text: &str, limit: usize) -> Result<(), String> {
    if text.chars().count() > limit || text.chars().any(breaks_a_line) {
        return Err(format!("{what} is at most {limit} characters, on one line"));
    }
    Ok(())
}

/// A character that can start a line, or reorder one, in a native dialog:
/// control characters, the Unicode line and paragraph separators, and the
/// invisible format characters — bidirectional overrides and isolates,
/// zero-width spaces and joiners — that make shown text differ from what it
/// is.
fn breaks_a_line(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{00AD}'
                | '\u{061C}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
        )
}

/// A short SHA-256 fingerprint of a CA bundle, for the confirmation dialog:
/// the file name is only what the file was called.
fn fingerprint(pem: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(pem.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Largest CA file read, in bytes.
const MAX_CA_FILE_BYTES: u64 = oav_kafka::connection::MAX_CA_PEM_BYTES as u64;

/// A read stops here whatever else is true.
const READ_DEADLINE: Duration = Duration::from_secs(300);

/// Listening stops here, however quiet the topic: a session left open
/// overnight is not a feature anyone asked for.
const FOLLOW_DEADLINE: Duration = Duration::from_secs(8 * 60 * 60);

/// A read stops when no record has arrived for this long.
const READ_STALL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCa {
    /// The file name it was read from, for the user to recognise.
    label: String,
    pem: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSource {
    id: String,
    name: String,
    bootstrap_servers: Vec<String>,
    topic: String,
    security: Security,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mechanism: Option<SaslMechanism>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ca: Option<StoredCa>,
}

impl StoredSource {
    /// A fingerprint of everything a stored password is tied to, kept beside
    /// the password in the keychain and checked before every read: a source
    /// list changed by anything but a confirmed save — a file edited behind
    /// the app's back — cannot send the password somewhere new.
    fn credential_fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let (servers, security, mechanism, username, ca) = self.credential_target();
        let mut hasher = Sha256::new();
        for part in [
            servers.join("\n"),
            format!("{security:?}"),
            mechanism.map_or("", SaslMechanism::as_str).to_owned(),
            username.unwrap_or_default(),
            ca.unwrap_or_default(),
        ] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part.as_bytes());
        }
        hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// Everything a stored password is tied to. A password saved for one of
    /// these is never sent under another.
    fn credential_target(&self) -> (Vec<String>, Security, Option<SaslMechanism>, Option<String>, Option<String>) {
        let mut servers = self.bootstrap_servers.clone();
        servers.sort();
        (
            servers,
            self.security,
            self.mechanism,
            self.username.clone(),
            self.ca.as_ref().map(|ca| ca.pem.clone()),
        )
    }
}

/// What the webview is told about a CA: never the certificates themselves.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaSummary {
    label: String,
    certificates: usize,
}

/// What the webview is told about a source. No password, ever.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    id: String,
    name: String,
    bootstrap_servers: Vec<String>,
    topic: String,
    security: Security,
    #[serde(skip_serializing_if = "Option::is_none")]
    mechanism: Option<SaslMechanism>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ca: Option<CaSummary>,
}

impl From<&StoredSource> for SourceSummary {
    fn from(source: &StoredSource) -> Self {
        SourceSummary {
            id: source.id.clone(),
            name: source.name.clone(),
            bootstrap_servers: source.bootstrap_servers.clone(),
            topic: source.topic.clone(),
            security: source.security,
            mechanism: source.mechanism,
            username: source.username.clone(),
            ca: source.ca.as_ref().map(|ca| CaSummary {
                label: ca.label.clone(),
                certificates: count_pem_certificates(&ca.pem).unwrap_or(0),
            }),
        }
    }
}

/// A CA chosen in the dialog, handed back to be saved with a source.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChosenCa {
    label: String,
    pem: String,
    certificates: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum CaDraft {
    /// Trust the public roots.
    None,
    /// Keep the CA the source already has.
    Keep,
    /// Trust this CA instead of the public roots.
    New { label: String, pem: String },
}

/// A source as the webview asks for it to be saved.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDraft {
    /// Absent for a new source.
    id: Option<String>,
    name: String,
    bootstrap_servers: Vec<String>,
    topic: String,
    security: Security,
    mechanism: Option<SaslMechanism>,
    username: Option<String>,
    /// Absent to keep the stored password, which is allowed only while the
    /// credential target is unchanged.
    password: Option<String>,
    ca: CaDraft,
}

/// One read at a time, the way to stop it, and one change to the source list
/// at a time: a save waits on a dialog, and two saves interleaved would each
/// write back the list as it was before the other.
#[derive(Default)]
pub struct KafkaState {
    reading: AtomicBool,
    cancel: Arc<AtomicBool>,
    changing: tokio::sync::Mutex<()>,
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}-{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn sources_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "the app's configuration directory could not be found".to_owned())?;
    Ok(directory.join(SOURCES_FILE))
}

fn load_sources(app: &AppHandle) -> Result<Vec<StoredSource>, String> {
    let path = sources_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|_| format!("{} could not be read; it is not a source list this version wrote", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(format!("{} could not be read", path.display())),
    }
}

/// Written whole to a temporary file and moved into place, so a crash never
/// leaves half a list.
fn save_sources(app: &AppHandle, sources: &[StoredSource]) -> Result<(), String> {
    let path = sources_path(app)?;
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)
            .map_err(|_| "the app's configuration directory could not be created".to_owned())?;
    }
    let text = serde_json::to_string_pretty(sources).map_err(|_| "the source list could not be written".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|_| "the source list could not be written".to_owned())?;
    std::fs::rename(&temporary, &path).map_err(|_| "the source list could not be written".to_owned())
}

fn keychain_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(|error| format!("the system keychain could not be used: {error}"))
}

/// What the keychain holds for a source: the password, and the fingerprint
/// of what it was entered for.
#[derive(Serialize, Deserialize)]
struct Secret {
    target: String,
    password: String,
}

fn store_password(source: &StoredSource, password: &str) -> Result<(), String> {
    let secret = serde_json::to_string(&Secret {
        target: source.credential_fingerprint(),
        password: password.to_owned(),
    })
    .map_err(|_| "the password could not be saved in the system keychain".to_owned())?;
    keychain_entry(&source.id)?
        .set_password(&secret)
        .map_err(|error| format!("the password could not be saved in the system keychain: {error}"))
}

fn read_password(source: &StoredSource) -> Result<String, String> {
    let stored = match keychain_entry(&source.id)?.get_password() {
        Ok(stored) => stored,
        Err(keyring::Error::NoEntry) => {
            return Err(
                "no password is saved for this source; edit it and enter the password again"
                    .to_owned(),
            )
        }
        Err(error) => return Err(format!("the system keychain could not be read: {error}")),
    };
    let secret: Secret = serde_json::from_str(&stored).map_err(|_| {
        "the saved password is not in a form this version wrote; edit the source and enter it again"
            .to_owned()
    })?;
    if secret.target != source.credential_fingerprint() {
        return Err("the saved password was entered for other brokers, another user, another connection or another CA; edit the source and enter it again".to_owned());
    }
    Ok(secret.password)
}

fn forget_password(id: &str) {
    if let Ok(entry) = keychain_entry(id) {
        let _ = entry.delete_credential();
    }
}

/// Checks a draft and turns it into what would be stored, without touching
/// the keychain or the file. Pure, so that every rule is testable.
fn prepare(draft: &SourceDraft, existing: Option<&StoredSource>) -> Result<(StoredSource, bool), String> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("give the source a name".to_owned());
    }
    one_line("a source name", name, MAX_NAME_CHARS)?;
    let servers: Vec<String> = draft
        .bootstrap_servers
        .iter()
        .map(|server| server.trim().to_owned())
        .filter(|server| !server.is_empty())
        .collect();
    let topic = draft.topic.trim().to_owned();
    validate_topic(&topic).map_err(|error| error.0)?;

    let sasl = draft.security == Security::SaslTls;
    let (mechanism, username) = if sasl {
        let username = draft.username.as_deref().map(str::trim).unwrap_or("");
        if username.is_empty() {
            return Err("SASL needs a user name".to_owned());
        }
        one_line("a user name", username, MAX_LABEL_CHARS)?;
        (
            Some(draft.mechanism.ok_or_else(|| "choose a SASL mechanism".to_owned())?),
            Some(username.to_owned()),
        )
    } else {
        (None, None)
    };

    let ca = match &draft.ca {
        CaDraft::None => None,
        CaDraft::Keep => Some(
            existing
                .and_then(|source| source.ca.clone())
                .ok_or_else(|| "there is no saved CA to keep".to_owned())?,
        ),
        CaDraft::New { label, pem } => {
            one_line("a CA file name", label, MAX_LABEL_CHARS)?;
            count_pem_certificates(pem).map_err(|error| error.0)?;
            Some(StoredCa { label: label.clone(), pem: pem.clone() })
        }
    };
    if draft.security == Security::Plaintext && ca.is_some() {
        return Err("a CA certificate means nothing without TLS".to_owned());
    }

    let source = StoredSource {
        id: existing.map_or_else(new_id, |source| source.id.clone()),
        name: name.to_owned(),
        bootstrap_servers: servers,
        topic,
        security: draft.security,
        mechanism,
        username,
        ca,
    };

    // Validated as the connection it describes, with a stand-in password: the
    // rules for servers, protection and CA are the crate's, stated once.
    Connection {
        bootstrap_servers: source.bootstrap_servers.clone(),
        security: source.security,
        sasl: source.username.clone().map(|username| Sasl {
            mechanism: source.mechanism.unwrap_or(SaslMechanism::Plain),
            username,
            password: "x".into(),
        }),
        ca_pem: source.ca.as_ref().map(|ca| ca.pem.clone()),
    }
    .validate()
    .map_err(|error| error.0)?;

    let password = draft.password.as_deref().filter(|password| !password.is_empty());
    let needs_new_password = sasl
        && password.is_none()
        && existing.is_none_or(|existing| {
            existing.security != Security::SaslTls
                || existing.credential_target() != source.credential_target()
        });
    if needs_new_password {
        return Err(if existing.is_some() {
            "enter the password again: a saved password is only ever sent to the brokers, as the user and over the protection, it was entered for".to_owned()
        } else {
            "SASL needs a password".to_owned()
        });
    }
    if !sasl && password.is_some() {
        return Err("a password is only ever sent over TLS with SASL".to_owned());
    }
    Ok((source, password.is_some()))
}

/// What the confirmation dialog says. Everything a script might have changed
/// is named, so the person clicking sees what they are allowing.
fn confirmation(source: &StoredSource, new_password: bool) -> String {
    let protection = match source.security {
        Security::Plaintext => {
            "without TLS: audit events will cross the network unencrypted".to_owned()
        }
        Security::Tls => "over TLS".to_owned(),
        Security::SaslTls => format!(
            "over TLS, as \"{}\" with {}",
            source.username.as_deref().unwrap_or(""),
            source.mechanism.map_or("SASL", SaslMechanism::as_str)
        ),
    };
    let trust = match (&source.security, &source.ca) {
        (Security::Plaintext, _) => String::new(),
        (_, Some(ca)) => format!(
            "\nThe broker's certificate must be signed by the CA in {} ({} certificate{}, SHA-256 {}).",
            ca.label,
            count_pem_certificates(&ca.pem).unwrap_or(0),
            if count_pem_certificates(&ca.pem).unwrap_or(0) == 1 { "" } else { "s" },
            fingerprint(&ca.pem)
        ),
        (_, None) => "\nThe broker's certificate must be signed by a public certificate authority.".to_owned(),
    };
    let password = if new_password {
        "\nThe password you entered is saved in the system keychain, for this source only."
    } else {
        ""
    };
    format!(
        "Save the Kafka source \"{}\"?\n\nWhen you ask it to read, the viewer connects to {} {} and reads topic \"{}\".{}{}\n\nIt connects only when you ask it to read. It joins no consumer group, commits no offset and creates no topic.",
        source.name,
        source.bootstrap_servers.join(", "),
        protection,
        source.topic,
        trust,
        password
    )
}

async fn confirm(app: &AppHandle, title: &str, message: String, ok: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.to_owned(), "Cancel".to_owned()))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    receiver.await.unwrap_or(false)
}

/// The saved sources.
#[tauri::command]
pub fn kafka_sources(app: AppHandle) -> Result<Vec<SourceSummary>, String> {
    Ok(load_sources(&app)?.iter().map(SourceSummary::from).collect())
}

/// Saves a source, after the user confirms it in a native dialog. `Ok(None)`
/// when they did not.
#[tauri::command]
pub async fn kafka_save_source(
    app: AppHandle,
    state: State<'_, KafkaState>,
    draft: SourceDraft,
) -> Result<Option<SourceSummary>, String> {
    let _changing = state.changing.lock().await;
    let mut sources = load_sources(&app)?;
    let index = match &draft.id {
        Some(id) => Some(
            sources
                .iter()
                .position(|source| &source.id == id)
                .ok_or_else(|| "that source no longer exists".to_owned())?,
        ),
        None => None,
    };
    if index.is_none() && sources.len() >= MAX_SOURCES {
        return Err(format!("at most {MAX_SOURCES} sources are kept; delete one first"));
    }
    let existing = index.map(|index| &sources[index]);
    let (source, new_password) = prepare(&draft, existing)?;

    if !confirm(&app, "Save Kafka source", confirmation(&source, new_password), "Save").await {
        return Ok(None);
    }

    // The list first, then the keychain. Should the second fail, the source
    // is saved with a password that does not match it, which a read refuses —
    // never a password filed against brokers it was not entered for.
    let password = draft.password.clone().filter(|password| !password.is_empty());
    let summary = SourceSummary::from(&source);
    let saved = source.clone();
    match index {
        Some(index) => sources[index] = source,
        None => sources.push(source),
    }
    save_sources(&app, &sources)?;
    if saved.security == Security::SaslTls {
        if let Some(password) = password {
            store_password(&saved, &password)?;
        }
    } else {
        forget_password(&saved.id);
    }
    Ok(Some(summary))
}

/// Deletes a source and its saved password, after a native confirmation.
/// `Ok(false)` when the user did not confirm.
#[tauri::command]
pub async fn kafka_delete_source(
    app: AppHandle,
    state: State<'_, KafkaState>,
    id: String,
) -> Result<bool, String> {
    let _changing = state.changing.lock().await;
    let mut sources = load_sources(&app)?;
    let Some(index) = sources.iter().position(|source| source.id == id) else {
        return Err("that source no longer exists".to_owned());
    };
    let message = format!(
        "Delete the Kafka source \"{}\" and the password saved for it?",
        sources[index].name
    );
    if !confirm(&app, "Delete Kafka source", message, "Delete").await {
        return Ok(false);
    }
    let removed = sources.remove(index);
    forget_password(&removed.id);
    save_sources(&app, &sources)?;
    Ok(true)
}

/// Opens a native file dialog for a CA certificate. The file is read and
/// checked here; `Ok(None)` when the dialog was cancelled.
#[tauri::command]
pub async fn kafka_choose_ca(app: AppHandle) -> Result<Option<ChosenCa>, String> {
    use std::io::Read;
    use tauri_plugin_dialog::DialogExt;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose the CA certificate that signed the broker's certificate")
        .pick_file(move |chosen| {
            let _ = sender.send(chosen);
        });
    let Some(chosen) = receiver.await.map_err(|_| "the dialog closed unexpectedly".to_owned())? else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|_| "the chosen CA is not a file on this machine".to_owned())?;
    let metadata = std::fs::metadata(&path).map_err(|_| "the chosen file could not be read".to_owned())?;
    if !metadata.is_file() {
        return Err("the chosen path is not a regular file".to_owned());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|_| "the chosen file could not be read".to_owned())?
        .take(MAX_CA_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "the chosen file could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_CA_FILE_BYTES {
        return Err(format!("the chosen file is larger than {MAX_CA_FILE_BYTES} bytes, too large to be a CA certificate"));
    }
    let pem = String::from_utf8(bytes).map_err(|_| "the chosen file is not PEM text".to_owned())?;
    let certificates = count_pem_certificates(&pem).map_err(|error| error.0)?;
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(ChosenCa { label, pem, certificates }))
}

/// What to read from a source.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRequest {
    partitions: Option<Vec<i32>>,
    start: Start,
    #[serde(default)]
    end: End,
    #[serde(default)]
    select: Select,
    #[serde(default)]
    filter: Filter,
    max_events: usize,
    #[serde(default)]
    follow: bool,
}

/// What the webview hears while a read runs.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReadEvent {
    Records { records: Vec<Record> },
    CaughtUp { partitions: Vec<oav_kafka::PartitionReport> },
    Progress { scanned: u64, kept: u64 },
}

/// What a read held, and which source it came from.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    source: SourceSummary,
    report: FetchReport,
    max_events: usize,
}

/// Clears the reading flag however the read ends.
struct Reading<'a>(&'a AtomicBool);

impl Drop for Reading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Reads one window of a saved source, and goes on listening when asked.
/// Records arrive on `events` a batch at a time, then a `caught-up` once the
/// window is read; the result, when reading stops, says what was read and why
/// it ended.
#[tauri::command]
pub async fn kafka_read(
    app: AppHandle,
    state: State<'_, KafkaState>,
    id: String,
    request: ReadRequest,
    events: Channel<ReadEvent>,
) -> Result<ReadResult, String> {
    if state.reading.swap(true, Ordering::SeqCst) {
        return Err("a read is already running; stop it first".to_owned());
    }
    let _reading = Reading(&state.reading);
    state.cancel.store(false, Ordering::SeqCst);

    let sources = load_sources(&app)?;
    let source = sources
        .into_iter()
        .find(|source| source.id == id)
        .ok_or_else(|| "that source no longer exists".to_owned())?;
    let sasl = match source.security {
        Security::SaslTls => Some(Sasl {
            mechanism: source.mechanism.ok_or_else(|| "the source names no SASL mechanism".to_owned())?,
            username: source.username.clone().unwrap_or_default(),
            password: read_password(&source)?,
        }),
        _ => None,
    };
    let connection = Connection {
        bootstrap_servers: source.bootstrap_servers.clone(),
        security: source.security,
        sasl,
        ca_pem: source.ca.as_ref().map(|ca| ca.pem.clone()),
    };
    let max_events = request.max_events.clamp(1, MAX_WINDOW_EVENTS);
    let window = Window {
        topic: source.topic.clone(),
        partitions: request.partitions.clone(),
        start: request.start.clone(),
        end: request.end,
        select: request.select,
        filter: request.filter.clone(),
        max_events,
        follow: request.follow,
        window_deadline: READ_DEADLINE,
        deadline: if request.follow { FOLLOW_DEADLINE } else { READ_DEADLINE },
        stall: READ_STALL,
    };
    let cancel = Arc::clone(&state.cancel);
    let report = tauri::async_runtime::spawn_blocking(move || {
        fetch(&connection, &window, &cancel, |event| {
            // A window closed mid-read has nobody to send to; the read ends
            // on its own at the next limit or when cancelled.
            let _ = events.send(match event {
                Event::Records(records) => ReadEvent::Records { records },
                Event::CaughtUp { partitions } => ReadEvent::CaughtUp { partitions },
                Event::Progress { scanned, kept } => ReadEvent::Progress { scanned, kept },
            });
        })
    })
    .await
    .map_err(|_| "the read stopped unexpectedly".to_owned())?
    .map_err(|error| error.to_string())?;

    Ok(ReadResult { source: SourceSummary::from(&source), report, max_events })
}

/// Stops the read that is running, if any. It ends at its next check and
/// returns what it read so far.
#[tauri::command]
pub fn kafka_cancel_read(state: State<'_, KafkaState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(security: Security) -> SourceDraft {
        SourceDraft {
            id: None,
            name: "Production audit".into(),
            bootstrap_servers: vec![" broker-1.example.com:9094 ".into(), "".into()],
            topic: "audit.events".into(),
            security,
            mechanism: Some(SaslMechanism::ScramSha512),
            username: Some("reader".into()),
            password: Some("secret".into()),
            ca: CaDraft::None,
        }
    }

    const CA: &str = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

    #[test]
    fn a_new_sasl_source_needs_its_password() {
        let (source, new_password) = prepare(&draft(Security::SaslTls), None).expect("valid");
        assert!(new_password);
        assert_eq!(source.bootstrap_servers, vec!["broker-1.example.com:9094"]);
        let mut without = draft(Security::SaslTls);
        without.password = None;
        assert!(prepare(&without, None).is_err());
    }

    #[test]
    fn a_saved_password_is_kept_only_while_everything_it_was_sent_to_stays_the_same() {
        let (saved, _) = prepare(&draft(Security::SaslTls), None).expect("valid");

        let mut rename = draft(Security::SaslTls);
        rename.id = Some(saved.id.clone());
        rename.password = None;
        rename.name = "Renamed".into();
        rename.topic = "audit.other".into();
        assert!(prepare(&rename, Some(&saved)).is_ok(), "a name or topic is not where a password goes");

        for change in 0..4 {
            let mut changed = rename.clone();
            match change {
                0 => changed.bootstrap_servers = vec!["attacker.example:9094".into()],
                1 => changed.username = Some("someone-else".into()),
                2 => changed.mechanism = Some(SaslMechanism::Plain),
                _ => changed.ca = CaDraft::New { label: "ca.pem".into(), pem: CA.into() },
            }
            let error = prepare(&changed, Some(&saved)).expect_err("password must be entered again");
            assert!(error.contains("enter the password again"), "{error}");
        }
    }

    #[test]
    fn a_password_is_refused_without_sasl_and_sasl_without_tls_does_not_exist() {
        assert!(prepare(&draft(Security::Tls), None).is_err());
        let mut plain = draft(Security::Plaintext);
        plain.password = None;
        let (source, _) = prepare(&plain, None).expect("valid");
        assert_eq!(source.username, None, "a user name is not kept without SASL");
    }

    #[test]
    fn a_ca_without_tls_is_refused() {
        let mut plain = draft(Security::Plaintext);
        plain.password = None;
        plain.ca = CaDraft::New { label: "ca.pem".into(), pem: CA.into() };
        assert!(prepare(&plain, None).is_err());
    }

    #[test]
    fn the_dialog_names_everything_a_script_could_have_changed() {
        let mut tls = draft(Security::SaslTls);
        tls.ca = CaDraft::New { label: "corp-ca.pem".into(), pem: CA.into() };
        let (source, new_password) = prepare(&tls, None).expect("valid");
        let text = confirmation(&source, new_password);
        for expected in ["broker-1.example.com:9094", "\"reader\"", "SCRAM-SHA-512", "audit.events", "corp-ca.pem", "keychain"] {
            assert!(text.contains(expected), "{expected} missing from: {text}");
        }
        assert!(!text.contains("secret"), "the password is never shown");

        let mut plain = draft(Security::Plaintext);
        plain.password = None;
        let (source, _) = prepare(&plain, None).expect("valid");
        assert!(confirmation(&source, false).contains("unencrypted"));
    }

    #[test]
    fn nothing_shown_in_the_dialog_can_start_a_line_of_its_own() {
        let forged = "Prod\n\nWhen you ask it to read, the viewer connects to trusted.example:9094";
        let mut named = draft(Security::SaslTls);
        named.name = forged.into();
        assert!(prepare(&named, None).is_err());
        let mut user = draft(Security::SaslTls);
        user.username = Some(format!("reader\n{forged}"));
        assert!(prepare(&user, None).is_err());
        let mut ca = draft(Security::SaslTls);
        ca.ca = CaDraft::New { label: format!("ca.pem\n{forged}"), pem: CA.into() };
        assert!(prepare(&ca, None).is_err());
    }

    #[test]
    fn the_dialog_names_a_ca_by_its_contents_as_well_as_its_name() {
        let mut tls = draft(Security::SaslTls);
        tls.ca = CaDraft::New { label: "corp-ca.pem".into(), pem: CA.into() };
        let (source, _) = prepare(&tls, None).expect("valid");
        let text = confirmation(&source, false);
        assert!(text.contains(&fingerprint(CA)), "{text}");
        assert!(text.contains("1 certificate,"), "{text}");
    }

    #[test]
    fn invisible_characters_cannot_add_a_line_either() {
        for trick in ['\u{2028}', '\u{2029}', '\u{202E}', '\u{2066}', '\u{200B}', '\u{FEFF}', '\u{0085}'] {
            let mut named = draft(Security::SaslTls);
            named.name = format!("Prod{trick}When you ask it to read, the viewer connects to x:1");
            assert!(prepare(&named, None).is_err(), "U+{:04X} was accepted", trick as u32);
        }
        let mut ordinary = draft(Security::SaslTls);
        ordinary.name = "Üretim — denetim olayları".into();
        assert!(prepare(&ordinary, None).is_ok(), "ordinary non-ASCII text is fine");
    }

    #[test]
    fn a_password_is_bound_to_everything_it_was_entered_for() {
        let (saved, _) = prepare(&draft(Security::SaslTls), None).expect("valid");
        let fingerprint = saved.credential_fingerprint();
        let mut elsewhere = saved.clone();
        elsewhere.bootstrap_servers = vec!["attacker.example:9094".into()];
        assert_ne!(elsewhere.credential_fingerprint(), fingerprint);
        let mut other_user = saved.clone();
        other_user.username = Some("someone".into());
        assert_ne!(other_user.credential_fingerprint(), fingerprint);
        let mut renamed = saved.clone();
        renamed.name = "Renamed".into();
        renamed.topic = "other.topic".into();
        assert_eq!(renamed.credential_fingerprint(), fingerprint, "a name or a topic is not where a password goes");
        // Fields cannot run into each other: "ab"+"c" is not "a"+"bc".
        let mut shifted = saved.clone();
        shifted.username = Some(format!("{}x", saved.username.clone().unwrap_or_default()));
        assert_ne!(shifted.credential_fingerprint(), fingerprint);
    }

    #[test]
    fn the_stored_list_holds_no_password() {
        let (source, _) = prepare(&draft(Security::SaslTls), None).expect("valid");
        let text = serde_json::to_string(&vec![source]).expect("serialises");
        assert!(!text.contains("secret"));
        assert!(!text.to_ascii_lowercase().contains("password"));
    }
}
