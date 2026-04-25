/**
 * shell/mcp-registry.mjs — Shell-side MCP Server Discovery
 *
 * Thin convenience layer over workflow/mcp-registry.mjs that exposes
 * server configs suitable for the native harness. No connection logic
 * lives here — use shell/mcp-client.mjs for transports.
 *
 * Public API:
 *   discoverMcpServers(options) → Promise<Object[]>
 *
 * Options:
 *   - rootDir: string                workspace root for library lookup
 *   - serverIds: string[]            explicit IDs to resolve
 *   - includeInstalled: boolean      auto-resolve all installed servers (default true)
 *   - catalogOverrides: Object       per-server env overrides
 */

import {
  listInstalledMcpServers,
  resolveMcpServersForAgent,
} from "../workflow/mcp-registry.mjs";

const TAG = "[shell-mcp-registry]";

function toStr(v) {
  return String(v ?? "").trim();
}

/**
 * Discover and resolve MCP server configurations for the native harness.
 *
 * @param {Object} options
 * @returns {Promise<Array<{id, name, transport, command?, args?, url?, env}>>}
 */
export async function discoverMcpServers(options = {}) {
  const {
    rootDir = "",
    serverIds = [],
    includeInstalled = true,
    catalogOverrides = {},
  } = options;

  const ids = [...serverIds];

  if (includeInstalled && rootDir) {
    try {
      const installed = await listInstalledMcpServers(rootDir);
      for (const entry of installed) {
        if (entry?.id && !ids.includes(entry.id)) {
          ids.push(entry.id);
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to list installed MCP servers: ${err?.message || err}`);
    }
  }

  if (ids.length === 0) return [];

  try {
    const resolved = await resolveMcpServersForAgent(rootDir, ids, {
      catalogOverrides,
      requireAuth: true,
    });
    return resolved;
  } catch (err) {
    console.warn(`${TAG} resolve failed: ${err?.message || err}`);
    return [];
  }
}

export default { discoverMcpServers };
