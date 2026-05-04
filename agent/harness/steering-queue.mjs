function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export function createSteeringQueue(initialItems = []) {
  const items = Array.isArray(initialItems) ? [...initialItems] : [];
  return {
    enqueue(prompt, meta = {}) {
      const entry = {
        prompt: toTrimmedString(prompt),
        meta: meta && typeof meta === "object" ? { ...meta } : {},
        queuedAt: new Date().toISOString(),
      };
      items.push(entry);
      return entry;
    },
    dequeue() {
      return items.shift() || null;
    },
    peek() {
      return items[0] || null;
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

export default createSteeringQueue;
