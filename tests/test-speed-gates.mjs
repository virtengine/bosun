export const isCiOnlyTestRun =
  process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";

export const skipLocallyForSpeed = !isCiOnlyTestRun;
