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
  if (user.role === "superadmin") {
    return {};
  }

  if (user.role !== "admin") {
    return { submittedBy: user.id };
  }

  const directReportIds = await getDirectReportIds(user.id);

  return {
    $or: [
      { submittedBy: user.id },
      { submittedBy: { $in: directReportIds } },
      { selected_approver_id: user.id },
    ],
  };
}

async function canAccessReport(user, report) {
  if (user.role === "superadmin") {
    return true;
  }

  const ownerId = idToString(report.submittedBy);
  const approverId = idToString(report.selected_approver_id);

  if (ownerId === user.id || approverId === user.id) {
    return true;
  }

  if (user.role === "admin") {
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
