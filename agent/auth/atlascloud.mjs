import { createProviderAuthAdapter } from "./_shared.mjs";

export const ATLASCLOUD_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "atlascloud",
  label: "Atlas Cloud API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_ATLASCLOUD_ENABLED",
    defaultModel: "BOSUN_PROVIDER_ATLASCLOUD_MODEL",
    baseUrl: "BOSUN_PROVIDER_ATLASCLOUD_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default ATLASCLOUD_AUTH_ADAPTER;
