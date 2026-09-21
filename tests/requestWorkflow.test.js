jest.mock("../src/services/emailService", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  sendActivationEmail: jest.fn().mockResolvedValue(true),
  buildActivationEmail: jest.fn(),
}));

const request = require("supertest");
const mongoose = require("mongoose");
const createApp = require("../src/app");
const User = require("../src/models/User");
const TravelRequest = require("../src/models/TravelRequest");
const Notification = require("../src/models/Notification");
const { sendEmail } = require("../src/services/emailService");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");

let app;

async function createUser(overrides = {}) {
  const passwordHash = overrides.passwordHash || (await hashPassword("Password123!"));

  return User.create({
    name: "Test User",
    email: `user-${Math.random().toString(36).slice(2)}@example.com`,
    role: "user",
    isActive: true,
    mustSetPassword: false,
    passwordHash,
    ...overrides,
  });
}

async function login(email, password = "Password123!") {
  const response = await request(app).post("/api/auth/login").send({ email, password });
  return response.body.token;
}

function passengerFor(user) {
  return {
    user: user._id.toString(),
    name: user.name,
    employeeNumber: user.employeeNumber || "1600",
  };
}

function buildRequestPayload(selectedApproverId, overrides = {}) {
  return {
    selected_approver_id: selectedApproverId,
    project: {
      name: "WE4R",
      businessUnit: "KEN03",
      fundCode: "DEC16",
      projectId: "CDEUKE3014",
      departmentId: "KE0201",
      activityId: "3",
    },
    assignedAreaOfOperation: "Kisumu and Siaya",
    purposeOfTrip: "Field monitoring visit",
    requesterSignature: "Requester Signature",
    modeOfTravel: {
      careVehicle: true,
      publicTransport: false,
      aircraft: false,
    },
    itinerary: {
      dateFrom: "2026-07-05T00:00:00.000Z",
      dateTo: "2026-07-07T00:00:00.000Z",
      destination: "Kisumu",
      accommodationNeeded: true,
    },
    passengers: [{ name: "Passenger One", employeeNumber: "1600" }],
    ...overrides,
  };
}

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    TravelRequest.deleteMany({}),
    Notification.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

