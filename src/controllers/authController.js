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
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user || !user.passwordHash) {
    throw new HttpError(401, "Invalid email or password");
  }

  if (!user.isActive) {
    throw new HttpError(403, "This user account is inactive");
  }

  if (user.mustSetPassword) {
    throw new HttpError(
      403,
      "Please activate your account and set a password before logging in.",
      { code: "ACCOUNT_NOT_ACTIVATED" }
    );
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    throw new HttpError(401, "Invalid email or password");
  }

  const token = signToken({
    userId: user._id.toString(),
    role: user.role,
  });

  return res.json({
    token,
    user: buildAuthUserResponse(user),
  });
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

  if (user.mustSetPassword) {
    throw new HttpError(
      403,
      "Please activate your account first using the link sent to your email.",
      { code: "ACCOUNT_NOT_ACTIVATED" }
    );
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);

  if (!passwordMatches) {
    throw new HttpError(401, "Invalid email or password");
  }

  user.passwordHash = await hashPassword(newPassword);
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
  activateAccount,
  setPassword,
};
