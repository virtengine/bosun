export const RISK_WEIGHT_MAP = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 5,
});

function normalizeNumeric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric;
}

export function normalizeRiskLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return RISK_WEIGHT_MAP[normalized] ? normalized : "medium";
}

export function getRiskWeight(value) {
  return RISK_WEIGHT_MAP[normalizeRiskLevel(value)];
}

export function computeScore(task = {}) {
  const impact = normalizeNumeric(task.impact);
  const confidence = normalizeNumeric(task.confidence);
  const riskWeight = getRiskWeight(task.risk);
  const score = (impact * confidence) / riskWeight;
  return Number(score.toFixed(4));
}

export function attachBacklogScore(task = {}) {
  const riskLevel = normalizeRiskLevel(task.risk);
  return {
    ...task,
    risk: riskLevel,
    risk_weight: getRiskWeight(riskLevel),
    score: computeScore({ ...task, risk: riskLevel }),
  };
}
