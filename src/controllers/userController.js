const User = require("../models/User");
const { listEligibleApprovers } = require("../services/approverService");
const { listEligiblePassengers } = require("../services/passengerService");
const { hashPassword } = require("../services/passwordService");
const HttpError = require("../utils/httpError");
const crypto = require("crypto");
const { isEmailConfigured, sendTemporaryPasswordEmail } = require("../services/emailService");

function generateTemporaryPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

async function getMe(req, res) {
  return res.json(req.currentUser);
}

async function updateMe(req, res) {
  const allowedFields = ["name", "email", "employeeNumber", "position", "office", "department", "managerName", "managerEmail", "alternateManagers"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      updates[field] = typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field];
    }
  });

  if (!updates.name) {
    throw new HttpError(400, "Name is required");
  }
  if (updates.managerEmail) updates.managerEmail = updates.managerEmail.toLowerCase();
  if (updates.alternateManagers !== undefined) {
    if (!Array.isArray(updates.alternateManagers) || updates.alternateManagers.length > 3) {
      throw new HttpError(400, "Provide up to three alternate approvers");
    }
    updates.alternateManagers = updates.alternateManagers
      .filter((contact) => contact && (contact.name || contact.email))
      .map((contact) => ({ name: String(contact.name || "").trim(), email: String(contact.email || "").trim().toLowerCase() }));
    if (updates.alternateManagers.some((contact) => !contact.name || !contact.email)) {
      throw new HttpError(400, "Each alternate approver needs a name and email");
    }
  }

  if (updates.email) {
    updates.email = updates.email.toLowerCase();
    const existingUser = await User.findOne({
      email: updates.email,
      _id: { $ne: req.user.id },
    });
    if (existingUser) {
      throw new HttpError(409, "A user with that email already exists");
    }
  }

  const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, {
    new: true,
    runValidators: true,
  }).select("-passwordHash -inviteToken -inviteTokenExpires");

  return res.json(user);
}

async function listUsers(req, res) {
  const users = await User.find()
    .select("-passwordHash -inviteToken -inviteTokenExpires")
    .sort({ name: 1 });
  return res.json(users);
}

async function createUser(req, res) {
  const { employeeNumber, name, email, position, office, department } = req.body;
  const requestedRole = req.body.role || "user";

  const role = req.user.role === "admin" ? "user" : requestedRole;
  if (!["user", "admin", "superadmin"].includes(role)) {
    throw new HttpError(400, "Role must be user, admin, or superadmin");
  }
  if (role === "superadmin" && req.user.role !== "superadmin") {
    throw new HttpError(403, "Only a superadmin can create a superadmin account");
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (await User.exists({ email: normalizedEmail })) {
    throw new HttpError(409, "A user with that email already exists");
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const user = await User.create({
    employeeNumber: employeeNumber || null,
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await hashPassword(temporaryPassword),
    passwordExpiresAt,
    position: position || null,
    office: office || null,
    department: department || null,
    role,
    managerId: req.user.role === "admin" ? req.user.id : null,
    isActive: true,
    mustSetPassword: false,
    inviteToken: null,
    inviteTokenExpires: null,
  });

  return res.status(201).json({
    id: user._id,
    employeeNumber: user.employeeNumber,
    name: user.name,
    email: user.email,
    position: user.position,
    office: user.office,
    department: user.department,
    role: user.role,
    managerId: user.managerId,
    isActive: user.isActive,
    mustSetPassword: user.mustSetPassword,
    passwordExpiresAt: user.passwordExpiresAt,
    temporaryPassword,
  });
}

async function updateUserStatus(req, res) {
  if (req.params.id === req.user.id) {
    throw new HttpError(400, "You cannot deactivate your own account");
  }
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: req.body.isActive === true } },
    { new: true, runValidators: true }
  ).select("-passwordHash -inviteToken -inviteTokenExpires");
  if (!user) throw new HttpError(404, "User not found");
  return res.json(user);
}

async function deleteUser(req, res) {
  if (req.params.id === req.user.id) {
    throw new HttpError(400, "You cannot delete your own account");
  }
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) throw new HttpError(404, "User not found");
  return res.status(204).send();
}

