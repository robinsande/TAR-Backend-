const HttpError = require("../utils/httpError");
const { getDirectReportIds } = require("./requestAccessService");

function idToString(value) {
  if (!value) {
    return null;
  }

  return value._id ? value._id.toString() : value.toString();
}

/**
 * Build Mongo filter for team reimbursement lists (admin).
 * Mirrors travel team visibility: own, direct reports, or assigned approver.
 */
async function buildReimbursementTeamScope(user) {
  if (["superadmin", "super_superadmin"].includes(user.role) || user.roles?.includes("auditor")) {
    return {};
  }

  if (user.roles?.includes("supervisor")) {
    return { supervisorId: user.id };
  }
  if (user.roles?.includes("finance_admin")) {
    return {
      $or: [
        { financeAdminId: user.id },
        { financeAdminId: null },
      ],
      status: { $in: ["SUBMITTED_TO_FINANCE", "FINANCE_REVIEW", "FINANCE_APPROVED", "FINANCE_DECLINED", "PAYMENT_PROCESSING", "COMPLETED"] },
    };
  }
  if (!["admin", "approver_budget_holder"].includes(user.role)) {
    return { submittedBy: user.id };
  }

  const directReportIds = await getDirectReportIds(user.id);

  return {
    $or: [
      { submittedBy: user.id },
      { submittedBy: { $in: directReportIds } },
      { selected_approver_id: user.id },
      { lineManagerId: user.id },
    ],
  };
}

async function canAccessReport(user, report) {
  if (["superadmin", "super_superadmin"].includes(user.role) || user.roles?.includes("auditor")) {
    return true;
  }

  const ownerId = idToString(report.submittedBy);
  const approverId = idToString(report.selected_approver_id);

  if (
    ownerId === user.id ||
    approverId === user.id ||
    idToString(report.supervisorId) === user.id ||
    idToString(report.lineManagerId) === user.id
  ) {
    return true;
  }

  if (user.roles?.includes("finance_admin")) {
    return (!report.financeAdminId || idToString(report.financeAdminId) === user.id) && [
      "SUBMITTED_TO_FINANCE",
      "FINANCE_REVIEW",
      "FINANCE_APPROVED",
      "FINANCE_DECLINED",
      "PAYMENT_PROCESSING",
      "COMPLETED",
    ].includes(report.status);
  }

  if (["admin", "approver_budget_holder"].includes(user.role)) {
    const directReportIds = await getDirectReportIds(user.id);
    const reportIdSet = new Set(directReportIds.map((id) => id.toString()));
    return reportIdSet.has(ownerId);
  }

  return false;
}

async function ensureCanAccessReport(user, report) {
  const allowed = await canAccessReport(user, report);

  if (!allowed) {
    throw new HttpError(403, "You do not have access to this reimbursement report");
  }
}

function ensureReportOwner(user, report) {
  const ownerId = idToString(report.submittedBy);

  if (ownerId !== user.id) {
    throw new HttpError(403, "Only the submitter can access this reimbursement report");
  }
}

function ensureReportApprover(user, report) {
  const approverId = idToString(report.selected_approver_id);

  if (user.role !== "admin" || approverId !== user.id) {
    throw new HttpError(403, "Only the assigned approver can perform this action");
  }
}

module.exports = {
  buildReimbursementTeamScope,
  canAccessReport,
  ensureCanAccessReport,
  ensureReportOwner,
  ensureReportApprover,
};
