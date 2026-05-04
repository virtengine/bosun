function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export function createFollowupQueue(initialItems = []) {
  const items = Array.isArray(initialItems) ? [...initialItems] : [];
  return {
    enqueue(message, meta = {}) {
      const entry = {
        message: toTrimmedString(message),
        meta: meta && typeof meta === "object" ? { ...meta } : {},
        queuedAt: new Date().toISOString(),
      };
      items.push(entry);
      return entry;
    },
    drain() {
      const drained = items.splice(0, items.length);
      return drained.map((entry) => ({ ...entry, meta: { ...entry.meta } }));
    },
    list() {
      return items.map((entry) => ({ ...entry, meta: { ...entry.meta } }));
    },
    size() {
      return items.length;
    },
    clear() {
      items.length = 0;
    },
  };
}

export default createFollowupQueue;
