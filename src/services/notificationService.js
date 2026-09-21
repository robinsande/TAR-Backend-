const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendEmail } = require("./emailService");
const { loadPassengerUsers } = require("./passengerService");

function buildNotificationEmail(recipientName, message, entityLabel, entityId) {
  const approvalUrl = `${require("../config/env").frontendUrl.replace(/\/+$/, "")}/approvals.html`;
  return `
    <p>Hello ${recipientName},</p>
    <p>${message}</p>
    <p>${entityLabel}: ${entityId}</p>
    <p><a href="${approvalUrl}">Open the CARE TAR approvals page</a></p>
  `;
}

async function createAndSendNotification({
  recipient,
  type,
  message,
  subject,
  requestId = null,
  reimbursementId = null,
  replyTo = null,
  from = null,
  entityLabel,
  entityId,
}) {
  const notification = await Notification.create({
    recipient: recipient._id,
    type,
    request: requestId,
    reimbursement: reimbursementId,
    message,
  });

  const html = buildNotificationEmail(recipient.name, message, entityLabel, entityId);
  const emailOptions = {
    ...(replyTo ? { replyTo } : {}),
    ...(from ? { from } : {}),
  };
  await sendEmail(recipient.email, subject, html, emailOptions);

  return notification;
}

function buildTravelRequestNotificationContent(type, requestDocument, audience = "approver", requester = null) {
  const destination = requestDocument.itinerary.destination;
  const purpose = requestDocument.purposeOfTrip;
  const requesterLabel = requester?.email
    ? `${requester.name || "A staff member"} (${requester.email})`
    : requestDocument.requestedBy?.email
      ? `${requestDocument.requestedBy.name || "A staff member"} (${requestDocument.requestedBy.email})`
      : "A staff member";

  if (audience === "requester") {
    switch (type) {
      case "new_request":
        return {
          subject: "Travel request submitted",
          message: `Your travel request to ${destination} for ${purpose} was submitted and is awaiting approval.`,
        };
      default:
        break;
    }
  }

  if (audience === "passenger") {
    switch (type) {
      case "new_request":
        return {
          subject: "You were added to a travel request",
          message: `You were listed as a passenger on a travel request to ${destination} for ${purpose}. It is awaiting approval.`,
        };
      case "approved":
        return {
          subject: "Travel request approved",
          message: `Your travel request to ${destination} for ${purpose} was approved.`,
        };
      case "rejected":
        return {
          subject: "Travel request rejected",
          message: `Your travel request to ${destination} for ${purpose} was rejected.`,
        };
      case "resubmitted":
        return {
          subject: "Travel request resubmitted",
          message: `A travel request to ${destination} for ${purpose} that lists you as a passenger was resubmitted for approval.`,
        };
      default:
        return {
          subject: "Travel request update",
          message: `A travel request to ${destination} for ${purpose} that lists you as a passenger was updated.`,
        };
    }
  }

  switch (type) {
    case "flight_booking_required":
      return {
        subject: "Flight booking required for approved TAR",
        message: `${requesterLabel} has an approved TAR for ${destination} for ${purpose}. Please arrange the required flight booking and reply to the requester if more information is needed.`,
      };
    case "approval_reminder":
      return {
        subject: "Reminder: travel request awaiting your approval",
        message: `${requesterLabel} is reminding you to review and approve the TAR for ${destination} for ${purpose}.`,
      };
    case "new_request":
      return {
        subject: "New travel request awaiting approval",
          message: `${requesterLabel} submitted a new travel request to ${destination} for ${purpose}. Please review and approve the TAR.`,
      };
    case "approved":
      return {
        subject: "Travel request approved",
        message: `Your travel request to ${destination} for ${purpose} was approved.`,
      };
    case "rejected":
      return {
        subject: "Travel request rejected",
        message: `Your travel request to ${destination} for ${purpose} was rejected.`,
      };
    case "resubmitted":
      return {
        subject: "Travel request resubmitted",
          message: `${requesterLabel} edited and resubmitted a travel request to ${destination} for ${purpose}. Please review and approve the TAR.`,
      };
    default:
      return {
        subject: "Travel request update",
        message: `A travel request to ${destination} for ${purpose} was updated.`,
      };
  }
}

