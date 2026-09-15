const mongoose = require("mongoose");
const ExpenseLineItem = require("../models/ExpenseLineItem");
const ReimbursementReport = require("../models/ReimbursementReport");

function getReimbursementPopulateQuery(query) {
  return query
    .populate("travelRequest")
    .populate("submittedBy", "-passwordHash")
    .populate("selected_approver_id", "-passwordHash")
    .populate("decision.decidedBy", "-passwordHash");
}

async function populateReport(reportId) {
  return getReimbursementPopulateQuery(ReimbursementReport.findById(reportId));
}

function toDecimal128(amount) {
  return mongoose.Types.Decimal128.fromString(Number(amount).toFixed(2));
}

function normalizeLineItems(lineItems = []) {
  return lineItems.map((item) => {
    const category = String(item.category || "").trim();
    const description = String(item.description || "").trim() || category;

    return {
      expenseDate: item.expenseDate,
      location: item.location.trim(),
      category,
      description,
      amount: toDecimal128(item.amount),
    };
  });
}

async function recalculateReportTotal(reportId, session = null) {
  const query = ExpenseLineItem.find({ report: reportId }).select("amount");
  if (session) {
    query.session(session);
  }

  const lineItems = await query.lean();
  const total = lineItems.reduce(
    (sum, item) => sum + parseFloat(item.amount.toString()),
    0
  );

  await ReimbursementReport.findByIdAndUpdate(
    reportId,
    { totalAmountKsh: toDecimal128(total) },
    { session }
  );

  return total;
}

async function attachLineItems(reports) {
  const reportList = Array.isArray(reports) ? reports : [reports];
  const reportIds = reportList.map((report) => report._id);

  const lineItems = await ExpenseLineItem.find({ report: { $in: reportIds } }).sort({
    expenseDate: 1,
  });

  const itemsByReport = lineItems.reduce((map, item) => {
    const key = item.report.toString();
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(item);
    return map;
  }, {});

  return reportList.map((report) => ({
    ...report.toJSON(),
    lineItems: itemsByReport[report._id.toString()] || [],
  }));
}

async function buildReimbursementResponse(reportId) {
  const populated = await populateReport(reportId);
  const [response] = await attachLineItems([populated]);
  return response;
}

function buildReimbursementDraftData(payload, submitterId, approverId, fallbackProfile = {}) {
  return {
    travelRequest: payload.travelRequestId,
    submittedBy: submitterId,
    selected_approver_id: approverId,
    employeeNumber: payload.employeeNumber || fallbackProfile.employeeNumber || "N/A",
    department: payload.department || fallbackProfile.department || "N/A",
    position: payload.position || fallbackProfile.position || "N/A",
    baseLocation: payload.baseLocation,
    status: "pending",
    submittedAt: new Date(),
  };
}

async function replaceReportLineItems(reportId, lineItems) {
  await ExpenseLineItem.deleteMany({ report: reportId });
  await ExpenseLineItem.insertMany(
    lineItems.map((item) => ({
      ...item,
      report: reportId,
    }))
  );
}

function getEditableReimbursementSnapshot(report, lineItems = []) {
  return {
    selected_approver_id: report.selected_approver_id,
    employeeNumber: report.employeeNumber,
    department: report.department,
    position: report.position,
    baseLocation: report.baseLocation,
    totalAmountKsh: report.totalAmountKsh,
    lineItems: lineItems.map((item) => ({
      expenseDate: item.expenseDate,
      location: item.location,
      category: item.category,
      description: item.description,
      amount: item.amount,
    })),
  };
}

function resetReimbursementDecision(report) {
  report.decision = {
    decidedBy: null,
    decidedAt: null,
    comment: null,
  };
}

function applyReimbursementResubmission(report, payload, approverId) {
  report.selected_approver_id = approverId;
  report.employeeNumber = payload.employeeNumber || report.employeeNumber;
  report.department = payload.department || report.department;
  report.position = payload.position || report.position;
  report.baseLocation = payload.baseLocation;
  report.version += 1;
  report.status = "pending";
  report.approvedAt = null;
  resetReimbursementDecision(report);
  report.submittedAt = new Date();
}

function applyApprovalDecision(report, status, decidedBy, comment) {
  const now = new Date();
  report.decision = {
    decidedBy,
    decidedAt: now,
    comment: status === "rejected" ? comment?.trim() : comment?.trim() || null,
  };

  if (status === "approved") {
    report.status = "approved";
    report.approvedAt = now;
    return;
  }

  report.status = "rejected";
  report.approvedAt = null;
}

module.exports = {
  getReimbursementPopulateQuery,
  populateReport,
  toDecimal128,
  normalizeLineItems,
  recalculateReportTotal,
  attachLineItems,
  buildReimbursementResponse,
  buildReimbursementDraftData,
  replaceReportLineItems,
  getEditableReimbursementSnapshot,
  resetReimbursementDecision,
  applyReimbursementResubmission,
  applyApprovalDecision,
};
