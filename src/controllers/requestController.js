const TravelRequest = require("../models/TravelRequest");
const User = require("../models/User");
const path = require("path");
const HttpError = require("../utils/httpError");
const {
  notifyTravelRequestUser,
  notifyTravelRequestApprover,
  notifyTravelRequestPassengers,
  notifyFlightBookingSuperAdmins,
} = require("../services/notificationService");
const { createAuditLog } = require("../services/auditLogService");
const { getEligibleApproverById } = require("../services/approverService");
const { resolvePassengers, getPassengerUserIds, isPassengerOnRequest } = require("../services/passengerService");
const { buildTravelRequestPdf } = require("../services/pdfService");
const { uploadDirectory } = require("../middleware/requestUpload");
const { storeAttachment, streamAttachment } = require("../services/attachmentStorageService");
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
  await notifyTravelRequestApprover(requestDocument, "new_request", requester);
  if (!isPassengerOnRequest(requestDocument, requester)) {
    await notifyTravelRequestUser(requester, "new_request", requestDocument, "requester");
  }

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

  const emailSent = await notifyTravelRequestUser(
    requestDocument.selected_approver_id,
    "approval_reminder",
    requestDocument,
    "approver",
    requestDocument.requestedBy
  );

  if (!emailSent) {
    throw new HttpError(503, "Reminder notification was recorded, but the email could not be sent. Check the Brevo sender configuration.");
  }

  return res.json({ message: "Reminder sent to the assigned approver" });
}

async function remindAllPendingApprovers(req, res) {
  const requests = await TravelRequest.find({ status: "pending" })
    .populate("requestedBy", "name email")
    .select("requestedBy selected_approver_id selected_approver_ids itinerary purposeOfTrip status");
  const results = { total: requests.length, sent: 0, failed: 0, skipped: 0 };

  for (const requestDocument of requests) {
    let notifications;
    try {
      notifications = await notifyTravelRequestApprover(
        requestDocument,
        "approval_reminder",
        requestDocument.requestedBy
      );
    } catch {
      results.failed += 1;
      continue;
    }
    const sent = Array.isArray(notifications) ? notifications.filter(Boolean).length : Number(Boolean(notifications));
    if (!sent) results.skipped += 1;
    else if (sent === (requestDocument.selected_approver_ids?.length || 1)) results.sent += sent;
    else results.failed += 1;
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
  await notifyFlightBookingSuperAdmins(requestDocument);

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
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

  const passengers = await resolvePassengers(req.body.passengers);
  const requestedApproverIds = Array.isArray(req.body.selected_approver_ids) && req.body.selected_approver_ids.length
    ? req.body.selected_approver_ids
    : [req.body.selected_approver_id];
  const approvers = await resolveApproversForRequest(
    requestedApproverIds,
    req.user.id,
    passengers,
  );

  requestDocument.history.push({
    snapshot: getEditableRequestSnapshot(requestDocument),
    status: requestDocument.status,
    decision: requestDocument.decision,
    editedAt: new Date(),
  });

  applyRequestResubmission(requestDocument, req.body, approvers, passengers);

  await requestDocument.save();

  await createAuditLog({
    action: "request_resubmitted",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: { version: requestDocument.version },
  });

  await notifyTravelRequestPassengers(requestDocument, "resubmitted");
  await notifyTravelRequestApprover(requestDocument, "resubmitted", requestDocument.requestedBy);

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
}

async function getPendingMyApproval(req, res) {
  const query =
    req.user.role === "superadmin"
      ? { status: "pending" }
      : {
          $or: [{ selected_approver_id: req.user.id }, { selected_approver_ids: req.user.id }],
          status: "pending",
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

module.exports = {
  createRequest,
  listRequests,
  remindApprover,
  remindAllPendingApprovers,
  getRequestById,
  uploadRequestAttachments,
  downloadRequestAttachment,
  approveRequest,
  rejectRequest,
  resubmitRequest,
  getPendingMyApproval,
  downloadTravelRequestPdf,
  downloadTravelRequestTemplatePdf,
};
