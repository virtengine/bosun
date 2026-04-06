import {
  getBuiltInProviderDriver,
  listBuiltInProviderDrivers,
  normalizeProviderDriverId,
} from "./providers/index.mjs";

const DEFAULT_CAPABILITIES = Object.freeze({
  streaming: true,
  steering: false,
  sessions: false,
  sdkCommands: false,
  usage: true,
  auth: true,
  subscription: false,
  apiKey: false,
  oauth: false,
  local: false,
  openaiCompatible: false,
  toolCalls: false,
  reasoning: false,
  cost: false,
});

const LEGACY_PROVIDER_MAP = Object.freeze({
  codex: "openai-codex-subscription",
  "codex-sdk": "openai-codex-subscription",
  copilot: "copilot-oauth",
  "copilot-sdk": "copilot-oauth",
  claude: "claude-subscription-shim",
  "claude-sdk": "claude-subscription-shim",
  gemini: "gemini-generate-content",
  "gemini-sdk": "gemini-generate-content",
  "google-gemini": "gemini-generate-content",
  opencode: "openai-compatible",
  "opencode-sdk": "openai-compatible",
  "open-code": "openai-compatible",
});
const LEGACY_PROVIDER_CAPABILITIES = Object.freeze({});

function normalizeKnownProviderId(value) {
  const normalized = normalizeProviderDriverId(value || "");
  if (!normalized) return "";
  const mapped = LEGACY_PROVIDER_MAP[normalized] || normalized;
  const driver = getBuiltInProviderDriver(mapped);
  if (driver) return driver.id;
  return mapped;
}

function toCapabilitySnapshot(driver) {
  return Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...(driver?.capabilities || {}),
    providerId: driver?.id || null,
    adapterId: driver?.adapterHints?.adapterId || null,
    transport: driver?.transport?.apiStyle || null,
    toolCalls: driver?.capabilities?.tools === true,
  });
}

const PROVIDER_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    listBuiltInProviderDrivers().map((driver) => [driver.id, toCapabilitySnapshot(driver)]),
  ),
);

export function normalizeProviderCapabilityId(value) {
  const normalized = normalizeKnownProviderId(value);
  return normalized || "openai-responses";
}

export function listProviderCapabilityIds() {
  return [
    ...Object.keys(PROVIDER_CAPABILITIES),
    ...Object.keys(LEGACY_PROVIDER_CAPABILITIES),
  ];
}

export function getProviderCapabilities(providerId, overrides = null) {
  const normalized = normalizeProviderCapabilityId(providerId);
  const base =
    PROVIDER_CAPABILITIES[normalized]
    || LEGACY_PROVIDER_CAPABILITIES[normalized]
    || DEFAULT_CAPABILITIES;
  return overrides && typeof overrides === "object"
    ? { ...base, ...overrides, providerId: normalized }
    : { ...base };
}

export function supportsProviderCapability(providerId, capability, overrides = null) {
  const resolved = getProviderCapabilities(providerId, overrides);
  return resolved[String(capability || "").trim()] === true;
}

export default getProviderCapabilities;
