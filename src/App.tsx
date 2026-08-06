import { useMemo, useState } from "react";
import "./App.css";
import { EventTable } from "./components/EventTable";
import { EventDetail } from "./components/EventDetail";
import { Overview } from "./components/Overview";
import { Traces } from "./components/Traces";
import { SettingsDialog } from "./components/SettingsDialog";
import { exportRows, loadFolder, pickFolder } from "./lib/load";
import { applyThemePreference, loadThemePreference } from "./lib/settings";
import {
  ANY,
  EMPTY_FILTER,
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

type Tab = "overview" | "events" | "traces";

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
  // Traces tab stays visible in the detail panel even when a filter hides it
  // from the table.
  const selectedRow = events.find((row) => row.rowId === selectedRowId);

  async function handleOpenFolder(): Promise<void> {
    setLoadError(undefined);
    const chosen = await pickFolder();
    if (chosen === undefined) {
      return;
    }
    setFolder(chosen);
    setLoading(true);
    try {
      const result = await loadFolder(chosen);
      setEvents(result.events);
      setSummary(result.summary);
      setSelectedRowId(undefined);
      setTab("overview");
    } catch (cause) {
      setLoadError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function showApplication(name: string): void {
    // "(unknown)" is the label the breakdown gives events with no application
    // name; it is not a value any event carries, so it filters to nothing.
    setFilterField("application", name === "(unknown)" ? ANY : name);
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

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={handleOpenFolder} disabled={loading}>
          {loading ? "Loading…" : "Open folder…"}
        </button>
        {folder ? (
          <span className="folder-path" title={folder}>
            {folder}
          </span>
        ) : null}
        {summary ? (
          <span className="summary">
            {summary.filesRead} files · {events.length} events · {validCount} valid ·{" "}
            {events.length - validCount} invalid
            {summary.filesFailed.length > 0 ? ` · ${summary.filesFailed.length} unreadable` : ""}
            {summary.filesSkipped.length > 0 ? ` · ${summary.filesSkipped.length} too large` : ""}
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

      {loadError ? <p className="load-error">{loadError}</p> : null}

      {summary?.truncated ? (
        <p className="load-warning">
          Stopped at {summary.eventLimit.toLocaleString()} events — this folder holds more. What is
          shown below is the first {summary.eventLimit.toLocaleString()} read, not a sample of the
          whole: totals, chains and flows describe only that part.
        </p>
      ) : null}

      {summary && summary.filesSkipped.length > 0 ? (
        <p className="load-warning">
          {summary.filesSkipped.length} file
          {summary.filesSkipped.length === 1 ? " was" : "s were"} not read:{" "}
          {summary.filesSkipped
            .slice(0, 3)
            .map((notice) => `${notice.file.split(/[/\\]/).pop()} (${notice.reason})`)
            .join("; ")}
          {summary.filesSkipped.length > 3 ? ", and others" : ""}.
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
          className={tab === "traces" ? "tab active" : "tab"}
          onClick={() => setTab("traces")}
        >
          Traces
        </button>
      </nav>

      <div className={tab === "overview" ? "tab-panel" : "tab-panel hidden"}>
        <Overview events={events} summary={summary} onSelectApplication={showApplication} />
      </div>

      <div className={tab === "traces" ? "tab-panel" : "tab-panel hidden"}>
        <Traces
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
            events={filtered}
            selectedRowId={selectedRowId}
            onSelect={setSelectedRowId}
            bookmarks={bookmarks.ids}
            onToggleBookmark={bookmarks.toggle}
          />
          <EventDetail
            row={selectedRow}
            allEvents={events}
            bookmarked={selectedRow !== undefined && bookmarks.has(selectedRow.rowId)}
            onToggleBookmark={bookmarks.toggle}
            onSelectRow={setSelectedRowId}
          />
        </main>
      </div>
    </div>
  );
}

export default App;
