const bcrypt = require("bcryptjs");
const User = require("../models/User");
const HttpError = require("../utils/httpError");
const { signToken } = require("../services/jwtService");
const { hashPassword } = require("../services/passwordService");
const { isInviteTokenValid } = require("../services/inviteTokenService");

function buildAuthUserResponse(user) {
  return {
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
  };
}

async function login(req, res) {
  const startedAt = performance.now();
  const { email, password } = req.body;

  const lookupStartedAt = performance.now();
  const user = await User.findOne({ email: email.toLowerCase() });
  const lookupMs = performance.now() - lookupStartedAt;

  if (!user || !user.passwordHash) {
    res.setHeader("Server-Timing", `user-lookup;dur=${lookupMs.toFixed(1)}`);
    throw new HttpError(401, "Invalid email or password");
  }

  if (!user.isActive) {
    throw new HttpError(403, "This user account is inactive");
  }

  if (user.mustSetPassword) {
    throw new HttpError(403, "This account has not been activated", {
      code: "ACCOUNT_NOT_ACTIVATED",
    });
  }

  if (user.passwordExpiresAt && user.passwordExpiresAt <= new Date()) {
    throw new HttpError(403, "This temporary password has expired. Contact a superadmin for a new account password.");
  }

  const passwordStartedAt = performance.now();
  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  const passwordMs = performance.now() - passwordStartedAt;

  if (!passwordMatches) {
    res.setHeader(
      "Server-Timing",
      `user-lookup;dur=${lookupMs.toFixed(1)}, password;dur=${passwordMs.toFixed(1)}`
    );
    throw new HttpError(401, "Invalid email or password");
  }

  const tokenStartedAt = performance.now();
  const token = signToken({
    userId: user._id.toString(),
    role: user.role,
  });
  const tokenMs = performance.now() - tokenStartedAt;
  res.setHeader(
    "Server-Timing",
    `user-lookup;dur=${lookupMs.toFixed(1)}, password;dur=${passwordMs.toFixed(1)}, token;dur=${tokenMs.toFixed(1)}, auth-total;dur=${(performance.now() - startedAt).toFixed(1)}`
  );

  return res.json({
    token,
    user: buildAuthUserResponse(user),
  });
}

async function register(req, res) {
  const { name, email, password } = req.body;
  const normalizedEmail = email.toLowerCase();

  if (await User.exists({ email: normalizedEmail })) {
    throw new HttpError(409, "A user with that email already exists");
  }

  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
    passwordExpiresAt: null,
    role: "user",
    isActive: true,
    mustSetPassword: false,
  });

  const token = signToken({ userId: user._id.toString(), role: user.role });
  return res.status(201).json({ token, user: buildAuthUserResponse(user) });
}

async function activateAccount(req, res) {
  const { email, token, newPassword } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user || !user.isActive) {
    throw new HttpError(404, "Account not found");
  }

  if (!user.mustSetPassword) {
    throw new HttpError(400, "This account has already been activated");
  }

  if (!isInviteTokenValid(user, token)) {
    throw new HttpError(400, "Invalid or expired activation token");
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustSetPassword = false;
  user.inviteToken = null;
  user.inviteTokenExpires = null;
  await user.save();

  const authToken = signToken({
    userId: user._id.toString(),
    role: user.role,
  });

  return res.json({
    token: authToken,
    user: buildAuthUserResponse(user),
  });
}

async function setPassword(req, res) {
  const { email, currentPassword, newPassword } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user || !user.passwordHash) {
    throw new HttpError(401, "Invalid email or password");
  }

  if (!user.isActive) {
    throw new HttpError(403, "This user account is inactive");
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);

  if (!passwordMatches) {
    throw new HttpError(401, "Invalid email or password");
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordExpiresAt = null;
  user.mustSetPassword = false;
  await user.save();

  const token = signToken({
    userId: user._id.toString(),
    role: user.role,
  });

  return res.json({
    token,
    user: buildAuthUserResponse(user),
  });
}

module.exports = {
  login,
  register,
  activateAccount,
  setPassword,
};
