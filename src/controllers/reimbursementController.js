const User = require("../models/User");
const TravelRequest = require("../models/TravelRequest");
const ReimbursementReport = require("../models/ReimbursementReport");
const ExpenseLineItem = require("../models/ExpenseLineItem");
const HttpError = require("../utils/httpError");
const { getEligibleSupervisorById } = require("../services/approverService");
const { EXPENSE_CATEGORIES } = require("../constants/expenseCategories");
const {
  storeAttachment,
  streamAttachment,
  getAttachmentBuffer,
  deleteAttachment,
} = require("../services/attachmentStorageService");
const { createAuditLog } = require("../services/auditLogService");
const { notifyReimbursementUser } = require("../services/notificationService");
const {
  buildReimbursementPdf,
  buildPaymentVoucherPdf,
  buildEmptyTravelExpenseReportPdf,
  getVoucherExpenseDescription,
} = require("../services/pdfService");
const {
  getTravelRequestPopulateQuery,
  getTravelRequestPdfPopulateQuery,
} = require("../services/travelRequestService");
const {
  ensureUserCanClaimReimbursement,
  ensureApproverNotOnRequest,
} = require("../services/passengerService");
const REIMBURSEMENT_ATTACHMENT_AUDIENCES = {
  receipt_ticket: "financial",
  expense_document: "financial",
  back_to_office: "line_manager",
  terms_of_reference: "line_manager",
};
const {
  buildReimbursementTeamScope,
  ensureCanAccessReport,
  ensureReportOwner,
  canViewMergedReimbursementPackage,
} = require("../services/reimbursementAccessService");
const {
  buildReimbursementFilters,
  mergeReimbursementScope,
} = require("../services/reimbursementFilterService");
const {
  getReimbursementPopulateQuery,
  populateReport,
  buildReimbursementResponse,
  buildReimbursementDraftData,
  normalizeLineItems,
  recalculateReportTotal,
  attachLineItems,
  replaceReportLineItems,
  getEditableReimbursementSnapshot,
  applyReimbursementResubmission,
} = require("../services/reimbursementService");

const APPROVAL_STAGES = {
  SUBMITTED_TO_SUPERVISOR: {
    review: "SUPERVISOR_REVIEW",
    level: "SUPERVISOR",
    assignedField: "supervisorId",
    approverRole: "supervisor",
    approved: "SUBMITTED_TO_LINE_MANAGER",
    declined: "SUPERVISOR_DECLINED",
  },
  SUPERVISOR_REVIEW: {
    review: "SUPERVISOR_REVIEW",
    level: "SUPERVISOR",
    assignedField: "supervisorId",
    approverRole: "supervisor",
    approved: "SUBMITTED_TO_BUDGET_HOLDER",
    declined: "SUPERVISOR_DECLINED",
  },
  SUBMITTED_TO_BUDGET_HOLDER: {
    review: "BUDGET_HOLDER_REVIEW",
    level: "BUDGET_HOLDER",
    assignedField: "selected_approver_id",
    approverRole: "approver_budget_holder",
    approved: "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT",
    declined: "BUDGET_HOLDER_DECLINED",
  },
  BUDGET_HOLDER_REVIEW: {
    review: "BUDGET_HOLDER_REVIEW",
    level: "BUDGET_HOLDER",
    assignedField: "selected_approver_id",
    approverRole: "approver_budget_holder",
    approved: "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT",
    declined: "BUDGET_HOLDER_DECLINED",
  },
  SUBMITTED_TO_LINE_MANAGER: {
    review: "LINE_MANAGER_REVIEW",
    level: "LINE_MANAGER",
    assignedField: "lineManagerId",
    approverRole: "line_manager",
    approved: "SUBMITTED_TO_FINANCE",
    declined: "LINE_MANAGER_DECLINED",
  },
  LINE_MANAGER_REVIEW: {
    review: "LINE_MANAGER_REVIEW",
    level: "LINE_MANAGER",
    assignedField: "lineManagerId",
    approverRole: "line_manager",
    approved: "SUBMITTED_TO_FINANCE",
    declined: "LINE_MANAGER_DECLINED",
  },
  SUBMITTED_TO_FINANCE: {
    review: "FINANCE_REVIEW",
    level: "FINANCE_ADMIN",
    assignedField: "financeAdminId",
    approverRole: "finance_admin",
    approved: "PAYMENT_PROCESSING",
    declined: "FINANCE_DECLINED",
  },
  FINANCE_REVIEW: {
    review: "FINANCE_REVIEW",
    level: "FINANCE_ADMIN",
    assignedField: "financeAdminId",
    approverRole: "finance_admin",
    approved: "PAYMENT_PROCESSING",
    declined: "FINANCE_DECLINED",
  },
};

const STANDARD_EXPENSE_RATES = {
  BREAKFAST: 1000,
  LUNCH: 1000,
  DINNER: 1500,
};

function userHasRole(user, role) {
  return user.role === role || (user.roles || []).includes(role);
}

function hasLineManagerRole(user) {
  return ["admin", "approver_budget_holder"].includes(user.role);
}

function addApprovalHistory(
  report,
  req,
  { level, action, reason = null, comments = null, resultingStatus = null }
) {
  report.approvalHistory.push({
    approvalLevel: level,
    action,
    performedBy: req.user.id,
    performedByRole: (req.currentUser?.roles || []).includes(level.toLowerCase())
      ? level
      : req.currentUser?.role || req.user.role,
    resultingStatus,
    occurredAt: new Date(),
    comments: comments || null,
    reason: reason || null,
    ipAddress: req.ip || null,
  });
}

