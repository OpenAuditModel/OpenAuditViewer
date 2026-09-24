/**
 * Settings, About and Updates in one small dialog.
 *
 * The update check opens a socket only from the button below — the one other
 * thing that does is reading from a Kafka source the operator saved. There is
 * no check on launch, no timer and nothing remembered between runs, so an
 * operator who never presses it, and never reads from Kafka, runs an app that
 * never reaches the network. The request is made by Rust
 * against a constant URL and carries a User-Agent and nothing else; see
 * `src-tauri/src/update.rs` for why it exists at all and what it deliberately
 * does not send.
 */
import { useEffect, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  clearFlowLayout,
  flowLayoutSize,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
} from "../lib/settings";
import { ALL_PROFILES } from "../lib/profiles";
import { checkForUpdate, type UpdateState } from "../lib/update";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** One line describing the result, and never "up to date" for an answer that could not be read. */
function updateMessage(state: UpdateState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "checking":
      return "asking github.com…";
    case "current":
      return `${state.version} is the latest published release`;
    case "behind":
      return `${state.latest} is available — this build is ${state.current}`;
    case "ahead":
      return `this build (${state.current}) is newer than the latest release (${state.latest})`;
    case "failed":
      return state.message;
  }
}

export function SettingsDialog({ open, onClose }: Props) {
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [appVersion, setAppVersion] = useState("…");
  const [tauriVersion, setTauriVersion] = useState("…");
  const [appName, setAppName] = useState("OpenAuditViewer");
  const [layoutCount, setLayoutCount] = useState(0);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });

  useEffect(() => {
    if (!open) {
      return;
    }
    setLayoutCount(flowLayoutSize());
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
    void getTauriVersion()
      .then(setTauriVersion)
      .catch(() => setTauriVersion("unknown"));
    void getName()
      .then(setAppName)
      .catch(() => undefined);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  function chooseTheme(next: ThemePreference): void {
    setTheme(next);
    saveThemePreference(next);
  }

  function link(url: string, label: string) {
    return (
      <button type="button" className="link-button" onClick={() => void openUrl(url)}>
        {label}
      </button>
    );
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <span>Settings</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-section">
          <h4>Appearance</h4>
          <div className="theme-row">
            {THEME_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={theme === option.value ? "theme-choice active" : "theme-choice"}
                onClick={() => chooseTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="dialog-section">
          <h4>Data</h4>
          <p className="dialog-note">
            Audit content is never transmitted and never written to disk. The app stores two
            preferences locally: this theme choice and hand-arranged flow map positions.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={layoutCount === 0}
            onClick={() => {
              clearFlowLayout();
              setLayoutCount(0);
            }}
          >
            Clear saved flow map layout{layoutCount > 0 ? ` (${layoutCount} nodes)` : ""}
          </button>
        </div>

        <div className="dialog-section">
          <h4>About</h4>
          <table className="about-table">
            <tbody>
              <tr>
                <td>{appName}</td>
                <td>{appVersion}</td>
              </tr>
              <tr>
                <td>OpenAuditModel spec</td>
                <td>0.1 · {ALL_PROFILES.length} profiles</td>
              </tr>
              <tr>
                <td>Tauri runtime</td>
                <td>{tauriVersion}</td>
              </tr>
            </tbody>
          </table>
          <p className="dialog-note">
            Reads OpenAuditModel 1.0 events, and events written under 0.1. Validation, privacy
            linting, digest, chain and signature verification and profile checks run entirely
            offline, held to the answers of the OpenAuditModel conformance tooling.
          </p>
          <div className="about-links">
            {link("https://openauditmodel.org", "openauditmodel.org")}
            {link("https://github.com/OpenAuditModel/OpenAuditModel", "Specification on GitHub")}
          </div>
        </div>

        <div className="dialog-section">
          <h4>Updates</h4>
          <p className="dialog-note">
            This reaches the network only when you press the button — the one other thing that does
            is reading from a Kafka source you saved. It asks GitHub for the latest published
            release and compares it with this build. Nothing about the archive on screen is sent,
            nothing is checked automatically, and nothing is remembered.
          </p>
          <div className="sweep-row">
            <button
              type="button"
              className="secondary-button"
              disabled={update.status === "checking"}
              onClick={() => {
                setUpdate({ status: "checking" });
                void checkForUpdate(appVersion).then(setUpdate);
              }}
            >
              {update.status === "checking" ? "Checking…" : "Check for updates"}
            </button>
            <span className="detail-note-inline">{updateMessage(update)}</span>
          </div>
          {update.status === "behind" ? (
            <div className="about-links">{link(update.url, `Open ${update.latest} on GitHub`)}</div>
          ) : null}
          <p className="dialog-note">
            Updating means replacing the executable with a newer build; there is no automatic
            installer. Running an old build is a correctness question and not only a convenience
            one: the analysis engines come from a pinned release, so an old build evaluates against
            an old schema and old profiles.
          </p>
        </div>
      </div>
    </div>
  );
}
