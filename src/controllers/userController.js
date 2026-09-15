const User = require("../models/User");
const { listEligibleApprovers } = require("../services/approverService");
const { listEligiblePassengers } = require("../services/passengerService");
const { hashPassword } = require("../services/passwordService");
const HttpError = require("../utils/httpError");
const crypto = require("crypto");

function generateTemporaryPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

async function getMe(req, res) {
  return res.json(req.currentUser);
}

async function updateMe(req, res) {
  const allowedFields = ["name", "email", "employeeNumber", "position", "office", "department"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      updates[field] = typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field];
    }
  });

  if (!updates.name) {
    throw new HttpError(400, "Name is required");
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

async function updateUserRole(req, res) {
  const { role } = req.body;

  if (!["user", "admin", "superadmin"].includes(role)) {
    throw new HttpError(400, "Role must be user, admin, or superadmin");
  }

  async function updateUserProfile(req, res) {
    const allowedFields = ["name", "email", "employeeNumber", "position", "office", "department"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field];
      }
    });

    if (!updates.name) throw new HttpError(400, "Name is required");
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
    user.mustSetPassword = false;
    await user.save();

    return res.json({
      id: user._id,
      email: user.email,
      passwordExpiresAt: user.passwordExpiresAt,
      temporaryPassword,
    });
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
  const approvers = await listEligibleApprovers();
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
  updateUserStatus,
  deleteUser,
  listApprovers,
  listPassengers,
};
