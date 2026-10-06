const TravelRequest = require("../models/TravelRequest");
const BudgetHolder = require("../models/BudgetHolder");
const User = require("../models/User");
const path = require("path");
const HttpError = require("../utils/httpError");
const {
  notifyTravelRequestUser,
  notifyTravelRequestApprover,
  notifyTravelRequestPassengers,
  notifyApprovedTarSuperAdmins,
} = require("../services/notificationService");
const { createAuditLog } = require("../services/auditLogService");
const { getEligibleApproverById } = require("../services/approverService");
const { resolvePassengers, getPassengerUserIds, isPassengerOnRequest } = require("../services/passengerService");
const { buildTravelRequestPdf } = require("../services/pdfService");
const { uploadDirectory } = require("../middleware/requestUpload");
const { storeAttachment, streamAttachment, deleteAttachment } = require("../services/attachmentStorageService");
const {
  ensureCanAccessRequest,
  ensureApprover,
  ensureRequestOwner,
} = require("../services/requestAccessService");
const {
  getPagination,
  buildPaginatedResponse,
} = require("../services/requestFilterService");
const {
  getTravelRequestPopulateQuery,
  populateTravelRequestById,
  buildTravelRequestResponse,
  getEditableRequestSnapshot,
  applyRequestDecision,
  resetRequestDecision,
  applyRequestResubmission,
} = require("../services/travelRequestService");

async function resolveApproversForRequest(approverIds, requesterId, passengers) {
  const excludeUserIds = [requesterId, ...getPassengerUserIds({ passengers })];
  const requestedIds = [...new Set((approverIds || []).filter(Boolean).map(String))];
  if (requestedIds.length) {
    return Promise.all(
      requestedIds.map((approverId) => getEligibleApproverById(approverId, { excludeUserIds }))
    );
  }
  throw new HttpError(400, "Select an active admin approver before submitting this request");
}

async function createRequest(req, res) {
  const requester = await User.findById(req.user.id);

  if (!requester || !requester.isActive) {
    throw new HttpError(404, "Requester not found");
  }

  if (!req.body.selected_budget_holder_id) {
    throw new HttpError(400, "Select a budget holder before submitting this TAR");
  }

  const budgetHolder = req.body.selected_budget_holder_id
    ? await BudgetHolder.findOne({
      _id: req.body.selected_budget_holder_id,
      isActive: true,
    }).populate("user")
    : null;
  if (
    req.body.selected_budget_holder_id &&
    (!budgetHolder || !budgetHolder.user?.isActive || budgetHolder.user.role !== "approver_budget_holder")
  ) {
    throw new HttpError(400, "Select an active account with the Approver / Budget Holder role");
  }

  const passengers = await resolvePassengers(req.body.passengers);
  const requestedApproverIds = Array.isArray(req.body.selected_approver_ids) && req.body.selected_approver_ids.length
    ? req.body.selected_approver_ids
    : [req.body.selected_approver_id];
  const approvers = await resolveApproversForRequest(
    requestedApproverIds,
    requester._id,
    passengers,
  );

  const requestDocument = await TravelRequest.create({
    requestedBy: requester._id,
    selected_budget_holder_id: budgetHolder?._id || null,
    approvalStage: budgetHolder ? "budget_holder" : "line_manager",
    selected_approver_id: approvers[0]._id,
    selected_approver_ids: approvers.map((approver) => approver._id),
    project: req.body.project,
    assignedAreaOfOperation: req.body.assignedAreaOfOperation,
    employeeOffice: req.body.employeeOffice || requester.office || null,
    purposeOfTrip: req.body.purposeOfTrip,
    requesterSignature: req.body.requesterSignature || null,
    modeOfTravel: req.body.modeOfTravel || {},
    itinerary: req.body.itinerary,
    travelSegments: req.body.travelSegments || [],
    passengers,
    submittedAt: new Date(),
  });

  await createAuditLog({
    action: "request_created",
    performedBy: requester._id,
    targetRequest: requestDocument._id,
    metadata: { status: requestDocument.status },
  });

  await notifyTravelRequestPassengers(requestDocument, "new_request");
  const approverNotification = await notifyTravelRequestApprover(
    requestDocument,
    "new_request",
    requester
  );
  if (approverNotification.some(Boolean)) {
    requestDocument.lastApprovalReminderAt = new Date();
  }
  if (!isPassengerOnRequest(requestDocument, requester)) {
    await notifyTravelRequestUser(requester, "new_request", requestDocument, "requester");
  }

  await requestDocument.save();

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.status(201).json(populated);
}

