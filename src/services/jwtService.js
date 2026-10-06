const jwt = require("jsonwebtoken");
const env = require("../config/env");

function signToken(payload) {
  return jwt.sign({ ...payload, tokenType: "session" }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

function signMfaChallengeToken(payload) {
  return jwt.sign(
    { ...payload, tokenType: "mfa_challenge" },
    env.jwtSecret,
    { expiresIn: "15m" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = {
  signToken,
  signMfaChallengeToken,
  verifyToken,
};
