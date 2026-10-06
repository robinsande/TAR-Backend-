const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const HttpError = require("../utils/httpError");
const { signMfaChallengeToken, signToken, verifyToken } = require("../services/jwtService");
const { hashPassword } = require("../services/passwordService");
const { isInviteTokenValid } = require("../services/inviteTokenService");
const {
  createAuthenticatorQrCode,
  decryptAuthenticatorSecret,
  encryptAuthenticatorSecret,
  generateAuthenticatorSecret,
  verifyTotpCode,
} = require("../services/mfaService");

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
  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+mfaSecretEncrypted +mfaPendingSecretEncrypted +mfaChallengeId"
  );
  const lookupMs = performance.now() - lookupStartedAt;

  if (!user || !user.passwordHash) {
    res.setHeader("Server-Timing", `user-lookup;dur=${lookupMs.toFixed(1)}`);
    throw new HttpError(401, "Invalid email or password");
  }

  if (!user.isActive) {
    throw new HttpError(403, "This user account is inactive");
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

  if (user.mfaEnabled && !user.mfaSecretEncrypted) {
    throw new HttpError(500, "Authenticator setup is unavailable. Contact your system administrator.");
  }

  const challengeId = crypto.randomUUID();
  user.mfaChallengeId = challengeId;
  await user.save();
  const challengeToken = signMfaChallengeToken({
    userId: user._id.toString(),
    role: user.role,
    purpose: user.mfaEnabled ? "login" : "enroll",
    jti: challengeId,
  });
  res.setHeader(
    "Server-Timing",
    `user-lookup;dur=${lookupMs.toFixed(1)}, password;dur=${passwordMs.toFixed(1)}, auth-total;dur=${(performance.now() - startedAt).toFixed(1)}`
  );

  return res.json({
    challengeToken,
    mfaRequired: user.mfaEnabled,
    mfaSetupRequired: !user.mfaEnabled,
  });
}

async function getMfaChallengeUser(req, purpose) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "Authenticator verification is required");
  }

  let payload;
  try {
    payload = verifyToken(authHeader.slice(7));
  } catch {
    throw new HttpError(401, "Your sign-in verification expired. Please sign in again.");
  }

  if (payload.tokenType !== "mfa_challenge" || payload.purpose !== purpose || !payload.jti) {
    throw new HttpError(401, "Invalid authenticator verification session");
  }

  const user = await User.findById(payload.userId).select(
    "+mfaSecretEncrypted +mfaPendingSecretEncrypted +mfaChallengeId"
  );
  if (
    !user ||
    !user.isActive ||
    !user.mfaChallengeId ||
    user.mfaChallengeId !== payload.jti
  ) {
    throw new HttpError(401, "Your sign-in verification expired. Please sign in again.");
  }

  return user;
}

async function setupMfa(req, res) {
  const user = await getMfaChallengeUser(req, "enroll");
  if (user.mfaEnabled) {
    throw new HttpError(409, "Authenticator verification is already enabled for this account");
  }

  if (!user.mfaPendingSecretEncrypted) {
    user.mfaPendingSecretEncrypted = encryptAuthenticatorSecret(
      generateAuthenticatorSecret()
    );
    await user.save();
  }

  const secret = decryptAuthenticatorSecret(user.mfaPendingSecretEncrypted);
  const setup = await createAuthenticatorQrCode(secret, user.email);
  return res.json(setup);
}

async function verifyMfa(req, res) {
  const authHeader = req.headers.authorization || "";
  let payload;
  try {
    payload = verifyToken(authHeader.slice(7));
  } catch {
    throw new HttpError(401, "Your sign-in verification expired. Please sign in again.");
  }

  if (payload.tokenType !== "mfa_challenge" || !["enroll", "login"].includes(payload.purpose)) {
    throw new HttpError(401, "Invalid authenticator verification session");
  }

  const user = await getMfaChallengeUser(req, payload.purpose);
  const encryptedSecret =
    payload.purpose === "enroll"
      ? user.mfaPendingSecretEncrypted
      : user.mfaSecretEncrypted;
  if (!encryptedSecret || (payload.purpose === "login" && !user.mfaEnabled)) {
    throw new HttpError(400, "Authenticator setup is incomplete. Please sign in again.");
  }

  const secret = decryptAuthenticatorSecret(encryptedSecret);
  if (!verifyTotpCode(secret, req.body.code)) {
    throw new HttpError(401, "The authenticator code is invalid or expired");
  }

  const update = { mfaChallengeId: null };
  const challengeFilter = {
    _id: user._id,
    mfaChallengeId: payload.jti,
    isActive: true,
  };
  if (payload.purpose === "enroll") {
    challengeFilter.mfaEnabled = false;
    update.mfaSecretEncrypted = user.mfaPendingSecretEncrypted;
    update.mfaPendingSecretEncrypted = null;
    update.mfaEnabled = true;
    update.mfaEnabledAt = new Date();
  } else {
    challengeFilter.mfaEnabled = true;
  }

  const verifiedUser = await User.findOneAndUpdate(
    challengeFilter,
    { $set: update },
    { returnDocument: "after" }
  );
  if (!verifiedUser) {
    throw new HttpError(401, "Your sign-in verification has already been used. Please sign in again.");
  }

  return res.json({
    token: signToken({
      userId: verifiedUser._id.toString(),
      role: verifiedUser.role,
    }),
    user: buildAuthUserResponse(verifiedUser),
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

  return res.json({
    message: "Account activated. Sign in to set up authenticator verification.",
    user: buildAuthUserResponse(user),
  });
}

async function setPassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user.id);

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
  setupMfa,
  verifyMfa,
  activateAccount,
  setPassword,
};
