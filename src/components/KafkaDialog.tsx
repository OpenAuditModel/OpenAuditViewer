/**
 * Reading a window of a Kafka topic: the saved sources, the form that saves
 * one, and the form that reads from one.
 *
 * Saving is confirmed in a native dialog drawn by the operating system, which
 * names the brokers, the protection and the user; this component cannot click
 * it, and neither can anything else running in the webview. A password typed
 * here goes to the system keychain and is never shown again. See
 * `src-tauri/src/kafka.rs`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_READ_FORM,
  MAX_WINDOW_EVENTS,
  buildRequest,
  canFollow,
  cancelRead,
  chooseCa,
  deleteSource,
  describeProtection,
  listSources,
  parseServers,
  readWindow,
  saveSource,
  usesEventLimit,
  type CaDraft,
  type ChosenCa,
  type KafkaSource,
  type ReadForm,
  type ReadMode,
  type ReadOutcome,
  type SaslMechanism,
  type Security,
} from "../lib/kafka";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onLoaded: (result: ReadOutcome) => void;
  /** Called before a read starts, to stop one that is still listening. */
  readonly onBeforeRead?: () => Promise<void>;
}

interface Form {
  readonly id?: string;
  readonly name: string;
  readonly servers: string;
  readonly topic: string;
  readonly security: Security;
  readonly mechanism: SaslMechanism;
  readonly username: string;
  readonly password: string;
  /** "keep" the saved CA, use the public roots, or a newly chosen one. */
  readonly ca: "keep" | "public" | ChosenCa;
  readonly savedCaLabel?: string;
}

const EMPTY_FORM: Form = {
  name: "",
  servers: "",
  topic: "",
  security: "sasl-tls",
  mechanism: "SCRAM-SHA-512",
  username: "",
  password: "",
  ca: "public",
};

function formFor(source: KafkaSource): Form {
  return {
    id: source.id,
    name: source.name,
    servers: source.bootstrapServers.join(", "),
    topic: source.topic,
    security: source.security,
    mechanism: source.mechanism ?? "SCRAM-SHA-512",
    username: source.username ?? "",
    password: "",
    ca: source.ca === undefined ? "public" : "keep",
    ...(source.ca === undefined ? {} : { savedCaLabel: source.ca.label }),
  };
}

function caDraft(form: Form): CaDraft {
  if (form.ca === "keep") {
    return { kind: "keep" };
  }
  if (form.ca === "public") {
    return { kind: "none" };
  }
  return { kind: "new", label: form.ca.label, pem: form.ca.pem };
}

const READ_MODES: readonly { value: ReadMode; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "newest-per-partition", label: "Newest per partition" },
  { value: "time", label: "Time range" },
  { value: "offset", label: "Offsets" },
  { value: "everything", label: "Everything" },
];

function hasFilter(form: ReadForm): boolean {
  return (
    form.contains.trim() !== "" ||
    form.eventNamePrefix.trim() !== "" ||
    form.application.trim() !== ""
  );
}

/** A short label for how a source connects, and how much it should worry anyone. */
function protectionBadge(source: KafkaSource): { text: string; tone: "warn" | "ok" | "plain" } {
  switch (source.security) {
    case "plaintext":
      return { text: "No TLS", tone: "warn" };
    case "tls":
      return { text: source.ca === undefined ? "TLS" : "TLS · private CA", tone: "ok" };
    case "sasl-tls":
      return {
        text: `TLS · ${source.mechanism ?? "SASL"} · ${source.username ?? ""}`,
        tone: "ok",
      };
  }
}

