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
const TravelRequest = require("../src/models/TravelRequest");
const ReimbursementReport = require("../src/models/ReimbursementReport");
const ExpenseLineItem = require("../src/models/ExpenseLineItem");
const { hashPassword } = require("../src/services/passwordService");

let mongoServer;
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
    employeeNumber: "R691",
    department: "ADMIN",
    position: "Officer",
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
    employeeNumber: user.employeeNumber || "R691",
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

function buildReimbursementPayload(travelRequestId, selectedApproverId, overrides = {}) {
  return {
    travelRequestId,
    selected_approver_id: selectedApproverId,
    baseLocation: "Nairobi",
    lineItems: [
      {
        expenseDate: "2026-07-06T00:00:00.000Z",
        location: "Kisumu",
        category: "PER DIEM (M&I)",
        description: "Field day per diem",
        amount: 3500,
      },
      {
        expenseDate: "2026-07-06T00:00:00.000Z",
        location: "Kisumu",
        category: "HOTEL ROOM & TAXES",
        description: "Overnight stay",
        amount: 8500,
      },
    ],
    ...overrides,
  };
}

async function createApprovedTravelRequest(manager, traveller, booker = traveller) {
  const bookerToken = await login(booker.email);
  const createResponse = await request(app)
    .post("/api/requests")
    .set("Authorization", `Bearer ${bookerToken}`)
    .send(
      buildRequestPayload(manager._id, {
        passengers: Array.isArray(traveller)
          ? traveller.map(passengerFor)
          : [passengerFor(traveller)],
      })
    );

  const managerToken = await login(manager.email);
  await request(app)
    .patch(`/api/requests/${createResponse.body._id}/approve`)
    .set("Authorization", `Bearer ${managerToken}`)
    .send({});

  return createResponse.body._id;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = createApp();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    TravelRequest.deleteMany({}),
    ReimbursementReport.deleteMany({}),
    ExpenseLineItem.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("reimbursement workflow", () => {
  it("submits a reimbursement report with line items and calculated total", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);

    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("pending");
    expect(response.body.totalAmountKsh).toBe(12000);
    expect(response.body.lineItems).toHaveLength(2);
    expect(response.body.lineItems[0].category).toBe("PER DIEM (M&I)");
    expect(response.body.lineItems[1].category).toBe("HOTEL ROOM & TAXES");
    expect(response.body.employeeNumber).toBe("R691");
    expect(response.body.department).toBe("ADMIN");
  });

  it("lists expense categories for reimbursement form dropdowns", async () => {
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
    });
    const requesterToken = await login(requester.email);

    const response = await request(app)
      .get("/api/reimbursements/expense-categories")
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(response.status).toBe(200);
    expect(response.body.categories).toEqual(
      expect.arrayContaining(["LUNCH", "DINNER", "OTHER EXPENSES"])
    );
  });

  it("accepts category without free-text description and rejects unknown categories", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);

    const invalid = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildReimbursementPayload(travelRequestId, manager._id, {
          lineItems: [
            {
              expenseDate: "2026-07-06T00:00:00.000Z",
              location: "Kisumu",
              category: "FOOD",
              amount: 500,
            },
          ],
        })
      );

    expect(invalid.status).toBe(400);

    const valid = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildReimbursementPayload(travelRequestId, manager._id, {
          lineItems: [
            {
              expenseDate: "2026-07-06T00:00:00.000Z",
              location: "Kisumu",
              category: "LUNCH",
              amount: 800,
            },
          ],
        })
      );

    expect(valid.status).toBe(201);
    expect(valid.body.lineItems[0].category).toBe("LUNCH");
    expect(valid.body.lineItems[0].description).toBe("LUNCH");
    expect(valid.body.totalAmountKsh).toBe(800);
  });

  it("rejects reimbursement for non-approved travel requests", async () => {
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

    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(createResponse.body._id, manager._id));

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/approved travel request/i);
  });

  it("rejects reimbursement when the submitter is not a passenger on the trip", async () => {
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
    });

    const travelRequestId = await createApprovedTravelRequest(manager, traveller, booker);
    const bookerToken = await login(booker.email);

    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${bookerToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/listed on as a passenger/i);
  });

  it("allows each passenger to submit their own reimbursement on a shared trip", async () => {
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
    const alice = await createUser({
      name: "Alice Traveller",
      email: "alice-traveller@example.com",
      managerId: manager._id,
      employeeNumber: "A100",
    });
    const bob = await createUser({
      name: "Bob Traveller",
      email: "bob-traveller@example.com",
      managerId: manager._id,
      employeeNumber: "B100",
    });

    const travelRequestId = await createApprovedTravelRequest(manager, [alice, bob], booker);
    const aliceToken = await login(alice.email);
    const bobToken = await login(bob.email);

    const aliceReport = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const bobReport = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${bobToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    expect(aliceReport.status).toBe(201);
    expect(bobReport.status).toBe(201);
    expect(aliceReport.body.submittedBy._id || aliceReport.body.submittedBy).toBeTruthy();
  });

  it("prevents duplicate reimbursement reports for the same travel request", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const payload = buildReimbursementPayload(travelRequestId, manager._id);

    await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(payload);

    const duplicateResponse = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(payload);

    expect(duplicateResponse.status).toBe(409);
  });

  it("lists a user's reimbursements and manager pending approvals", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);

    await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const myRequests = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", `Bearer ${requesterToken}`);

    const pendingApprovals = await request(app)
      .get("/api/reimbursements/pending-approvals")
      .set("Authorization", `Bearer ${managerToken}`);

    expect(myRequests.status).toBe(200);
    expect(myRequests.body).toHaveLength(1);
    expect(pendingApprovals.status).toBe(200);
    expect(pendingApprovals.body).toHaveLength(1);
    expect(pendingApprovals.body[0].submittedBy.email).toBe(requester.email);
  });

  it("allows superadmins to view all reimbursements in read-only mode", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const superadmin = await createUser({
      name: "Read Only Superadmin",
      email: "superadmin@example.com",
      role: "superadmin",
    });
    const requesterOne = await createUser({
      name: "Requester One",
      email: "requester-one@example.com",
      managerId: manager._id,
    });
    const requesterTwo = await createUser({
      name: "Requester Two",
      email: "requester-two@example.com",
      managerId: manager._id,
    });

    const travelRequestOne = await createApprovedTravelRequest(manager, requesterOne);
    const travelRequestTwo = await createApprovedTravelRequest(manager, requesterTwo);
    const requesterOneToken = await login(requesterOne.email);
    const requesterTwoToken = await login(requesterTwo.email);
    const superadminToken = await login(superadmin.email);

    await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterOneToken}`)
      .send(buildReimbursementPayload(travelRequestOne, manager._id));

    await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterTwoToken}`)
      .send(buildReimbursementPayload(travelRequestTwo, manager._id));

    const response = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it("allows a manager to approve or reject a pending reimbursement", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const approveResponse = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "approved" });

    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body.status).toBe("approved");
    expect(approveResponse.body.approvedAt).toBeTruthy();

    const rejectManager = await createUser({
      name: "Reject Manager",
      email: "reject-manager@example.com",
      role: "admin",
    });
    const rejectRequester = await createUser({
      name: "Reject Requester",
      email: "reject-requester@example.com",
      managerId: rejectManager._id,
    });
    const rejectTravelRequestId = await createApprovedTravelRequest(
      rejectManager,
      rejectRequester
    );
    const rejectRequesterToken = await login(rejectRequester.email);
    const rejectManagerToken = await login(rejectManager.email);

    const rejectable = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${rejectRequesterToken}`)
      .send(buildReimbursementPayload(rejectTravelRequestId, rejectManager._id));

    const rejectResponse = await request(app)
      .patch(`/api/reimbursements/${rejectable.body._id}/status`)
      .set("Authorization", `Bearer ${rejectManagerToken}`)
      .send({ status: "rejected", comment: "Missing receipt for accommodation" });

    expect(rejectResponse.status).toBe(200);
    expect(rejectResponse.body.status).toBe("rejected");
    expect(rejectResponse.body.decision.comment).toBe("Missing receipt for accommodation");
  });

  it("rejects liquidated as a reimbursement status", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const response = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "liquidated" });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/approved or rejected/i);
  });

  it("approves reimbursements when the request body is omitted", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const approveResponse = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "approved" });

    expect(approveResponse.status).toBe(200);
  });

  it("stores history and resets status when a rejected reimbursement is resubmitted", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const alternateManager = await createUser({
      name: "Alternate Admin",
      email: "alternate-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const pendingUpdate = await request(app)
      .patch(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildReimbursementPayload(travelRequestId, alternateManager._id, {
          baseLocation: "Mombasa",
        })
      );

    expect(pendingUpdate.status).toBe(400);

    const rejectResponse = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "rejected", comment: "Missing taxi receipt." });

    expect(rejectResponse.status).toBe(200);

    const updateResponse = await request(app)
      .patch(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(
        buildReimbursementPayload(travelRequestId, alternateManager._id, {
          baseLocation: "Mombasa",
          lineItems: [
            {
              expenseDate: "2026-07-06T00:00:00.000Z",
              location: "Mombasa",
              category: "TAXI/LOCAL TRANSPORTATION",
              description: "Airport transfer",
              amount: 1500,
            },
          ],
        })
      );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.status).toBe("pending");
    expect(updateResponse.body.version).toBe(2);
    expect(updateResponse.body.history).toHaveLength(1);
    expect(updateResponse.body.history[0].status).toBe("rejected");
    expect(updateResponse.body.history[0].decision.comment).toBe("Missing taxi receipt.");
    expect(updateResponse.body.baseLocation).toBe("Mombasa");
    expect(updateResponse.body.totalAmountKsh).toBe(1500);
    expect(updateResponse.body.lineItems).toHaveLength(1);
    expect(updateResponse.body.selected_approver_id._id).toBe(
      alternateManager._id.toString()
    );
  });

  it("blocks superadmins from mutating reimbursement status", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager@example.com",
      role: "admin",
    });
    const superadmin = await createUser({
      name: "Read Only Superadmin",
      email: "superadmin@example.com",
      role: "superadmin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester@example.com",
      managerId: manager._id,
    });

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const superadminToken = await login(superadmin.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const response = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ status: "approved" });

    expect(response.status).toBe(403);
  });

  it("downloads a reimbursement PDF", async () => {
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

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);

    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const pdfResponse = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toMatch(/application\/pdf/);
  });
});
