/**
 * tool-call-repair.mjs
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║      B O S U N   T O O L   C A L L   R E P A I R                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Inspires directly from Vercel AI SDK's ToolCallRepairFunction pattern:
 *     packages/ai/src/generate-text/tool-call-repair-function.ts
 *     packages/ai/src/generate-text/parse-tool-call.ts
 *
 * When the model returns a malformed or invalid tool call, this module
 * gives it ONE chance to self-correct by sending a repair prompt that
 * includes the original call, the schema, and the parse error.
 *
 * ─── WHEN IT FIRES ──────────────────────────────────────────────────────────
 *
 *   1. The assistant returns a function call whose arguments are not
 *      valid JSON — e.g. a partially-truncated object.
 *   2. The arguments parse as JSON but don't match the tool's schema
 *      (missing required field, wrong type, unknown key).
 *   3. The model hallucinated a tool name that doesn't exist in the
 *      current tool catalog.
 *
 * ─── HOW IT WORKS ───────────────────────────────────────────────────────────
 *
 *   repair(brokenCalls, execOptions) → Promise<ToolCall[]>
 *
 *   For each broken call the repair sends a single non-streaming Chat
 *   Completions call with:
 *     - system: "You are a strict JSON repair assistant."
 *     - user:  the broken call + the JSON schema + the error description
 *   and expects a repaired JSON object in the response.
 *
 *   If the repair fails (network, timeout, still invalid), the original
 *   broken call is passed through unchanged — callers get an error output
 *   that the LLM can self-correct on the next round. The repair NEVER
 *   blocks forward progress.
 *
 *   Repair calls use a small/fast model (default: gpt-4o-mini) and are
 *   non-streaming with a 10-second timeout.
 *
 * ─── PUBLIC API ─────────────────────────────────────────────────────────────
 *
 *  detectBrokenToolCalls(toolCalls, toolDefs)       → BrokenCall[]
 *  repairToolCalls(brokenCalls, execOptions, opts?) → Promise<RepairedCall[]>
 *  applyRepairs(toolCalls, repairs)                 → ToolCall[]      (merged)
 */

// ── Utilities ────────────────────────────────────────────────────────────────

function toStr(v) { return String(v ?? "").trim(); }

function isAzureEndpoint(rawEndpoint) {
  const candidate = toStr(rawEndpoint);
  if (!candidate) return false;

  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    const host = toStr(parsed.hostname).toLowerCase();
    return host === "azure.com" || host.endsWith(".azure.com");
  } catch {
    return false;
  }
}

function tryParseJson(s) {
  if (typeof s !== "string") return { ok: false, error: "Not a string" };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: toStr(err?.message) };
  }
}

// ── Schema Introspection ──────────────────────────────────────────────────────

/**
 * Extract a human-readable list of required properties and their types
 * from a JSON Schema object. Used in repair prompts.
 */
function schemaToDescription(schema) {
  if (!schema || typeof schema !== "object") return "(no schema)";
  const props = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  const lines = [];
  for (const [key, def] of Object.entries(props)) {
    const type = typeof def === "object" ? (def.type ?? "any") : "any";
    const req  = required.has(key) ? " (required)" : " (optional)";
    const desc = typeof def === "object" && def.description ? ` — ${def.description}` : "";
    lines.push(`  ${key}: ${type}${req}${desc}`);
  }
  if (lines.length === 0) return "(no properties defined)";
  return lines.join("\n");
}

// ── Broken Call Detection ─────────────────────────────────────────────────────

/**
 * Scan a tool-call batch and identify calls that are broken.
 * Returns an array of BrokenCall descriptors for each broken call.
 *
 * @param {Array}  toolCalls  Tool call objects from the stream
 * @param {Object} toolDefs   Map of toolName → toolDefinition (from execOptions.toolDefinitions)
 * @returns {BrokenCall[]}
 *
 * A BrokenCall is:
 *   { index: number, tc: ToolCall, reason: string, schema: object|null }
 */
export function detectBrokenToolCalls(toolCalls, toolDefs = {}) {
  if (!Array.isArray(toolCalls)) return [];
  const broken = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc     = toolCalls[i];
    const name   = toStr(tc?.name || "");
    const toolDef = toolDefs[name] ?? null;

    // ① Unknown tool name
    if (name && Object.keys(toolDefs).length > 0 && !toolDef) {
      broken.push({
        index: i, tc,
        reason: `Tool "${name}" does not exist. Available tools: ${Object.keys(toolDefs).join(", ")}`,
        schema: null,
      });
      continue;
    }

    // ② Unparseable arguments
    const rawArgs = tc?.argumentsRaw ?? (
      typeof tc?.arguments === "string" ? tc.arguments :
      (tc?.arguments != null ? JSON.stringify(tc.arguments) : "")
    );

    const parsed = tryParseJson(rawArgs);
    if (!parsed.ok && rawArgs.length > 0) {
      broken.push({
        index: i, tc,
        reason: `Arguments are not valid JSON: ${parsed.error}`,
        schema: toolDef?.parameters ?? toolDef?.inputSchema ?? null,
      });
      continue;
    }

    // ③ Schema validation (basic required-field check)
    const schema = toolDef?.parameters ?? toolDef?.inputSchema ?? null;
    if (schema && parsed.ok) {
      const args     = parsed.value ?? {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      const missing  = required.filter((k) => !(k in args));
      if (missing.length > 0) {
        broken.push({
          index: i, tc,
          reason: `Missing required argument(s): ${missing.join(", ")}`,
          schema,
        });
      }
    }
  }

  return broken;
}

// ── Repair Prompt Builder ─────────────────────────────────────────────────────

