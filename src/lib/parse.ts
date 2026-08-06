/**
 * Turns raw file text into rows the table can show: parse, then validate
 * against the canonical schema, then extract the handful of fields the table
 * displays directly rather than re-reading the JSON on every render.
 */
import { validateEvent } from "./schema";
import { lintEvent } from "./privacy/lint-event";
import type { LoadedEvent, SourceFormat } from "./types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

let nextRowId = 0;

function buildRow(
  sourceFile: string,
  sourceFormat: SourceFormat,
  event: Record<string, unknown> | null,
  extra: { forcedError?: string } = {},
): LoadedEvent {
  const rowId = `${sourceFile}#${nextRowId++}`;

  if (event === null) {
    return {
      rowId,
      sourceFile,
      sourceFormat,
      event: null,
      valid: false,
      errors: [{ path: "/", message: extra.forcedError ?? "could not be parsed as an event" }],
      privacyFindings: [],
    };
  }

  const errors = validateEvent(event);
  // Deep linting is skipped for a schema-invalid event, the same rule the CLI
  // follows: traversing an arbitrary structure produces paths that mean
  // nothing. schemaValidate: false avoids running the (identical) validation
  // a second time inside lintEvent.
  const privacyFindings =
    errors.length === 0 ? lintEvent(event, sourceFile, { validateSchema: false }).findings : [];
  const eventDescriptor = asRecord(event["event"]);
  const actor = asRecord(event["actor"]);
  const resource = asRecord(event["resource"]);
  const application = asRecord(event["application"]);

  return {
    rowId,
    sourceFile,
    sourceFormat,
    event,
    valid: errors.length === 0,
    errors,
    privacyFindings,
    time: asString(event["time"]),
    applicationName: asString(application?.["name"]),
    environment: asString(application?.["environment"]),
    eventName: asString(eventDescriptor?.["name"]),
    eventCategory: asString(eventDescriptor?.["category"]),
    outcome: asString(eventDescriptor?.["outcome"]),
    actorType: asString(actor?.["type"]),
    actorId: asString(actor?.["id"]),
    resourceType: asString(resource?.["type"]),
    resourceId: asString(resource?.["id"]),
    summary: asString(eventDescriptor?.["summary"]),
  };
}

function parseJson(fileName: string, text: string): LoadedEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return [
      buildRow(fileName, "json", null, {
        forcedError: `not valid JSON: ${(cause as Error).message}`,
      }),
    ];
  }
  const documents = Array.isArray(parsed) ? parsed : [parsed];
  return documents.map((document) => buildRow(fileName, "json", asRecord(document) ?? null));
}

/**
 * Parses one line of a JSON Lines file.
 *
 * Exposed separately so the loader can consume a file as a stream instead of
 * holding all of its text, and then all of its lines, in memory at once.
 * Returns undefined for a blank line, which carries no event.
 */
export function parseJsonLine(
  fileName: string,
  line: string,
  lineNumber: number,
): LoadedEvent | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line);
    return buildRow(fileName, "jsonl", asRecord(parsed) ?? null);
  } catch (cause) {
    return buildRow(fileName, "jsonl", null, {
      forcedError: `line ${lineNumber}: not valid JSON (${(cause as Error).message})`,
    });
  }
}

/** True when a file name says its contents are one event per line. */
export function isJsonLines(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

/**
 * Parses one file's text in full.
 *
 * The loader streams JSON Lines rather than calling this, so in the app this
 * runs only for `.json` documents, which cannot be parsed incrementally. It
 * remains whole-text for tests and tooling.
 */
export function parseFile(fileName: string, text: string): LoadedEvent[] {
  if (isJsonLines(fileName)) {
    return text
      .split(/\r?\n/)
      .map((line, index) => parseJsonLine(fileName, line, index + 1))
      .filter((row): row is LoadedEvent => row !== undefined);
  }
  return parseJson(fileName, text);
}
