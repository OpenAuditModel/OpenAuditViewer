/**
 * URL and connection-string analysis.
 *
 * Parsing is done with the WHATWG `URL` parser rather than a regular
 * expression. URL grammar is genuinely difficult, and a regular expression that
 * looks right will disagree with a real parser on exactly the inputs an attacker
 * chooses. Nothing here resolves, fetches or opens anything: the parser is used
 * as a grammar, offline.
 */

/** What was found in a value that parses as a URL. */
export interface UrlAnalysis {
  readonly scheme: string;
  readonly hasUserinfo: boolean;
  readonly hasPassword: boolean;
  readonly hasQuery: boolean;
  readonly hasFragment: boolean;
}

/**
 * Schemes whose URL form is a connection string: a locator for a data store or
 * broker, which commonly carries credentials.
 */
const DATA_SYSTEM_SCHEMES: ReadonlySet<string> = new Set([
  "postgres:",
  "postgresql:",
  "mysql:",
  "mariadb:",
  "mongodb:",
  "mongodb+srv:",
  "redis:",
  "rediss:",
  "amqp:",
  "amqps:",
  "mssql:",
  "sqlserver:",
  "oracle:",
  "jdbc:",
  "cassandra:",
  "clickhouse:",
  "db2:",
  "ftp:",
  "ftps:",
  "sftp:",
  "smb:",
]);

/** Keys that appear in key-value connection strings. */
const CONNECTION_STRING_KEYS: ReadonlySet<string> = new Set([
  "server",
  "host",
  "hostname",
  "datasource",
  "initialcatalog",
  "database",
  "userid",
  "uid",
  "username",
  "user",
  "password",
  "pwd",
  "port",
  "endpoint",
  "accountname",
  "accountkey",
  "sharedaccesskey",
  "integratedsecurity",
  "encrypt",
  "trustservercertificate",
]);

/** Keys whose presence with a non-empty value means the string carries a credential. */
const CONNECTION_STRING_SECRET_KEYS: ReadonlySet<string> = new Set([
  "password",
  "pwd",
  "accountkey",
  "sharedaccesskey",
]);

/** Parses a value as a URL and reports what it contains. Returns `undefined` if it is not a URL. */
export function analyzeUrl(value: string): UrlAnalysis | undefined {
  const trimmed = value.trim();
  if (!trimmed.includes(":")) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  return {
    scheme: url.protocol,
    hasUserinfo: url.username !== "" || url.password !== "",
    hasPassword: url.password !== "",
    hasQuery: url.search !== "",
    hasFragment: url.hash !== "",
  };
}

/** True when a URL scheme identifies a data store or message broker. */
export function isDataSystemScheme(scheme: string): boolean {
  return DATA_SYSTEM_SCHEMES.has(scheme.toLowerCase());
}

export type ConnectionStringKind = "credentialed" | "uncredentialed";

/**
 * Recognises a key-value connection string such as
 * `Server=...;Database=...;User Id=...;Password=...`.
 *
 * At least two recognised keys are required, so that an arbitrary
 * semicolon-separated string is not mistaken for one. The pattern is a single
 * bounded alternation over one key-value pair and cannot backtrack
 * catastrophically.
 */
export function analyzeKeyValueConnectionString(value: string): ConnectionStringKind | undefined {
  if (!value.includes("=") || !value.includes(";")) {
    return undefined;
  }
  if (value.length > 8192) {
    return undefined;
  }

  let recognisedKeys = 0;
  let credentialed = false;

  for (const pair of value.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = pair
      .slice(0, separator)
      .trim()
      .toLowerCase()
      .replaceAll(/[-_. ]/g, "");
    const hasValue = pair.slice(separator + 1).trim() !== "";

    if (!CONNECTION_STRING_KEYS.has(key)) {
      continue;
    }
    recognisedKeys += 1;
    if (CONNECTION_STRING_SECRET_KEYS.has(key) && hasValue) {
      credentialed = true;
    }
  }

  if (recognisedKeys < 2) {
    return undefined;
  }
  return credentialed ? "credentialed" : "uncredentialed";
}

/**
 * Recognises a connection string in either URL or key-value form.
 *
 * A connection string without a credential is still reported, separately and at
 * low severity: it discloses infrastructure, but calling it a credential when it
 * carries none would be wrong.
 */
export function analyzeConnectionString(value: string): ConnectionStringKind | undefined {
  const url = analyzeUrl(value);
  if (url !== undefined && isDataSystemScheme(url.scheme)) {
    return url.hasPassword ? "credentialed" : "uncredentialed";
  }
  return analyzeKeyValueConnectionString(value);
}
