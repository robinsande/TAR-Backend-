jest.mock("../src/services/emailService", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  sendActivationEmail: jest.fn().mockResolvedValue(true),
  buildActivationEmail: jest.fn(),
}));

const request = require("supertest");
const mongoose = require("mongoose");
const { PDFDocument: TestPDFDocument } = require("pdf-lib");
const createApp = require("../src/app");
const {
  buildVoucherDailySummary,
  buildTerDayBuckets,
  getVoucherExpenseDescription,
} = require("../src/services/pdfService");
const User = require("../src/models/User");
const TravelRequest = require("../src/models/TravelRequest");
const BudgetHolder = require("../src/models/BudgetHolder");
const ReimbursementReport = require("../src/models/ReimbursementReport");
const ExpenseLineItem = require("../src/models/ExpenseLineItem");
const Notification = require("../src/models/Notification");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");
const { loginWithMfa } = require("./mfaTestHelper");

let app;
let defaultBudgetHolderId;
let defaultBudgetHolderUserId;
let defaultBudgetHolderToken;
let defaultFinanceAdminId;
const testRequesterSignature =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/B9sAAAAASUVORK5CYII=";

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

async function getPdfPageCount(buffer) {
  const pdf = await TestPDFDocument.load(buffer);
  return pdf.getPageCount();
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

function buildReimbursementPayload(travelRequestId, _selectedApproverId, overrides = {}) {
  return {
    travelRequestId,
    supervisorId: overrides.supervisorId || "",
    financeAdminId: defaultFinanceAdminId?.toString(),
    paymentRequestPurpose: "Approved travel expenses",
    paymentDetails: {
      paymentMethod: "mpesa",
      mpesaNumber: "0712345678",
    },
    requesterSignedName: "Requester Signature",
    requesterSignature: testRequesterSignature,
    baseLocation: "Nairobi",
    lineItems: [
      {
        expenseDate: "2026-07-06T00:00:00.000Z",
        location: "Kisumu",
        category: "PER DIEM (M&I)",
        description: "Field day per diem",
        invoiceNumber: "INV-TER-001",
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
  defaultBudgetHolderUserId = budgetHolderUser._id;
  const holder = await BudgetHolder.create({
    name: budgetHolderUser.name,
    email: budgetHolderUser.email,
    fundCode: "DEC16",
    user: budgetHolderUser._id,
  });
  defaultBudgetHolderId = holder._id;
  const financeAdmin = await createUser({
    name: "Default Finance Admin",
    email: `finance-admin-${Math.random().toString(36).slice(2)}@example.com`,
    role: "admin",
    roles: ["finance_admin"],
  });
  defaultFinanceAdminId = financeAdmin._id;
});

describe("reimbursement workflow", () => {
  it("saves, returns, and clears a signature only through the owner's profile", async () => {
    const requester = await createUser({ email: "signature-owner@example.com" });
    const token = await login(requester.email);

    const saved = await request(app)
      .patch("/api/users/me")
      .set("Authorization", "Bearer " + token)
      .send({ savedSignature: testRequesterSignature });
    expect(saved.status).toBe(200);
    expect(saved.body.savedSignature).toBe(testRequesterSignature);

    const profile = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer " + token);
    expect(profile.status).toBe(200);
    expect(profile.body.savedSignature).toBe(testRequesterSignature);

    const invalid = await request(app)
      .patch("/api/users/me")
      .set("Authorization", "Bearer " + token)
      .send({ savedSignature: "data:image/jpeg;base64,ZmFrZQ==" });
    expect(invalid.status).toBe(400);

    const cleared = await request(app)
      .patch("/api/users/me")
      .set("Authorization", "Bearer " + token)
      .send({ savedSignature: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.savedSignature).toBeNull();
  });

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

    const preview = await request(app)
      .post("/api/reimbursements/preview")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id, {
        supervisorId: "",
        peopleSoftFundCode: "CUSTOM-FUND",
        peopleSoftProjectId: "CUSTOM-PROJECT",
        peopleSoftActivityId: "CUSTOM-ACTIVITY",
        peopleSoftDepartmentId: "CUSTOM-DEPARTMENT",
      }));
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toMatch(/application\/pdf/);
    expect(await getPdfPageCount(preview.body)).toBe(3);

    const receiptPdf = await TestPDFDocument.create();
    receiptPdf.addPage([321, 456]);
    const previewWithReceipt = await request(app)
      .post("/api/reimbursements/preview")
      .set("Authorization", "Bearer " + requesterToken)
      .field("payload", JSON.stringify(buildReimbursementPayload(
        travelRequestId,
        manager._id,
        { supervisorId: "" }
      )))
      .field("previewAttachments", JSON.stringify([
        { documentType: "receipt_ticket", category: "financial" },
      ]))
      .attach("attachments", Buffer.from(await receiptPdf.save()), {
        filename: "preview-receipt.pdf",
        contentType: "application/pdf",
      });
    expect(previewWithReceipt.status).toBe(200);
    const previewPdfDocument = await TestPDFDocument.load(previewWithReceipt.body);
    expect(previewPdfDocument.getPageCount()).toBe(4);
    expect(previewPdfDocument.getPage(3).getSize()).toMatchObject({
      width: 321,
      height: 456,
    });

    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id, {
        supervisorId: "",
        peopleSoftFundCode: "CUSTOM-FUND",
        peopleSoftProjectId: "CUSTOM-PROJECT",
        peopleSoftActivityId: "CUSTOM-ACTIVITY",
        peopleSoftDepartmentId: "CUSTOM-DEPARTMENT",
      }));
    expect(response.status).toBe(201);
    expect(response.body.status).toBe("SUBMITTED_TO_BUDGET_HOLDER");
    expect(response.body.selected_approver_id._id).toBe(
      (await User.findById(defaultBudgetHolderUserId))._id.toString()
    );
    expect(response.body.lineManagerId._id).toBe(manager._id.toString());
    expect(response.body.supervisorId).toBeNull();
    expect(response.body.totalAmountKsh).toBe(12000);
    expect(response.body.lineItems).toHaveLength(2);
    expect(response.body.lineItems[0].category).toBe("PER DIEM (M&I)");
    expect(response.body.lineItems[1].category).toBe("HOTEL ROOM & TAXES");
    expect(response.body.employeeNumber).toBe("R691");
    expect(response.body.department).toBe("ADMIN");
    expect(response.body.paymentRequestPurpose).toBe("Approved travel expenses");
    expect(response.body.paymentDetails).toMatchObject({
      paymentMethod: "mpesa",
      mpesaNumber: "0712345678",
    });
    expect(response.body.lineItems[0].invoiceNumber).toBe("INV-TER-001");
    expect(response.body.travelRequest.project).toMatchObject({
      fundCode: "DEC16",
      projectId: "CDEUKE3014",
      activityId: "3",
      departmentId: "KE0201",
    });
    expect(response.body.financeAdminId).toBeNull();
    expect(response.body.peopleSoftFundCode).toBe("CUSTOM-FUND");
    expect(response.body.peopleSoftProjectId).toBe("CUSTOM-PROJECT");
    expect(response.body.peopleSoftActivityId).toBe("CUSTOM-ACTIVITY");
    expect(response.body.peopleSoftDepartmentId).toBe("CUSTOM-DEPARTMENT");
    expect(response.body.requesterSignedName).toBe(requester.name);
  });

  it("allows no Supervisor and rejects assigning the TAR Line Manager to both roles", async () => {
    const manager = await createUser({
      name: "Optional Supervisor Line Manager",
      email: "optional-supervisor-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Optional Supervisor Requester",
      email: "optional-supervisor-requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const payload = buildReimbursementPayload(travelRequestId, manager._id, {
      supervisorId: manager._id.toString(),
    });

    const duplicateAssignment = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(payload);
    expect(duplicateAssignment.status).toBe(400);
    expect(duplicateAssignment.body.message).toMatch(/different from the approved TAR Line Manager/i);

    const noSupervisor = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send({ ...payload, supervisorId: "" });
    expect(noSupervisor.status).toBe(201);
    expect(noSupervisor.body.status).toBe("SUBMITTED_TO_BUDGET_HOLDER");
    expect(noSupervisor.body.supervisorId).toBeNull();
  }, 20000);

  it("offers active Finance Admins and generates a one-page blank TER template", async () => {
    const requester = await createUser({ email: "template-requester@example.com" });
    const requesterToken = await login(requester.email);
    const financeAdmins = await request(app)
      .get("/api/users/finance-admins")
      .set("Authorization", "Bearer " + requesterToken);
    const template = await request(app)
      .get("/api/reimbursements/template/ter.pdf")
      .set("Authorization", "Bearer " + requesterToken);

    expect(financeAdmins.status).toBe(200);
    expect(financeAdmins.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: defaultFinanceAdminId.toString() }),
      ])
    );
    expect(template.status).toBe(200);
    expect(template.headers["content-type"]).toMatch(/application\/pdf/);
    expect((template.body.toString("latin1").match(/\/Type\s*\/Page\b/g) || [])).toHaveLength(1);
  });

  it("rejects a mismatched requester signature without requiring Finance routing", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-signature@example.com",
      role: "admin",
    });

    const requester = await createUser({
      name: "Requester Signature",
      email: "requester-signature@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const invalidSignature = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(
        buildReimbursementPayload(travelRequestId, manager._id, {
          requesterSignature: "Someone Else",
        })
      );
    const noFinanceSelection = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(
        buildReimbursementPayload(travelRequestId, manager._id, {
          financeAdminId: "",
        })
      );

    expect(invalidSignature.status).toBe(400);
    expect(invalidSignature.body.message).toMatch(/account name|drawn signature/i);
    expect(noFinanceSelection.status).toBe(201);
    expect(noFinanceSelection.body.financeAdminId).toBeNull();
    expect(noFinanceSelection.body.financeCcAdminId).toBeNull();
  });

  it("requires M-PESA as the payment method and a mobile number", async () => {
    const manager = await createUser({
      name: "M-PESA Line Manager",
      email: "mpesa-line-manager@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "M-PESA Requester",
      email: "mpesa-requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const payload = buildReimbursementPayload(travelRequestId, manager._id);

    const unsupportedMethod = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send({ ...payload, paymentDetails: { ...payload.paymentDetails, paymentMethod: "bank_transfer" } });
    const missingNumber = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send({ ...payload, paymentDetails: { paymentMethod: "mpesa", mpesaNumber: "" } });

    expect(unsupportedMethod.status).toBe(400);
    expect(missingNumber.status).toBe(400);
  }, 20000);

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
              amount: 1000,
            },
          ],
        })
      );

    expect(valid.status).toBe(201);
    expect(valid.body.lineItems[0].category).toBe("LUNCH");
    expect(valid.body.lineItems[0].description).toBe("Per diem while in Kisumu");
    expect(valid.body.totalAmountKsh).toBe(1000);

    const wrongStandardRate = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
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
    expect(wrongStandardRate.status).toBe(400);
    expect(wrongStandardRate.body.message).toMatch(/LUNCH must be reimbursed at KSH 1000/);
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

  it("lists a user's reimbursements and Budget Holder pending approvals", async () => {
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
    const budgetHolderToken = defaultBudgetHolderToken;

    await request(app)
      .post("/api/reimbursements")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send(buildReimbursementPayload(travelRequestId, manager._id));

    const myRequests = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", `Bearer ${requesterToken}`);

    const pendingApprovals = await request(app)
      .get("/api/reimbursements/pending-approvals")
      .set("Authorization", "Bearer " + budgetHolderToken);

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
      .get("/api/reimbursements/my-requests?scope=all")
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it("allows superadmin and super-superadmin staff to create TARs and reimbursements", async () => {
    const manager = await createUser({
      name: "Line Manager",
      email: "staff-line-manager@example.com",
      role: "admin",
    });
    const superadmin = await createUser({
      name: "Superadmin Staff",
      email: "superadmin-staff@example.com",
      role: "superadmin",
      managerId: manager._id,
    });
    const superSuperadmin = await createUser({
      name: "Super-superadmin Staff",
      email: "super-superadmin-staff@example.com",
      role: "super_superadmin",
      managerId: manager._id,
    });

    const superadminTarId = await createApprovedTravelRequest(manager, superadmin);
    const superSuperadminTarId = await createApprovedTravelRequest(manager, superSuperadmin);
    const superadminToken = await login(superadmin.email);
    const superSuperadminToken = await login(superSuperadmin.email);
    const superadminTarDetail = await request(app)
      .get(`/api/requests/${superadminTarId}`)
      .set("Authorization", "Bearer " + superadminToken);
    const superSuperadminTarList = await request(app)
      .get("/api/requests?scope=mine")
      .set("Authorization", "Bearer " + superSuperadminToken);
    const superSuperadminTarDetail = await request(app)
      .get(`/api/requests/${superSuperadminTarId}`)
      .set("Authorization", "Bearer " + superSuperadminToken);
    const superadminReport = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + superadminToken)
      .send(buildReimbursementPayload(superadminTarId, manager._id));
    const superSuperadminReport = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + superSuperadminToken)
      .send(buildReimbursementPayload(superSuperadminTarId, manager._id));

    expect(superadminReport.status).toBe(201);
    expect(superSuperadminReport.status).toBe(201);
    expect(superadminTarDetail.status).toBe(200);
    expect(superSuperadminTarList.body.data).toHaveLength(1);
    expect(superSuperadminTarDetail.status).toBe(200);

    const superadminMine = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", "Bearer " + superadminToken);
    const superadminAll = await request(app)
      .get("/api/reimbursements/my-requests?scope=all")
      .set("Authorization", "Bearer " + superadminToken);
    const superSuperadminMine = await request(app)
      .get("/api/reimbursements/my-requests")
      .set("Authorization", "Bearer " + superSuperadminToken);
    const superSuperadminAll = await request(app)
      .get("/api/reimbursements/my-requests?scope=all")
      .set("Authorization", "Bearer " + superSuperadminToken);

    expect(superadminMine.body).toHaveLength(1);
    expect(superadminMine.body[0].submittedBy.email).toBe(superadmin.email);
    expect(superadminAll.body).toHaveLength(2);
    expect(superSuperadminMine.body).toHaveLength(1);
    expect(superSuperadminMine.body[0].submittedBy.email).toBe(superSuperadmin.email);
    expect(superSuperadminAll.body).toHaveLength(2);
  }, 30000);

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
    const budgetHolderToken = defaultBudgetHolderToken;
    const financeToken = await login(finance.email);
    const auditorToken = await login(auditor.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, supervisor._id, {
        financeAdminId: finance._id,
        supervisorId: supervisor._id,
      }));
    const report = await ReimbursementReport.findById(created.body._id);
    report.attachments.push(
      ...[
        ["financial", "receipt_ticket"],
        ["supervisor", "other"],
        ["line_manager", "back_to_office"],
        ["line_manager", "terms_of_reference"],
      ].map(([category, documentType]) => ({
        category,
        documentType,
        originalName: `${documentType}.pdf`,
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
      .set("Authorization", "Bearer " + budgetHolderToken)
      .send({ status: "review_started" });
    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + budgetHolderToken)
      .send({ status: "approved" });
    await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "acknowledged", signature: testRequesterSignature });

    const tarResponse = await request(app)
      .get(`/api/requests/${travelRequestId}`)
      .set("Authorization", "Bearer " + auditorToken);
    const tarList = await request(app)
      .get("/api/requests?scope=all")
      .set("Authorization", "Bearer " + auditorToken);
    const reimbursementList = await request(app)
      .get("/api/reimbursements/my-requests?scope=all")
      .set("Authorization", "Bearer " + auditorToken);
    const reimbursementDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + auditorToken);
    const budgetHolderDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken);
    const financeDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeToken);
    const lineManagerDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + managerToken);
    const lineManagerMergedPdf = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
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
    expect(reimbursementDetail.body.attachments).toHaveLength(4);
    expect(budgetHolderDetail.body.attachments.map((attachment) => attachment.documentType)).toEqual(["receipt_ticket"]);
    expect(financeDetail.status).toBe(403);
    expect(lineManagerDetail.body.attachments.map((attachment) => attachment.category)).toEqual(
      expect.arrayContaining(["line_manager", "line_manager"])
    );
    expect(lineManagerDetail.body.attachments.map((attachment) => attachment.documentType)).toEqual(
      expect.arrayContaining(["back_to_office", "terms_of_reference"])
    );
    expect(lineManagerDetail.body.attachments).toHaveLength(4);
    expect(lineManagerMergedPdf.status).toBe(403);
    expect(forbiddenApproval.status).toBe(403);
  }, 30000);

  it("allows the assigned Budget Holder to approve or reject when no Supervisor is assigned", async () => {
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
    const managerToken = defaultBudgetHolderToken;

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
    expect(approveResponse.body.status).toBe("SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT");
    expect(approveResponse.body.budgetHolderApprovedAt).toBeTruthy();

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
    const rejectManagerToken = defaultBudgetHolderToken;

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
    expect(rejectResponse.body.status).toBe("BUDGET_HOLDER_DECLINED");
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
    const managerToken = defaultBudgetHolderToken;

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
    const managerToken = defaultBudgetHolderToken;

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
    expect(updateResponse.body.status).toBe("SUBMITTED_TO_BUDGET_HOLDER");
    expect(updateResponse.body.version).toBe(2);
    expect(updateResponse.body.history).toHaveLength(1);
    expect(updateResponse.body.history[0].status).toBe("BUDGET_HOLDER_DECLINED");
    expect(updateResponse.body.history[0].decision.comment).toBe("Missing taxi receipt.");
    expect(updateResponse.body.baseLocation).toBe("Mombasa");
    expect(updateResponse.body.totalAmountKsh).toBe(1500);
    expect(updateResponse.body.lineItems).toHaveLength(1);
    expect(updateResponse.body.selected_approver_id._id).toBe(defaultBudgetHolderUserId.toString());
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

  it("finishes in the approved handoff state when the Budget Holder is also the Line Manager", async () => {
    const manager = await createUser({
      name: "Combined Approver",
      email: "combined-approver@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester",
      email: "combined-approver-requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    await BudgetHolder.findByIdAndUpdate(defaultBudgetHolderId, {
      user: manager._id,
      name: manager.name,
      email: manager.email,
    });
    const requesterToken = await login(requester.email);
    const managerToken = await login(manager.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id, {
        supervisorId: "",
        financeAdminId: "",
      }));
    expect(created.status).toBe(201);
    expect(created.body.selected_approver_id._id).toBe(manager._id.toString());
    expect(created.body.lineManagerId._id).toBe(manager._id.toString());
    expect(created.body.financeAdminId).toBeNull();

    const review = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    expect(review.body.status).toBe("BUDGET_HOLDER_REVIEW");
    const approval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "approved" });
    expect(approval.body.status).toBe("APPROVED_FOR_FINANCE_SUBMISSION");
    expect(approval.body.lineManagerAcknowledgedAt).toBeNull();
    const packageDownload = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(packageDownload.status).toBe(200);
  }, 20000);

  it("requires Supervisor, Budget Holder, and Line Manager acknowledgement before Finance handoff", async () => {
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
    const financeCc = await createUser({
      name: "Copied Finance Admin",
      email: "finance-cc@example.com",
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
    const financeCcToken = await login(financeCc.email);
    const unassignedFinanceToken = await login(
      (await User.findById(defaultFinanceAdminId)).email
    );
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, supervisor._id, {
        financeAdminId: finance._id,
        financeCcAdminId: financeCc._id,
        supervisorId: supervisor._id,
      }));

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
    const earlyFinanceCcAccess = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeCcToken);
    expect(skippedSupervisor.status).toBe(403);
    expect(earlyFinanceAccess.status).toBe(403);
    expect(earlyFinanceCcAccess.status).toBe(403);

    const supervisorReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "review_started" });
    expect(supervisorReview.body.status).toBe("SUPERVISOR_REVIEW");
    const supervisorApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "approved", signature: testRequesterSignature });
    expect(supervisorApproval.body.status).toBe("SUBMITTED_TO_BUDGET_HOLDER");
    expect(supervisorApproval.body.supervisorSignedName).toBe(supervisor.name);
    expect(supervisorApproval.body.supervisorSignature).toBe(testRequesterSignature);

    const budgetHolderReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ status: "review_started" });
    expect(budgetHolderReview.body.status).toBe("BUDGET_HOLDER_REVIEW");
    const budgetHolderApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ status: "approved", signature: testRequesterSignature });
    expect(budgetHolderApproval.body.status).toBe("SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT");
    expect(budgetHolderApproval.body.budgetHolderSignedName).toBe("Budget Holder");
    expect(budgetHolderApproval.body.budgetHolderSignature).toBe(testRequesterSignature);
    const earlyFinanceNotification = await Notification.findOne({
      recipient: finance._id,
      reimbursement: created.body._id,
      type: "reimbursement_submitted",
    });
    expect(earlyFinanceNotification).toBeNull();
    const financeBeforeLineManagerAcknowledgement = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeToken);
    expect(financeBeforeLineManagerAcknowledgement.status).toBe(403);
    const lineManagerAcknowledgement = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "acknowledged", signature: testRequesterSignature });
    expect(lineManagerAcknowledgement.status).toBe(200);
    expect(lineManagerAcknowledgement.body.status).toBe("APPROVED_FOR_FINANCE_SUBMISSION");
    expect(lineManagerAcknowledgement.body.lineManagerAcknowledgedName).toBe(manager.name);
    const financeNotification = await Notification.findOne({
      recipient: finance._id,
      reimbursement: created.body._id,
      type: "reimbursement_submitted",
    });
    expect(financeNotification).toBeNull();
    const requesterApprovalNotification = await Notification.findOne({
      recipient: requester._id,
      reimbursement: created.body._id,
      type: "reimbursement_approved",
    });
    expect(requesterApprovalNotification.message).toMatch(/download the merged reimbursement package/i);

    const financeCcAccess = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + financeCcToken);
    const financeCcApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + financeCcToken)
      .send({ status: "review_started" });
    const earlyFinanceCcNotification = await Notification.findOne({
      recipient: financeCc._id,
      reimbursement: created.body._id,
      type: "reimbursement_cc",
    });
    expect(financeCcAccess.status).toBe(403);
    expect(financeCcApproval.status).toBe(400);
    expect(earlyFinanceCcNotification).toBeNull();

    const unassignedFinanceAccess = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + unassignedFinanceToken);
    const unassignedFinanceApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + unassignedFinanceToken)
      .send({ status: "review_started" });
    expect(unassignedFinanceAccess.status).toBe(403);
    expect(unassignedFinanceApproval.status).toBe(400);


  }, 20000);

  it("requires a distinct Supervisor approval before the TAR Line Manager approval", async () => {
    const manager = await createUser({
      name: "Distinct Line Manager",
      email: "distinct-line-manager@example.com",
      role: "admin",
    });
    const supervisor = await createUser({
      name: "Distinct Supervisor",
      email: "distinct-supervisor@example.com",
      roles: ["supervisor"],
    });
    const requester = await createUser({
      name: "Requester",
      email: "distinct-flow-requester@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const supervisorToken = await login(supervisor.email);
    const managerToken = await login(manager.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, supervisor._id, {
        supervisorId: supervisor._id,
      }));

    expect(created.status).toBe(201);
    expect(created.body.supervisorId._id).toBe(supervisor._id.toString());
    expect(created.body.lineManagerId._id).toBe(manager._id.toString());

    const managerCannotActAsSupervisor = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + managerToken)
      .send({ status: "review_started" });
    expect(managerCannotActAsSupervisor.status).toBe(403);

    const supervisorReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "review_started" });
    const supervisorApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + supervisorToken)
      .send({ status: "approved" });

    expect(supervisorReview.body.status).toBe("SUPERVISOR_REVIEW");
    expect(supervisorApproval.body.status).toBe("SUBMITTED_TO_BUDGET_HOLDER");
    expect(supervisorApproval.body.budgetHolderApprovedBy).toBeNull();

    const budgetHolderReview = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ status: "review_started" });
    const budgetHolderApproval = await request(app)
      .patch(`/api/reimbursements/${created.body._id}/status`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken)
      .send({ status: "approved" });
    expect(budgetHolderReview.body.status).toBe("BUDGET_HOLDER_REVIEW");
    expect(budgetHolderApproval.body.status).toBe("SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT");
    expect(String(budgetHolderApproval.body.budgetHolderApprovedBy)).toBe(
      defaultBudgetHolderUserId.toString()
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
        description: index < 8 ? "Per diem in Dadaab" : "",
        amount: 1000,
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
    expect(accepted.body.lineItems[0].description).toBe("Per diem while in Kisumu");
    expect(accepted.body.lineItems[8].description).toBe("Per diem while in Kisumu");
    expect(getVoucherExpenseDescription(" Dadaab ")).toBe("Per diem while in Dadaab");
    expect(getVoucherExpenseDescription("")).toBe("Per diem");
    expect(buildVoucherDailySummary({
      date: new Date("2026-07-01T00:00:00.000Z"),
      items: [
        { category: "BREAKFAST", description: "Breakfast", amount: 1000, invoiceNumber: "INV-0" },
        { category: "LUNCH", description: "Lunch", amount: 1000, invoiceNumber: "INV-1" },
        { category: "DINNER", description: "Dinner", amount: 1500, invoiceNumber: "INV-2" },
      ],
    }, "Dadaab", {
      fundCode: "FUND1",
      projectId: "PROJECT1",
      activityId: "ACT1",
      departmentId: "DEPT1",
    }, "PS-ACCOUNT-001")).toEqual([
      "01/07/2026",
      "Per diem while in Dadaab",
      "3,500.00",
      "3 invoices",
      "PS-ACCOUNT-001",
      "FUND1",
      "PROJECT1",
      "ACT1",
      "DEPT1",
    ]);
    for (const [categories, expectedTotal] of [
      [["BREAKFAST", "LUNCH"], 2000],
      [["LUNCH", "DINNER"], 2500],
      [["BREAKFAST"], 1000],
    ]) {
      const partialMealItems = categories.map((category, index) => ({
        expenseDate: "2026-07-02T00:00:00.000Z",
        location: "Dadaab",
        category,
        amount: category === "DINNER" ? 1500 : 1000,
        invoiceNumber: `MEAL-${index + 1}`,
      }));
      const dailyBuckets = buildTerDayBuckets(partialMealItems);
      expect(dailyBuckets).toHaveLength(1);
      expect(buildVoucherDailySummary(dailyBuckets[0], "Dadaab", {
        fundCode: "FUND1",
        projectId: "PROJECT1",
        activityId: "ACT1",
        departmentId: "DEPT1",
      }, "PS-ACCOUNT-001")[2]).toBe(expectedTotal.toLocaleString("en-KE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }));
    }
    const voucherPdf = await request(app)
      .get(`/api/reimbursements/${accepted.body._id}/payment-voucher.pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(voucherPdf.status).toBe(200);
    expect(voucherPdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect(await getPdfPageCount(voucherPdf.body)).toBe(2);

    const reimbursementPdf = await request(app)
      .get(`/api/reimbursements/${accepted.body._id}/pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(reimbursementPdf.status).toBe(200);
    expect(await getPdfPageCount(reimbursementPdf.body)).toBe(6);

    const overLimitTravelRequestId = await createApprovedTravelRequest(manager, requester);
    const response = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(overLimitTravelRequestId, manager._id, { lineItems }));
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/30 days/);
  }, 30000);

  it("stores receipts for Finance and keeps Back-to-Office and TOR files separate for Line Managers", async () => {
    const manager = await createUser({
      name: "Manager Admin",
      email: "manager-documents@example.com",
      role: "admin",
    });
    const requester = await createUser({
      name: "Requester Documents",
      email: "requester-documents@example.com",
      managerId: manager._id,
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id, {
        supervisorId: "",
        peopleSoftAccount: "PS-ACCOUNT-001",
        lineItems: [
          {
            expenseDate: "2026-07-06T00:00:00.000Z",
            location: "Kisumu",
            category: "OTHER EXPENSES",
            description: "Other expense",
            amount: 750,
          },
        ],
      }));
    expect(created.body.peopleSoftAccount).toBe("PS-ACCOUNT-001");

    const receiptPdf = await TestPDFDocument.create();
    receiptPdf.addPage([321, 456]);
    const receipt = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "receipt_ticket")
      .attach("file", Buffer.from(await receiptPdf.save()), {
        filename: "receipt.pdf",
        contentType: "application/pdf",
      });
    const backToOffice = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "back_to_office")
      .attach("file", Buffer.from("report"), {
        filename: "back-to-office.pdf",
        contentType: "application/pdf",
      });
    const tor = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "terms_of_reference")
      .attach("file", Buffer.from("terms"), {
        filename: "terms-of-reference.pdf",
        contentType: "application/pdf",
      });
    const expenseSupportPdf = await TestPDFDocument.create();
    expenseSupportPdf.addPage();
    const expenseDocument = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "expense_document")
      .attach("file", Buffer.from(await expenseSupportPdf.save()), {
        filename: "other-expense-support.pdf",
        contentType: "application/pdf",
      });
    const expenseImage = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "expense_document")
      .attach("file", Buffer.from(testRequesterSignature.split(",")[1], "base64"), {
        filename: "other-expense-scan.png",
        contentType: "image/png",
      });
    const additionalFinancialDocument = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "other")
      .field("category", "financial")
      .attach("file", Buffer.from(await expenseSupportPdf.save()), {
        filename: "additional-finance-document.pdf",
        contentType: "application/pdf",
      });

    expect(receipt.status).toBe(201);
    expect(receipt.body).toMatchObject({
      documentType: "receipt_ticket",
      category: "financial",
    });
    expect(backToOffice.status).toBe(201);
    expect(backToOffice.body).toMatchObject({
      documentType: "back_to_office",
      category: "line_manager",
    });
    expect(tor.status).toBe(201);
    expect(tor.body).toMatchObject({
      documentType: "terms_of_reference",
      category: "line_manager",
    });
    expect(expenseDocument.status).toBe(201);
    expect(expenseDocument.body).toMatchObject({
      documentType: "expense_document",
      category: "financial",
    });
    expect(expenseImage.status).toBe(201);
    expect(additionalFinancialDocument.status).toBe(201);

    const mergedPdf = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(mergedPdf.status).toBe(200);
    const mergedPdfDocument = await TestPDFDocument.load(mergedPdf.body);
    expect(mergedPdfDocument.getPageCount()).toBe(7);
    expect(mergedPdfDocument.getPage(3).getSize()).toMatchObject({
      width: 321,
      height: 456,
    });

    const lineManagerToken = await login(manager.email);
    const lineManagerPreview = await request(app)
      .get(`/api/reimbursements/${created.body._id}/attachments/${tor.body.id}?view=true`)
      .set("Authorization", "Bearer " + lineManagerToken);
    expect(lineManagerPreview.status).toBe(200);
    expect(lineManagerPreview.headers["content-disposition"]).toMatch(/^inline;/);

    await ExpenseLineItem.deleteMany({ report: created.body._id });
    const expenseWithoutTerLine = await request(app)
      .post(`/api/reimbursements/${created.body._id}/attachments`)
      .set("Authorization", "Bearer " + requesterToken)
      .field("documentType", "expense_document")
      .attach("file", Buffer.from(await expenseSupportPdf.save()), {
        filename: "unmatched-expense.pdf",
        contentType: "application/pdf",
      });
    expect(expenseWithoutTerLine.status).toBe(400);
    expect(expenseWithoutTerLine.body.message).toMatch(/OTHER EXPENSES/i);
  }, 30000);

  it("includes Line Manager support documents in the merged package when the Budget Holder is also the Line Manager", async () => {
    const manager = await User.findById(defaultBudgetHolderUserId);
    const requester = await createUser({
      name: "Requester with shared approver",
      email: "shared-approver-requester@example.com",
    });
    const travelRequestId = await createApprovedTravelRequest(manager, requester);
    const requesterToken = await login(requester.email);
    const created = await request(app)
      .post("/api/reimbursements")
      .set("Authorization", "Bearer " + requesterToken)
      .send(buildReimbursementPayload(travelRequestId, manager._id, { supervisorId: "" }));
    expect(created.status).toBe(201);

    const beforeUpload = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken);
    const beforeUploadPageCount = await getPdfPageCount(beforeUpload.body);
    const supportPdf = await TestPDFDocument.create();
    supportPdf.addPage();
    const supportFile = Buffer.from(await supportPdf.save());

    for (const [documentType, filename] of [
      ["back_to_office", "back-to-office.pdf"],
      ["terms_of_reference", "terms-of-reference.pdf"],
    ]) {
      const upload = await request(app)
        .post(`/api/reimbursements/${created.body._id}/attachments`)
        .set("Authorization", "Bearer " + requesterToken)
        .field("documentType", documentType)
        .attach("file", supportFile, { filename, contentType: "application/pdf" });
      expect(upload.status).toBe(201);
    }

    const budgetHolderDetail = await request(app)
      .get(`/api/reimbursements/${created.body._id}`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken);
    expect(budgetHolderDetail.body.attachments.map((attachment) => attachment.documentType)).toEqual([
      "back_to_office",
      "terms_of_reference",
    ]);

    const mergedPdf = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", "Bearer " + defaultBudgetHolderToken);
    const requesterMergedPdf = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(mergedPdf.status).toBe(200);
    expect(await getPdfPageCount(mergedPdf.body)).toBe(beforeUploadPageCount + 2);
    expect(await getPdfPageCount(requesterMergedPdf.body)).toBe(beforeUploadPageCount + 2);
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
      .send(buildReimbursementPayload(travelRequestId, manager._id, { supervisorId: "" }));

    const pdfResponse = await request(app)
      .get(`/api/reimbursements/${created.body._id}/pdf`)
      .set("Authorization", `Bearer ${requesterToken}`);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toMatch(/application\/pdf/);

    const voucherResponse = await request(app)
      .get(`/api/reimbursements/${created.body._id}/payment-voucher.pdf`)
      .set("Authorization", "Bearer " + requesterToken);
    expect(voucherResponse.status).toBe(200);
    expect(voucherResponse.headers["content-type"]).toMatch(/application\/pdf/);
    expect(voucherResponse.headers["content-disposition"]).toMatch(/payment-voucher-/);
    expect((voucherResponse.body.toString("latin1").match(/\/Type\s*\/Page\b/g) || []))
      .toHaveLength(1);

    const templateResponse = await request(app)
      .get("/api/reimbursements/template/ter.pdf")
      .set("Authorization", "Bearer " + requesterToken);
    expect(templateResponse.status).toBe(200);
    expect(templateResponse.headers["content-type"]).toMatch(/application\/pdf/);
    expect(templateResponse.body.subarray(0, 4).toString()).toBe("%PDF");
  }, 30000);
});
