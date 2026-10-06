const Notification = require("../models/Notification");
const User = require("../models/User");
const BudgetHolder = require("../models/BudgetHolder");
const { sendEmail } = require("./emailService");
const { loadPassengerUsers } = require("./passengerService");

function buildNotificationEmail(recipientName, message, entityLabel, entityId) {
  const approvalUrl = getApprovalsUrl();
  return `
    <p>Hello ${recipientName},</p>
    <p>${message}</p>
    <p>${entityLabel}: ${entityId}</p>
    <p><a href="${approvalUrl}">Open the CARE TAR approvals page</a></p>
  `;
}

function getApprovalsUrl() {
  return `${require("../config/env").frontendUrl.replace(/\/+$/, "")}/approvals.html`;
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
    text: `Hello ${recipient.name},\n\n${message}\n\n${entityLabel}: ${entityId}\n\nOpen the CARE TAR approvals page: ${getApprovalsUrl()}`,
  };
  const emailSent = await sendEmail(recipient.email, subject, html, emailOptions);

  return emailSent ? notification : null;
}

function buildTravelRequestNotificationContent(type, requestDocument, audience = "approver", requester = null, extras = {}) {
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

  if (audience === "budget_holder") {
    const fundCode = extras.budgetHolder?.fundCode || requestDocument.project?.fundCode || "the submitted fund code";
    return type === "approval_reminder"
      ? {
          subject: "Reminder: TAR awaiting your fund-code review",
          message: `${requesterLabel} is reminding you to review the fund code ${fundCode} on the TAR for ${destination} before it proceeds to the line manager.`,
        }
      : {
          subject: "TAR awaiting your fund-code review",
          message: `${requesterLabel} submitted a TAR for ${destination} and selected you to verify fund code ${fundCode}. Please approve or reject it before it proceeds to the line manager.`,
        };
  }

  if (audience === "superadmin" && type === "approved") {
    return {
      subject: "Approved TAR notification",
      message: `${requesterLabel} has an approved travel request to ${destination} for ${purpose}. Please review it in the CARE TAR system.`,
    };
  }

  switch (type) {
    case "flight_booking_required":
      return {
        subject: "Approved TAR requires travel arrangements",
        message: `${requesterLabel} has an approved TAR for ${destination} for ${purpose}. Please review the request and arrange the required travel, then reply to the requester if more information is needed.`,
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
    case "rerouted":
      return {
        subject: "Approval re-routed to you",
        message: `A superadmin re-routed a travel request to ${destination} for ${purpose} from another approver to you. It is awaiting your approval.${
          extras?.comment ? `\n\nReroute comment: ${extras.comment}` : ""
        }`,
      };
    default:
      return {
        subject: "Travel request update",
        message: `A travel request to ${destination} for ${purpose} was updated.`,
      };
  }
}

function buildSuperAdminApprovalNotification(requestDocument) {
  const destination = requestDocument.itinerary.destination;
  const purpose = requestDocument.purposeOfTrip;
  return {
    subject: "TAR approved: management notification",
    message: `A travel request to ${destination} for ${purpose} has been approved and is available for oversight.`,
  };
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

async function notifyTravelRequestUser(recipient, type, requestDocument, audience = "approver", requester = null, extras = {}) {
  if (!recipient) {
    return null;
  }

  const content = buildTravelRequestNotificationContent(type, requestDocument, audience, requester, extras);
  const requesterEmail = requester?.email || requestDocument.requestedBy?.email || null;

  return createAndSendNotification({
    recipient,
    type,
    message: content.message,
    subject: content.subject,
    requestId: requestDocument._id,
    replyTo: ["approver", "flight_booking", "budget_holder"].includes(audience) ? requesterEmail : null,
    entityLabel: "Request ID",
    entityId: requestDocument._id,
  });
}

async function notifyTravelRequestApprover(requestDocument, type, requester = null, extras = {}) {
  if (requestDocument.approvalStage === "budget_holder") {
    const budgetHolderId = requestDocument.selected_budget_holder_id?._id ||
      requestDocument.selected_budget_holder_id;
    const budgetHolder = budgetHolderId
      ? await BudgetHolder.findById(budgetHolderId).populate("user")
      : null;
    const user = budgetHolder?.user;
    if (!user || !user.isActive || !budgetHolder.isActive) {
      return [];
    }
    const notificationType = type === "approval_reminder" ? type : "new_request";
    return [await notifyTravelRequestUser(
      user,
      notificationType,
      requestDocument,
      "budget_holder",
      requester,
      { ...extras, budgetHolder }
    )];
  }

  const selectedApproverIds = requestDocument.selected_approver_ids?.length
    ? requestDocument.selected_approver_ids
    : [requestDocument.selected_approver_id];
  const approverIds = [...new Set(selectedApproverIds.map((approver) => String(approver?._id || approver)).filter(Boolean))];
  if (!approverIds.length) {
    return [];
  }

  const approvers = await User.find({
    _id: { $in: approverIds },
    role: { $in: ["admin", "approver_budget_holder"] },
    isActive: true,
  }).select("-passwordHash");
  const approversById = new Map(approvers.map((approver) => [String(approver._id), approver]));

  return Promise.all(approverIds.map((approverId) => {
    const approver = approversById.get(approverId);
    return approver
      ? notifyTravelRequestUser(approver, type, requestDocument, "approver", requester, extras)
      : null;
  }));
}

async function notifyApprovedTarSuperAdmins(requestDocument) {
  if (requestDocument.status !== "approved") {
    return [];
  }

  const superAdmins = await User.find({
    role: "super_superadmin",
    isActive: true,
  }).select("-passwordHash");
  const requester = requestDocument.requestedBy;

  return Promise.all(superAdmins.map((superAdmin) =>
    notifyTravelRequestUser(superAdmin, "approved", requestDocument, "superadmin", requester)
  ));
}

async function resendTravelRequestNotifications(requestDocument) {
  const requester = requestDocument.requestedBy;
  const approvalNotification = await notifyTravelRequestApprover(
    requestDocument,
    "new_request",
    requester
  );
  const approvedTarNotifications = await notifyApprovedTarSuperAdmins(requestDocument);

  return {
    approvalCount: Array.isArray(approvalNotification)
      ? approvalNotification.filter(Boolean).length
      : Number(Boolean(approvalNotification)),
    approvedTarEmailCount: approvedTarNotifications.filter(Boolean).length,
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
  notifyTravelRequestApprover,
  notifyTravelRequestPassengers,
  notifyApprovedTarSuperAdmins,
  resendTravelRequestNotifications,
  notifyReimbursementUser,
};