function assertMaximumExpenseDays(lineItems) {
  const days = new Set(lineItems.map((item) => new Date(item.expenseDate).toISOString().slice(0, 10)));
  if (days.size > 30) {
    throw new HttpError(400, "A reimbursement can include expenses for no more than 30 days");
  }
}

function normalizePeopleSoftAccount(value) {
  const account = String(value || "").trim();
  if (account.length > 80) {
    throw new HttpError(400, "PeopleSoft Account must be 80 characters or fewer");
  }
  return account;
}

function assertStandardExpenseRates(lineItems) {
  for (const item of lineItems) {
    const requiredAmount = STANDARD_EXPENSE_RATES[item.category];
    if (requiredAmount && Number(item.amount).toFixed(2) !== requiredAmount.toFixed(2)) {
      throw new HttpError(400, `${item.category} must be reimbursed at KSH ${requiredAmount}`);
    }
  }
}

async function resolveOptionalSupervisor(supervisorId, submitter, budgetHolder, passengers, lineManager) {
  if (!supervisorId) return null;

  const supervisor = await getEligibleSupervisorById(supervisorId, {
    excludeUserIds: [submitter._id],
  });
  if ([budgetHolder._id, lineManager?._id].some((id) => id && String(supervisor._id) === String(id))) {
    throw new HttpError(400, "The Supervisor must be different from the approved TAR Line Manager");
  }
  ensureApproverNotOnRequest(supervisor._id, submitter._id, passengers);
  return supervisor;
}

async function resolveTravelApprovers(travelRequest, submitter, passengers) {
  const lineManagerId =
    travelRequest.selected_approver_id?._id || travelRequest.selected_approver_id;
  const lineManager = await User.findOne({
    _id: lineManagerId,
    role: { $in: ["admin", "approver_budget_holder"] },
    isActive: true,
  });
  if (!lineManager) {
    throw new HttpError(400, "The approved TAR does not have an active Line Manager assigned");
  }

  const selectedBudgetHolder = travelRequest.selected_budget_holder_id;
  const budgetHolderUserId = selectedBudgetHolder?.user?._id || selectedBudgetHolder?.user;
  let budgetHolder = budgetHolderUserId
    ? await User.findOne({
        _id: budgetHolderUserId,
        role: { $in: ["admin", "approver_budget_holder"] },
        isActive: true,
      })
    : null;
  if (budgetHolderUserId && !budgetHolder) {
    throw new HttpError(400, "The approved TAR Budget Holder must be an active authorized user");
  }
  if (!budgetHolder) budgetHolder = lineManager;

  ensureApproverNotOnRequest(budgetHolder._id, submitter._id, passengers);
  return { budgetHolder, lineManager };
}

async function resolveOptionalFinanceCcAdmin(financeCcAdminId, financeAdmin) {
  if (!financeCcAdminId) return null;

  const financeAdminId = financeAdmin?._id || financeAdmin;
  if (String(financeCcAdminId) === String(financeAdminId)) {
    throw new HttpError(400, "The Finance Admin to copy must differ from the assigned Finance approver");
  }

  const financeCcAdmin = await User.findOne({
    _id: financeCcAdminId,
    $or: [{ roles: "finance_admin" }, { role: "finance_admin" }],
    isActive: true,
  });
  if (!financeCcAdmin) {
    throw new HttpError(400, "Select an active Finance Admin to copy");
  }
  return financeCcAdmin;
}

function resolveRequesterSignature(signatureValue, user) {
  const signature = String(signatureValue || "").trim();
  if (!signature) throw new HttpError(400, "Requester signature is required");

  const isPngSignature = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature);
  if (!isPngSignature && signature.toLowerCase() !== user.name.trim().toLowerCase()) {
    throw new HttpError(400, "Type your account name or provide a drawn signature");
  }

  return { signature, signedName: user.name };
}

function visibleAttachments(report, user) {
  if (["superadmin", "super_superadmin"].includes(user.role)) return report.attachments || [];
  if (user.roles?.includes("auditor")) return report.attachments || [];
  const reportOwnerId = String(report.submittedBy?._id || report.submittedBy || "");
  if (reportOwnerId === user.id) return report.attachments || [];
  const lineManagerId = String(report.lineManagerId?._id || report.lineManagerId || "");
  const budgetHolderId = String(report.selected_approver_id?._id || report.selected_approver_id || "");
  if (lineManagerId === user.id) {
    return report.attachments || [];
  }
  if (budgetHolderId === user.id) {
    return (report.attachments || []).filter((attachment) => attachment.category === "financial");
  }
  if (userHasRole(user, "finance_admin")) {
    return (report.attachments || []).filter((attachment) => attachment.category === "financial");
  }
  if (user.role === "admin") {
    return [];
  }
  if (user.role === "approver_budget_holder") {
    return [];
  }
  if (String(report.supervisorId?._id || report.supervisorId || "") === user.id) {
    return (report.attachments || []).filter((attachment) => attachment.category !== "line_manager");
  }
  return [];
}

async function attachLineItemsForUser(reports, user) {
  const data = await attachLineItems(reports);
  data.forEach((report) => {
    report.attachments = visibleAttachments(report, user);
  });
  return data;
}

