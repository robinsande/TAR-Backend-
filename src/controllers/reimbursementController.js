const User = require("../models/User");
const TravelRequest = require("../models/TravelRequest");
const ReimbursementReport = require("../models/ReimbursementReport");
const ExpenseLineItem = require("../models/ExpenseLineItem");
const HttpError = require("../utils/httpError");
const { EXPENSE_CATEGORIES } = require("../constants/expenseCategories");
const { createAuditLog } = require("../services/auditLogService");
const { getEligibleApproverById } = require("../services/approverService");
const { notifyReimbursementUser } = require("../services/notificationService");
const { buildReimbursementPdf } = require("../services/pdfService");
const {
  ensureUserCanClaimReimbursement,
  ensureApproverNotOnRequest,
} = require("../services/passengerService");
const {
  buildReimbursementTeamScope,
  ensureCanAccessReport,
  ensureReportOwner,
  ensureReportApprover,
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
  applyApprovalDecision,
} = require("../services/reimbursementService");

async function createReimbursement(req, res) {
  const submitter = await User.findById(req.user.id);

  if (!submitter || !submitter.isActive) {
    throw new HttpError(404, "User not found");
  }

  const travelRequest = await TravelRequest.findById(req.body.travelRequestId);

  if (!travelRequest) {
    throw new HttpError(404, "Travel request not found");
  }

  if (travelRequest.status !== "approved") {
    throw new HttpError(400, "Reimbursement requires an approved travel request");
  }

  ensureUserCanClaimReimbursement(travelRequest, submitter._id);

  const approver = await getEligibleApproverById(req.body.selected_approver_id, {
    excludeUserIds: [submitter._id],
  });
  ensureApproverNotOnRequest(approver._id, submitter._id, travelRequest.passengers);

  const lineItems = normalizeLineItems(req.body.lineItems);
  let report;

  try {
    report = await ReimbursementReport.create(
      buildReimbursementDraftData(
        { ...req.body, travelRequestId: travelRequest._id },
        submitter._id,
        approver._id,
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
    metadata: { travelRequest: travelRequest._id, status: "pending" },
  });

  const response = await buildReimbursementResponse(report._id);
  await notifyReimbursementUser(approver, "reimbursement_submitted", response);

  return res.status(201).json(response);
}

async function getMyReimbursements(req, res) {
  const scope =
    req.user.role === "superadmin" ? {} : { submittedBy: req.user.id };
  const queryFilters = await buildReimbursementFilters(req.query, req.user);
  const filter = mergeReimbursementScope(scope, queryFilters);

  if (filter._id === null) {
    return res.json([]);
  }

  const reports = await getReimbursementPopulateQuery(
    ReimbursementReport.find(filter).sort({ createdAt: -1 })
  );

  const data = await attachLineItems(reports);
  return res.json(data);
}

async function getPendingApprovals(req, res) {
  const reports = await getReimbursementPopulateQuery(
    ReimbursementReport.find({
      selected_approver_id: req.user.id,
      status: "pending",
    }).sort({ submittedAt: -1 })
  );

  const data = await attachLineItems(reports);
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

  const data = await attachLineItems(reports);
  return res.json(data);
}

async function getReimbursementById(req, res) {
  const report = await populateReport(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  await ensureCanAccessReport(req.user, report);

  const [response] = await attachLineItems([report]);
  return res.json(response);
}

async function updateReimbursement(req, res) {
  const report = await ReimbursementReport.findById(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  ensureReportOwner(req.user, report);

  if (report.status !== "rejected") {
    throw new HttpError(400, "Only rejected reimbursement reports can be edited and resubmitted");
  }

  const approver = await getEligibleApproverById(req.body.selected_approver_id);
  const lineItems = normalizeLineItems(req.body.lineItems);
  const existingLineItems = await ExpenseLineItem.find({ report: report._id }).sort({
    expenseDate: 1,
  });

  report.history.push({
    snapshot: getEditableReimbursementSnapshot(report, existingLineItems),
    status: report.status,
    decision: report.decision,
    editedAt: new Date(),
  });

  applyReimbursementResubmission(report, req.body, approver._id);

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
  await notifyReimbursementUser(approver, "reimbursement_resubmitted", response);

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

  ensureReportApprover(req.user, report);

  if (report.status !== "pending") {
    throw new HttpError(400, "Only pending reports can be approved or rejected");
  }

  applyApprovalDecision(report, status, req.user.id, comment);

  await report.save();

  await createAuditLog({
    action: status === "approved" ? "reimbursement_approved" : "reimbursement_rejected",
    performedBy: req.user.id,
    targetReimbursement: report._id,
    metadata: { status: report.status, comment: report.decision.comment },
  });

  const response = await buildReimbursementResponse(report._id);

  if (status === "approved") {
    await notifyReimbursementUser(response.submittedBy, "reimbursement_approved", response);
  } else if (status === "rejected") {
    await notifyReimbursementUser(response.submittedBy, "reimbursement_rejected", response);
  }

  return res.json(response);
}

async function downloadReimbursementPdf(req, res) {
  const report = await populateReport(req.params.id);

  if (!report) {
    throw new HttpError(404, "Reimbursement report not found");
  }

  await ensureCanAccessReport(req.user, report);

  const [response] = await attachLineItems([report]);
  buildReimbursementPdf(res, response);
}

function getExpenseCategories(req, res) {
  res.json({ categories: EXPENSE_CATEGORIES });
}

module.exports = {
  createReimbursement,
  getMyReimbursements,
  getPendingApprovals,
  getTeamReimbursements,
  getReimbursementById,
  updateReimbursement,
  updateReimbursementStatus,
  downloadReimbursementPdf,
  getExpenseCategories,
};
