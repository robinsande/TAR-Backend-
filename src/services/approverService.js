const User = require("../models/User");
const HttpError = require("../utils/httpError");

async function listEligibleApprovers(userId) {
  const user = userId ? await User.findById(userId).select("role managerId managerEmail alternateApproverIds alternateManagers") : null;
  const contactEmails = user ? [user.managerEmail, ...(user.alternateManagers || []).map((contact) => contact.email)].filter(Boolean) : [];
  const linkedIds = user ? [user.managerId, ...(user.alternateApproverIds || [])].filter(Boolean) : [];
  const query = user?.role === "superadmin"
    ? { role: "admin", isActive: true }
    : user
      ? { $or: [{ _id: { $in: linkedIds } }, { email: { $in: contactEmails } }], role: "admin", isActive: true }
      : { role: "admin", isActive: true };

  return User.find(query)
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

    async function listApproversForUser(userId) {
      return listEligibleApprovers(userId);
    }

    if (manager.role === "admin") {
      return manager;
    }

    currentUser = manager;
  }

  return null;
}

async function getEligibleApproverById(approverId, { excludeUserIds = [] } = {}) {
  const approver = await User.findById(approverId).select("-passwordHash");

  if (!approver || !approver.isActive) {
    throw new HttpError(400, "Selected approver was not found or is inactive");
  }

  if (approver.role !== "admin") {
    throw new HttpError(400, "Selected approver must be an active admin");
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

module.exports = {
  listEligibleApprovers,
  listApproversForUser,
  getEligibleApproverById,
  resolveManagerApproverForUser,
};
