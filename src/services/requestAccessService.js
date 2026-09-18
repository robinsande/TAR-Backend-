const User = require("../models/User");
const HttpError = require("../utils/httpError");
const { getPassengerUserIds, isPassengerOnRequest } = require("./passengerService");

function idToString(value) {
  if (!value) {
    return null;
  }

  return value._id ? value._id.toString() : value.toString();
}

async function getDirectReportIds(adminId) {
  const directReports = await User.find({ managerId: adminId, isActive: true }).select("_id");
  return directReports.map((report) => report._id);
}

function buildPersonalRequestScope(userId) {
  return {
    $or: [{ requestedBy: userId }, { "passengers.user": userId }],
  };
}

/**
 * Build Mongo filter for list endpoints.
 * @param {{ id: string, role: string }} user
 * @param {string} [listScope] - "mine" | "team" | "all" (from ?scope=)
 *   - mine: requester or passenger (any role)
 *   - team: admin team visibility (default for admin when unset)
 *   - all: unrestricted (superadmin only; others fall back to role default)
 */
async function buildRequestScope(user, listScope) {
  const personal = buildPersonalRequestScope(user.id);
  const normalized = String(listScope || "").toLowerCase();

  if (normalized === "mine") {
    return personal;
  }

  if (user.role === "superadmin") {
    return {};
  }

  if (user.role === "admin") {
    const directReportIds = await getDirectReportIds(user.id);

    return {
      $or: [
        { requestedBy: user.id },
        { "passengers.user": user.id },
        { requestedBy: { $in: directReportIds } },
        { "passengers.user": { $in: directReportIds } },
        { selected_approver_id: user.id },
      ],
    };
  }

  return personal;
}

async function canAccessRequest(user, request) {
  if (user.role === "superadmin") {
    return true;
  }

  const requesterId = idToString(request.requestedBy);
  const approverId = idToString(request.selected_approver_id);

  if (requesterId === user.id || isPassengerOnRequest(request, user.id)) {
    return true;
  }

  if (user.role === "admin") {
    if (approverId === user.id) {
      return true;
    }

    const directReportIds = await getDirectReportIds(user.id);
    const reportIdSet = new Set(directReportIds.map((id) => id.toString()));

    if (reportIdSet.has(requesterId)) {
      return true;
    }

    return getPassengerUserIds(request).some((passengerId) => reportIdSet.has(passengerId));
  }

  return false;
}

async function ensureCanAccessRequest(user, request) {
  const allowed = await canAccessRequest(user, request);

  if (!allowed) {
    throw new HttpError(403, "You do not have access to this request");
  }
}

function ensureApprover(user, request) {
  const approverId = idToString(request.selected_approver_id);
  const requesterId = idToString(request.requestedBy);

  if (user.role !== "admin" || approverId !== user.id) {
    throw new HttpError(403, "Only the assigned approver can perform this action");
  }

  if (requesterId === user.id || isPassengerOnRequest(request, user.id)) {
    throw new HttpError(403, "Managers cannot approve their own travel request");
  }
}

function ensureRequestOwner(user, request) {
  const requesterId = idToString(request.requestedBy);

  if (requesterId !== user.id) {
    throw new HttpError(403, "Only the requester can modify this request");
  }
}

module.exports = {
  getDirectReportIds,
  buildRequestScope,
  canAccessRequest,
  ensureCanAccessRequest,
  ensureApprover,
  ensureRequestOwner,
};