async function listRequests(req, res) {
  const pagination = getPagination(req.query);
  const query = TravelRequest.find(req.requestScope).sort({ createdAt: -1 });

  const [requests, total] = await Promise.all([
    getTravelRequestPopulateQuery(query.skip(pagination.skip).limit(pagination.limit)),
    TravelRequest.countDocuments(req.requestScope),
  ]);

  return res.json(buildPaginatedResponse(requests, total, pagination));
}

async function remindApprover(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id)
    .populate("requestedBy", "name email")
    .populate("selected_approver_id", "name email role isActive");

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  if (String(requestDocument.requestedBy?._id) !== String(req.user.id)) {
    throw new HttpError(403, "Only the requester can remind the approver");
  }

  if (requestDocument.status !== "pending") {
    throw new HttpError(400, "Only pending requests can be reminded");
  }

  const notifications = await notifyTravelRequestApprover(
    requestDocument,
    "approval_reminder",
    requestDocument.requestedBy
  );

  const sentCount = Array.isArray(notifications)
    ? notifications.filter(Boolean).length
    : Number(Boolean(notifications));

  if (!sentCount) {
    throw new HttpError(503, "Reminder notification was recorded, but the email could not be sent. Check the Brevo sender configuration.");
  }

  if (notifications.some(Boolean)) {
    requestDocument.lastApprovalReminderAt = new Date();
    await requestDocument.save();
  }

  return res.json({
    message: `Reminder sent to ${sentCount} selected approver${sentCount === 1 ? "" : "s"}`,
    sentCount,
  });
}

async function remindAllPendingApprovers(req, res) {
  const requests = await TravelRequest.find({ status: "pending" })
    .populate("requestedBy", "name email")
    .select("requestedBy selected_approver_id selected_approver_ids itinerary purposeOfTrip status lastApprovalReminderAt");
  const results = { total: requests.length, sent: 0, failed: 0, skipped: 0 };

  for (const requestDocument of requests) {
    let notifications;
    try {
      notifications = await notifyTravelRequestApprover(
        requestDocument,
        "approval_reminder",
        requestDocument.requestedBy
      );
    } catch (error) {
      results.failed += 1;
      console.error(
        `[pending-reminders] Failed to send manual reminder for TAR ${requestDocument._id}:`,
        error.message
      );
      continue;
    }
    const sent = Array.isArray(notifications) ? notifications.filter(Boolean).length : Number(Boolean(notifications));
    if (!sent) {
      results.skipped += 1;
    } else {
      requestDocument.lastApprovalReminderAt = new Date();
      await requestDocument.save();
      results.sent += sent;
      if (!notifications.every(Boolean)) {
        results.failed += 1;
      }
    }
  }

  return res.json(results);
}

async function getRequestById(req, res) {
  const requestDocument = await populateTravelRequestById(req.params.id);

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  await ensureCanAccessRequest(req.user, requestDocument);

  return res.json(requestDocument);
}

async function uploadRequestAttachments(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id);
  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  ensureRequestOwner(req.user, requestDocument);
  const files = [
    ...(req.files?.scopeDocuments || []).map((file) => ({ file, category: "scope" })),
    ...(req.files?.supportingDocuments || []).map((file) => ({ file, category: "supporting" })),
  ];

  if (!files.length) {
    throw new HttpError(400, "Select at least one document to upload");
  }

  const storedAttachments = await Promise.all(files.map(async ({ file, category }) => ({
      category,
      originalName: file.originalname,
      storageName: `gridfs:${await storeAttachment(file, { requestId: String(requestDocument._id), category })}`,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
    })));
  requestDocument.attachments.push(...storedAttachments);
  await requestDocument.save();
  return res.status(201).json(requestDocument.attachments);
}

