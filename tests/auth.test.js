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
    expect(updatedUser.managerId).toBeNull();
    expect(updatedUser.alternateApproverIds).toHaveLength(0);

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
    expect(response.body.token).toBeTruthy();
    expect(response.body.user.mustSetPassword).toBe(false);

    const loginResponse = await request(app).post("/api/auth/login").send({
      email: "alice@example.com",
      password: "NewSecure123!",
    });

    expect(loginResponse.status).toBe(200);
  });

  it("allows staff with a password to sign in without an activation link", async () => {
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
    expect(response.body.token).toBeTruthy();
    expect(response.body.user.mustSetPassword).toBe(true);
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

    const response = await request(app).post("/api/auth/set-password").send({
      email: "alice@example.com",
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

    const response = await request(app).post("/api/auth/set-password").send({
      email: "alice@example.com",
      currentPassword: "WrongPass123!",
      newPassword: "NewSecure123!",
    });

    expect(response.status).toBe(401);
  });
});
