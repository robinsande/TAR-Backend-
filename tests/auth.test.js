jest.mock("../src/services/emailService", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  sendActivationEmail: jest.fn().mockResolvedValue(true),
  buildActivationEmail: jest.fn(),
}));

const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const createApp = require("../src/app");
const User = require("../src/models/User");
const { hashPassword } = require("../src/services/passwordService");
const { generateInviteToken, getInviteTokenExpiry } = require("../src/services/inviteTokenService");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = createApp();
});

afterEach(async () => {
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("account activation", () => {
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

  it("blocks login until the account is activated", async () => {
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

    expect(response.status).toBe(403);
    expect(response.body.details.code).toBe("ACCOUNT_NOT_ACTIVATED");
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
