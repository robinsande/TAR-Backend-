jest.mock("../src/services/emailService", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  sendActivationEmail: jest.fn().mockResolvedValue(true),
  buildActivationEmail: jest.fn(),
}));

const request = require("supertest");
const mongoose = require("mongoose");
const createApp = require("../src/app");
const User = require("../src/models/User");
const { hashPassword } = require("../src/services/passwordService");
const { signToken } = require("../src/services/jwtService");
const { generateInviteToken, getInviteTokenExpiry } = require("../src/services/inviteTokenService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");
const {
  decryptAuthenticatorSecret,
  generateTotpCode,
} = require("../src/services/mfaService");
const { loginWithMfa } = require("./mfaTestHelper");

let app;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterEach(async () => {
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

describe("account activation", () => {
  it("does not allow public account registration", async () => {
    const response = await request(app).post("/api/auth/register").send({
      name: "New User",
      email: "new@example.com",
      password: "NewSecure123!",
    });

    expect(response.status).toBe(404);
    expect(await User.countDocuments()).toBe(0);
  });

  it("allows only superadmins to create accounts", async () => {
    const admin = await User.create({
      name: "Admin User",
      email: "admin@example.com",
      role: "admin",
      isActive: true,
    });
    const superadmin = await User.create({
      name: "Superadmin User",
      email: "superadmin@example.com",
      role: "superadmin",
      isActive: true,
    });
    const payload = {
      name: "Created User",
      email: "created@example.com",
      role: "user",
    };

    const adminResponse = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${signToken({ userId: admin._id.toString(), role: admin.role })}`)
      .send(payload);

    expect(adminResponse.status).toBe(403);
    expect(await User.exists({ email: payload.email })).toBeNull();

    const superadminResponse = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${signToken({ userId: superadmin._id.toString(), role: superadmin.role })}`)
      .send(payload);

    expect(superadminResponse.status).toBe(201);
    expect(superadminResponse.body.temporaryPassword).toBeTruthy();
    expect(await User.exists({ email: payload.email, role: "user" })).toBeTruthy();
  });

  it("permanently deletes users only when requested by a superadmin", async () => {
    const admin = await User.create({
      name: "Admin User",
      email: "admin@example.com",
      role: "admin",
      isActive: true,
    });
    const superadmin = await User.create({
      name: "Superadmin User",
      email: "superadmin@example.com",
      role: "superadmin",
      isActive: true,
    });
    const deletedUser = await User.create({
      name: "Deleted User",
      email: "deleted@example.com",
      role: "user",
      isActive: true,
    });
    const remainingUser = await User.create({
      name: "Remaining User",
      email: "remaining@example.com",
      role: "user",
      isActive: true,
      managerId: deletedUser._id,
      alternateApproverIds: [deletedUser._id],
    });
    const deletionPath = `/api/users/${deletedUser._id}`;

    const adminResponse = await request(app)
      .delete(deletionPath)
      .set("Authorization", `Bearer ${signToken({ userId: admin._id.toString(), role: admin.role })}`);

    expect(adminResponse.status).toBe(403);
    expect(await User.exists({ _id: deletedUser._id })).toBeTruthy();

    const superadminResponse = await request(app)
      .delete(deletionPath)
      .set("Authorization", `Bearer ${signToken({ userId: superadmin._id.toString(), role: superadmin.role })}`);

    expect(superadminResponse.status).toBe(204);
    expect(await User.exists({ _id: deletedUser._id })).toBeNull();
    const updatedUser = await User.findById(remainingUser._id);
    expect(String(updatedUser.managerId)).toBe(String(deletedUser._id));
    expect(updatedUser.alternateApproverIds.map(String)).toEqual([String(deletedUser._id)]);

    const selfDeleteResponse = await request(app)
      .delete(`/api/users/${superadmin._id}`)
      .set("Authorization", `Bearer ${signToken({ userId: superadmin._id.toString(), role: superadmin.role })}`);

    expect(selfDeleteResponse.status).toBe(400);
    expect(await User.exists({ _id: superadmin._id })).toBeTruthy();
  });

  it("activates a new account with a valid invite token", async () => {
    const token = generateInviteToken();

    await User.create({
      name: "Alice User",
      email: "alice@example.com",
      role: "user",
      isActive: true,
      mustSetPassword: true,
      passwordHash: null,
      inviteToken: token,
      inviteTokenExpires: getInviteTokenExpiry(),
    });

    const response = await request(app).post("/api/auth/activate").send({
      email: "alice@example.com",
      token,
      newPassword: "NewSecure123!",
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeUndefined();
    expect(response.body.message).toMatch(/authenticator/i);
    expect(response.body.user.mustSetPassword).toBe(false);

    const loginResponse = await request(app).post("/api/auth/login").send({
      email: "alice@example.com",
      password: "NewSecure123!",
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.mfaSetupRequired).toBe(true);
    expect(loginResponse.body.token).toBeUndefined();
  });

  it("requires authenticator enrollment for staff signing in with a password", async () => {
    await User.create({
      name: "Alice User",
      email: "alice@example.com",
      role: "user",
      isActive: true,
      mustSetPassword: true,
      passwordHash: await hashPassword("TempPass123!"),
    });

    const response = await request(app).post("/api/auth/login").send({
      email: "alice@example.com",
      password: "TempPass123!",
    });

    expect(response.status).toBe(200);
    expect(response.body.mfaSetupRequired).toBe(true);
    expect(response.body.token).toBeUndefined();
  });

  it("requires an authenticator code at every sign-in after initial enrollment", async () => {
    await User.create({
      name: "MFA User",
      email: "mfa@example.com",
      role: "user",
      isActive: true,
      passwordHash: await hashPassword("SecurePass123!"),
    });

    const firstLogin = await request(app).post("/api/auth/login").send({
      email: "mfa@example.com",
      password: "SecurePass123!",
    });
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.body.mfaSetupRequired).toBe(true);
    expect(firstLogin.body.token).toBeUndefined();

    const challengeHeader = { Authorization: `Bearer ${firstLogin.body.challengeToken}` };
    const blockedSession = await request(app)
      .get("/api/users")
      .set(challengeHeader);
    expect(blockedSession.status).toBe(401);

    const setup = await request(app)
      .post("/api/auth/mfa/setup")
      .set(challengeHeader);
    expect(setup.status).toBe(200);
    expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const pendingUser = await User.findOne({ email: "mfa@example.com" })
      .select("+mfaPendingSecretEncrypted");
    expect(pendingUser.mfaEnabled).toBe(false);
    expect(pendingUser.mfaPendingSecretEncrypted).not.toBe(setup.body.manualEntryKey);

    const wrongCode = generateTotpCode(setup.body.manualEntryKey) === "000000"
      ? "000001"
      : "000000";
    const badCode = await request(app)
      .post("/api/auth/mfa/verify")
      .set(challengeHeader)
      .send({ code: wrongCode });
    expect(badCode.status).toBe(401);

    const enrollment = await request(app)
      .post("/api/auth/mfa/verify")
      .set(challengeHeader)
      .send({ code: generateTotpCode(setup.body.manualEntryKey) });
    expect(enrollment.status).toBe(200);
    expect(enrollment.body.token).toBeTruthy();

    const enrolledUser = await User.findOne({ email: "mfa@example.com" })
      .select("+mfaSecretEncrypted +mfaPendingSecretEncrypted");
    expect(enrolledUser.mfaEnabled).toBe(true);
    expect(enrolledUser.mfaPendingSecretEncrypted).toBeNull();
    const secret = decryptAuthenticatorSecret(enrolledUser.mfaSecretEncrypted);
    expect(secret).toBe(setup.body.manualEntryKey);

    const secondLogin = await request(app).post("/api/auth/login").send({
      email: "mfa@example.com",
      password: "SecurePass123!",
    });
    expect(secondLogin.status).toBe(200);
    expect(secondLogin.body.mfaRequired).toBe(true);
    expect(secondLogin.body.mfaSetupRequired).toBe(false);
    expect(secondLogin.body.token).toBeUndefined();

    const secondChallenge = { Authorization: `Bearer ${secondLogin.body.challengeToken}` };
    const verified = await request(app)
      .post("/api/auth/mfa/verify")
      .set(secondChallenge)
      .send({ code: generateTotpCode(secret) });
    expect(verified.status).toBe(200);
    expect(verified.body.token).toBeTruthy();

    const replayedChallenge = await request(app)
      .post("/api/auth/mfa/verify")
      .set(secondChallenge)
      .send({ code: generateTotpCode(secret) });
    expect(replayedChallenge.status).toBe(401);
  });

  it("replaces an enabled authenticator only after the new code is verified", async () => {
    await User.create({
      name: "MFA Reset User",
      email: "mfa-reset@example.com",
      role: "user",
      isActive: true,
      passwordHash: await hashPassword("SecurePass123!"),
    });

    const sessionToken = await loginWithMfa(app, "mfa-reset@example.com", "SecurePass123!");
    const userBeforeReset = await User.findOne({ email: "mfa-reset@example.com" })
      .select("+mfaSecretEncrypted");
    const oldSecret = decryptAuthenticatorSecret(userBeforeReset.mfaSecretEncrypted);

    const rejectedSetup = await request(app)
      .post("/api/auth/mfa/reset/setup")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ currentPassword: "WrongPass123!" });
    expect(rejectedSetup.status).toBe(401);

    const setup = await request(app)
      .post("/api/auth/mfa/reset/setup")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ currentPassword: "SecurePass123!" });
    expect(setup.status).toBe(200);
    expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.challengeToken).toBeTruthy();
    expect(setup.body.manualEntryKey).not.toBe(oldSecret);

    const unverifiedUser = await User.findOne({ email: "mfa-reset@example.com" })
      .select("+mfaSecretEncrypted +mfaPendingSecretEncrypted");
    expect(decryptAuthenticatorSecret(unverifiedUser.mfaSecretEncrypted)).toBe(oldSecret);
    expect(decryptAuthenticatorSecret(unverifiedUser.mfaPendingSecretEncrypted))
      .toBe(setup.body.manualEntryKey);

    const verifiedReset = await request(app)
      .post("/api/auth/mfa/verify")
      .set("Authorization", `Bearer ${setup.body.challengeToken}`)
      .send({ code: generateTotpCode(setup.body.manualEntryKey) });
    expect(verifiedReset.status).toBe(200);
    expect(verifiedReset.body.token).toBeTruthy();

    const resetUser = await User.findOne({ email: "mfa-reset@example.com" })
      .select("+mfaSecretEncrypted +mfaPendingSecretEncrypted");
    expect(decryptAuthenticatorSecret(resetUser.mfaSecretEncrypted))
      .toBe(setup.body.manualEntryKey);
    expect(resetUser.mfaPendingSecretEncrypted).toBeNull();
  });
});

describe("set password", () => {
  it("updates a password when the current password is correct", async () => {
    await User.create({
      name: "Alice User",
      email: "alice@example.com",
      role: "user",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("TempPass123!"),
    });

    const token = await loginWithMfa(app, "alice@example.com", "TempPass123!");
    const response = await request(app).post("/api/auth/set-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
      currentPassword: "TempPass123!",
      newPassword: "NewSecure123!",
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();

    const loginResponse = await request(app).post("/api/auth/login").send({
      email: "alice@example.com",
      password: "NewSecure123!",
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.mfaRequired).toBe(true);
  });

  it("rejects password updates when the current password is wrong", async () => {
    await User.create({
      name: "Alice User",
      email: "alice@example.com",
      role: "user",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("TempPass123!"),
    });

    const token = await loginWithMfa(app, "alice@example.com", "TempPass123!");
    const response = await request(app).post("/api/auth/set-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
      currentPassword: "WrongPass123!",
      newPassword: "NewSecure123!",
    });

    expect(response.status).toBe(401);
  });
});
