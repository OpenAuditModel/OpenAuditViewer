//! The one outbound request this application ever makes, and only when asked.
//!
//! The app's promise is that nothing leaves the machine: no telemetry, no
//! crash reporting, no remote validation. An update check is a deliberate,
//! narrow exception to "the app opens no socket", and it is built so that the
//! promise about *data* stays intact and easy to verify:
//!
//! * It runs only from an explicit click. There is no timer, no check on
//!   launch, and nothing is remembered between runs.
//! * The URL is a constant here. The webview cannot supply one, so this can
//!   never become a general HTTP client for a page that renders untrusted log
//!   content. The Content-Security-Policy still forbids the frontend from
//!   reaching the network at all.
//! * The request carries no query, no body, no cookies and no credentials —
//!   only the User-Agent the GitHub API requires. Nothing about the archive on
//!   screen, or the machine, is transmitted.
//! * Exactly two strings are read out of the response, and neither is ever
//!   rendered as markup or handed to a browser without the user clicking.
//!
//! Why it exists at all: this is a verification tool whose analysis engines
//! come from a pinned release. Running an old build means evaluating against
//! an old schema and old profiles, and 0.5.0 fixed a case where a signature
//! this app could not check was reported as verified. Knowing you are behind
//! is a correctness question here, not a convenience.
use std::time::Duration;

/// Where the releases live. A constant, never a parameter.
const RELEASES_API: &str =
    "https://api.github.com/repos/OpenAuditModel/OpenAuditViewer/releases/latest";

/// How long to wait before giving up. An update check must never hang a dialog.
const TIMEOUT: Duration = Duration::from_secs(10);

/// What the check found. `tag` is the release tag, such as `v0.5.0`.
#[derive(serde::Serialize)]
pub struct LatestRelease {
    pub tag: String,
    /// The release page, for the user to open in their browser if they choose.
    pub url: String,
}

/// The two fields read out of the response. Everything else is ignored.
#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

/// Asks GitHub for the latest published release of this application.
///
/// Returns a human-readable message on failure rather than an error type: the
/// caller shows it and moves on, and a failed update check is not a failure of
/// the application.
#[tauri::command]
pub async fn check_latest_release() -> Result<LatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(concat!("OpenAuditViewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("could not start the request: {error}"))?;

    let response = client
        .get(RELEASES_API)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "could not reach github.com".to_string())?;

    if !response.status().is_success() {
        return Err(format!("github.com answered {}", response.status().as_u16()));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|_| "github.com answered with something unexpected".to_string())?;

    Ok(LatestRelease {
        tag: release.tag_name,
        url: release.html_url,
    })
}
