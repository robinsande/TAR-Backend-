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
const Notification = require("../src/models/Notification");
const { sendEmail } = require("../src/services/emailService");
const { hashPassword } = require("../src/services/passwordService");
const { runPendingApprovalReminders } = require("../src/services/pendingReminderScheduler");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");

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

async function approveBudgetHolderRequestFor(requestId) {
  return request(app)
    .patch(`/api/requests/${requestId}/budget-holder/approve`)
    .set("Authorization", "Bearer " + defaultBudgetHolderToken)
    .send({ signature: "Budget Holder Signature" });
}

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

beforeEach(async () => {
  const budgetHolderUser = await createUser({
    name: "Budget Holder",
    email: `budget-holder-${Math.random().toString(36).slice(2)}@example.com`,
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

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    BudgetHolder.deleteMany({}),
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

describe("user profile updates", () => {
  it("lets superadmins assign the combined approver and budget-holder role", async () => {
    const superadmin = await createUser({
      name: "Super Admin",
      email: "role-superadmin@example.com",
      role: "superadmin",
    });
    const account = await createUser({
      name: "Dual Role Reviewer",
      email: "dual-role-reviewer@example.com",
    });
    const token = await login(superadmin.email);

    const update = await request(app)
      .patch(`/api/users/${account._id}/role`)
      .set("Authorization", "Bearer " + token)
      .send({ role: "approver_budget_holder" });
    const approvers = await request(app)
      .get("/api/users/approvers")
      .set("Authorization", "Bearer " + token);

    expect(update.status).toBe(200);
    expect(update.body.role).toBe("approver_budget_holder");
    expect(approvers.body.map((user) => user._id)).toContain(account._id.toString());
  });

  it("preserves a designated manager stored by name and email when managerId is omitted", async () => {
    const superadmin = await createUser({
      name: "Super Admin",
      email: "superadmin-profile@example.com",
      role: "superadmin",
    });
    const user = await createUser({
      name: "Profile User",
      email: "profile-user@example.com",
      managerName: "Imported Manager",
      managerEmail: "imported-manager@example.com",
    });
    const token = await login(superadmin.email);

    const response = await request(app)
      .patch(`/api/users/${user._id}/profile`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Updated Profile User",
        email: user.email,
        department: "Programs",
      });

    expect(response.status).toBe(200);
    expect(response.body.managerName).toBe("Imported Manager");
    expect(response.body.managerEmail).toBe("imported-manager@example.com");
    const savedUser = await User.findById(user._id);
    expect(savedUser.managerName).toBe("Imported Manager");
    expect(savedUser.managerEmail).toBe("imported-manager@example.com");
  });
});

describe("request scoping and workflow", () => {
  it("requires budget-holder approval before notifying or exposing a TAR to its line manager", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "budget-stage-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "budget-stage-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.approvalStage).toBe("budget_holder");
    const budgetHolder = await BudgetHolder.findById(defaultBudgetHolderId);
    const budgetHolderEmail = sendEmail.mock.calls.find(
      ([recipient]) => recipient === budgetHolder.email
    );
    expect(budgetHolderEmail[2]).toContain("<p>Dear Budget Holder;</p>");
    expect(budgetHolderEmail[2]).toContain(
      "Requester One has submitted a TAR, capturing the relevant charging details, for your review and approval."
    );
    expect(budgetHolderEmail[3].text).toContain(
      "Dear Budget Holder;\n\n"
    );
    expect(budgetHolderEmail[3].text).toContain(
      "Requester One has submitted a TAR, capturing the relevant charging details, for your review and approval."
    );
    const managerToken = await login(manager.email);
    const pendingBeforeVerification = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", "Bearer " + managerToken);
    const blockedApproval = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ signature: "Manager Signature" });

    expect(pendingBeforeVerification.body).toHaveLength(0);
    expect(blockedApproval.status).toBe(403);
    expect(sendEmail.mock.calls.filter(([, subject]) =>
      subject === "New travel request awaiting approval"
    )).toHaveLength(0);

    const holderQueue = await request(app)
      .get("/api/requests/pending-my-budget-approval")
      .set("Authorization", "Bearer " + defaultBudgetHolderToken);
    expect(holderQueue.status).toBe(200);
    expect(holderQueue.body).toHaveLength(1);
    expect(holderQueue.body[0]._id).toBe(createResponse.body._id);

    const holderApproval = await approveBudgetHolderRequestFor(createResponse.body._id);
    expect(holderApproval.status).toBe(200);
    expect(holderApproval.body.approvalStage).toBe("line_manager");
    expect(holderApproval.body.project.fundCode).toBe("DEC16");
    const pendingAfterVerification = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", "Bearer " + managerToken);
    expect(pendingAfterVerification.body.map((item) => item._id)).toContain(createResponse.body._id);

    const managerApproval = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ signature: "Manager Signature" });
    expect(managerApproval.status).toBe(200);
    expect(managerApproval.body.status).toBe("approved");
  });

  it("lets only the selected budget holder reject and notify the requester", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "budget-reject-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "budget-reject-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildRequestPayload(manager._id, { passengers: [passengerFor(requester)] }));
    const unauthorized = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/budget-holder/reject`)
      .set("Authorization", "Bearer " + requesterToken)
      .send({ comment: "Not the selected holder" });
    expect(unauthorized.status).toBe(403);

    const missingReason = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/budget-holder/reject`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ comment: "   " });
    expect(missingReason.status).toBe(400);

    const rejection = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/budget-holder/reject`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ comment: "Please correct the fund code." });
    expect(rejection.status).toBe(200, JSON.stringify(rejection.body));
    expect(rejection.body.status).toBe("rejected");
    expect(rejection.body.budgetHolderDecision.status).toBe("rejected");
    expect(rejection.body.budgetHolderDecision.comment).toBe("Please correct the fund code.");
    expect(await Notification.countDocuments({
      recipient: requester._id,
      type: "rejected",
      request: createResponse.body._id,
    })).toBe(1);
  });

  it("keeps the requester's fund code and does not require the budget holder to re-enter it", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "fund-correction-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "fund-correction-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildRequestPayload(manager._id, {
        project: { ...buildRequestPayload(manager._id).project, fundCode: "DEC16" },
        passengers: [passengerFor(requester)],
      }));
    expect(createResponse.status).toBe(201);

    const approval = await approveBudgetHolderRequestFor(createResponse.body._id);
    expect(approval.status).toBe(200);
    expect(approval.body.project.fundCode).toBe("DEC16");
    expect(approval.body.budgetHolderDecision.comment).toBe("Fund code reviewed");
    expect(approval.body.budgetHolderDecision.submittedFundCode).toBe("DEC16");
    expect(approval.body.approvalStage).toBe("line_manager");

    const managerToken = await login(manager.email);
    const pending = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", "Bearer " + managerToken);
    expect(pending.body[0].project.fundCode).toBe("DEC16");
  });

  it("automatically completes line-manager approval when the budget holder is also the selected manager", async () => {
    sendEmail.mockClear();
    const holder = await BudgetHolder.findById(defaultBudgetHolderId);
    await User.findByIdAndUpdate(holder.user, { role: "approver_budget_holder" });
    const managerToken = await login(holder.email);
    const requester = await createUser({
      name: "Requester One",
      email: "dual-role-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildRequestPayload(holder.user, {
        selected_approver_ids: [String(holder.user)],
        passengers: [passengerFor(requester)],
      }));

    expect(createResponse.status).toBe(201);
    const initialEmails = sendEmail.mock.calls.filter(([recipient]) => recipient === holder.email);
    expect(initialEmails.map(([, subject]) => subject)).toEqual([
      "TAR awaiting your review and approval",
    ]);

    const budgetApproval = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/budget-holder/approve`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ signature: "Budget Holder Signature" });
    expect(budgetApproval.status).toBe(200);
    expect(budgetApproval.body.status).toBe("approved");
    expect(budgetApproval.body.approvalStage).toBe("line_manager");
    expect(budgetApproval.body.decision).toMatchObject({
      decidedBy: expect.objectContaining({ _id: String(holder.user) }),
      signature: "Budget Holder Signature",
    });
    expect(budgetApproval.body.budgetHolderDecision).toMatchObject({
      status: "approved",
      signature: "Budget Holder Signature",
    });
    expect(new Date(budgetApproval.body.decision.decidedAt).getTime())
      .toBe(new Date(budgetApproval.body.budgetHolderDecision.decidedAt).getTime());

    const approvalEmails = sendEmail.mock.calls.filter(([recipient]) => recipient === holder.email);
    expect(approvalEmails.map(([, subject]) => subject)).toEqual([
      "TAR awaiting your review and approval",
    ]);
    const managerQueue = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", "Bearer " + managerToken);
    expect(managerQueue.status).toBe(200);
    expect(managerQueue.body.map((item) => item._id)).not.toContain(createResponse.body._id);
    expect(await Notification.countDocuments({
      recipient: requester._id,
      type: "approved",
      request: createResponse.body._id,
    })).toBe(1);
  });


  it("sends requests directly to the line manager when no budget holder is selected", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "optional-budget-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "optional-budget-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildRequestPayload(manager._id, {
        selected_budget_holder_id: "",
        passengers: [passengerFor(requester)],
      }));

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.selected_budget_holder_id).toBeNull();
    expect(createResponse.body.approvalStage).toBe("line_manager");
    const managerNotification = await Notification.findOne({
      recipient: manager._id,
      type: "new_request",
      request: createResponse.body._id,
    });
    expect(managerNotification).toBeTruthy();
    const managerEmail = sendEmail.mock.calls.find(([recipient]) => recipient === manager.email);
    expect(managerEmail[1]).toBe("New travel request awaiting approval");
    expect(managerEmail[2]).toContain("<p>Hello Manager Admin,</p>");
    expect(managerEmail[2]).toContain(
      "Requester One (optional-budget-requester@example.com) submitted a new travel request to Kisumu for Field monitoring visit. Please review and approve the TAR."
    );
    expect(await Notification.countDocuments({
      recipient: (await BudgetHolder.findById(defaultBudgetHolderId)).user,
      request: createResponse.body._id,
    })).toBe(0);

    const managerToken = await login(manager.email);
    const approval = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ signature: "Manager Signature" });
    expect(approval.status).toBe(200);
    expect(approval.body.status).toBe("approved");
  });

  it("keeps resubmitted TARs in the direct-to-manager path when the optional holder is blank", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "optional-resubmit-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "optional-resubmit-requester@example.com",
    });
    const requesterToken = await login(requester.email);
    const payload = buildRequestPayload(manager._id, {
      selected_budget_holder_id: "",
      passengers: [passengerFor(requester)],
    });
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", "Bearer " + requesterToken)
      .send(payload);
    const managerToken = await login(manager.email);
    const rejection = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/reject`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ comment: "Please update trip details." });
    expect(rejection.status).toBe(200);

    const resubmission = await request(app)
      .patch(`/api/requests/${createResponse.body._id}`)
      .set("Authorization", "Bearer " + requesterToken)
      .send({ ...payload, purposeOfTrip: "Updated field visit" });
    expect(resubmission.status).toBe(200);
    expect(resubmission.body.approvalStage).toBe("line_manager");
    expect(resubmission.body.selected_budget_holder_id).toBeNull();
    const managerNotification = await Notification.findOne({
      recipient: manager._id,
      type: "resubmitted",
      request: createResponse.body._id,
    });
    expect(managerNotification).toBeTruthy();
  });

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

    const budgetHolderResponse = await approveBudgetHolderRequestFor(createResponse.body._id);
    const approveToken = await login(manager.email);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${approveToken}`)
      .send({ signature: "Manager Signature" });

    expect(createResponse.status).toBe(201);
    expect(budgetHolderResponse.status).toBe(200);
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

  it("emails all selected approvers while allowing any selected approver to approve", async () => {
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

    const budgetHolderResponse = await approveBudgetHolderRequestFor(createResponse.body._id);
    const secondApproverToken = await login(secondApprover.email);
    const pendingResponse = await request(app)
      .get("/api/requests/pending-my-approval")
      .set("Authorization", `Bearer ${secondApproverToken}`);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${secondApproverToken}`)
      .send({ signature: "Second Approver Signature" });

    expect(createResponse.status).toBe(201);
    expect(budgetHolderResponse.status).toBe(200);
    expect(createResponse.body.selected_approver_ids).toHaveLength(2);
    expect(pendingResponse.status).toBe(200);
    expect(pendingResponse.body[0]._id).toBe(createResponse.body._id);
    expect(approveResponse.status).toBe(200);

    const approverEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "New travel request awaiting approval"
    );
    expect(approverEmails).toHaveLength(2);
    expect(approverEmails.map(([recipient]) => recipient)).toEqual(
      expect.arrayContaining([manager.email, secondApprover.email])
    );
    const requesterApprovalEmails = sendEmail.mock.calls.filter(
      ([recipient, subject]) => recipient === requester.email && subject === "Travel request approved"
    );
    expect(requesterApprovalEmails).toHaveLength(1);
    approverEmails.forEach(([, , , options]) => {
      expect(options.from).toBeUndefined();
      expect(options.replyTo).toBe(requester.email);
    });
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

    await approveBudgetHolderRequestFor(createResponse.body._id);
    sendEmail.mockClear();
    const reminderResponse = await request(app)
      .post(`/api/requests/${createResponse.body._id}/remind-approver`)
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(reminderResponse.status).toBe(200);
    const reminderEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Reminder: travel request awaiting your approval"
    );
    expect(reminderEmails).toHaveLength(2);
    expect(reminderEmails.map(([recipient]) => recipient)).toEqual(
      expect.arrayContaining([manager.email, secondApprover.email])
    );
  });

  it("sends scheduled reminders to every selected approver and retries failed sends", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-scheduled@example.com",
      role: "admin",
    });
    const secondApprover = await createUser({
      name: "Second Approver",
      email: "second-scheduled@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "requester-scheduled@example.com",
    });
    const submittedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const firstRequest = await TravelRequest.create({
      requestedBy: requester._id,
      selected_approver_id: manager._id,
      selected_approver_ids: [manager._id, secondApprover._id],
      submittedAt,
      ...buildRequestPayload(manager._id),
    });
    const secondRequest = await TravelRequest.create({
      requestedBy: requester._id,
      selected_approver_id: secondApprover._id,
      submittedAt,
      ...buildRequestPayload(secondApprover._id),
    });

    sendEmail.mockClear();
    sendEmail.mockResolvedValue(false);
    const failedRun = await runPendingApprovalReminders({ force: true });

    expect(failedRun.candidateRequests).toBe(2);
    expect(failedRun.approverEmailsSent).toBe(0);
    expect(await TravelRequest.findById(firstRequest._id).then((item) => item.lastApprovalReminderAt)).toBeNull();
    expect(await TravelRequest.findById(secondRequest._id).then((item) => item.lastApprovalReminderAt)).toBeNull();

    sendEmail.mockResolvedValue(true);
    sendEmail.mockClear();
    const successfulRun = await runPendingApprovalReminders({ force: true });
    const reminderEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Reminder: travel request awaiting your approval"
    );

    expect(successfulRun.candidateRequests).toBe(2);
    expect(successfulRun.approverEmailsSent).toBe(3);
    expect(reminderEmails.map(([recipient]) => recipient).sort()).toEqual(
      [manager.email, secondApprover.email, secondApprover.email].sort()
    );
    expect((await TravelRequest.findById(firstRequest._id)).lastApprovalReminderAt).toBeInstanceOf(Date);
    expect((await TravelRequest.findById(secondRequest._id)).lastApprovalReminderAt).toBeInstanceOf(Date);
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

  it("emails active read-only superadmins about every approved TAR", async () => {
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
    const readOnlySuperadmin = await createUser({
      name: "Read Only Travel Desk",
      email: "read-only-travel-desk@example.com",
      role: "super_superadmin",
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

    await approveBudgetHolderRequestFor(createResponse.body._id);
    expect(
      await Notification.countDocuments({
        recipient: superadmin._id,
        type: "approved",
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: secondSuperadmin._id,
        type: "approved",
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: readOnlySuperadmin._id,
        type: "approved",
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
        type: "approved",
        request: createResponse.body._id,
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: secondSuperadmin._id,
        type: "approved",
        request: createResponse.body._id,
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: readOnlySuperadmin._id,
        type: "approved",
        request: createResponse.body._id,
      })
    ).toBe(1);

    const approvedEmails = sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Approved TAR notification"
    );
    expect(approvedEmails.map(([recipient]) => recipient)).toEqual([readOnlySuperadmin.email]);
    expect(approvedEmails[0][3].text).toContain("Open the CARE TAR approvals page:");

    sendEmail.mockClear();
    const superadminToken = await login(superadmin.email);
    const resendResponse = await request(app)
      .post("/api/admin/resend-approved-tar-notifications")
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(resendResponse.status).toBe(200);
    expect(resendResponse.body.requests).toBe(1);
    expect(resendResponse.body.emailCount).toBe(1);
    expect(sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Approved TAR notification"
    )).toHaveLength(1);

    sendEmail.mockClear();
    sendEmail.mockResolvedValue(false);
    const failedResendResponse = await request(app)
      .post("/api/admin/resend-approved-tar-notifications")
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(failedResendResponse.status).toBe(200);
    expect(failedResendResponse.body.emailCount).toBe(0);
    sendEmail.mockResolvedValue(true);
  });

  it("limits read-only superadmins to approved TARs requiring flight booking", async () => {
    const approver = await createUser({
      name: "Approver Admin",
      email: "flight-approver@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "flight-requester@example.com",
    });
    const readOnlySuperadmin = await createUser({
      name: "Read Only Superadmin",
      email: "flight-read-only@example.com",
      role: "super_superadmin",
    });

    const flightRequest = await TravelRequest.create({
      requestedBy: requester._id,
      status: "approved",
      ...buildRequestPayload(approver._id, {
        purposeOfTrip: "Flight to Nairobi",
        modeOfTravel: { careVehicle: false, publicTransport: false, aircraft: true },
        passengers: [passengerFor(requester)],
      }),
    });
    const nonFlightRequest = await TravelRequest.create({
      requestedBy: requester._id,
      status: "approved",
      ...buildRequestPayload(approver._id, {
        purposeOfTrip: "Local field visit",
        modeOfTravel: { careVehicle: true, publicTransport: false, aircraft: false },
        passengers: [passengerFor(requester)],
      }),
    });

    const token = await login(readOnlySuperadmin.email);
    const listResponse = await request(app)
      .get("/api/requests")
      .set("Authorization", `Bearer ${token}`);
    const flightDetailResponse = await request(app)
      .get(`/api/requests/${flightRequest._id}`)
      .set("Authorization", `Bearer ${token}`);
    const nonFlightDetailResponse = await request(app)
      .get(`/api/requests/${nonFlightRequest._id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.map((item) => item._id)).toEqual([flightRequest._id.toString()]);
    expect(flightDetailResponse.status).toBe(200);
    expect(nonFlightDetailResponse.status).toBe(403);
  });

  it("notifies read-only superadmins about approved flight TARs", async () => {
    const approver = await createUser({
      name: "Approver Admin",
      email: "flight-only-approver@example.com",
      role: "admin",
    });
    const regularSuperadmin = await createUser({
      name: "Superadmin",
      email: "flight-only-superadmin@example.com",
      role: "superadmin",
    });
    const readOnlySuperadmin = await createUser({
      name: "Read Only Superadmin",
      email: "flight-only-readonly@example.com",
      role: "super_superadmin",
    });
    const requester = await createUser({
      name: "Requester One",
      email: "flight-only-requester@example.com",
    });

    const requesterToken = await login(requester.email);
    const createResponse = await request(app)
      .post("/api/requests")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildRequestPayload(approver._id, {
        modeOfTravel: { careVehicle: false, publicTransport: false, aircraft: true },
        passengers: [passengerFor(requester)],
      }));

    expect(createResponse.status).toBe(201);
    await approveBudgetHolderRequestFor(createResponse.body._id);
    sendEmail.mockClear();

    const approverToken = await login(approver.email);
    const approveResponse = await request(app)
      .patch(`/api/requests/${createResponse.body._id}/approve`)
      .set("Authorization", `Bearer ${approverToken}`)
      .send({ signature: "Approver Signature" });

    expect(approveResponse.status).toBe(200);
    expect(
      await Notification.countDocuments({
        recipient: regularSuperadmin._id,
        type: "approved",
        request: createResponse.body._id,
      })
    ).toBe(0);
    expect(
      await Notification.countDocuments({
        recipient: readOnlySuperadmin._id,
        type: "approved",
        request: createResponse.body._id,
      })
    ).toBe(1);
    expect(sendEmail.mock.calls.filter(([, subject]) =>
      subject === "Approved TAR notification"
    ).map(([recipient]) => recipient)).toEqual([readOnlySuperadmin.email]);
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

    await approveBudgetHolderRequestFor(createResponse.body._id);
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

    await approveBudgetHolderRequestFor(createResponse.body._id);
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

    await approveBudgetHolderRequestFor(createResponse.body._id);
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
    expect(response.body).toHaveLength(4);

    const ids = response.body.map((user) => user._id);
    expect(ids).toEqual(
      expect.arrayContaining([
        admin._id.toString(),
        colleague._id.toString(),
        requester._id.toString(),
      ])
    );
    expect(ids).toContain(String((await BudgetHolder.findById(defaultBudgetHolderId)).user));
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