async function updateUserProfile(req, res) {
    const allowedFields = ["name", "email", "employeeNumber", "position", "office", "department", "alternateApproverIds"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field];
      }
    });

    if (!updates.name) throw new HttpError(400, "Name is required");
    if (updates.alternateApproverIds !== undefined) {
      if (!Array.isArray(updates.alternateApproverIds)) {
        throw new HttpError(400, "Alternate approvers must be a list");
      }
      const targetUser = await User.findById(req.params.id).select("department");
      if (!targetUser) throw new HttpError(404, "User not found");
      const department = updates.department ?? targetUser.department;
      const alternates = await User.find({
        _id: { $in: updates.alternateApproverIds },
        role: "admin",
        isActive: true,
        department,
      }).select("_id");
      if (alternates.length !== updates.alternateApproverIds.length) {
        throw new HttpError(400, "Alternate approvers must be active admin users");
      }
      updates.alternateApproverIds = alternates.map((user) => user._id);
    }
    if (updates.email) {
      updates.email = updates.email.toLowerCase();
      if (await User.exists({ email: updates.email, _id: { $ne: req.params.id } })) {
        throw new HttpError(409, "A user with that email already exists");
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, { $set: updates }, {
      new: true,
      runValidators: true,
    }).select("-passwordHash -inviteToken -inviteTokenExpires");
    if (!user) throw new HttpError(404, "User not found");
    return res.json(user);
}

async function resetUserPassword(req, res) {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, "User not found");

  const temporaryPassword = generateTemporaryPassword();
  user.passwordHash = await hashPassword(temporaryPassword);
  user.passwordExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  user.mustSetPassword = true;
  await user.save();

  return res.json({
    id: user._id,
    email: user.email,
    passwordExpiresAt: user.passwordExpiresAt,
    temporaryPassword,
  });
}

async function sendBulkInvitations(req, res) {
  if (!isEmailConfigured()) {
    throw new HttpError(
      503,
      "Invitation email is not configured. Set BREVO_API_KEY, or BREVO_SMTP_USER and BREVO_SMTP_KEY, then restart the backend."
    );
  }

  const requestedIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  const query = req.body?.all
    ? { isActive: { $ne: false }, role: { $ne: "superadmin" }, _id: { $ne: req.user.id } }
    : { _id: { $in: requestedIds }, isActive: { $ne: false }, role: { $ne: "superadmin" }, _id: { $ne: req.user.id } };
  const users = await User.find(query).select("_id name email role");

  if (!users.length) {
    throw new HttpError(400, "Select at least one active user to invite.");
  }

    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
    }

    const invalidUsers = users.filter((user) => !isValidEmail(user.email));
    const validUsers = users.filter((user) => isValidEmail(user.email));
    const invalidErrors = invalidUsers.map((user) => ({
      name: user.name,
      email: user.email || null,
      message: "Invalid or missing email address; update this user before sending an invitation.",
    }));

  const results = await Promise.allSettled(users.map(async (user) => {
    const temporaryPassword = generateTemporaryPassword();
    const passwordExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const sent = await sendTemporaryPasswordEmail(user, temporaryPassword, passwordExpiresAt);
    if (!sent) throw new Error(`Invitation email failed for ${user.email}`);
      user.passwordHash = await hashPassword(temporaryPassword);
      user.passwordExpiresAt = passwordExpiresAt;
      user.mustSetPassword = true;
      user.inviteToken = null;
      user.inviteTokenExpires = null;
      await user.save();
    return user.email;
  }));

  const sent = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => ({ message: result.reason?.message || "Invitation failed" }));

    return res.json({ invited: sent.length, requested: users.length, emails: sent, errors: [...invalidErrors, ...errors] });
}

async function updateUserRole(req, res) {
  const { role } = req.body;

  if (!["user", "admin", "superadmin"].includes(role)) {
    throw new HttpError(400, "Role must be user, admin, or superadmin");
  }

  if (req.params.id === req.user.id) {
    throw new HttpError(400, "You cannot change your own role");
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { role } },
    { new: true, runValidators: true }
  ).select("-passwordHash -inviteToken -inviteTokenExpires");

  if (!user) {
    throw new HttpError(404, "User not found");
  }

  return res.json(user);
}

async function listApprovers(req, res) {
  const approvers = await listEligibleApprovers(req.user.id);
  return res.json(approvers);
}

async function listPassengers(req, res) {
  const passengers = await listEligiblePassengers();
  return res.json(passengers);
}

module.exports = {
  getMe,
  updateMe,
  listUsers,
  createUser,
  updateUserRole,
  updateUserProfile,
  resetUserPassword,
    sendBulkInvitations,
  updateUserStatus,
  deleteUser,
  listApprovers,
  listPassengers,
};
