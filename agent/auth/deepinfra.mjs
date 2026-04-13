import { createProviderAuthAdapter } from "./_shared.mjs";

export const DEEPINFRA_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "deepinfra",
  label: "DeepInfra API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_DEEPINFRA_ENABLED",
    defaultModel: "BOSUN_PROVIDER_DEEPINFRA_MODEL",
    baseUrl: "BOSUN_PROVIDER_DEEPINFRA_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default DEEPINFRA_AUTH_ADAPTER;