async function stageRecipients(stage, report) {
  const assignedValue = report[stage.assignedField];
  const recipientId = assignedValue?._id || assignedValue;
  if (stage.level === "FINANCE_ADMIN" && !recipientId) {
    return User.find({
      $or: [{ roles: "finance_admin" }, { role: "finance_admin" }],
      isActive: true,
    }).select("-passwordHash");
  }
  const recipient = recipientId
    ? await User.findOne({ _id: recipientId, isActive: true }).select("-passwordHash")
    : null;
  return recipient ? [recipient] : [];
}

async function createReimbursement(req, res) {
  const submitter = await User.findById(req.user.id);

  if (!submitter || !submitter.isActive) {
    throw new HttpError(404, "User not found");
  }

  const travelRequest = await getTravelRequestPopulateQuery(
    TravelRequest.findById(req.body.travelRequestId)
  );

  if (!travelRequest) {
    throw new HttpError(404, "Travel request not found");
  }

  if (travelRequest.status !== "approved") {
    throw new HttpError(400, "Reimbursement requires an approved travel request");
  }

  ensureUserCanClaimReimbursement(travelRequest, submitter._id);

  const { budgetHolder, lineManager } = await resolveTravelApprovers(
    travelRequest,
    submitter,
    travelRequest.passengers
  );
  const supervisor = await resolveOptionalSupervisor(
  req.body.supervisorId,
  submitter,
  budgetHolder,
  travelRequest.passengers,
  lineManager
  );

  const { signature: requesterSignature, signedName: requesterSignedName } =
    resolveRequesterSignature(req.body.requesterSignature, submitter);
  const peopleSoftAccount = normalizePeopleSoftAccount(req.body.peopleSoftAccount);

  assertMaximumExpenseDays(req.body.lineItems);
  assertStandardExpenseRates(req.body.lineItems);
  const lineItems = normalizeLineItems(req.body.lineItems).map((item) => ({
    ...item,
    description: getVoucherExpenseDescription(travelRequest.itinerary?.destination),
  }));
  let report;

  try {
    report = await ReimbursementReport.create(
      buildReimbursementDraftData(
        {
          ...req.body,
          travelRequestId: travelRequest._id,
          financeAdminId: null,
          financeCcAdminId: null,
          requesterSignedName,
          requesterSignature,
          peopleSoftAccount,
        },
        submitter._id,
        supervisor?._id || null,
        budgetHolder._id,
        lineManager._id,
        submitter
      )
    );

    await replaceReportLineItems(report._id, lineItems);

    await recalculateReportTotal(report._id);
  } catch (error) {
    if (report?._id) {
      await ExpenseLineItem.deleteMany({ report: report._id });
      await ReimbursementReport.findByIdAndDelete(report._id);
    }

    if (error.code === 11000) {
      throw new HttpError(
        409,
        "A reimbursement report already exists for this passenger on this travel request"
      );
    }

    throw error;
  }

  await createAuditLog({
    action: "reimbursement_created",
    performedBy: submitter._id,
    targetReimbursement: report._id,
    metadata: { travelRequest: travelRequest._id, status: report.status },
  });

  const response = await buildReimbursementResponse(report._id);
  await notifyReimbursementUser(supervisor || budgetHolder, "reimbursement_submitted", response);

  return res.status(201).json(response);
}

async function previewReimbursement(req, res) {
  const submitter = req.currentUser;
  const travelRequest = await getTravelRequestPdfPopulateQuery(
    TravelRequest.findById(req.body.travelRequestId)
  );

  if (!travelRequest || travelRequest.status !== "approved") {
    throw new HttpError(400, "Preview requires a selected approved TAR");
  }
  ensureUserCanClaimReimbursement(travelRequest, submitter._id);

  const { budgetHolder, lineManager } = await resolveTravelApprovers(
    travelRequest,
    submitter,
    travelRequest.passengers
  );
  const supervisor = await resolveOptionalSupervisor(
      req.body.supervisorId,
      submitter,
      budgetHolder,
      travelRequest.passengers,
      lineManager
    );

  const { signature: requesterSignature, signedName: requesterSignedName } =
    resolveRequesterSignature(req.body.requesterSignature, submitter);
  const peopleSoftAccount = normalizePeopleSoftAccount(req.body.peopleSoftAccount);
  assertMaximumExpenseDays(req.body.lineItems);
  assertStandardExpenseRates(req.body.lineItems);

  const lineItems = normalizeLineItems(req.body.lineItems).map((item) => ({
    ...item,
    description: getVoucherExpenseDescription(travelRequest.itinerary?.destination),
  }));
  const totalAmountKsh = lineItems.reduce(
    (total, item) => total + Number(item.amount.toString()),
    0
  );
  const previewAttachments = req.body.previewAttachments || [];
  const uploadedPreviewFiles = req.files || [];
  if (previewAttachments.length !== uploadedPreviewFiles.length) {
    throw new HttpError(400, "Preview attachment details did not match the selected files");
  }
  const budgetHolderIsLineManager =
    String(budgetHolder._id) === String(lineManager._id);
  const expenseDocuments = uploadedPreviewFiles.flatMap((file, index) => {
    const metadata = previewAttachments[index];
    if (
      !metadata ||
      !["receipt_ticket", "expense_document", "back_to_office", "terms_of_reference", "other"].includes(metadata.documentType) ||
      !["financial", "line_manager", "supervisor"].includes(metadata.category)
    ) {
      throw new HttpError(400, "A selected preview document has invalid routing details");
    }
    const belongsInMergedPackage =
      metadata.category === "financial" ||
      (budgetHolderIsLineManager && metadata.category === "line_manager");
    if (!belongsInMergedPackage) return [];
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) {
      throw new HttpError(400, "Only PDF, JPEG, and PNG uploads can be included in the merged preview");
    }
    return [{
      buffer: file.buffer,
      mimeType: file.mimetype,
      documentType: metadata.documentType,
    }];
  }).sort((left, right) => {
    const priority = (attachment) => {
      if (attachment.documentType === "receipt_ticket") return 0;
      if (attachment.documentType === "expense_document") return 1;
      return 2;
    };
    return priority(left) - priority(right);
  });
  await buildReimbursementPdf(res, {
    _id: "preview",
    travelRequest,
    submittedBy: submitter,
    selected_approver_id: budgetHolder,
    supervisorId: supervisor,
    lineManagerId: lineManager,
    financeAdminId: null,
    financeCcAdminId: null,
    requesterSignedName,
    requesterSignedAt: new Date(),
    requesterSignature,
    employeeNumber: req.body.employeeNumber || submitter.employeeNumber || "N/A",
    department: req.body.department || submitter.department || "N/A",
    position: req.body.position || submitter.position || "N/A",
    baseLocation: req.body.baseLocation,
    paymentRequestPurpose: req.body.paymentRequestPurpose,
    peopleSoftAccount,
    peopleSoftFundCode: String(req.body.peopleSoftFundCode || "").trim(),
    peopleSoftProjectId: String(req.body.peopleSoftProjectId || "").trim(),
    peopleSoftActivityId: String(req.body.peopleSoftActivityId || "").trim(),
    peopleSoftDepartmentId: String(req.body.peopleSoftDepartmentId || "").trim(),
    paymentDetails: req.body.paymentDetails,
    lineItems,
    totalAmountKsh,
    submittedAt: new Date(),
    status: "DRAFT",
  }, expenseDocuments);
}

