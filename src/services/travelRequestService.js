const TravelRequest = require("../models/TravelRequest");

function getTravelRequestPopulateQuery(query) {
  return query
    .populate("requestedBy", "-passwordHash")
    .populate("selected_approver_id", "-passwordHash")
    .populate("selected_approver_ids", "-passwordHash")
    .populate("decision.decidedBy", "-passwordHash")
    .populate("passengers.user", "-passwordHash");
}

async function populateTravelRequestById(requestId) {
  return getTravelRequestPopulateQuery(TravelRequest.findById(requestId));
}

async function buildTravelRequestResponse(requestId) {
  return populateTravelRequestById(requestId);
}

function getEditableRequestSnapshot(requestDocument) {
  return {
    selected_approver_id: requestDocument.selected_approver_id,
    selected_approver_ids: requestDocument.selected_approver_ids || [requestDocument.selected_approver_id],
    project: requestDocument.project,
    assignedAreaOfOperation: requestDocument.assignedAreaOfOperation,
    employeeOffice: requestDocument.employeeOffice,
    purposeOfTrip: requestDocument.purposeOfTrip,
    requesterSignature: requestDocument.requesterSignature,
    modeOfTravel: requestDocument.modeOfTravel,
    itinerary: requestDocument.itinerary,
    travelSegments: requestDocument.travelSegments || [],
    passengers: requestDocument.passengers,
  };
}

function applyRequestDecision(requestDocument, status, decidedBy, comment = null, signature = null, decidedAt = null) {
  requestDocument.status = status;
  requestDocument.decision = {
    decidedBy,
    decidedAt: decidedAt ? new Date(decidedAt) : new Date(),
    comment,
    signature,
  };

  if (status === "approved" && requestDocument.submittedAt == null) {
    requestDocument.submittedAt = new Date();
  }
}

function resetRequestDecision(requestDocument) {
  requestDocument.decision = {
    decidedBy: null,
    decidedAt: null,
    comment: null,
    signature: null,
  };
}

function applyRequestResubmission(requestDocument, payload, approvers, passengers) {
  requestDocument.project = payload.project;
  requestDocument.assignedAreaOfOperation = payload.assignedAreaOfOperation;
  requestDocument.employeeOffice = payload.employeeOffice || requestDocument.employeeOffice || null;
  requestDocument.purposeOfTrip = payload.purposeOfTrip;
  requestDocument.modeOfTravel = payload.modeOfTravel || {};
  requestDocument.itinerary = payload.itinerary;
  requestDocument.travelSegments = payload.travelSegments || [];
  requestDocument.passengers = passengers;
  requestDocument.selected_approver_id = approvers[0]._id;
  requestDocument.selected_approver_ids = approvers.map((approver) => approver._id);
  requestDocument.version += 1;
  requestDocument.status = "pending";
  resetRequestDecision(requestDocument);
  requestDocument.submittedAt = new Date();
}

module.exports = {
  getTravelRequestPopulateQuery,
  populateTravelRequestById,
  buildTravelRequestResponse,
  getEditableRequestSnapshot,
  applyRequestDecision,
  resetRequestDecision,
  applyRequestResubmission,
};
