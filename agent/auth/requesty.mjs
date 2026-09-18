import { createProviderAuthAdapter } from "./_shared.mjs";

export const REQUESTY_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "requesty",
  label: "Requesty API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_REQUESTY_ENABLED",
    defaultModel: "BOSUN_PROVIDER_REQUESTY_MODEL",
    baseUrl: "BOSUN_PROVIDER_REQUESTY_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default REQUESTY_AUTH_ADAPTER;
