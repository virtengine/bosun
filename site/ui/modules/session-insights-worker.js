/*
 * Session insights Web Worker.
 * Offloads buildSessionInsights() to a background thread so InspectorPanel
 * polling never blocks the main thread (and chat input stays responsive).
 *
 * Protocol:
 *   main → worker: { id: number, session: object|null }
 *   worker → main: { id: number, ok: true,  insights: object|null }
 *               | { id: number, ok: false, error: string }
 */

import { buildSessionInsights } from "../../lib/session-insights.mjs";

self.onmessage = (event) => {
  const data = event?.data || {};
  const { id, session } = data;
  if (typeof id !== "number") return;
  try {
    const insights = buildSessionInsights(session || null);
    self.postMessage({ id, ok: true, insights });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err && err.message ? String(err.message) : "session-insights-failed",
    });
  }
};
