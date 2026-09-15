const Notification = require("../models/Notification");
const HttpError = require("../utils/httpError");

async function findOwnedNotification(notificationId, userId) {
  const notification = await Notification.findById(notificationId);

  if (!notification) {
    throw new HttpError(404, "Notification not found");
  }

  if (notification.recipient.toString() !== userId) {
    throw new HttpError(403, "You do not have access to this notification");
  }

  return notification;
}

async function listNotifications(req, res) {
  const notifications = await Notification.find({ recipient: req.user.id })
    .sort({ createdAt: -1 })
    .populate("request")
    .populate("reimbursement")
    .populate("recipient", "-passwordHash");

  return res.json(notifications);
}

async function markNotificationRead(req, res) {
  const notification = await findOwnedNotification(req.params.id, req.user.id);

  notification.read = true;
  await notification.save();

  return res.json(notification);
}

async function markAllNotificationsRead(req, res) {
  const result = await Notification.updateMany(
    { recipient: req.user.id, read: false },
    { $set: { read: true } }
  );

  return res.json({
    message: "All unread notifications marked as read",
    updatedCount: result.modifiedCount,
  });
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