async function getMyReimbursements(req, res) {
  const canViewAll =
    ["superadmin", "super_superadmin"].includes(req.user.role) ||
    req.user.roles?.includes("auditor");
  const scope =
    canViewAll && String(req.query.scope || "").toLowerCase() === "all"
      ? {}
      : { submittedBy: req.user.id };
  const queryFilters = await buildReimbursementFilters(req.query, req.user);
  const filter = mergeReimbursementScope(scope, queryFilters);

  if (filter._id === null) {
    return res.json([]);
  }

  const reports = await getReimbursementPopulateQuery(
    ReimbursementReport.find(filter).sort({ createdAt: -1 })
  );

  const data = await attachLineItemsForUser(reports, req.user);
  return res.json(data);
}

async function getPendingApprovals(req, res) {
  const stages = [];
  if (userHasRole(req.user, "supervisor")) {
    stages.push({
      supervisorId: req.user.id,
      status: { $in: ["SUBMITTED_TO_SUPERVISOR", "SUPERVISOR_REVIEW"] },
    });
  }
  if (userHasRole(req.user, "finance_admin")) {
    stages.push({
      $or: [
        { financeAdminId: req.user.id },
        { financeAdminId: null },
      ],
      status: { $in: ["SUBMITTED_TO_FINANCE", "FINANCE_REVIEW"] },
    });
  }
  if (hasLineManagerRole(req.user)) {
    stages.push({
      selected_approver_id: req.user.id,
      status: { $in: ["SUBMITTED_TO_BUDGET_HOLDER", "BUDGET_HOLDER_REVIEW"] },
    });
    stages.push({
      lineManagerId: req.user.id,
      status: {
        $in: [
          "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT",
          "SUBMITTED_TO_LINE_MANAGER",
          "LINE_MANAGER_REVIEW",
        ],
      },
    });
  }
  if (!stages.length) {
    throw new HttpError(403, "You do not have access to reimbursement approvals");
  }
  const reports = await getReimbursementPopulateQuery(
    ReimbursementReport.find({ $or: stages }).sort({ submittedAt: -1 })
  );

  const data = await attachLineItemsForUser(reports, req.user);
  return res.json(data);
}

async function getTeamReimbursements(req, res) {
  const scope = await buildReimbursementTeamScope(req.user);
  const queryFilters = await buildReimbursementFilters(req.query, req.user);
  const filter = mergeReimbursementScope(scope, queryFilters);

  if (filter._id === null) {
    return res.json([]);
  }

  const reports = await getReimbursementPopulateQuery(
    ReimbursementReport.find(filter).sort({ createdAt: -1 })
  );

  const data = await attachLineItemsForUser(reports, req.user);
  return res.json(data);
}

