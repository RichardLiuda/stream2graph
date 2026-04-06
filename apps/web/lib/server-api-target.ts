const DEFAULT_API_SERVICE_HOST = "api";
const DEFAULT_API_PORT = "8000";

function normalizeOrigin(value: string | undefined | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

function splitCsv(value: string | undefined | null) {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => Boolean(item));
}

function candidateOrigins() {
  const configuredPort = process.env.S2G_API_SERVICE_PORT?.trim() || process.env.API_PORT?.trim() || DEFAULT_API_PORT;
  const configuredHost = process.env.S2G_API_SERVICE_HOST?.trim() || DEFAULT_API_SERVICE_HOST;
  const configuredServiceUrl =
    normalizeOrigin(process.env.S2G_API_SERVICE_URL) || `http://${configuredHost}:${configuredPort}`;

  const candidates = [
    process.env.API_PROXY_TARGET,
    process.env.NEXT_PUBLIC_API_PROXY_TARGET,
    process.env.S2G_INTERNAL_API_BASE_URL,
    ...splitCsv(process.env.S2G_API_PROXY_CANDIDATES),
    configuredServiceUrl,
  ]
    .map((value) => normalizeOrigin(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

export function getApiProxyCandidates() {
  return candidateOrigins();
}
