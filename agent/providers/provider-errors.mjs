function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export class ProviderKernelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = toTrimmedString(options.code) || "provider_error";
    this.providerId = toTrimmedString(options.providerId) || null;
    this.cause = options.cause;
  }
}

export class ProviderConfigurationError extends ProviderKernelError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || "provider_configuration_error",
    });
  }
}

export class ProviderExecutionError extends ProviderKernelError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || "provider_execution_error",
    });
  }
}

export function normalizeProviderErrorDetails(error, fallback = {}) {
  if (typeof error === "string") {
    return {
      code: toTrimmedString(fallback.code) || "provider_error",
      message: toTrimmedString(error) || toTrimmedString(fallback.message) || "provider_error",
      providerId: toTrimmedString(fallback.providerId) || null,
      retriable: fallback.retriable === true,
    };
  }
  if (!error) {
    return {
      code: toTrimmedString(fallback.code) || "provider_error",
      message: toTrimmedString(fallback.message) || "provider_error",
      providerId: toTrimmedString(fallback.providerId) || null,
      retriable: fallback.retriable === true,
    };
  }
  return {
    code: toTrimmedString(error.code || fallback.code) || "provider_error",
    message: toTrimmedString(error.message || error.error || fallback.message) || "provider_error",
    providerId: toTrimmedString(error.providerId || fallback.providerId) || null,
    retriable: error.retriable === true || fallback.retriable === true,
  };
}

export default {
  ProviderConfigurationError,
  ProviderExecutionError,
  ProviderKernelError,
  normalizeProviderErrorDetails,
};