function buildRepairPrompt({ name, rawArgs, schema, error }) {
  const schemaDesc = schema
    ? `JSON Schema for the tool arguments:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``
    : "(no schema available — return a best-effort JSON object based on the tool name)";

  return (
    `You are repairing a malformed tool call for the tool "${name}".\n\n` +
    `PROBLEM:\n${error}\n\n` +
    `ORIGINAL ARGUMENTS (broken):\n\`\`\`\n${rawArgs || "(empty)"}\n\`\`\`\n\n` +
    `${schemaDesc}\n\n` +
    `Respond with ONLY a single valid JSON object that fixes the problem. ` +
    `Do NOT include markdown fences or explanations — just the JSON object.`
  );
}

// ── HTTP Repair Call ──────────────────────────────────────────────────────────

/**
 * Make a single, non-streaming Chat Completions call to repair a broken tool call.
 * Returns the repaired JSON object, or throws on failure.
 *
 * @param {string}          repairPrompt
 * @param {Object}          execOptions
 * @param {string|undefined} repairModel
 * @returns {Promise<{ repairedArgs: object, raw: string }>}
 */
async function callRepairApi(repairPrompt, execOptions, repairModel) {
  // Dynamic imports to avoid circular dependency on the adapter
  const { default: resolveEndpointUrl } =
    await import("./openai-native-adapter.mjs")
      .then((m) => ({ default: m._resolveEndpointUrl }))
      .catch(() => ({ default: null }));

  // Fall back to a simple URL construction if the helper isn't available
  const pc        = execOptions?.providerConfig ?? {};
  const rawEndpoint = toStr(pc.endpoint || pc.baseUrl || "");
  const model     = toStr(repairModel || pc.repairModel || pc.summaryModel || "gpt-4o-mini");
  const isAzure   = isAzureEndpoint(rawEndpoint) || Boolean(toStr(pc.deployment));

  let url;
  if (isAzure && rawEndpoint) {
    const deployment = toStr(pc.deployment) || model;
    const apiVersion = toStr(pc.apiVersion) || "2025-03-01-preview";
    url = `${rawEndpoint.replace(/\/+$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  } else {
    const base = rawEndpoint || "https://api.openai.com";
    url = `${base.replace(/\/+$/, "")}/v1/chat/completions`;
  }

  // Build auth headers
  const env    = execOptions?.env ?? process.env;
  const apiKey = toStr(pc.apiKey || env.AZURE_OPENAI_API_KEY || env.OPENAI_API_KEY || "");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(isAzure && apiKey ? { "api-key": apiKey } : {}),
    ...(!isAzure && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const body = {
    model,
    messages: [
      {
        role: "system",
        content: "You are a strict JSON repair assistant. Output only valid JSON.",
      },
      { role: "user", content: repairPrompt },
    ],
    stream: false,
    max_tokens: 1024,
    temperature: 0,
  };

  const controller  = new AbortController();
  const timeoutId   = setTimeout(() => controller.abort("repair_timeout"), 10_000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let errBody = "";
    try { errBody = await response.text(); } catch { /* ignore */ }
    throw new Error(`Repair API returned ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const json    = await response.json();
  const raw     = toStr(json?.choices?.[0]?.message?.content || "");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const parsed = tryParseJson(cleaned);
  if (!parsed.ok) {
    throw new Error(`Repair response is not valid JSON: ${parsed.error}\nRaw: ${cleaned.slice(0, 200)}`);
  }

  return { repairedArgs: parsed.value, raw: cleaned };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to repair each broken tool call.
 * Returns an array of { index, repairedArgs, success, error? }.
 * Never throws — failed repairs are returned with success=false.
 *
 * @param {Array}   brokenCalls      Output of detectBrokenToolCalls()
 * @param {Object}  execOptions       Standard exec options
 * @param {Object}  [opts]
 * @param {string}  [opts.repairModel]  Override for the repair model name
 * @returns {Promise<RepairedCall[]>}
 */
export async function repairToolCalls(brokenCalls, execOptions, opts = {}) {
  if (!brokenCalls || brokenCalls.length === 0) return [];
  const { repairModel } = opts;

  const repairResults = await Promise.allSettled(
    brokenCalls.map(async ({ index, tc, reason, schema }) => {
      const name   = toStr(tc?.name || "");
      const rawArgs = tc?.argumentsRaw ?? (
        typeof tc?.arguments === "string" ? tc.arguments :
        (tc?.arguments != null ? JSON.stringify(tc.arguments) : "")
      );

      const prompt = buildRepairPrompt({ name, rawArgs, schema, error: reason });

      try {
        const { repairedArgs } = await callRepairApi(prompt, execOptions, repairModel);
        return { index, repairedArgs, success: true };
      } catch (err) {
        return { index, repairedArgs: null, success: false, error: toStr(err?.message || err) };
      }
    }),
  );

  return repairResults.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { index: brokenCalls[repairResults.indexOf(r)]?.index, repairedArgs: null, success: false, error: String(r.reason?.message ?? r.reason) },
  );
}

/**
 * Merge repair results back into the original tool-call array.
 * Successfully repaired calls get updated `arguments` and `argumentsRaw`.
 * Calls that couldn't be repaired are returned unchanged.
 *
 * @param {Array} toolCalls   Original tool-call array
 * @param {Array} repairs     Output of repairToolCalls()
 * @returns {Array}  New array (original not mutated)
 */
export function applyRepairs(toolCalls, repairs) {
  if (!repairs || repairs.length === 0) return toolCalls;
  const result = [...toolCalls];
  for (const { index, success, repairedArgs } of repairs) {
    if (!success || repairedArgs == null) continue;
    const orig = result[index];
    if (!orig) continue;
    result[index] = {
      ...orig,
      arguments: repairedArgs,
      argumentsRaw: JSON.stringify(repairedArgs),
      repaired: true,
    };
  }
  return result;
}
