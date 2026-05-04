import { createToolEvent } from "./tool-event-contract.mjs";

function asListeners(options = {}) {
  return [
    options.onEvent,
    ...(Array.isArray(options.listeners) ? options.listeners : []),
  ].filter((listener) => typeof listener === "function");
}

export function createToolExecutionLedger(options = {}) {
  const listeners = asListeners(options);
  let sequence = 0;
  return {
    record(type, envelope = {}, detail = {}) {
      sequence += 1;
      const event = createToolEvent(type, envelope, {
        ...detail,
        sequence,
      });
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Tool observability must never break execution.
        }
      }
      return event;
    },
  };
}

export default createToolExecutionLedger;
