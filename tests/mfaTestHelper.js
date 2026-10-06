const request = require("supertest");
const User = require("../src/models/User");
const {
  decryptAuthenticatorSecret,
  generateTotpCode,
} = require("../src/services/mfaService");

async function loginWithMfa(app, email, password = "Password123!") {
  const loginResponse = await request(app)
    .post("/api/auth/login")
    .send({ email, password });
  if (loginResponse.status !== 200 || !loginResponse.body.challengeToken) {
    throw new Error(loginResponse.body.message || "Password sign-in failed");
  }

  const challengeToken = loginResponse.body.challengeToken;
  let secret;
  if (loginResponse.body.mfaSetupRequired) {
    const setupResponse = await request(app)
      .post("/api/auth/mfa/setup")
      .set("Authorization", `Bearer ${challengeToken}`);
    if (setupResponse.status !== 200) {
      throw new Error(setupResponse.body.message || "Authenticator setup failed");
    }
    secret = setupResponse.body.manualEntryKey;
  } else {
    const user = await User.findOne({ email }).select("+mfaSecretEncrypted");
    secret = decryptAuthenticatorSecret(user.mfaSecretEncrypted);
  }

  const verifyResponse = await request(app)
    .post("/api/auth/mfa/verify")
    .set("Authorization", `Bearer ${challengeToken}`)
    .send({ code: generateTotpCode(secret) });
  if (verifyResponse.status !== 200 || !verifyResponse.body.token) {
    throw new Error(verifyResponse.body.message || "Authenticator verification failed");
  }

  return verifyResponse.body.token;
}

module.exports = { loginWithMfa };
