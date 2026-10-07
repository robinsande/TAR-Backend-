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
        {
          $or: [{ financeAdminId: user.id }, { financeAdminId: null, financeCcAdminId: null }],
          status: { $in: ["SUBMITTED_TO_FINANCE", "FINANCE_REVIEW", "FINANCE_APPROVED", "FINANCE_DECLINED", "PAYMENT_PROCESSING", "COMPLETED"] },
        },
        {
          financeCcAdminId: user.id,
          status: { $in: ["PAYMENT_PROCESSING", "COMPLETED"] },
        },
      ],
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
  const lineManagerId = idToString(report.lineManagerId);
  const lineManagerCanReviewDocuments = [
    "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT",
    "SUBMITTED_TO_LINE_MANAGER",
    "LINE_MANAGER_REVIEW",
    "SUBMITTED_TO_FINANCE",
    "FINANCE_REVIEW",
    "FINANCE_APPROVED",
    "FINANCE_DECLINED",
    "PAYMENT_PROCESSING",
    "COMPLETED",
  ].includes(report.status);

  if (
    ownerId === user.id ||
    approverId === user.id ||
    idToString(report.supervisorId) === user.id ||
    (lineManagerId === user.id && lineManagerCanReviewDocuments)
  ) {
    return true;
  }

  if (user.roles?.includes("finance_admin")) {
    const financeStatuses = [
      "SUBMITTED_TO_FINANCE",
      "FINANCE_REVIEW",
      "FINANCE_APPROVED",
      "FINANCE_DECLINED",
      "PAYMENT_PROCESSING",
      "COMPLETED",
    ];
    const assignedFinance = report.financeAdminId
      ? idToString(report.financeAdminId) === user.id && financeStatuses.includes(report.status)
      : !report.financeCcAdminId && financeStatuses.includes(report.status);
    const copiedFinance =
      idToString(report.financeCcAdminId) === user.id &&
      ["PAYMENT_PROCESSING", "COMPLETED"].includes(report.status);
    return assignedFinance || copiedFinance;
  }

  if (["admin", "approver_budget_holder"].includes(user.role)) {
    const directReportIds = await getDirectReportIds(user.id);
    const reportIdSet = new Set(directReportIds.map((id) => id.toString()));
    return reportIdSet.has(ownerId);
  }

  return false;
}

function canViewMergedReimbursementPackage(user, report) {
  const userId = user.id;
  return (
    idToString(report.submittedBy) === userId ||
    idToString(report.selected_approver_id) === userId ||
    idToString(report.financeAdminId) === userId ||
    idToString(report.financeCcAdminId) === userId ||
    ["superadmin", "super_superadmin"].includes(user.role) ||
    user.roles?.includes("auditor")
  );
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
  canViewMergedReimbursementPackage,
};
