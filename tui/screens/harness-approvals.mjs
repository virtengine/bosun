export function getHarnessApprovalStatusLabel(approval) {
  const request = approval?.request || approval || {};
  const status = String(request?.status || "").trim().toLowerCase();
  if (status) return status;
  if (approval?.approvalPending === true) return "pending";
  return "none";
}
