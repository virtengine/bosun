const shouldSuppressExperimentalWarnings =
  process.env.BOSUN_TEST_VERBOSE_WARNINGS !== "1";

if (shouldSuppressExperimentalWarnings && !process.__bosunWarningFilterInstalled) {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = function bosunFilteredEmitWarning(warning, ...args) {
    const warningName = typeof warning === "object" && warning ? String(warning.name || "") : "";
    const firstArg = args[0];
    const warningType = typeof firstArg === "string" ? firstArg : "";
    if (warningName === "ExperimentalWarning" || warningType === "ExperimentalWarning") {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
  Object.defineProperty(process, "__bosunWarningFilterInstalled", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: true,
  });
}
