import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { EventTable } from "./components/EventTable";
import { EventDetail } from "./components/EventDetail";
import { Overview } from "./components/Overview";
import { ObservedFlow } from "./components/ObservedFlow";
import { Coverage } from "./components/Coverage";
import { Report } from "./components/Report";
import { SettingsDialog } from "./components/SettingsDialog";
import { KafkaDialog } from "./components/KafkaDialog";
import { stopWarning, type ReadOutcome } from "./lib/kafka";
import { exportRows, loadFolder, pickFolder } from "./lib/load";
import { displayPath } from "./lib/paths";
import { filesNeverOpened } from "./lib/summary";
import { applyThemePreference, loadThemePreference } from "./lib/settings";
import {
  ANY,
  EMPTY_FILTER,
  UNKNOWN_APPLICATION,
  applicationOptions,
  filterEvents,
  outcomeOptions,
  type EventFilter,
  type ValidityFilter,
} from "./lib/filter";
import { useBookmarks } from "./hooks/useBookmarks";
import type { LoadedEvent, LoadSummary } from "./lib/types";

// Before first paint, so a dark-theme user never sees a light flash.
applyThemePreference(loadThemePreference());

type Tab = "overview" | "events" | "coverage" | "traces" | "report";

function App() {
  const [events, setEvents] = useState<LoadedEvent[]>([]);
  const [summary, setSummary] = useState<LoadSummary | undefined>();
  const [folder, setFolder] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [selectedRowId, setSelectedRowId] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("events");
  const [exportNote, setExportNote] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [kafkaOpen, setKafkaOpen] = useState(false);
  // A Kafka read that is still listening: what it has added, and how to stop
  // it. The generation keeps rows from a feed that was replaced — by a folder
  // or another read — off the screen.
  const [live, setLive] = useState<
    | { readonly topic: string; readonly added: number; readonly stop: () => Promise<void> }
    | undefined
  >();
  const liveGeneration = useRef(0);
  // Resolves when the feed that is listening has ended, so that a new read
  // does not start while the old one still holds the connection.
  const liveEnded = useRef<Promise<void> | undefined>(undefined);
  // The rows of the latest batch that arrived while listening, which fade in.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  // Counts loads, so that the table opens fresh for each one — its sort and
  // its scroll — while rows added by listening keep it as it is.
  const [loadCount, setLoadCount] = useState(0);

  // A batch is fresh until it has faded in. Cleared afterwards, so that
  // filtering or scrolling later does not play the arrival again.
  useEffect(() => {
    if (freshIds.size === 0) {
      return;
    }
    const timer = setTimeout(
      () => setFreshIds((current) => (current === freshIds ? new Set() : current)),
      2500,
    );
    return () => clearTimeout(timer);
  }, [freshIds]);
  const [filter, setFilter] = useState<EventFilter>(EMPTY_FILTER);

  const bookmarks = useBookmarks();

  const applications = useMemo(() => applicationOptions(events), [events]);
  const outcomes = useMemo(() => outcomeOptions(events), [events]);

  const filtered = useMemo(
    () => filterEvents(events, filter, bookmarks.ids),
    [events, filter, bookmarks.ids],
  );

  /** Updates one field of the filter, leaving the rest alone. */
  function setFilterField<K extends keyof EventFilter>(key: K, value: EventFilter[K]): void {
    setFilter((current) => ({ ...current, [key]: value }));
  }

  // Looked up in all events, not the filtered view: a row opened from the
  // The Observed Flow tab stays visible in the detail panel even when a filter hides it
  // from the table.
  const selectedRow = events.find((row) => row.rowId === selectedRowId);

  /**
   * Stops listening, if anything is. The feed then ends on its own and its
   * final summary replaces the provisional one — unless `forget`, for when
   * what is on screen is about to be replaced anyway.
   */
  function stopListening(forget = false): void {
    if (forget) {
      liveGeneration.current += 1;
      setLive(undefined);
    }
    if (live !== undefined) {
      void live.stop();
    }
  }

  /** Stops listening, if anything is, and waits — briefly — for it to end. */
  async function stopListeningAndWait(): Promise<void> {
    const ended = liveEnded.current;
    if (live === undefined || ended === undefined) {
      return;
    }
    void live.stop();
    await Promise.race([ended, new Promise<void>((done) => setTimeout(done, 5_000))]);
  }

  async function handleOpenFolder(): Promise<void> {
    setLoadError(undefined);
    const chosen = await pickFolder();
    if (chosen === undefined) {
      return;
    }
    // Only now: cancelling the picker leaves a listening window as it was.
    stopListening(true);
    setFolder(chosen);
    setLoading(true);
    try {
      const result = await loadFolder(chosen);
      setEvents(result.events);
      setSummary(result.summary);
      setFreshIds(new Set());
      setLoadCount((count) => count + 1);
      setSelectedRowId(undefined);
      setTab("overview");
    } catch (cause) {
      setLoadError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /** A window read from Kafka replaces what is on screen, as a folder does;
   * when it goes on listening, what arrives is added as it comes. */
  function showWindow(result: ReadOutcome): void {
    liveGeneration.current += 1;
    const generation = liveGeneration.current;
    setLoadError(undefined);
    setFolder(result.location);
    setEvents(result.events);
    setSummary(result.summary);
    setFreshIds(new Set());
    setLoadCount((count) => count + 1);
    setSelectedRowId(undefined);
    setTab(result.live === undefined ? "overview" : "events");
    const feed = result.live;
    if (feed === undefined) {
      setLive(undefined);
      return;
    }
    setLive({ topic: result.summary.window?.topic ?? "", added: 0, stop: feed.stop });
    let markEnded: () => void = () => undefined;
    liveEnded.current = new Promise<void>((done) => {
      markEnded = done;
    });
    feed.subscribe(
      (rows, current) => {
        if (liveGeneration.current !== generation) {
          return;
        }
        setEvents((shown) => shown.concat(rows));
        setSummary(current);
        setFreshIds(new Set(rows.map((row) => row.rowId)));
        setLive((badge) =>
          badge === undefined ? badge : { ...badge, added: badge.added + rows.length },
        );
      },
      (finalSummary) => {
        markEnded();
        if (liveGeneration.current !== generation) {
          return;
        }
        setSummary(finalSummary);
        setLive(undefined);
      },
    );
  }

  function showApplication(name: string): void {
    // UNKNOWN_APPLICATION is the label the breakdown gives events with no application
    // name; it is not a value any event carries, so it filters to nothing.
    setFilterField("application", name === UNKNOWN_APPLICATION ? ANY : name);
    setTab("events");
  }

  function openEventFromTrace(rowId: string): void {
    setSelectedRowId(rowId);
    setTab("events");
  }

  async function handleExport(): Promise<void> {
    setExportNote(undefined);
    try {
      const written = await exportRows(filtered);
      if (written !== undefined) {
        setExportNote(`${written} events written`);
      }
    } catch (cause) {
      setExportNote(`export failed: ${(cause as Error).message}`);
    }
  }

  const validCount = events.filter((row) => row.valid).length;

  // Everything in the picked folder that did not become events, in one place.
  // A file declined for its size, a file that could not be read and a
  // directory that could not be listed are the same thing to the person
  // looking at the screen — something they pointed the app at is not here —
  // so each is named, with the reason it is missing.
  const notRead = summary
    ? [...summary.filesSkipped, ...summary.filesFailed, ...summary.directoriesFailed]
    : [];

  // Files the load never got to, because it stopped at the ceiling first.
  // Naming them all would be noise — there can be thousands — but saying how
  // many there are keeps "this folder holds more" from being the only clue.
  const filesUnopened = summary === undefined ? 0 : filesNeverOpened(summary);

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={handleOpenFolder} disabled={loading}>
          {loading ? "Loading…" : "Open folder…"}
        </button>
        <button
          type="button"
          className="toolbar-secondary"
          onClick={() => setKafkaOpen(true)}
          disabled={loading}
        >
          Read from Kafka…
        </button>
        {folder ? (
          <span className="folder-path" title={folder}>
            {folder}
          </span>
        ) : null}
        {summary?.window !== undefined ? (
          <span className="summary">
            {summary.window.partitions.length} partition
            {summary.window.partitions.length === 1 ? "" : "s"} · {events.length} events ·{" "}
            {validCount} valid · {events.length - validCount} invalid
          </span>
        ) : summary ? (
          <span className="summary">
            {summary.filesRead} files · {events.length} events · {validCount} valid ·{" "}
            {events.length - validCount} invalid
            {summary.filesFailed.length > 0 ? ` · ${summary.filesFailed.length} unreadable` : ""}
            {summary.filesSkipped.length > 0 ? ` · ${summary.filesSkipped.length} too large` : ""}
            {summary.directoriesSkipped.length > 0 ? (
              // Expected rather than alarming — a repository root holds
              // node_modules — so it is counted here rather than warned about.
              // The title carries which ones, since a skipped directory can
              // hold audit logs the user meant to open.
              <span
                title={summary.directoriesSkipped
                  .map((notice) => `${displayPath(notice.path, folder)} — ${notice.reason}`)
                  .join("\n")}
              >
                {` · ${summary.directoriesSkipped.length} folders skipped`}
              </span>
            ) : null}
          </span>
        ) : null}
        {live !== undefined ? (
          <span className="live-badge" title={`Listening to ${live.topic}`}>
            <span className="live-dot" aria-hidden="true" />
            Listening · {live.added.toLocaleString()} new
            <button type="button" className="live-stop" onClick={() => stopListening()}>
              Stop
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className={summary ? "gear-button" : "gear-button push-right"}
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </header>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <KafkaDialog
        open={kafkaOpen}
        onClose={() => setKafkaOpen(false)}
        onLoaded={showWindow}
        // One read at a time: a new one replaces the one listening, which is
        // stopped when the new read starts — not when the dialog opens.
        onBeforeRead={stopListeningAndWait}
      />

      {loadError ? <p className="load-error">{loadError}</p> : null}

      {summary?.window !== undefined && stopWarning(summary.window) !== undefined ? (
        <p className="load-warning">
          {stopWarning(summary.window)} What is shown is the part of the window that was read:
          totals, chains and flows describe only that part.
        </p>
      ) : null}

      {summary?.truncated ? (
        <p className="load-warning">
          Stopped at {summary.eventLimit.toLocaleString()} events — this folder holds more. What is
          shown below is the first {summary.eventLimit.toLocaleString()} read, not a sample of the
          whole: totals, chains and flows describe only that part.
          {filesUnopened > 0
            ? ` ${filesUnopened} of the ${summary.filesFound} files found were never opened.`
            : ""}
        </p>
      ) : null}

      {notRead.length > 0 ? (
        <p className="load-warning">
          {notRead.length === 1 ? "One path was" : `${notRead.length} paths were`} not read:{" "}
          {notRead
            .slice(0, 3)
            .map((notice) => `${displayPath(notice.path, folder)} (${notice.reason})`)
            .join("; ")}
          {notRead.length > 3 ? `, and ${notRead.length - 3} more` : ""}.
        </p>
      ) : null}

      <nav className="tabs">
        <button
          type="button"
          className={tab === "overview" ? "tab active" : "tab"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={tab === "events" ? "tab active" : "tab"}
          onClick={() => setTab("events")}
        >
          Events
        </button>
        <button
          type="button"
          className={tab === "coverage" ? "tab active" : "tab"}
          onClick={() => setTab("coverage")}
        >
          Coverage
        </button>
        <button
          type="button"
          className={tab === "traces" ? "tab active" : "tab"}
          onClick={() => setTab("traces")}
        >
          Observed Flow
        </button>
        <button
          type="button"
          className={tab === "report" ? "tab active" : "tab"}
          onClick={() => setTab("report")}
        >
          Report
        </button>
      </nav>

      <div className={tab === "overview" ? "tab-panel" : "tab-panel hidden"}>
        <Overview
          events={events}
          summary={summary}
          onSelectApplication={showApplication}
          onOpenEvent={openEventFromTrace}
          folder={folder}
          windowed={summary?.window?.edges === true}
        />
      </div>

      <div className={tab === "coverage" ? "tab-panel" : "tab-panel hidden"}>
        <Coverage events={events} onSelectRow={openEventFromTrace} />
      </div>

      <div className={tab === "report" ? "tab-panel" : "tab-panel hidden"}>
        <Report key={loadCount} events={events} summary={summary} folder={folder} />
      </div>

      <div className={tab === "traces" ? "tab-panel" : "tab-panel hidden"}>
        <ObservedFlow
          events={events}
          onOpenEvent={openEventFromTrace}
          onSelectApplication={showApplication}
        />
      </div>

      <div className={tab === "events" ? "tab-panel" : "tab-panel hidden"}>
        <div className="filters">
          <input
            type="text"
            placeholder="Search event, application, actor, resource, summary…"
            value={filter.search}
            onChange={(event) => setFilterField("search", event.target.value)}
          />
          <select
            value={filter.application}
            onChange={(event) => setFilterField("application", event.target.value)}
          >
            <option value={ANY}>All applications</option>
            {applications.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={filter.outcome}
            onChange={(event) => setFilterField("outcome", event.target.value)}
          >
            <option value={ANY}>All outcomes</option>
            {outcomes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={filter.validity}
            onChange={(event) => setFilterField("validity", event.target.value as ValidityFilter)}
          >
            <option value="all">Valid + invalid</option>
            <option value="valid">Valid only</option>
            <option value="invalid">Invalid only</option>
          </select>
          <button
            type="button"
            className={filter.bookmarkedOnly ? "star-filter active" : "star-filter"}
            title={filter.bookmarkedOnly ? "Show all events" : "Show bookmarked only"}
            onClick={() => setFilterField("bookmarkedOnly", !filter.bookmarkedOnly)}
          >
            ★ {bookmarks.ids.size}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={filtered.length === 0}
            title="Export the current view as JSON Lines"
            onClick={() => void handleExport()}
          >
            Export
          </button>
          {exportNote ? <span className="export-note">{exportNote}</span> : null}
        </div>

        <main className="main">
          <EventTable
            key={loadCount}
            events={filtered}
            selectedRowId={selectedRowId}
            onSelect={setSelectedRowId}
            bookmarks={bookmarks.ids}
            onToggleBookmark={bookmarks.toggle}
            // A window read from Kafka opens newest read first, which is where
            // listening adds; a folder opens by the time its events carry.
            initialSort={
              summary?.window !== undefined
                ? { key: "arrival", ascending: false }
                : { key: "time", ascending: false }
            }
            fresh={freshIds}
          />
          <EventDetail
            row={selectedRow}
            allEvents={events}
            bookmarked={selectedRow !== undefined && bookmarks.has(selectedRow.rowId)}
            onToggleBookmark={bookmarks.toggle}
            onSelectRow={setSelectedRowId}
            windowed={summary?.window?.edges === true}
          />
        </main>
      </div>
    </div>
  );
}

export default App;
