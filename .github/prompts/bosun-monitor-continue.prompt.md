---
description: "Resume the Bosun Local Ops Monitor in continuous mode from the latest .bosun-monitor session notes and the narrowest unresolved blocker."
name: "Continue Bosun Monitor"
agent: "Bosun Local Ops Monitor"
argument-hint: "Optional focus, task ID, workflow family, or suspected blocker"
---
Resume the Bosun local operations monitor for this workspace in continuous mode.

Mandatory behavior:
- Read the latest three `.bosun-monitor/session*.md` notes before touching runtime state.
- Rebuild the open-blocker list from the newest note and continue from the narrowest unresolved blocker.
- Re-check runtime health, active paths, live task progress, workflow-run behavior, and recent non-monitor throughput.
- Inspect at least one real task path end to end before declaring health.
- If the previous cycle changed code and validation is incomplete, finish validation before new cleanup.
- If the previous cycle only did runtime cleanup, keep going until you either land a durable source fix or isolate a precise blocker with proof.
- End by writing a fresh handoff note for the next cycle and reporting `healthy`, `warning`, or `incident` exactly as the agent requires.

Treat any user-supplied text as a priority hint, not as a replacement for the required startup sequence.

Continue the Bosun local ops monitor. Read the latest three session notes first, rebuild the open-blocker list, resume from the narrowest unresolved blocker, verify live task progress and throughput, and do not stop at runtime cleanup. Land the smallest durable source fix you can, or leave a precise symptom -> proof -> code path -> blocker handoff for the next cycle.

