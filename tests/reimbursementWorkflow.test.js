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
const BudgetHolder = require("../src/models/BudgetHolder");
const ReimbursementReport = require("../src/models/ReimbursementReport");
const ExpenseLineItem = require("../src/models/ExpenseLineItem");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");
const { loginWithMfa } = require("./mfaTestHelper");

let app;
let defaultBudgetHolderId;
let defaultBudgetHolderToken;

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
    roles: overrides.roles || (overrides.role === "admin" ? ["supervisor"] : []),
    position: "Officer",
    ...overrides,
  });
}

async function login(email, password = "Password123!") {
  return loginWithMfa(app, email, password);
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
    selected_budget_holder_id: defaultBudgetHolderId?.toString(),
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
    supervisorId: selectedApproverId,
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

async function approveBudgetHolderRequest(requestId) {
  return request(app)
    .patch(`/api/requests/${requestId}/budget-holder/approve`)
    .set("Authorization", "Bearer " + defaultBudgetHolderToken)
    .send({ signature: "Budget Holder Signature" });
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

  if (createResponse.status !== 201) {
    throw new Error(`Could not create test travel request: ${createResponse.body.message || createResponse.status}`);
  }
  const budgetHolderResponse = await approveBudgetHolderRequest(createResponse.body._id);
  if (budgetHolderResponse.status !== 200) {
    throw new Error(`Could not approve test budget holder stage: ${budgetHolderResponse.body.message || budgetHolderResponse.status}`);
  }
  const managerToken = await login(manager.email);
  await request(app)
    .patch(`/api/requests/${createResponse.body._id}/approve`)
    .set("Authorization", `Bearer ${managerToken}`)
    .send({ signature: "Manager Signature" });

  return createResponse.body._id;
}

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    BudgetHolder.deleteMany({}),
    TravelRequest.deleteMany({}),
    ReimbursementReport.deleteMany({}),
    ExpenseLineItem.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

beforeEach(async () => {
  const budgetHolderUser = await createUser({
    name: "Budget Holder",
    email: `budget-holder-${Math.random().toString(36).slice(2)}@example.com`,
    role: "approver_budget_holder",
  });
  defaultBudgetHolderToken = await login(budgetHolderUser.email);
  const holder = await BudgetHolder.create({
    name: budgetHolderUser.name,
    email: budgetHolderUser.email,
    fundCode: "DEC16",
    user: budgetHolderUser._id,
  });
  defaultBudgetHolderId = holder._id;
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
    expect(response.body.status).toBe("SUBMITTED_TO_SUPERVISOR");
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
  }, 15000);

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

  it("allows auditors to read TARs and reimbursement history without approving", async () => {
    const manager = await createUser({
      name: "Line Manager",
      email: "line-manager@example.com",
      role: "admin",
    });
    const supervisor = await createUser({
      name: "Supervisor",
      email: "supervisor@example.com",
      roles: ["supervisor"],
    });
    const finance = await createUser({
      name: "Finance Admin",
      email: "finance@example.com",
      role: "admin",
      roles: ["finance_admin"],
    });
    const requester = await createUser({
      name: "Requester",
      email: "requester@example.com",
      managerId: manager._id,
    });
    const auditor = await createUser({
      name: "Auditor",
      email: "auditor@example.com",
      roles: ["auditor"],
    });

    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const supervisorToken = await login(supervisor.email);
    const managerToken = await login(manager.email);
    const financeToken = await login(finance.email);
    const auditorToken = await login(auditor.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, supervisor._id));
    const report = await ReimbursementReport.findById(created.body._id);
    report.attachments.push(
      ...["financial", "supervisor", "line_manager"].map((category) => ({
        category,
        originalName: `${category}.pdf`,
        storageId: `${category}-attachment`,
        mimeType: "application/pdf",
        size: 1,
        uploadedBy: requester._id,
      }))
    );
    await report.save();

    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "review_started" });
    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "approved" });
    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "approved" });

    const tarResponse = await request(app)
      .get(`/api/requests/${travelRequestId}`)
      .set("Authorization", "Bearer " + auditorToken);
    const tarList = await request(app)
      .get("/api/requests?scope=all")
      .set("Authorization", "Bearer " + auditorToken);
    const reimbursementList = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", "Bearer " + auditorToken);
    const reimbursementDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + auditorToken);
    const financeDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeToken);
    const lineManagerDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + managerToken);
    const forbiddenApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + auditorToken)
      .send({ status: "approved" });

    expect(tarResponse.status).toBe(200);
    expect(tarList.status).toBe(200);
    expect(tarList.body.data).toHaveLength(1);
    expect(reimbursementList.status).toBe(200);
    expect(reimbursementList.body).toHaveLength(1);
    expect(reimbursementDetail.status).toBe(200);
    expect(reimbursementDetail.body.approvalHistory[0].performedBy.name).toBe(requester.name);
    expect(reimbursementDetail.body.attachments).toHaveLength(3);
    expect(financeDetail.body.attachments.map((attachment) => attachment.category)).toEqual(["financial"]);
    expect(lineManagerDetail.body.attachments.map((attachment) => attachment.category)).toEqual(
      expect.arrayContaining(["financial", "line_manager"])
    );
    expect(lineManagerDetail.body.attachments).toHaveLength(2);
    expect(forbiddenApproval.status).toBe(403);
  }, 30000);

  it("allows an assigned supervisor to approve or reject a reimbursement", async () => {
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

    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    const approveResponse = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "approved" });

    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body.status).toBe("SUBMITTED_TO_LINE_MANAGER");
    expect(approveResponse.body.supervisorApprovedAt).toBeTruthy();

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

    await request(app)
      .patch(`/api/reimbursements/${rejectable.body._id}/status`)
      .set("Authorization", "Bearer " + rejectManagerToken)
      .send({ status: "review_started" });
    const rejectResponse = await request(app)
      .patch(`/api/reimbursements/${rejectable.body._id}/status`)
      .set("Authorization", `Bearer ${rejectManagerToken}`)
      .send({ status: "rejected", comment: "Missing receipt for accommodation" });

    expect(rejectResponse.status).toBe(200);
    expect(rejectResponse.body.status).toBe("SUPERVISOR_DECLINED");
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
    expect(JSON.stringify(response.body)).toMatch(/approved.*rejected/i);
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

    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
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

    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
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
    expect(updateResponse.body.status).toBe("SUBMITTED_TO_SUPERVISOR");
    expect(updateResponse.body.version).toBe(2);
    expect(updateResponse.body.history).toHaveLength(1);
    expect(updateResponse.body.history[0].status).toBe("SUPERVISOR_DECLINED");
    expect(updateResponse.body.history[0].decision.comment).toBe("Missing taxi receipt.");
    expect(updateResponse.body.baseLocation).toBe("Mombasa");
    expect(updateResponse.body.totalAmountKsh).toBe(1500);
    expect(updateResponse.body.lineItems).toHaveLength(1);
    expect(updateResponse.body.selected_approver_id._id).toBe(manager._id.toString());
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

  it("enforces supervisor, TAR line manager, and finance approvals in sequence", async () => {
    const manager = await createUser({
      name: "Line Manager",
      email: "line-manager@example.com",
      role: "admin",
    });
    const supervisor = await createUser({
      name: "Supervisor",
      email: "supervisor@example.com",
      roles: ["supervisor"],
    });
    const finance = await createUser({
      name: "Finance Admin",
      email: "finance@example.com",
      role: "admin",
      roles: ["finance_admin"],
    });
    const requester = await createUser({
      name: "Requester",
      email: "requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const supervisorToken = await login(supervisor.email);
    const managerToken = await login(manager.email);
    const financeToken = await login(finance.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, supervisor._id));

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("SUBMITTED_TO_SUPERVISOR");
    expect(created.body.lineManagerId.name).toBe(manager.name);

    const skippedSupervisor = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + requesterToken)
      .send({ status: "approved" });
    const earlyFinanceAccess = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeToken);
    expect(skippedSupervisor.status).toBe(403);
    expect(earlyFinanceAccess.status).toBe(403);

    const supervisorReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "review_started" });
    expect(supervisorReview.body.status).toBe("SUPERVISOR_REVIEW");
    const supervisorApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "approved" });
    expect(supervisorApproval.body.status).toBe("SUBMITTED_TO_LINE_MANAGER");

    const lineManagerReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    expect(lineManagerReview.body.status).toBe("LINE_MANAGER_REVIEW");
    const lineManagerApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "approved" });
    expect(lineManagerApproval.body.status).toBe("SUBMITTED_TO_FINANCE");

    const financeReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + financeToken)
      .send({ status: "review_started" });
    expect(financeReview.body.status).toBe("FINANCE_REVIEW");
    const financeDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeToken);
    expect(financeDetail.status).toBe(200);

    const financeApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + financeToken)
      .send({ status: "approved" });
    expect(financeApproval.body.status).toBe("PAYMENT_PROCESSING");

    const completed = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + financeToken)
      .send({ status: "completed" });
    expect(completed.body).toMatchObject({ status: "COMPLETED" });
    expect(completed.body.approvalHistory.map((entry) => entry.resultingStatus)).toEqual(
      expect.arrayContaining([
        "SUPERVISOR_APPROVED",
        "SUPERVISOR_REVIEW",
        "LINE_MANAGER_REVIEW",
        "FINANCE_REVIEW",
        "LINE_MANAGER_APPROVED",
        "SUBMITTED_TO_FINANCE",
        "PAYMENT_PROCESSING",
        "COMPLETED",
      ])
    );
  }, 20000);

  it("records one approval by a dual-role line manager as both Supervisor and Line Manager approval", async () => {
    const manager = await createUser({
      name: "Supervisor and Line Manager",
      email: "dual-approver@example.com",
      role: "admin",
      roles: ["supervisor"],
    });
    const requester = await createUser({
      name: "Requester",
      email: "dual-flow-requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    expect(created.status).toBe(201);
    expect(created.body.supervisorId._id).toBe(manager._id.toString());
    expect(created.body.lineManagerId._id).toBe(manager._id.toString());

    const review = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    const approval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "approved" });

    expect(review.body.status).toBe("SUPERVISOR_REVIEW");
    expect(approval.body.status).toBe("SUBMITTED_TO_FINANCE");
    expect(String(approval.body.supervisorApprovedBy)).toBe(manager._id.toString());
    expect(approval.body.supervisorApprovedAt).toBeTruthy();
    expect(String(approval.body.lineManagerApprovedBy)).toBe(manager._id.toString());
    expect(approval.body.lineManagerApprovedAt).toBeTruthy();
    expect(approval.body.approvalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approvalLevel: "SUPERVISOR",
          action: "APPROVED",
          resultingStatus: "SUPERVISOR_APPROVED",
        }),
        expect.objectContaining({
          approvalLevel: "LINE_MANAGER",
          action: "APPROVED",
          resultingStatus: "LINE_MANAGER_APPROVED",
        }),
        expect.objectContaining({
          action: "SUBMITTED_TO_FINANCE",
          resultingStatus: "SUBMITTED_TO_FINANCE",
        }),
      ])
    );
    expect(approval.body.approvalHistory).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "SUBMITTED_TO_LINE_MANAGER" }),
      ])
    );
  }, 20000);

  it("accepts up to 30 expense days and rejects more than 30", async () => {
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
    const lineItems = Array.from({ length: 31 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 6, 1 + index));
      return {
        expenseDate: date.toISOString(),
        location: "Kisumu",
        category: "LUNCH",
        amount: 500,
      };
    });
    const accepted = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id, {
        lineItems: lineItems.slice(0, 30),
      }));
    expect(accepted.status).toBe(201);
    expect(accepted.body.lineItems).toHaveLength(30);

    const overLimitTravelRequestId = await createApprovedTravelRequest(manager, requester);
    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(overLimitTravelRequestId, manager._id, { lineItems }));
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/30 days/);
  }, 30000);

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

    const templateResponse = await request(app)
      .get("/api/reimbursements/template/ter.pdf")
      .set("Authorization", "Bearer " + requesterToken);
    expect(templateResponse.status).toBe(200);
    expect(templateResponse.headers["content-type"]).toMatch(/application\/pdf/);
    expect(templateResponse.body.subarray(0, 4).toString()).toBe("%PDF");
  });
});
