export interface NetworkTelemetryEntry {
  id: number;
  method: string;
  endpoint: string;
  status?: number;
  requestBytes: number;
  responseBytes: number;
  durationMs?: number;
  startedAt: string;
}

export interface NetworkTelemetrySummary {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  byEndpoint: Record<string, { requests: number; responseBytes: number }>;
}

const MAX_ENTRIES = 250;
const entries: NetworkTelemetryEntry[] = [];
let nextId = 1;

function telemetryEnabled() {
  if (process.env.NODE_ENV !== "production") return true;
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem("church-attendance-network-telemetry") === "1"
    );
  } catch {
    return false;
  }
}

function byteLength(value: BodyInit | null | undefined) {
  if (!value) return 0;
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof URLSearchParams) {
    return new TextEncoder().encode(value.toString()).byteLength;
  }
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return 0;
}

function safeEndpoint(input: RequestInfo | URL) {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, "http://localhost");
    return url.pathname;
  } catch {
    return "unknown";
  }
}

function append(entry: NetworkTelemetryEntry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function resetNetworkTelemetry() {
  entries.length = 0;
  nextId = 1;
}

export function getNetworkTelemetryEntries() {
  return entries.map((entry) => ({ ...entry }));
}

export function getNetworkTelemetrySummary(): NetworkTelemetrySummary {
  return entries.reduce<NetworkTelemetrySummary>(
    (summary, entry) => {
      summary.requests += 1;
      summary.requestBytes += entry.requestBytes;
      summary.responseBytes += entry.responseBytes;
      const endpoint = summary.byEndpoint[entry.endpoint] ?? {
        requests: 0,
        responseBytes: 0,
      };
      endpoint.requests += 1;
      endpoint.responseBytes += entry.responseBytes;
      summary.byEndpoint[entry.endpoint] = endpoint;
      return summary;
    },
    { requests: 0, requestBytes: 0, responseBytes: 0, byEndpoint: {} },
  );
}

export function installNetworkTelemetryDebug() {
  if (typeof window === "undefined" || !telemetryEnabled()) return;
  const debugWindow = window as Window & {
    __churchAttendanceNetwork?: {
      summary: typeof getNetworkTelemetrySummary;
      entries: typeof getNetworkTelemetryEntries;
      reset: typeof resetNetworkTelemetry;
    };
  };
  debugWindow.__churchAttendanceNetwork = Object.freeze({
    summary: getNetworkTelemetrySummary,
    entries: getNetworkTelemetryEntries,
    reset: resetNetworkTelemetry,
  });
}

export async function telemetryFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (!telemetryEnabled()) return fetch(input, init);
  const started = performance.now();
  const request = input instanceof Request ? input : undefined;
  const entry: NetworkTelemetryEntry = {
    id: nextId++,
    method: init?.method ?? request?.method ?? "GET",
    endpoint: safeEndpoint(input),
    requestBytes: byteLength(init?.body),
    responseBytes: 0,
    startedAt: new Date().toISOString(),
  };
  try {
    const response = await fetch(input, init);
    entry.status = response.status;
    const headerSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(headerSize) && headerSize >= 0) {
      entry.responseBytes = headerSize;
    } else {
      try {
        entry.responseBytes = (await response.clone().arrayBuffer()).byteLength;
      } catch {
        // Opaque responses may not expose a readable body.
      }
    }
    return response;
  } finally {
    entry.durationMs = Math.round((performance.now() - started) * 10) / 10;
    append(entry);
  }
}