export function KafkaDialog({ open, onClose, onLoaded, onBeforeRead }: Props) {
  const [sources, setSources] = useState<KafkaSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [form, setForm] = useState<Form | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [formNote, setFormNote] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const [readForm, setReadForm] = useState<ReadForm>(DEFAULT_READ_FORM);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState({ scanned: 0, kept: 0 });
  const [readError, setReadError] = useState<string | undefined>();

  const refresh = useCallback(async (select?: string) => {
    try {
      const listed = await listSources();
      setSources(listed);
      setSelectedId((current) => {
        const wanted = select ?? current;
        return listed.some((source) => source.id === wanted) ? wanted : listed[0]?.id;
      });
    } catch (cause) {
      setReadError(String(cause));
    }
  }, []);

  // Counts reads started and dialogs dismissed: a read whose dialog was closed
  // before it finished is cancelled, and what it returns is not shown.
  const readToken = useRef(0);

  const close = useCallback(() => {
    if (reading) {
      readToken.current += 1;
      void cancelRead();
    }
    onClose();
  }, [reading, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refresh();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, refresh, close]);

  if (!open) {
    return null;
  }

  const selected = sources.find((source) => source.id === selectedId);

  function update<K extends keyof Form>(key: K, value: Form[K]): void {
    setForm((current) => (current === undefined ? current : { ...current, [key]: value }));
  }

  async function save(): Promise<void> {
    if (form === undefined) {
      return;
    }
    setFormError(undefined);
    setFormNote(undefined);
    const sasl = form.security === "sasl-tls";
    setSaving(true);
    try {
      const saved = await saveSource({
        ...(form.id === undefined ? {} : { id: form.id }),
        name: form.name,
        bootstrapServers: parseServers(form.servers),
        topic: form.topic,
        security: form.security,
        ...(sasl ? { mechanism: form.mechanism, username: form.username } : {}),
        ...(sasl && form.password.length > 0 ? { password: form.password } : {}),
        ca: form.security === "plaintext" ? { kind: "none" } : caDraft(form),
      });
      if (saved === undefined) {
        setFormNote("Not saved: the confirmation was declined.");
        return;
      }
      setForm(undefined);
      await refresh(saved.id);
    } catch (cause) {
      setFormError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove(source: KafkaSource): Promise<void> {
    setReadError(undefined);
    try {
      if (await deleteSource(source.id)) {
        await refresh();
      }
    } catch (cause) {
      setReadError(String(cause));
    }
  }

  async function pickCa(): Promise<void> {
    setFormError(undefined);
    try {
      const chosen = await chooseCa();
      if (chosen !== undefined) {
        update("ca", chosen);
      }
    } catch (cause) {
      setFormError(String(cause));
    }
  }

  function setRead<K extends keyof ReadForm>(key: K, value: ReadForm[K]): void {
    setReadForm((current) => ({ ...current, [key]: value }));
  }

  async function read(): Promise<void> {
    if (selected === undefined) {
      return;
    }
    setReadError(undefined);
    const request = buildRequest(readForm);
    if (typeof request === "string") {
      setReadError(request);
      return;
    }
    readToken.current += 1;
    const token = readToken.current;
    setReading(true);
    setProgress({ scanned: 0, kept: 0 });
    try {
      await onBeforeRead?.();
      const outcome = await readWindow(selected, request, setProgress);
      if (readToken.current !== token) {
        // Dismissed while reading: cancelled, and nothing is shown.
        void outcome.live?.stop();
        return;
      }
      onLoaded(outcome);
      onClose();
    } catch (cause) {
      if (readToken.current === token) {
        setReadError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setReading(false);
    }
  }

  const canRead = selected !== undefined && form === undefined;

  return (
    <div className="dialog-backdrop" onClick={close}>
      <div
        className="dialog dialog-wide kafka-dialog"
        role="dialog"
        aria-label="Read from Kafka"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <span>Read from Kafka</span>
          <button type="button" className="dialog-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-section">
          <p className="dialog-intro">
            Reads a window of a topic and disconnects. No consumer group is joined, no offset is
            committed and no topic is created — the broker is left as it was.
          </p>
        </div>

        <div className="dialog-section">
          <div className="section-head">
            <h4>Sources</h4>
            {form === undefined ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setFormError(undefined);
                  setFormNote(undefined);
                  setForm(EMPTY_FORM);
                }}
              >
                + New source
              </button>
            ) : null}
          </div>
          {sources.length === 0 && form === undefined ? (
            <p className="dialog-note">
              No source is saved yet. Add one to name the brokers and the topic to read.
            </p>
          ) : null}
          <div className="source-list">
            {sources.map((source) => {
              const protection = protectionBadge(source);
              return (
                <label
                  key={source.id}
                  className={source.id === selectedId ? "source-row selected" : "source-row"}
                >
                  <input
                    type="radio"
                    name="kafka-source"
                    checked={source.id === selectedId}
                    onChange={() => setSelectedId(source.id)}
                  />
                  <span className="source-main">
                    <span className="source-title">
                      <strong>{source.name}</strong>
                      <code className="source-topic">{source.topic}</code>
                    </span>
                    <span className="source-detail">
                      <span className="source-servers">{source.bootstrapServers.join(", ")}</span>
                      <span
                        className={`chip chip-${protection.tone}`}
                        title={describeProtection(source)}
                      >
                        {protection.text}
                      </span>
                    </span>
                  </span>
                  <span className="source-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={(event) => {
                        event.preventDefault();
                        setFormError(undefined);
                        setFormNote(undefined);
                        setForm(formFor(source));
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={(event) => {
                        event.preventDefault();
                        void remove(source);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {form !== undefined ? (
          <div className="dialog-section">
            <h4>{form.id === undefined ? "New source" : "Edit source"}</h4>
            <div className="form-grid">
              <label htmlFor="kafka-name">Name</label>
              <input
                id="kafka-name"
                className="field"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="Production audit"
              />
              <label htmlFor="kafka-servers">Bootstrap servers</label>
              <input
                id="kafka-servers"
                className="field"
                value={form.servers}
                onChange={(event) => update("servers", event.target.value)}
                placeholder="broker-1.example.com:9094, broker-2.example.com:9094"
              />
              <label htmlFor="kafka-topic">Topic</label>
              <input
                id="kafka-topic"
                className="field"
                value={form.topic}
                onChange={(event) => update("topic", event.target.value)}
                placeholder="audit.events"
              />
              <label htmlFor="kafka-security">Connection</label>
              <select
                id="kafka-security"
                className="field"
                value={form.security}
                onChange={(event) => update("security", event.target.value as Security)}
              >
                <option value="sasl-tls">TLS, with a user and password (SASL)</option>
                <option value="tls">TLS, no user</option>
                <option value="plaintext">No TLS, no user</option>
              </select>
              {form.security === "sasl-tls" ? (
                <>
                  <label htmlFor="kafka-mechanism">Mechanism</label>
                  <select
                    id="kafka-mechanism"
                    className="field"
                    value={form.mechanism}
                    onChange={(event) => update("mechanism", event.target.value as SaslMechanism)}
                  >
                    <option value="SCRAM-SHA-512">SCRAM-SHA-512</option>
                    <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
                    <option value="PLAIN">PLAIN</option>
                  </select>
                  <label htmlFor="kafka-user">User</label>
                  <input
                    id="kafka-user"
                    className="field"
                    value={form.username}
                    autoComplete="off"
                    onChange={(event) => update("username", event.target.value)}
                  />
                  <label htmlFor="kafka-password">Password</label>
                  <input
                    id="kafka-password"
                    className="field"
                    type="password"
                    value={form.password}
                    autoComplete="new-password"
                    placeholder={form.id === undefined ? "" : "saved — leave empty to keep it"}
                    onChange={(event) => update("password", event.target.value)}
                  />
                </>
              ) : null}
              {form.security !== "plaintext" ? (
                <>
                  <span>Broker CA</span>
                  <span className="form-inline">
                    <span className="ca-choice">
                      {form.ca === "public"
                        ? "Public certificate authorities"
                        : form.ca === "keep"
                          ? `Saved CA · ${form.savedCaLabel ?? ""}`
                          : `${form.ca.label} · ${form.ca.certificates} certificate${form.ca.certificates === 1 ? "" : "s"}`}
                    </span>
                    <button type="button" className="ghost-button" onClick={() => void pickCa()}>
                      Choose CA file…
                    </button>
                    {form.ca !== "public" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => update("ca", "public")}
                      >
                        Use public CAs
                      </button>
                    ) : null}
                  </span>
                </>
              ) : null}
            </div>
            {form.security === "plaintext" ? (
              <p className="callout callout-warn">
                Without TLS, the audit events read cross the network unencrypted, and nothing
                confirms the broker is the one you meant.
              </p>
            ) : null}
            <p className="dialog-note">
              Saving asks for confirmation in a system dialog that names where the viewer will
              connect. The password goes to the system keychain and is not shown again
              {form.security === "sasl-tls" && form.id !== undefined
                ? "; it is only ever sent to the brokers, as the user and over the connection it was entered for, so changing any of those means entering it again."
                : "."}
            </p>
            {formError !== undefined ? <p className="callout callout-bad">{formError}</p> : null}
            {formNote !== undefined ? <p className="dialog-note">{formNote}</p> : null}
            <div className="form-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setForm(undefined)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "Waiting for confirmation…" : "Save source…"}
              </button>
            </div>
          </div>
        ) : null}

        {canRead && selected !== undefined ? (
          <div className="dialog-section">
            <h4>
              Read from <code className="source-topic">{selected.topic}</code>
            </h4>
            <div className="mode-picker" role="radiogroup" aria-label="What to read">
              {READ_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  aria-checked={readForm.mode === mode.value}
                  className={readForm.mode === mode.value ? "mode-choice active" : "mode-choice"}
                  onClick={() => setRead("mode", mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="form-grid">
              {readForm.mode === "newest" ||
              readForm.mode === "oldest" ||
              readForm.mode === "newest-per-partition" ? (
                <>
                  <label htmlFor="kafka-count">How many</label>
                  <span className="form-inline">
                    <input
                      id="kafka-count"
                      className="field short-input"
                      value={readForm.count}
                      onChange={(event) => setRead("count", event.target.value)}
                    />
                    <span className="unit">
                      {readForm.mode === "newest-per-partition"
                        ? "records from the end of each partition"
                        : "records, across every partition, by the time they carry"}
                    </span>
                  </span>
                </>
              ) : null}
              {readForm.mode === "time" ? (
                <>
                  <label htmlFor="kafka-from">From</label>
                  <input
                    id="kafka-from"
                    type="datetime-local"
                    className="field"
                    value={readForm.from}
                    onChange={(event) => setRead("from", event.target.value)}
                  />
                  <label htmlFor="kafka-until">Until</label>
                  <span className="form-inline">
                    <input
                      id="kafka-until"
                      type="datetime-local"
                      className="field"
                      value={readForm.until}
                      onChange={(event) => setRead("until", event.target.value)}
                    />
                    <span className="unit">empty for now</span>
                  </span>
                </>
              ) : null}
              {readForm.mode === "offset" ? (
                <>
                  <label htmlFor="kafka-from-offset">From offset</label>
                  <input
                    id="kafka-from-offset"
                    className="field"
                    value={readForm.fromOffset}
                    onChange={(event) => setRead("fromOffset", event.target.value)}
                    placeholder="120 in every partition — or 0:120, 2:40"
                  />
                  <label htmlFor="kafka-until-offset">To offset</label>
                  <span className="form-inline">
                    <input
                      id="kafka-until-offset"
                      className="field short-input"
                      value={readForm.untilOffset}
                      onChange={(event) => setRead("untilOffset", event.target.value)}
                    />
                    <span className="unit">included; empty for the end</span>
                  </span>
                </>
              ) : null}
              <label htmlFor="kafka-partitions">Partitions</label>
              <input
                id="kafka-partitions"
                className="field"
                value={readForm.partitions}
                onChange={(event) => setRead("partitions", event.target.value)}
                placeholder="All partitions — or a list, such as 0, 2"
              />
            </div>

            <details className="filter-box" open={hasFilter(readForm)}>
              <summary>Only events that match{hasFilter(readForm) ? " · on" : ""}</summary>
              <div className="form-grid">
                <label htmlFor="kafka-filter-name">Event name starts with</label>
                <input
                  id="kafka-filter-name"
                  className="field"
                  value={readForm.eventNamePrefix}
                  onChange={(event) => setRead("eventNamePrefix", event.target.value)}
                  placeholder="auth. — or data.record.delete"
                />
                <label htmlFor="kafka-filter-app">Application</label>
                <input
                  id="kafka-filter-app"
                  className="field"
                  value={readForm.application}
                  onChange={(event) => setRead("application", event.target.value)}
                  placeholder="exactly as application.name says it"
                />
                <label htmlFor="kafka-filter-text">Record contains</label>
                <input
                  id="kafka-filter-text"
                  className="field"
                  value={readForm.contains}
                  onChange={(event) => setRead("contains", event.target.value)}
                  placeholder="any text — a user id, a resource id; case is ignored"
                />
              </div>
              <p className="dialog-note">
                The broker still sends every record in the range; the viewer keeps the ones that
                match, and counts both.
              </p>
            </details>

            <div className="form-grid">
              {usesEventLimit(readForm) ? (
                <>
                  <label htmlFor="kafka-max">At most</label>
                  <span className="form-inline">
                    <input
                      id="kafka-max"
                      className="field short-input"
                      value={readForm.maxEvents}
                      onChange={(event) => setRead("maxEvents", event.target.value)}
                    />
                    <span className="unit">
                      events{readForm.follow ? " in all, listening included" : ""}, up to{" "}
                      {MAX_WINDOW_EVENTS.toLocaleString()}
                    </span>
                  </span>
                </>
              ) : null}
              <span>Listen</span>
              <label
                className={canFollow(readForm) ? "check-row" : "check-row disabled"}
                title={
                  canFollow(readForm)
                    ? undefined
                    : "Only a window that ends now can go on listening, and not the oldest records"
                }
              >
                <input
                  type="checkbox"
                  checked={readForm.follow && canFollow(readForm)}
                  disabled={!canFollow(readForm)}
                  onChange={(event) => setRead("follow", event.target.checked)}
                />
                Keep listening for new records after the window
              </label>
            </div>

            <p className="dialog-note">
              The window replaces what is on screen. Chains and flows are judged on what was read: a
              link to an event outside it is reported as not checked, not as broken.
            </p>
            {readError !== undefined ? <p className="callout callout-bad">{readError}</p> : null}
            <div className="form-actions">
              {reading ? (
                <>
                  <span className="read-progress">
                    <span className="spinner" aria-hidden="true" />
                    {progress.scanned.toLocaleString()} read
                    {progress.kept !== progress.scanned
                      ? ` · ${progress.kept.toLocaleString()} kept`
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="ghost-button danger"
                    onClick={() => void cancelRead()}
                  >
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" className="primary-button" onClick={() => void read()}>
                  {readForm.follow && canFollow(readForm) ? "Read and listen" : "Read window"}
                </button>
              )}
            </div>
          </div>
        ) : readError !== undefined ? (
          <div className="dialog-section">
            <p className="callout callout-bad">{readError}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
