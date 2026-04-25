---
description: "Resume the Bosun Local Ops Monitor in simulator-first continuous mode from the latest .bosun-monitor session notes and the narrowest unresolved blocker."
name: "Continue Bosun Monitor"
agent: "Bosun Local Ops Monitor"
argument-hint: "Optional focus, task ID, workflow family, or suspected blocker"
---
Resume the Bosun local operations monitor for this workspace in continuous mode.

Mandatory behavior:
- Read the latest three `.bosun-monitor/session*.md` notes before touching runtime state.
- Rebuild the open-blocker list from the newest note and continue from the narrowest unresolved blocker.
- Resume with `bosun simulate task <task-id>`, `bosun simulate task restart`, or `bosun simulate task` before using the full daemon as the main monitor path.
- Re-check simulator progress first. Only re-check daemon health, active paths, live task progress, workflow-run behavior, and recent non-monitor throughput after the simulator proves a real task can complete end to end or when you need minimal comparison evidence for the blocker.
- Inspect at least one real task path end to end before declaring health, including task execution, PR creation, review, fixes if review finds issues, and merge.
- If the previous cycle changed code and validation is incomplete, finish simulator validation before new cleanup.
- If the previous cycle only did runtime cleanup, keep going until you either land a durable source fix or isolate a precise blocker with proof.
- Do not unlock full-daemon monitoring until the simulator confirms that a real task finishes properly end to end and the merge lands cleanly.
- Once the simulator gate is satisfied, run the daemon and continue optimizing the live system in parallel.
- End by writing a fresh handoff note for the next cycle and reporting `healthy`, `warning`, or `incident` exactly as the agent requires.

Treat any user-supplied text as a priority hint, not as a replacement for the required startup sequence.

Continue the Bosun local ops monitor. Read the latest three session notes first, rebuild the open-blocker list, and resume from the narrowest unresolved blocker in simulator-first mode. Do not switch to full-daemon monitoring until `bosun simulate task` proves that a real task completes implementation, push, PR creation, review, fixes if needed, and merge end to end. After that gate is satisfied, run the daemon and keep optimizing live throughput in parallel. Do not stop at runtime cleanup. Land the smallest durable source fix you can, or leave a precise symptom -> proof -> code path -> blocker handoff for the next cycle.

