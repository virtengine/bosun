import { normalizeProviderStreamEvent } from "../provider-message-transform.mjs";

export function normalizeProviderStreamEnvelope(event = {}, options = {}) {
  return normalizeProviderStreamEvent(event, options);
}

export default normalizeProviderStreamEnvelope;