function buildReimbursementNotificationContent(type, report) {
  const destination = report.travelRequest?.itinerary?.destination || "the trip";
  const amount = Number(report.totalAmountKsh || 0).toFixed(2);

  switch (type) {
    case "reimbursement_submitted":
      return {
        subject: "New reimbursement awaiting approval",
        message: `A reimbursement request for ${destination} totaling KES ${amount} is awaiting your approval.`,
      };
    case "reimbursement_resubmitted":
      return {
        subject: "Reimbursement resubmitted",
        message: `A reimbursement request for ${destination} totaling KES ${amount} was edited and resubmitted for your review.`,
      };
    case "reimbursement_approved":
      return {
        subject: "Reimbursement approved",
        message: `Your reimbursement request for ${destination} totaling KES ${amount} was approved.`,
      };
    case "reimbursement_rejected":
      return {
        subject: "Reimbursement rejected",
        message: `Your reimbursement request for ${destination} totaling KES ${amount} was rejected.`,
      };
    default:
      return {
        subject: "Reimbursement update",
        message: `Your reimbursement request for ${destination} was updated.`,
      };
  }
}

async function notifyTravelRequestUser(recipient, type, requestDocument, audience = "approver", requester = null) {
  if (!recipient) {
    return null;
  }

  const content = buildTravelRequestNotificationContent(type, requestDocument, audience, requester);
  const requesterEmail = requester?.email || requestDocument.requestedBy?.email || null;

  return createAndSendNotification({
    recipient,
    type,
    message: content.message,
    subject: content.subject,
    requestId: requestDocument._id,
    replyTo: ["approver", "flight_booking"].includes(audience) ? requesterEmail : null,
    from: ["approver", "flight_booking"].includes(audience) ? requesterEmail : null,
    entityLabel: "Request ID",
    entityId: requestDocument._id,
  });
}

async function notifyFlightBookingSuperAdmins(requestDocument) {
  if (
    requestDocument.status !== "approved" ||
    !requestDocument.modeOfTravel?.aircraft
  ) {
    return [];
  }

  const superAdmins = await User.find({
    role: "superadmin",
    isActive: true,
  }).select("-passwordHash");
  const requester = requestDocument.requestedBy;

  return Promise.all(
    superAdmins.map((superAdmin) =>
      notifyTravelRequestUser(
        superAdmin,
        "flight_booking_required",
        requestDocument,
        "flight_booking",
        requester
      )
    )
  );
}

async function resendTravelRequestNotifications(requestDocument) {
  const requester = requestDocument.requestedBy;
  const approverIds = requestDocument.selected_approver_ids?.length
    ? requestDocument.selected_approver_ids
    : [requestDocument.selected_approver_id];
  const approvers = await User.find({
    _id: { $in: approverIds },
    role: "admin",
    isActive: true,
  }).select("-passwordHash");

  const approvalNotifications = await Promise.all(
    approvers.map((approver) =>
      notifyTravelRequestUser(approver, "new_request", requestDocument, "approver", requester)
    )
  );
  const flightNotifications = await notifyFlightBookingSuperAdmins(requestDocument);

  return {
    approvalCount: approvalNotifications.filter(Boolean).length,
    flightBookingCount: flightNotifications.filter(Boolean).length,
  };
}

async function notifyTravelRequestPassengers(requestDocument, type) {
  const passengers = await loadPassengerUsers(requestDocument);
  const requesterId = String(requestDocument.requestedBy?._id || requestDocument.requestedBy || "");
  const results = [];

  for (const passenger of passengers) {
    const audience = String(passenger._id) === requesterId ? "requester" : "passenger";
    results.push(
      await notifyTravelRequestUser(passenger, type, requestDocument, audience)
    );
  }

  return results;
}

async function notifyReimbursementUser(recipient, type, report) {
  const content = buildReimbursementNotificationContent(type, report);

  return createAndSendNotification({
    recipient,
    type,
    message: content.message,
    subject: content.subject,
    requestId: report.travelRequest?._id || report.travelRequest || null,
    reimbursementId: report._id,
    entityLabel: "Reimbursement ID",
    entityId: report._id,
  });
}

module.exports = {
  notifyTravelRequestUser,
  notifyTravelRequestPassengers,
  notifyFlightBookingSuperAdmins,
  resendTravelRequestNotifications,
  notifyReimbursementUser,
};