async function downloadRequestAttachment(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id);
  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  await ensureCanAccessRequest(req.user, requestDocument);
  const attachment = requestDocument.attachments.id(req.params.attachmentId);
  if (!attachment) {
    throw new HttpError(404, "Attachment not found");
  }

  const filePath = path.join(uploadDirectory, attachment.storageName);
  if (attachment.storageName.startsWith("gridfs:")) {
    res.type(attachment.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `${req.query.view === "true" ? "inline" : "attachment"}; filename="${attachment.originalName.replace(/"/g, "")}"`);
    return streamAttachment(attachment.storageName.slice("gridfs:".length), res);
  }

  if (req.query.view === "true") {
    res.type(attachment.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${attachment.originalName.replace(/"/g, "")}"`);
    return res.sendFile(filePath);
  }

  return res.download(filePath, attachment.originalName);
}

async function deleteRequestAttachment(req, res) {
  if (req.user.role !== "superadmin") throw new HttpError(403, "Only superadmins can delete attachments");
  const requestDocument = await TravelRequest.findById(req.params.id);
  if (!requestDocument) throw new HttpError(404, "Travel request not found");
  const attachment = requestDocument.attachments.id(req.params.attachmentId);
  if (!attachment) throw new HttpError(404, "Attachment not found");

  if (attachment.storageName.startsWith("gridfs:")) {
    await deleteAttachment(attachment.storageName.slice("gridfs:".length));
  }
  requestDocument.attachments.pull(attachment._id);
  await requestDocument.save();
  return res.status(204).send();
}

async function deleteRequest(req, res) {
  if (req.user.role !== "superadmin") throw new HttpError(403, "Only superadmins can delete TARs");
  const requestDocument = await TravelRequest.findById(req.params.id);
  if (!requestDocument) throw new HttpError(404, "Travel request not found");
  for (const attachment of requestDocument.attachments) {
    if (attachment.storageName.startsWith("gridfs:")) {
      await deleteAttachment(attachment.storageName.slice("gridfs:".length));
    }
  }
  await requestDocument.deleteOne();
  return res.status(204).send();
}

async function approveRequest(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id).populate(
    "requestedBy",
    "-passwordHash"
  );

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  ensureApprover(req.user, requestDocument);

  if (requestDocument.status !== "pending") {
    throw new HttpError(400, "Only pending requests can be approved");
  }

  applyRequestDecision(
    requestDocument,
    "approved",
    req.user.id,
    req.body?.comment || null,
    req.body.signature,
    req.body.decisionDate || null
  );

  await requestDocument.save();

  await createAuditLog({
    action: "request_approved",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: {
      comment: requestDocument.decision.comment,
      signature: requestDocument.decision.signature,
    },
  });

  await notifyTravelRequestPassengers(requestDocument, "approved");

  const requester = requestDocument.requestedBy;
  if (requester && !isPassengerOnRequest(requestDocument, requester)) {
    await notifyTravelRequestUser(requester, "approved", requestDocument);
  }
  await notifyApprovedTarSuperAdmins(requestDocument);

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
}

async function getPendingMyBudgetApproval(req, res) {
  const holderIds = await BudgetHolder.find({ user: req.user.id, isActive: true }).distinct("_id");
  const requests = await getTravelRequestPopulateQuery(
    TravelRequest.find({
      selected_budget_holder_id: { $in: holderIds },
      approvalStage: "budget_holder",
      status: "pending",
    }).sort({ createdAt: -1 })
  );
  return res.json(requests);
}

async function decideBudgetHolderRequest(req, res, decisionStatus) {
  const requestDocument = await TravelRequest.findById(req.params.id)
    .populate("requestedBy", "-passwordHash")
    .populate("selected_approver_id", "name email position")
    .populate("selected_approver_ids", "name email position")
    .populate({ path: "selected_budget_holder_id", populate: { path: "user", select: "name email isActive" } });

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }
  if (
    requestDocument.status !== "pending" ||
    requestDocument.approvalStage !== "budget_holder"
  ) {
    throw new HttpError(400, "This request is not awaiting budget-holder approval");
  }
  if (String(requestDocument.selected_budget_holder_id?.user?._id) !== req.user.id) {
    throw new HttpError(403, "Only the selected budget holder can review this request");
  }

  requestDocument.budgetHolderDecision = {
    status: decisionStatus,
    decidedBy: req.user.id,
    decidedAt: new Date(),
    comment: req.body?.comment || null,
    signature: decisionStatus === "approved" ? req.body.signature : null,
    submittedFundCode: requestDocument.project.fundCode,
  };

  const requester = requestDocument.requestedBy;
  let automaticallyApprovedByLineManager = false;
  if (decisionStatus === "approved") {
    requestDocument.budgetHolderDecision.comment = "Fund code reviewed";
    const approverIds = requestDocument.selected_approver_ids?.length
      ? requestDocument.selected_approver_ids
      : [requestDocument.selected_approver_id];
    automaticallyApprovedByLineManager = approverIds.some(
      (approver) => String(approver?._id || approver) === req.user.id
    );
    requestDocument.approvalStage = "line_manager";
    if (automaticallyApprovedByLineManager) {
      requestDocument.status = "approved";
      requestDocument.decision = {
        decidedBy: req.user.id,
        decidedAt: requestDocument.budgetHolderDecision.decidedAt,
        comment: "Budget holder and line-manager approval completed by the same person",
        signature: req.body.signature,
      };
    }
  } else {
    requestDocument.status = "rejected";
  }
  await requestDocument.save();

  await createAuditLog({
    action: `request_budget_holder_${decisionStatus}`,
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: {
      fundCode: requestDocument.project.fundCode,
      comment: requestDocument.budgetHolderDecision.comment,
    },
  });

  if (automaticallyApprovedByLineManager) {
    await createAuditLog({
      action: "request_approved",
      performedBy: req.user.id,
      targetRequest: requestDocument._id,
      metadata: {
        comment: requestDocument.decision.comment,
        signature: requestDocument.decision.signature,
        automaticallyApprovedAfterBudgetHolderReview: true,
      },
    });
    await notifyTravelRequestPassengers(requestDocument, "approved");
    if (requester && !isPassengerOnRequest(requestDocument, requester)) {
      await notifyTravelRequestUser(requester, "approved", requestDocument);
    }
    await notifyApprovedTarSuperAdmins(requestDocument);
  } else if (decisionStatus === "approved") {
    const notifications = await notifyTravelRequestApprover(
      requestDocument,
      "new_request",
      requester
    );
    if (notifications.some(Boolean)) {
      requestDocument.lastApprovalReminderAt = new Date();
      await requestDocument.save();
    }
  } else {
    await notifyTravelRequestPassengers(requestDocument, "rejected");
    if (requester && !isPassengerOnRequest(requestDocument, requester)) {
      await notifyTravelRequestUser(requester, "rejected", requestDocument);
    }
  }

  return res.json(await buildTravelRequestResponse(requestDocument._id));
}

async function approveBudgetHolderRequest(req, res) {
  return decideBudgetHolderRequest(req, res, "approved");
}

async function rejectBudgetHolderRequest(req, res) {
  return decideBudgetHolderRequest(req, res, "rejected");
}

async function rejectRequest(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id).populate(
    "requestedBy",
    "-passwordHash"
  );

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  ensureApprover(req.user, requestDocument);

  if (requestDocument.status !== "pending") {
    throw new HttpError(400, "Only pending requests can be rejected");
  }

  applyRequestDecision(requestDocument, "rejected", req.user.id, req.body?.comment);

  await requestDocument.save();

  await createAuditLog({
    action: "request_rejected",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: { comment: req.body?.comment ?? null },
  });

  await notifyTravelRequestPassengers(requestDocument, "rejected");

  const requester = requestDocument.requestedBy;
  if (requester && !isPassengerOnRequest(requestDocument, requester)) {
    await notifyTravelRequestUser(requester, "rejected", requestDocument);
  }

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
}

async function resubmitRequest(req, res) {
  const requestDocument = await TravelRequest.findById(req.params.id)
    .populate("requestedBy")
    .populate("selected_approver_id")
    .populate("selected_approver_ids");

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  ensureRequestOwner(req.user, requestDocument);

  if (!["pending", "rejected"].includes(requestDocument.status)) {
    throw new HttpError(400, "Only pending or rejected requests can be edited");
  }

  if (!req.body.selected_budget_holder_id) {
    throw new HttpError(400, "Select a budget holder before resubmitting this TAR");
  }

  const passengers = await resolvePassengers(req.body.passengers);
  const budgetHolder = req.body.selected_budget_holder_id
    ? await BudgetHolder.findOne({
      _id: req.body.selected_budget_holder_id,
      isActive: true,
    }).populate("user")
    : null;
  if (
    req.body.selected_budget_holder_id &&
    (!budgetHolder || !budgetHolder.user?.isActive || budgetHolder.user.role !== "approver_budget_holder")
  ) {
    throw new HttpError(400, "Select an active account with the Approver / Budget Holder role");
  }
  const requestedApproverIds = Array.isArray(req.body.selected_approver_ids) && req.body.selected_approver_ids.length
    ? req.body.selected_approver_ids
    : [req.body.selected_approver_id];
  const approvers = await resolveApproversForRequest(
    requestedApproverIds,
    requestDocument.requestedBy._id,
    passengers,
  );

  requestDocument.history.push({
    snapshot: getEditableRequestSnapshot(requestDocument),
    status: requestDocument.status,
    decision: requestDocument.decision,
    editedAt: new Date(),
  });

  applyRequestResubmission(requestDocument, req.body, approvers, passengers, budgetHolder);
  requestDocument.lastApprovalReminderAt = null;

  await requestDocument.save();

  await createAuditLog({
    action: "request_resubmitted",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: { version: requestDocument.version },
  });

  await notifyTravelRequestPassengers(requestDocument, "resubmitted");
  const approverNotification = await notifyTravelRequestApprover(
    requestDocument,
    "resubmitted",
    requestDocument.requestedBy
  );
  if (approverNotification.some(Boolean)) {
    requestDocument.lastApprovalReminderAt = new Date();
    await requestDocument.save();
  }

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
}

async function getPendingMyApproval(req, res) {
  const query =
    req.user.role === "superadmin"
      ? { status: "pending" }
      : !["admin", "approver_budget_holder"].includes(req.user.role)
        ? { _id: null }
      : {
          $or: [{ selected_approver_id: req.user.id }, { selected_approver_ids: req.user.id }],
          status: "pending",
          approvalStage: "line_manager",
        };

  const requests = await getTravelRequestPopulateQuery(
    TravelRequest.find(query).sort({ createdAt: -1 })
  );

  return res.json(requests);
}

async function downloadTravelRequestPdf(req, res) {
  if (req.params.id === "template") {
    return downloadTravelRequestTemplatePdf(req, res);
  }

  const requestDocument = await populateTravelRequestById(req.params.id);

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  await ensureCanAccessRequest(req.user, requestDocument);

  if (req.query.preview === "true") {
    return buildTravelRequestPdf(res, requestDocument);
  }

  if (
    requestDocument.status !== "approved" ||
    !requestDocument.requesterSignature ||
    !requestDocument.decision?.signature
  ) {
    throw new HttpError(
      403,
      "The signed TAR is available only after approval and completion of both signatures"
    );
  }

  buildTravelRequestPdf(res, requestDocument);
}

function downloadTravelRequestTemplatePdf(req, res) {
  buildTravelRequestPdf(res, {
    _id: "template",
    requestedBy: {},
    project: {},
    selected_budget_holder_id: {},
    budgetHolderDecision: {},
    assignedAreaOfOperation: "",
    employeeOffice: "",
    purposeOfTrip: "",
    modeOfTravel: {},
    itinerary: {},
    passengers: [],
    status: "pending",
    submittedAt: null,
    decision: {},
  });
}

async function rerouteApproval(req, res) {
  if (req.user.role !== "superadmin") {
    throw new HttpError(403, "Only superadmins can re-route approvals");
  }

  const requestDocument = await TravelRequest.findById(req.params.id)
    .populate("requestedBy", "-passwordHash")
    .populate("selected_approver_id", "-passwordHash")
    .populate("selected_approver_ids", "-passwordHash");

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }
  if (requestDocument.approvalStage === "budget_holder") {
    throw new HttpError(400, "The request must pass budget-holder review before the line-manager approval can be rerouted");
  }

  if (requestDocument.status !== "pending") {
    throw new HttpError(400, "Only pending requests can have their approval re-routed");
  }

  const newApprover = await getEligibleApproverById(req.body.newApproverId, {
    excludeUserIds: [
      requestDocument.requestedBy?._id,
      ...(requestDocument.passengers || [])
        .map((p) => p.user?._id || p.user)
        .filter(Boolean),
    ],
  });

  const oldApproverIds = [
    requestDocument.selected_approver_id,
    ...(requestDocument.selected_approver_ids || []),
  ].filter(Boolean).map((id) => String(id));
  const oldApprover = requestDocument.selected_approver_id;
  const oldApprovers = requestDocument.selected_approver_ids || [requestDocument.selected_approver_id];

  requestDocument.history.push({
    snapshot: getEditableRequestSnapshot(requestDocument),
    status: requestDocument.status,
    decision: requestDocument.decision,
    editedAt: new Date(),
    metadata: {
      action: "reroute_approval",
      previousApproverIds: oldApproverIds,
      newApproverId: newApprover._id.toString(),
      comment: req.body?.comment || null,
      reroutedBy: req.user.id,
    },
  });

  requestDocument.selected_approver_id = newApprover._id;
  requestDocument.selected_approver_ids = [newApprover._id];
  resetRequestDecision(requestDocument);
  requestDocument.submittedAt = new Date();
  requestDocument.lastApprovalReminderAt = null;
  requestDocument.version += 1;

  await requestDocument.save();

  await createAuditLog({
    action: "request_approval_rerouted",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: {
      previousApproverIds: oldApproverIds,
      newApproverId: newApprover._id.toString(),
      comment: req.body?.comment ?? null,
    },
  });

  const reroutedRequest = await populateTravelRequestById(requestDocument._id);

  const approverNotification = await notifyTravelRequestApprover(
    reroutedRequest,
    "rerouted",
    reroutedRequest.requestedBy,
    {
      comment: req.body?.comment || null,
      oldApprover,
      oldApprovers,
      newApprover,
    }
  );
  if (approverNotification.some(Boolean)) {
    reroutedRequest.lastApprovalReminderAt = new Date();
    await reroutedRequest.save();
  }

  const populated = await buildTravelRequestResponse(requestDocument._id);
  return res.json(populated);
}

module.exports = {
  createRequest,
  listRequests,
  remindApprover,
  remindAllPendingApprovers,
  getRequestById,
  uploadRequestAttachments,
  downloadRequestAttachment,
  deleteRequestAttachment,
  deleteRequest,
  approveRequest,
  getPendingMyBudgetApproval,
  approveBudgetHolderRequest,
  rejectBudgetHolderRequest,
  rejectRequest,
  resubmitRequest,
  getPendingMyApproval,
  downloadTravelRequestPdf,
  downloadTravelRequestTemplatePdf,
  rerouteApproval,
};
