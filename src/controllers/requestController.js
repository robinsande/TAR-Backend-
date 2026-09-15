const TravelRequest = require("../models/TravelRequest");
const User = require("../models/User");
const HttpError = require("../utils/httpError");
const {
  notifyTravelRequestUser,
  notifyTravelRequestPassengers,
} = require("../services/notificationService");
const { createAuditLog } = require("../services/auditLogService");
const { getEligibleApproverById, resolveManagerApproverForUser } = require("../services/approverService");
const { resolvePassengers, getPassengerUserIds, isPassengerOnRequest } = require("../services/passengerService");
const { buildTravelRequestPdf } = require("../services/pdfService");
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

async function resolveApproverForRequest(approverId, requesterId, passengers, requesterRole) {
  const requesterIdString = String(requesterId);

  if (approverId && String(approverId) === requesterIdString) {
    throw new HttpError(
      400,
      "Managers cannot approve their own request. Choose a different admin approver."
    );
  }

  const expectedApprover = await resolveManagerApproverForUser(requesterId);

  if (requesterRole === "superadmin") {
    if (!approverId) {
      throw new HttpError(400, "Select an admin approver for this request");
    }
    return getEligibleApproverById(approverId, {
      excludeUserIds: [requesterId, ...getPassengerUserIds({ passengers })],
    });
  }

  if (!expectedApprover) {
    throw new HttpError(400, "This user has no valid manager approver assigned");
  }

  const excludeUserIds = [requesterId, ...getPassengerUserIds({ passengers })];

  if (approverId && String(approverId) !== String(expectedApprover._id)) {
    return getEligibleApproverById(expectedApprover._id, { excludeUserIds });
  }

  return getEligibleApproverById(approverId || expectedApprover._id, { excludeUserIds });
}

async function createRequest(req, res) {
  const requester = await User.findById(req.user.id);

  if (!requester || !requester.isActive) {
    throw new HttpError(404, "Requester not found");
  }

  const passengers = await resolvePassengers(req.body.passengers);
  const approver = await resolveApproverForRequest(
    req.body.selected_approver_id,
    requester._id,
    passengers,
    requester.role
  );

  const requestDocument = await TravelRequest.create({
    requestedBy: requester._id,
    selected_approver_id: approver._id,
    project: req.body.project,
    assignedAreaOfOperation: req.body.assignedAreaOfOperation,
    employeeOffice: req.body.employeeOffice || requester.office || requester.department || null,
    purposeOfTrip: req.body.purposeOfTrip,
    requesterSignature: req.body.requesterSignature || null,
    modeOfTravel: req.body.modeOfTravel || {},
    itinerary: req.body.itinerary,
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
  await notifyTravelRequestUser(approver, "new_request", requestDocument);

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

async function getRequestById(req, res) {
  const requestDocument = await populateTravelRequestById(req.params.id);

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  await ensureCanAccessRequest(req.user, requestDocument);

  return res.json(requestDocument);
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
    req.body.signature
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
    .populate("selected_approver_id");

  if (!requestDocument) {
    throw new HttpError(404, "Travel request not found");
  }

  ensureRequestOwner(req.user, requestDocument);

  if (requestDocument.status !== "rejected") {
    throw new HttpError(400, "Only rejected requests can be edited and resubmitted");
  }

  const passengers = await resolvePassengers(req.body.passengers);
  const approver = await resolveApproverForRequest(
    req.body.selected_approver_id,
    req.user.id,
    passengers,
    req.user.role
  );

  requestDocument.history.push({
    snapshot: getEditableRequestSnapshot(requestDocument),
    status: requestDocument.status,
    decision: requestDocument.decision,
    editedAt: new Date(),
  });

  applyRequestResubmission(requestDocument, req.body, approver._id, passengers);

  await requestDocument.save();

  await createAuditLog({
    action: "request_resubmitted",
    performedBy: req.user.id,
    targetRequest: requestDocument._id,
    metadata: { version: requestDocument.version },
  });

  await notifyTravelRequestPassengers(requestDocument, "resubmitted");
  await notifyTravelRequestUser(approver, "resubmitted", requestDocument);

  const populated = await buildTravelRequestResponse(requestDocument._id);

  return res.json(populated);
}

async function getPendingMyApproval(req, res) {
  const query =
    req.user.role === "superadmin"
      ? { status: "pending" }
      : { selected_approver_id: req.user.id, status: "pending" };

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
  getRequestById,
  approveRequest,
  rejectRequest,
  resubmitRequest,
  getPendingMyApproval,
  downloadTravelRequestPdf,
  downloadTravelRequestTemplatePdf,
};
