const crypto = require("crypto");

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateInviteToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getInviteTokenExpiry() {
  return new Date(Date.now() + INVITE_TOKEN_TTL_MS);
}

function isInviteTokenValid(user, token) {
  if (!user.inviteToken || !user.inviteTokenExpires || !token) {
    return false;
  }

  if (user.inviteToken !== token) {
    return false;
  }

  return user.inviteTokenExpires.getTime() > Date.now();
}

module.exports = {
  INVITE_TOKEN_TTL_MS,
  generateInviteToken,
  getInviteTokenExpiry,
  isInviteTokenValid,
};
