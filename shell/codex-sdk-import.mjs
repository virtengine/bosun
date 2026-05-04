const dynamicImport = new Function("specifier", "return import(specifier);");

export async function loadBareCodexSdkModule() {
  return dynamicImport("@openai/codex-sdk");
}

export default loadBareCodexSdkModule;
