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

function parseJsonLines(fileName: string, text: string): LoadedEvent[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      return buildRow(fileName, "jsonl", asRecord(parsed) ?? null);
    } catch (cause) {
      return buildRow(fileName, "jsonl", null, {
        forcedError: `line ${index + 1}: not valid JSON (${(cause as Error).message})`,
      });
    }
  });
}

/** Parses one file's text, given its name (used only to pick a format by extension). */
export function parseFile(fileName: string, text: string): LoadedEvent[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    return parseJsonLines(fileName, text);
  }
  return parseJson(fileName, text);
}
