/**
 * Settings, About and Updates in one small dialog.
 *
 * The Updates section is deliberately inert: this build has no update
 * channel, and a "check for updates" button that has nothing honest to
 * check against would be theater. When releases exist somewhere stable,
 * a version check goes here — carrying a version number and nothing else.
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

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsDialog({ open, onClose }: Props) {
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [appVersion, setAppVersion] = useState("…");
  const [tauriVersion, setTauriVersion] = useState("…");
  const [appName, setAppName] = useState("OpenAuditViewer");
  const [layoutCount, setLayoutCount] = useState(0);

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
                <td>0.1 · {ALL_PROFILES.length} profiles vendored</td>
              </tr>
              <tr>
                <td>Tauri runtime</td>
                <td>{tauriVersion}</td>
              </tr>
            </tbody>
          </table>
          <p className="dialog-note">
            Experimental build. Validation, privacy linting, digest/chain verification and profile
            checks run entirely offline, ported from the OpenAuditModel conformance tooling.
          </p>
          <div className="about-links">
            {link("https://openauditmodel.org", "openauditmodel.org")}
            {link("https://github.com/OpenAuditModel/OpenAuditModel", "Specification on GitHub")}
          </div>
        </div>

        <div className="dialog-section">
          <h4>Updates</h4>
          <p className="dialog-note">
            This build has no update channel yet — updating means replacing the executable with a
            newer build. An update check will be added once releases are published somewhere it can
            honestly point at; it will send a version number and no event data.
          </p>
        </div>
      </div>
    </div>
  );
}
