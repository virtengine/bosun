export async function requestJsonApi(base, path, options = {}) {
  const {
    method = "GET",
    body,
    timeoutMs = 15000,
    headers = {},
    bearerToken = "",
    unwrapData = false,
    errorPrefix = "API request",
  } = options;
  const normalizedBase = String(base || "").trim();
  if (!normalizedBase) {
    throw new Error(`${errorPrefix} host missing`);
  }
  const url = new URL(path, normalizedBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${errorPrefix} failed: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`${errorPrefix} response parse error: ${err.message}`);
    }
  }

  if (!response.ok || data?.ok === false || data?.success === false) {
    const detail = String(
      data?.error ||
      data?.message ||
      response.statusText ||
      `HTTP ${response.status}`,
    ).trim() || `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return unwrapData ? (data?.data ?? data) : data;
}
