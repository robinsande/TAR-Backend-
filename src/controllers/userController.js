const User = require("../models/User");
const { listEligibleApprovers } = require("../services/approverService");
const { listEligiblePassengers } = require("../services/passengerService");
const { hashPassword } = require("../services/passwordService");
const HttpError = require("../utils/httpError");

async function getMe(req, res) {
  return res.json(req.currentUser);
}

async function updateMe(req, res) {
  const allowedFields = ["name", "employeeNumber", "position", "office", "department"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      updates[field] = typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field];
    }
  });

  if (!updates.name) {
    throw new HttpError(400, "Name is required");
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
  const { employeeNumber, name, email, password, position, office, department } = req.body;
  const requestedRole = req.body.role || "user";

  if (!name || !email || !password) {
    throw new HttpError(400, "Name, email, and password are required");
  }

  if (password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters");
  }

  const role = req.user.role === "admin" ? "user" : requestedRole;
  if (!["user", "admin"].includes(role)) {
    throw new HttpError(400, "Role must be user or admin");
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (await User.exists({ email: normalizedEmail })) {
    throw new HttpError(409, "A user with that email already exists");
  }

  const user = await User.create({
    employeeNumber: employeeNumber || null,
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
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
  });
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
  listApprovers,
  listPassengers,
};
