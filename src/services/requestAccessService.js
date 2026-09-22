const User = require("../models/User");
const HttpError = require("../utils/httpError");
const { getPassengerUserIds, isPassengerOnRequest } = require("./passengerService");

function idToString(value) {
  if (!value) {
    return null;
  }

  return value._id ? value._id.toString() : value.toString();
}

async function getDirectReportIds(adminId, adminEmail = null) {
  const directReports = await User.find({
    isActive: true,
    $or: [
      { managerId: adminId },
      ...(adminEmail ? [{ managerEmail: adminEmail.toLowerCase() }] : []),
    ],
  }).select("_id");
  return directReports.map((report) => report._id);
}

function buildPersonalRequestScope(userId) {
  return {
    $or: [{ requestedBy: userId }, { "passengers.user": userId }],
  };
}

function getRequestApproverIds(request) {
  const ids = request?.selected_approver_ids?.length
    ? request.selected_approver_ids
    : [request?.selected_approver_id];
  return ids.map(idToString).filter(Boolean);
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

  if (user.role === "super_superadmin") {
    return { status: "approved" };
  }

  if (normalized === "mine") {
    return personal;
  }

  if (user.role === "superadmin") {
    return {};
  }

  if (user.role === "admin") {
    const directReportIds = await getDirectReportIds(user.id, user.email);

    return {
      $or: [
        { requestedBy: user.id },
        { "passengers.user": user.id },
        { requestedBy: { $in: directReportIds } },
        { "passengers.user": { $in: directReportIds } },
        { selected_approver_id: user.id },
        { selected_approver_ids: user.id },
      ],
    };
  }

  return personal;
}

async function canAccessRequest(user, request) {
  if (user.role === "superadmin") {
    return true;
  }

  if (user.role === "super_superadmin") {
    return request.status === "approved";
  }

  const requesterId = idToString(request.requestedBy);
  const approverIds = getRequestApproverIds(request);

  if (requesterId === user.id || isPassengerOnRequest(request, user.id)) {
    return true;
  }

  if (user.role === "admin") {
    if (approverIds.includes(user.id)) {
      return true;
    }

    const directReportIds = await getDirectReportIds(user.id, user.email);
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
  const approverIds = getRequestApproverIds(request);
  const requesterId = idToString(request.requestedBy);

  if (user.role !== "admin" || !approverIds.includes(user.id)) {
    throw new HttpError(403, "Only the assigned approver can perform this action");
  }

  if (requesterId === user.id || isPassengerOnRequest(request, user.id)) {
    throw new HttpError(403, "Managers cannot approve their own travel request");
  }
}

function ensureRequestOwner(user, request) {
  const requesterId = idToString(request.requestedBy);

  if (user.role !== "superadmin" && requesterId !== user.id) {
    throw new HttpError(403, "Only the requester can modify this request");
  }
}

module.exports = {
  getDirectReportIds,
  getRequestApproverIds,
  buildRequestScope,
  canAccessRequest,
  ensureCanAccessRequest,
  ensureApprover,
  ensureRequestOwner,
};