async function getReimbursementById(req, res) {
  const report = await populateReport(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  await ensureCanAccessReport(req.user, report);
  const [response] = await attachLineItems([report]);
  response.attachments = visibleAttachments(response, req.user);
  return res.json(response);
}

async function updateReimbursement(req, res) {
  const report = await ReimbursementReport.findById(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  ensureReportOwner(req.user, report);

  if (!["pending", "DRAFT", "rejected", "SUPERVISOR_DECLINED", "BUDGET_HOLDER_DECLINED", "LINE_MANAGER_DECLINED", "FINANCE_DECLINED"].includes(report.status)) {
    throw new HttpError(400, "Only declined reimbursement reports can be edited and resubmitted");
  }

  const travelRequest = await getTravelRequestPopulateQuery(
    TravelRequest.findById(req.body.travelRequestId)
  );
  if (!travelRequest || travelRequest.status !== "approved") {
    throw new HttpError(409, "Select an approved TAR before resubmission");
  }
  ensureUserCanClaimReimbursement(travelRequest, req.currentUser._id);
  if (
    String(travelRequest._id) !== String(report.travelRequest) &&
    await ReimbursementReport.exists({
      travelRequest: travelRequest._id,
      submittedBy: req.currentUser._id,
      _id: { $ne: report._id },
    })
  ) {
    throw new HttpError(409, "A reimbursement already exists for you on the selected TAR");
  }
  const { budgetHolder, lineManager } = await resolveTravelApprovers(
    travelRequest,
    req.currentUser,
    travelRequest.passengers
  );
  const supervisor = await resolveOptionalSupervisor(
    req.body.supervisorId,
    req.currentUser,
    budgetHolder,
    travelRequest.passengers,
    lineManager
  );
  const { signature: requesterSignature, signedName: requesterSignedName } =
    resolveRequesterSignature(req.body.requesterSignature, req.currentUser);
  const peopleSoftAccount = normalizePeopleSoftAccount(req.body.peopleSoftAccount);
  assertMaximumExpenseDays(req.body.lineItems);
  assertStandardExpenseRates(req.body.lineItems);
  const lineItems = normalizeLineItems(req.body.lineItems).map((item) => ({
    ...item,
    description: getVoucherExpenseDescription(travelRequest.itinerary?.destination),
  }));
  const existingLineItems = await ExpenseLineItem.find({ report: report._id }).sort({
    expenseDate: 1,
  });

  report.history.push({
    snapshot: getEditableReimbursementSnapshot(report, existingLineItems),
    status: report.status,
    decision: report.decision,
    editedAt: new Date(),
  });

  applyReimbursementResubmission(report, req.body, supervisor?._id || null);
  report.lineManagerId = lineManager._id;
  report.selected_approver_id = budgetHolder._id;
  report.travelRequest = travelRequest._id;
  report.financeAdminId = null;
  report.financeCcAdminId = null;
  report.requesterSignedName = requesterSignedName;
  report.requesterSignedAt = new Date();
  report.requesterSignature = requesterSignature;
  report.paymentRequestPurpose = req.body.paymentRequestPurpose;
  report.peopleSoftAccount = peopleSoftAccount;
  report.peopleSoftFundCode = String(req.body.peopleSoftFundCode || "").trim();
  report.peopleSoftProjectId = String(req.body.peopleSoftProjectId || "").trim();
  report.peopleSoftActivityId = String(req.body.peopleSoftActivityId || "").trim();
  report.peopleSoftDepartmentId = String(req.body.peopleSoftDepartmentId || "").trim();
  report.paymentDetails = req.body.paymentDetails || {};
  report.supervisorSignedName = null;
  report.supervisorSignature = null;
  report.lineManagerSignedName = null;
  report.lineManagerSignature = null;
  report.budgetHolderSignedName = null;
  report.budgetHolderSignature = null;
  report.budgetHolderApprovedBy = null;
  report.budgetHolderApprovedAt = null;
  report.budgetHolderDeclinedBy = null;
  report.budgetHolderDeclinedAt = null;
  report.budgetHolderDeclineReason = null;
  report.lineManagerAcknowledgedBy = null;
  report.lineManagerAcknowledgedAt = null;
  report.lineManagerAcknowledgedName = null;
  report.lineManagerAcknowledgementSignature = null;
  report.financeCcAcknowledgedBy = null;
  report.financeCcAcknowledgedAt = null;
  report.financeCcAcknowledgedName = null;
  report.financeCcAcknowledgementSignature = null;
  report.financeSignedName = null;
  report.financeSignature = null;
  for (const field of [
    "supervisorApprovedBy",
    "supervisorApprovedAt",
    "supervisorDeclinedBy",
    "supervisorDeclinedAt",
    "supervisorDeclineReason",
    "lineManagerApprovedBy",
    "lineManagerApprovedAt",
    "lineManagerDeclinedBy",
    "lineManagerDeclinedAt",
    "lineManagerDeclineReason",
    "financeApprovedBy",
    "financeApprovedAt",
    "financeDeclinedBy",
    "financeDeclinedAt",
    "financeDeclineReason",
  ]) {
    report[field] = null;
  }
  report.status = supervisor ? "SUBMITTED_TO_SUPERVISOR" : "SUBMITTED_TO_BUDGET_HOLDER";
  report.approvalHistory.push({
    approvalLevel: "SYSTEM",
    action: supervisor ? "RESUBMITTED_TO_SUPERVISOR" : "RESUBMITTED_TO_BUDGET_HOLDER",
    performedBy: req.user.id,
    performedByRole: req.currentUser?.role || req.user.role,
    occurredAt: new Date(),
    ipAddress: req.ip || null,
  });

  await report.save();

  await replaceReportLineItems(report._id, lineItems);
  await recalculateReportTotal(report._id);

  await createAuditLog({
    action: "reimbursement_resubmitted",
    performedBy: req.user.id,
    targetReimbursement: report._id,
    metadata: { version: report.version },
  });

  const response = await buildReimbursementResponse(report._id);
  await notifyReimbursementUser(supervisor || budgetHolder, "reimbursement_resubmitted", response);

  return res.json(response);
}

async function updateReimbursementStatus(req, res) {
  const { status, comment } = req.body;

  const report = await ReimbursementReport.findById(req.params.id).populate(
    "submittedBy",
    "-passwordHash"
  );

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  if (status === "acknowledged") {
    const signature = String(req.body.signature || "").trim();
    if (!signature) throw new HttpError(400, "A signature is required to acknowledge this reimbursement");
    const userId = String(req.user.id);
    const isLineManagerCopy =
      String(report.lineManagerId || "") === userId &&
      String(report.selected_approver_id || "") !== userId &&
      hasLineManagerRole(req.user) &&
      report.status === "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT";
    const isFinanceCopy =
      String(report.financeCcAdminId || "") === userId &&
      userHasRole(req.user, "finance_admin") &&
      ["PAYMENT_PROCESSING", "COMPLETED"].includes(report.status);
    if (!isLineManagerCopy && !isFinanceCopy) {
      throw new HttpError(403, "You are not an assigned copied recipient for this reimbursement");
    }
    const acknowledgementPrefix = isLineManagerCopy ? "lineManager" : "financeCc";
    if (report[`${acknowledgementPrefix}AcknowledgedAt`]) {
      throw new HttpError(409, "You have already acknowledged this reimbursement");
    }
    report[`${acknowledgementPrefix}AcknowledgedBy`] = req.user.id;
    report[`${acknowledgementPrefix}AcknowledgedAt`] = new Date();
    report[`${acknowledgementPrefix}AcknowledgedName`] =
      req.currentUser?.name || req.user.name;
    report[`${acknowledgementPrefix}AcknowledgementSignature`] = signature;
    if (isLineManagerCopy) {
      report.status = "APPROVED_FOR_FINANCE_SUBMISSION";
      addApprovalHistory(report, req, {
        level: "SYSTEM",
        action: "APPROVED_FOR_FINANCE_SUBMISSION",
        resultingStatus: "APPROVED_FOR_FINANCE_SUBMISSION",
      });
    }
    addApprovalHistory(report, req, {
      level: isLineManagerCopy ? "LINE_MANAGER" : "FINANCE_ADMIN",
      action: "ACKNOWLEDGED",
      comments: comment || null,
      resultingStatus: report.status,
    });
    await report.save();
    await createAuditLog({
      action: "reimbursement_acknowledged",
      performedBy: req.user.id,
      targetReimbursement: report._id,
      metadata: { copiedRole: isLineManagerCopy ? "line_manager" : "finance_admin" },
    });
    const response = await buildReimbursementResponse(report._id);
    response.attachments = visibleAttachments(response, req.user);
    if (isLineManagerCopy) {
      await notifyReimbursementUser(response.submittedBy, "reimbursement_approved", response);
    }
    return res.json(response);
  }

  if (status === "completed") {
    if (
      !userHasRole(req.user, "finance_admin") ||
      (report.financeAdminId && String(report.financeAdminId) !== req.user.id) ||
      report.status !== "PAYMENT_PROCESSING"
    ) {
      throw new HttpError(403, "Only Finance Admin can complete payment processing");
    }
    report.status = "COMPLETED";
    addApprovalHistory(report, req, {
      level: "SYSTEM",
      action: "COMPLETED",
      resultingStatus: "COMPLETED",
    });
  } else {
    const stage = APPROVAL_STAGES[report.status];
    if (!stage) throw new HttpError(400, "This reimbursement is not awaiting an approval decision");

    const isAssignedApprover = stage.assignedField
      ? String(report[stage.assignedField] || "") === req.user.id ||
        (stage.level === "FINANCE_ADMIN" && !report[stage.assignedField] &&
          userHasRole(req.user, stage.approverRole))
      : userHasRole(req.user, stage.approverRole);
    const hasRequiredRole =
      ["line_manager", "approver_budget_holder"].includes(stage.approverRole)
        ? hasLineManagerRole(req.user)
        : userHasRole(req.user, stage.approverRole);
    if (!isAssignedApprover || !hasRequiredRole) {
      throw new HttpError(403, "You are not authorized to approve this reimbursement at this stage");
    }

    if (status === "review_started") {
      if (report.status === stage.review) {
        throw new HttpError(409, "This reimbursement is already under review");
      }
      addApprovalHistory(report, req, {
        level: stage.level,
        action: "REVIEW_STARTED",
        resultingStatus: stage.review,
      });
      report.status = stage.review;
    } else {
      if (report.status !== stage.review) {
        throw new HttpError(409, "Start the review before approving or declining this reimbursement");
      }
      const approvalAction = status === "approved" ? "APPROVED" : "DECLINED";
      addApprovalHistory(report, req, {
        level: stage.level,
        action: approvalAction,
        reason: status === "rejected" ? comment : null,
        comments: status === "approved" ? comment : null,
        resultingStatus: status === "approved"
          ? `${stage.level === "FINANCE_ADMIN" ? "FINANCE" : stage.level}_APPROVED`
          : stage.declined,
      });

      if (status === "approved") {
        report.status = stage.approved;
        if (stage.level === "SUPERVISOR") {
          report.supervisorSignedName = req.currentUser?.name || req.user.name;
          report.supervisorSignature = req.body.signature || report.supervisorSignedName;
          report.supervisorApprovedBy = req.user.id;
          report.supervisorApprovedAt = new Date();
        }
        if (stage.level === "LINE_MANAGER") {
          report.lineManagerSignedName = req.currentUser?.name || req.user.name;
          report.lineManagerSignature = req.body.signature || report.lineManagerSignedName;
          report.lineManagerApprovedBy = req.user.id;
          report.lineManagerApprovedAt = new Date();
        }
        if (stage.level === "BUDGET_HOLDER") {
          report.budgetHolderSignedName = req.currentUser?.name || req.user.name;
          report.budgetHolderSignature = req.body.signature || report.budgetHolderSignedName;
          report.budgetHolderApprovedBy = req.user.id;
          report.budgetHolderApprovedAt = new Date();
          const budgetHolderId = String(report.selected_approver_id || "");
          const lineManagerId = String(report.lineManagerId || "");
          if (!lineManagerId || lineManagerId === budgetHolderId) {
            report.status = "APPROVED_FOR_FINANCE_SUBMISSION";
            addApprovalHistory(report, req, {
              level: "SYSTEM",
              action: "APPROVED_FOR_FINANCE_SUBMISSION",
              resultingStatus: "APPROVED_FOR_FINANCE_SUBMISSION",
            });
          }
        }
        if (stage.level === "FINANCE_ADMIN") {
          report.financeSignedName = req.currentUser?.name || req.user.name;
          report.financeSignature = req.body.signature || report.financeSignedName;
          report.financeApprovedBy = req.user.id;
          report.financeApprovedAt = new Date();
        }
        if (stage.level === "FINANCE_ADMIN") {
          addApprovalHistory(report, req, {
            level: "SYSTEM",
            action: "PAYMENT_PROCESSING",
            resultingStatus: "PAYMENT_PROCESSING",
          });
        } else if (report.status === stage.approved) {
          addApprovalHistory(report, req, {
            level: "SYSTEM",
            action: stage.approved,
            resultingStatus: stage.approved,
          });
        }
      } else {
        report.status = stage.declined;
        if (stage.level === "SUPERVISOR") {
          report.supervisorDeclinedBy = req.user.id;
          report.supervisorDeclinedAt = new Date();
          report.supervisorDeclineReason = comment.trim();
        } else if (stage.level === "LINE_MANAGER") {
          report.lineManagerDeclinedBy = req.user.id;
          report.lineManagerDeclinedAt = new Date();
          report.lineManagerDeclineReason = comment.trim();
        } else if (stage.level === "BUDGET_HOLDER") {
          report.budgetHolderDeclinedBy = req.user.id;
          report.budgetHolderDeclinedAt = new Date();
          report.budgetHolderDeclineReason = comment.trim();
        } else {
          report.financeDeclinedBy = req.user.id;
          report.financeDeclinedAt = new Date();
          report.financeDeclineReason = comment.trim();
        }
      }

      report.decision = {
        decidedBy: req.user.id,
        decidedAt: new Date(),
        comment: comment?.trim() || null,
      };
    }
  }

  await report.save();

  await createAuditLog({
    action: status === "approved"
      ? "reimbursement_approved"
      : status === "rejected"
        ? "reimbursement_rejected"
        : status === "completed"
          ? "reimbursement_completed"
          : "reimbursement_review_started",
    performedBy: req.user.id,
    targetReimbursement: report._id,
    metadata: { status: report.status, comment: report.decision?.comment },
  });

  const response = await buildReimbursementResponse(report._id);
  const submitter = response.submittedBy;
  if (status === "rejected" || status === "completed") {
    await notifyReimbursementUser(
      submitter,
      status === "rejected" ? "reimbursement_rejected" : "reimbursement_completed",
      response
    );
  } else if (status === "approved") {
    const nextStage = {
      SUBMITTED_TO_BUDGET_HOLDER: APPROVAL_STAGES.SUBMITTED_TO_BUDGET_HOLDER,
      SUBMITTED_TO_LINE_MANAGER: APPROVAL_STAGES.SUBMITTED_TO_LINE_MANAGER,
      SUBMITTED_TO_FINANCE: APPROVAL_STAGES.SUBMITTED_TO_FINANCE,
    }[report.status];
    if (nextStage) {
      const recipients = await stageRecipients(nextStage, response);
      for (const recipient of recipients) {
        await notifyReimbursementUser(recipient, "reimbursement_submitted", response);
      }
    }
    if (report.status === "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT") {
      const budgetHolderId = String(response.selected_approver_id?._id || response.selected_approver_id || "");
      const lineManagerId = String(response.lineManagerId?._id || response.lineManagerId || "");
      if (lineManagerId && lineManagerId !== budgetHolderId) {
        await notifyReimbursementUser(response.lineManagerId, "reimbursement_cc", response);
      }
    }
    if (report.status === "SUBMITTED_TO_FINANCE") {
      const nextStage = APPROVAL_STAGES.SUBMITTED_TO_FINANCE;
      for (const recipient of await stageRecipients(nextStage, response)) {
        await notifyReimbursementUser(recipient, "reimbursement_submitted", response);
      }
    }
    if (report.status === "PAYMENT_PROCESSING" && response.financeCcAdminId) {
      await notifyReimbursementUser(response.financeCcAdminId, "reimbursement_cc", response);
    }
    if (report.status !== "SUBMITTED_TO_LINE_MANAGER_ACKNOWLEDGEMENT") {
      await notifyReimbursementUser(submitter, "reimbursement_approved", response);
    }
  }

  response.attachments = visibleAttachments(response, req.user);
  return res.json(response);
}

async function downloadReimbursementPdf(req, res) {
  const report = await populateReport(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  await ensureCanAccessReport(req.user, report);
  if (!canViewMergedReimbursementPackage(req.user, report)) {
    throw new HttpError(403, "Only the submitter, Budget Holder, or Finance can download the merged reimbursement package");
  }

  const [response] = await attachLineItems([report]);
  const budgetHolderId = String(
    response.selected_approver_id?._id || response.selected_approver_id || ""
  );
  const lineManagerId = String(response.lineManagerId?._id || response.lineManagerId || "");
  const budgetHolderIsLineManager =
    Boolean(budgetHolderId) && budgetHolderId === lineManagerId;
  const expenseDocuments = await Promise.all(
    (response.attachments || [])
      .filter((attachment) =>
        attachment.category === "financial" ||
        (budgetHolderIsLineManager && attachment.category === "line_manager")
      )
      .filter((attachment) =>
        ["application/pdf", "image/jpeg", "image/png"].includes(attachment.mimeType)
      )
      .sort((left, right) => {
        const priority = (attachment) => {
          if (attachment.documentType === "receipt_ticket") return 0;
          if (attachment.documentType === "expense_document") return 1;
          return 2;
        };
        return priority(left) - priority(right);
      })
      .map(async (attachment) => ({
        buffer: await getAttachmentBuffer(attachment.storageId),
        mimeType: attachment.mimeType,
      }))
  );
  await buildReimbursementPdf(res, response, expenseDocuments);
}

async function downloadPaymentVoucherPdf(req, res) {
  const report = await populateReport(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  await ensureCanAccessReport(req.user, report);
  if (!canViewMergedReimbursementPackage(req.user, report)) {
    throw new HttpError(403, "Only the submitter, Budget Holder, or Finance can download the Payment Voucher");
  }

  const [response] = await attachLineItems([report]);
  buildPaymentVoucherPdf(res, response);
}

async function uploadReimbursementAttachment(req, res) {
  const report = await ReimbursementReport.findById(req.params.id);
  if (!report) throw new HttpError(404, "Reimbursement report not found");
  ensureReportOwner(req.user, report);
  if (report.status === "COMPLETED") {
    throw new HttpError(400, "Completed reimbursements cannot be changed");
  }
  if (!req.file) throw new HttpError(400, "Select a document to upload");

  const documentType = req.body.documentType || "other";
  if (!["receipt_ticket", "expense_document", "back_to_office", "terms_of_reference", "other"].includes(documentType)) {
    throw new HttpError(400, "Select a valid document type");
  }
  if (
    documentType === "expense_document" &&
    !(await ExpenseLineItem.exists({ report: report._id, category: "OTHER EXPENSES" }))
  ) {
    throw new HttpError(400, "Add an Other Expenses line to the TER before uploading its supporting document");
  }
  const category =
    REIMBURSEMENT_ATTACHMENT_AUDIENCES[documentType] || req.body.category || "line_manager";
  if (!["financial", "supervisor", "line_manager"].includes(category)) {
    throw new HttpError(400, "Select a valid document audience");
  }
  const allowedMimeTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.ms-excel",
  ]);
  if (!allowedMimeTypes.has(req.file.mimetype)) {
    throw new HttpError(400, "Upload a PDF, image, Word document, or Excel document");
  }
  if (
    ["receipt_ticket", "expense_document"].includes(documentType) &&
    !["application/pdf", "image/jpeg", "image/png"].includes(req.file.mimetype)
  ) {
    throw new HttpError(400, "Receipts and expense documents added to the merged PDF must be PDF, JPEG, or PNG files");
  }

  const storageId = await storeAttachment(req.file, {
    reimbursementId: String(report._id),
    category,
    documentType,
  });
  try {
    report.attachments.push({
      documentType,
      category,
      originalName: req.file.originalname,
      storageId,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user.id,
    });
    await report.save();
  } catch (error) {
    await deleteAttachment(storageId);
    throw error;
  }
  return res.status(201).json({
    id: report.attachments[report.attachments.length - 1]._id,
    originalName: req.file.originalname,
    documentType,
    category,
  });
}

async function downloadReimbursementAttachment(req, res) {
  const report = await ReimbursementReport.findById(req.params.id);
  if (!report) throw new HttpError(404, "Reimbursement report not found");
  await ensureCanAccessReport(req.user, report);

  const attachment = report.attachments.id(req.params.attachmentId);
  if (!attachment || !visibleAttachments(report, req.user).some(
    (item) => String(item._id) === String(attachment._id)
  )) {
    throw new HttpError(404, "Reimbursement attachment not found");
  }

  res.setHeader("Content-Type", attachment.mimeType);
  const canPreviewInline =
    attachment.mimeType === "application/pdf" ||
    attachment.mimeType === "image/jpeg" ||
    attachment.mimeType === "image/png";
  res.setHeader(
    "Content-Disposition",
    `${req.query.view === "true" && canPreviewInline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.originalName)}"`
  );
  streamAttachment(attachment.storageId, res);
}

function getExpenseCategories(req, res) {
  res.json({ categories: EXPENSE_CATEGORIES });
}

module.exports = {
  createReimbursement,
  previewReimbursement,
  getMyReimbursements,
  getPendingApprovals,
  getTeamReimbursements,
  getReimbursementById,
  updateReimbursement,
  updateReimbursementStatus,
  downloadReimbursementPdf,
  downloadPaymentVoucherPdf,
  uploadReimbursementAttachment,
  downloadReimbursementAttachment,
  getExpenseCategories,
};
