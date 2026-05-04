/**
 * Compatibility wrapper for legacy OpenCode provider discovery imports.
 *
 * Step 2 demotes shell-owned provider discovery. The authoritative inventory,
 * auth, model catalog, and connected-provider view now come from the registry-
 * backed provider runtime discovery under agent/.
 */

export {
  buildExecutorEntry,
  discoverProviders,
  formatModelsForMenu,
  formatProvidersForMenu,
  getConnectedProviders,
  getProviderModels,
  invalidateCache,
  isProviderConnected,
} from "../agent/provider-runtime-discovery.mjs";