describe("authentication and authorization", () => {
  it("logs a user in and returns a JWT token", async () => {
    const user = await createUser({
      name: "Alice User",
      email: "alice@example.com",
    });

    const response = await request(app).post("/api/auth/login").send({
      email: user.email,
      password: "Password123!",
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();
    expect(response.body.user.email).toBe(user.email);
  });

  it("blocks a user from the superadmin user listing route", async () => {
    const user = await createUser({
      name: "Alice User",
      email: "alice@example.com",
    });
    const token = await login(user.email);

    const response = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
  });
});

describe("request scoping and workflow", () => {
  it("lets passengers see travel requests raised for them", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const booker = await createUser({
      name: "Booker One",
      email: "booker@example.com",
      managerId: manager._id,
    });
    const traveller = await createUser({
      name: "Traveller One",
      email: "traveller@example.com",
      managerId: manager._id,
      employeeNumber: "1800",
    });

    const bookerToken = await login(booker.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${bookerToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(traveller)] }));

    expect(createResponse.status).toBe(201);

    const travellerToken = await login(traveller.email);
    const listResponse = await request(app)
      .get("/api/requests")
      .set("Authorization", `Bearer ${travellerToken}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(1);
    expect(listResponse.body.data[0]._id).toBe(createResponse.body._id);

    const passengerNotifications = await Notification.find({
      recipient: traveller._id,
      type: "new_request",
    });
    expect(passengerNotifications).toHaveLength(1);
    expect(passengerNotifications[0].message).toMatch(/listed as a passenger/i);
  });

  it("allows staff to select any active admin as their approver", async () => {
    const seniorManager = await createUser({
      name: "Senior Manager",
      email: "senior@example.com",
      role: "admin",
    });
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
      managerId: seniorManager._id,
    });
    const staff = await createUser({
      name: "Staff Member",
      email: "staff@example.com",
      managerId: manager._id,
    });

    const staffToken = await login(staff.email);
    const response = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send(buildRequestPayload(seniorManager._id, { passengers: [passengerFor(staff)] }));

    expect(response.status).toBe(201);
    expect(String(response.body.selected_approver_id._id || response.body.selected_approver_id)).toBe(String(seniorManager._id));
  });

  it("prevents managers from selecting themselves as approver", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });

    const managerToken = await login(manager.email);
    const response = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${managerToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(manager)] }));

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/cannot approve their own/i);
  });

  it("limits normal users to their own requests", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });
    const anotherRequester = await createUser({
      name: "Requester Two",
      email: "another@example.com",
      managerId: manager._id,
    });

    await TravelRequest.create({
      requestedBy: requester._id,
      selected_approver_id: manager._id,
      ...buildRequestPayload(manager._id, {
        passengers: [passengerFor(requester)],
      }),
    });
    await TravelRequest.create({
      requestedBy: anotherRequester._id,
      selected_approver_id: manager._id,
      ...buildRequestPayload(manager._id, {
        purposeOfTrip: "Other trip",
        passengers: [passengerFor(anotherRequester)],
      }),
    });

    const token = await login(requester.email);
    const response = await request(app)
      .get("/api/requests")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].requestedBy.email).toBe(requester.email);
    expect(response.body.pagination.total).toBe(1);
  });

  it("allows an assigned admin approver to approve a pending request", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const createToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${createToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    const approveToken = await login(manager.email);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${approveToken}`)
      .send({ signature: "Manager Signature" });

    expect(createResponse.status).toBe(201);
    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body.status).toBe("approved");
    expect(approveResponse.body.decision.comment).toBeNull();
    expect(approveResponse.body.decision.signature).toBe("Manager Signature");

    const requesterNotification = await Notification.findOne({
      recipient: requester._id,
      type: "new_request",
      request: createResponse.body._id,
    });
    expect(requesterNotification.message).toContain("Your travel request");
    expect(requesterNotification.message).not.toContain("listed as a passenger");
  });

  it("lets the requester upload and authorized users download separate TAR documents", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-documents@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester-documents@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    const uploadResponse = await request(app)
      .post(`/api/requests/${createResponse.body._id}/attachments`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .attach("scopeDocuments", Buffer.from("scope document"), "scope.txt")
      .attach("supportingDocuments", Buffer.from("supporting document"), "supporting.txt");

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "scope", originalName: "scope.txt" }),
        expect.objectContaining({ category: "supporting", originalName: "supporting.txt" }),
      ])
    );

    const scopeAttachment = uploadResponse.body.find((attachment) => attachment.category === "scope");
    const managerToken = await login(manager.email);
    const downloadResponse = await request(app)
      .get(`/api/requests/${createResponse.body._id}/attachments/${scopeAttachment._id}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.text).toBe("scope document");
  });

  it("allows any selected per-request approver to approve the TAR", async () => {
    sendEmail.mockClear();
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-multiple@example.com",
      role: "admin",
    });
    const secondApprover = await createUser({
      name: "Second Approver",
      email: "second-approver@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester-multiple@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, {
        selected_approver_ids: [manager._id.toString(), secondApprover._id.toString()],
        passengers: [passengerFor(requester)],
      }));

    const secondApproverToken = await login(secondApprover.email);
    const pendingResponse = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", `Bearer ${secondApproverToken}`);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${secondApproverToken}`)
      .send({ signature: "Second Approver Signature" });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.selected_approver_ids).toHaveLength(2);
    expect(pendingResponse.status).toBe(200);
    expect(pendingResponse.body[0]._id).toBe(createResponse.body._id);
    expect(approveResponse.status).toBe(200);

    const approverEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "New travel request awaiting approval"
    );
    expect(approverEmails).toHaveLength(1);
    expect(approverEmails[0][0]).toBe(manager.email);
    expect(approverEmails[0][3].from).toBeUndefined();
    expect(approverEmails[0][3].replyTo).toBe(requester.email);
  });

  it("emails the selected approver when the requester sends a reminder", async () => {
    sendEmail.mockClear();
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-reminder@example.com",
      role: "admin",
    });
    const secondApprover = await createUser({
      name: "Second Approver",
      email: "second-reminder@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester-reminder@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, {
        selected_approver_ids: [manager._id.toString(), secondApprover._id.toString()],
        passengers: [passengerFor(requester)],
      }));

    sendEmail.mockClear();
    const reminderResponse = await request(app)
      .post(`/api/requests/${createResponse.body._id}/remind-approver`)
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(reminderResponse.status).toBe(200);
    const reminderEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Reminder: travel request awaiting your approval"
    );
    expect(reminderEmails).toHaveLength(1);
    expect(reminderEmails[0][0]).toBe(manager.email);
  });

  it("shows existing requests to a recreated manager with the same email", async () => {
    const oldManager = await createUser({
      name: "Original Manager",
      email: "adama.mwangi@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: oldManager._id,
      managerEmail: oldManager.email,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(oldManager._id, { passengers: [passengerFor(requester)] }));

    await User.deleteOne({ _id: oldManager._id });
    const recreatedManager = await createUser({
      name: "Adama Mwangi",
      email: oldManager.email,
      role: "admin",
    });

    const managerToken = await login(recreatedManager.email);
    const listResponse = await request(app)
      .get("/api/requests")
      .set("Authorization", `Bearer ${managerToken}`);

    expect(createResponse.status).toBe(201);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.map((item) => item._id)).toContain(createResponse.body._id);
  });

  it("emails every active superadmin about any approved TAR for travel arrangements", async () => {
    sendEmail.mockClear();
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const superadmin = await createUser({
      name: "Travel Desk",
      email: "travel-desk@example.com",
      role: "superadmin",
    });
    const secondSuperadmin = await createUser({
      name: "Travel Desk Backup",
      email: "travel-desk-backup@example.com",
      role: "superadmin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildRequestPayload(manager._id, {
          modeOfTravel: { careVehicle: true, publicTransport: false, aircraft: false },
          passengers: [passengerFor(requester)],
        })
      );

    expect(
      await Notification.countDocuments({
        recipient: superadmin._id,
        type: "flight_booking_required",
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: secondSuperadmin._id,
        type: "flight_booking_required",
      })
    ).toBe(0);

    const approveToken = await login(manager.email);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${approveToken}`)
      .send({ signature: "Manager Signature" });

    expect(approveResponse.status).toBe(200);
    expect(
      await Notification.countDocuments({
        recipient: superadmin._id,
        type: "flight_booking_required",
        request: createResponse.body._id,
      })
    ).toBe(1);
    expect(
      await Notification.countDocuments({
        recipient: secondSuperadmin._id,
        type: "flight_booking_required",
        request: createResponse.body._id,
      })
    ).toBe(1);

    const arrangementEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Flight booking required for approved TAR"
    );
    expect(arrangementEmails.map(([recipient]) => recipient).sort()).toEqual([
      superadmin.email,
      secondSuperadmin.email,
    ].sort());
  });

  it("stores history and resets status when a rejected request is resubmitted", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    const managerToken = await login(manager.email);
    const rejectResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/reject`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ comment: "Please add more detail." });

    expect(rejectResponse.status).toBe(200);

    const resubmitResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildRequestPayload(manager._id, {
          purposeOfTrip: "Updated field monitoring visit",
          passengers: [passengerFor(requester)],
        })
      );

    expect(resubmitResponse.status).toBe(200);
    expect(resubmitResponse.body.status).toBe("pending");
    expect(resubmitResponse.body.version).toBe(2);
    expect(resubmitResponse.body.history).toHaveLength(1);
    expect(resubmitResponse.body.history[0].status).toBe("rejected");
    expect(resubmitResponse.body.history[0].decision.comment).toBe(
      "Please add more detail."
    );

    const approveAfterResubmit = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ signature: "Manager Signature" });

    expect(approveAfterResubmit.status).toBe(200);
    expect(approveAfterResubmit.body.status).toBe("approved");
  });

  it("prevents a non-approver admin from approving someone else's request", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const otherAdmin = await createUser({
      name: "Other Admin",
      email: "other-admin@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    const otherAdminToken = await login(otherAdmin.email);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${otherAdminToken}`)
      .send({ signature: "Other Admin Signature" });

    expect(approveResponse.status).toBe(403);
  });

  it("lets admins filter requests by status and search term", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    await TravelRequest.create({
      requestedBy: requester._id,
      selected_approver_id: manager._id,
      status: "pending",
      ...buildRequestPayload(manager._id, {
        purposeOfTrip: "Kisumu monitoring visit",
        passengers: [passengerFor(requester)],
      }),
    });
    await TravelRequest.create({
      requestedBy: requester._id,
      selected_approver_id: manager._id,
      status: "approved",
      ...buildRequestPayload(manager._id, {
        purposeOfTrip: "Nairobi workshop",
        passengers: [passengerFor(requester)],
      }),
    });

    const token = await login(manager.email);
    const response = await request(app)
      .get("/api/requests?status=pending&search=Kisumu")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].status).toBe("pending");
    expect(response.body.data[0].purposeOfTrip).toContain("Kisumu");
  });

  it("lists eligible approvers for authenticated users", async () => {
    const admin = await createUser({
      name: "Approver Admin",
      email: "approver@example.com",
      role: "admin",
    });
    await createUser({
      name: "Read Only Superadmin",
      email: "superadmin@example.com",
      role: "superadmin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
    });

    const token = await login(requester.email);
    const response = await request(app)
      .get("/api/users/approvers")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]._id).toBe(admin._id.toString());
  });

  it("lists eligible passengers for authenticated users", async () => {
    const admin = await createUser({
      name: "Approver Admin",
      email: "approver@example.com",
      role: "admin",
      employeeNumber: "1700",
    });
    const superadmin = await createUser({
      name: "Read Only Superadmin",
      email: "superadmin@example.com",
      role: "superadmin",
    });
    const colleague = await createUser({
      name: "Colleague One",
      email: "colleague@example.com",
      employeeNumber: "1701",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      employeeNumber: "1702",
    });

    const token = await login(requester.email);
    const response = await request(app)
      .get("/api/users/passengers")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(3);

    const ids = response.body.map((user) => user._id);
    expect(ids).toEqual(
      expect.arrayContaining([
        admin._id.toString(),
        colleague._id.toString(),
        requester._id.toString(),
      ])
    );
    expect(ids).not.toContain(superadmin._id.toString());
    expect(response.body[0]).toHaveProperty("employeeNumber");
    expect(response.body[0]).not.toHaveProperty("passwordHash");
  });

  it("includes a superadmin requester but excludes other superadmins", async () => {
    const requester = await createUser({
      name: "Superadmin Requester",
      email: "superadmin-requester@example.com",
      role: "superadmin",
    });
    const otherSuperadmin = await createUser({
      name: "Other Superadmin",
      email: "other-superadmin@example.com",
      role: "superadmin",
    });

    const token = await login(requester.email);
    const response = await request(app)
      .get("/api/users/passengers")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.map((user) => user._id)).toContain(requester._id.toString());
    expect(response.body.map((user) => user._id)).not.toContain(otherSuperadmin._id.toString());
  });

  it("allows a superadmin to create a request as the first passenger", async () => {
    const approver = await createUser({
      name: "Approver Admin",
      email: "approver-for-superadmin@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Superadmin Requester",
      email: "requester-superadmin@example.com",
      role: "superadmin",
    });

    const token = await login(requester.email);
    const response = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${token}`)
      .send(buildRequestPayload(approver._id, { passengers: [passengerFor(requester)] }));

    expect(response.status).toBe(201);
    expect(response.body.requestedBy._id).toBe(requester._id.toString());
    expect(response.body.passengers[0].user._id).toBe(requester._id.toString());
  });

  it("marks all notifications as read for the authenticated user", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
    });

    await Notification.create([
      {
        recipient: requester._id,
        type: "approved",
        request: new mongoose.Types.ObjectId(),
        message: "Approved one",
      },
      {
        recipient: requester._id,
        type: "rejected",
        request: new mongoose.Types.ObjectId(),
        message: "Rejected two",
      },
      {
        recipient: manager._id,
        type: "new_request",
        request: new mongoose.Types.ObjectId(),
        message: "Other user notification",
      },
    ]);

    const token = await login(requester.email);
    const response = await request(app)
      .patch("/api/notifications/mark-all-read")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.updatedCount).toBe(2);

    const requesterNotifications = await Notification.find({ recipient: requester._id });
    expect(requesterNotifications.every((item) => item.read)).toBe(true);
  });

  it("downloads a travel request PDF", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    const pdfResponse = await request(app)
      .get(`/api/travel-requests/${createResponse.body._id}/pdf?preview=true`)
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toMatch(/application\/pdf/);
  });
});
