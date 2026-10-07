const User = require("../models/User");
const HttpError = require("../utils/httpError");

async function listEligibleApprovers(userId) {
  return User.find({ role: { $in: ["admin", "approver_budget_holder"] }, isActive: true })
    .select("-passwordHash")
    .sort({ name: 1 });
}

async function resolveManagerApproverForUser(userId) {
  let currentUser = await User.findById(userId).select("managerId role isActive");
  const seen = new Set();

  while (currentUser && currentUser.managerId && !seen.has(currentUser.managerId.toString())) {
    seen.add(currentUser.managerId.toString());

    const manager = await User.findById(currentUser.managerId).select("-passwordHash");
    if (!manager || !manager.isActive) {
      return null;
    }

    if (["admin", "approver_budget_holder"].includes(manager.role)) {
      return manager;
    }

    currentUser = manager;
  }

  return null;
}

async function listApproversForUser(userId) {
  return listEligibleApprovers(userId);
}

async function getEligibleApproverById(approverId, { excludeUserIds = [] } = {}) {
  const approver = await User.findById(approverId).select("-passwordHash");

  if (!approver || !approver.isActive) {
    throw new HttpError(400, "Selected approver was not found or is inactive");
  }

  if (!["admin", "approver_budget_holder"].includes(approver.role)) {
    throw new HttpError(400, "Selected approver must have an active approver role");
  }

  const excluded = new Set(excludeUserIds.map((id) => String(id)).filter(Boolean));
  if (excluded.has(approver._id.toString())) {
    throw new HttpError(
      400,
      "Managers cannot approve their own request. Choose a different admin approver."
    );
  }

  return approver;
}

async function getEligibleSupervisorById(supervisorId, { excludeUserIds = [] } = {}) {
  const supervisor = await User.findById(supervisorId).select("-passwordHash");
  if (!supervisor || !supervisor.isActive) {
    throw new HttpError(400, "Selected supervisor was not found or is inactive");
  }
  if (!(supervisor.roles || []).includes("supervisor")) {
    throw new HttpError(400, "Selected user does not have the Supervisor role");
  }

  const excluded = new Set(excludeUserIds.map((id) => String(id)).filter(Boolean));
  if (excluded.has(supervisor._id.toString())) {
    throw new HttpError(400, "You cannot select yourself as the reimbursement supervisor");
  }
  return supervisor;
}

module.exports = {
  listEligibleApprovers,
  listApproversForUser,
  getEligibleApproverById,
  getEligibleSupervisorById,
  resolveManagerApproverForUser,
};
