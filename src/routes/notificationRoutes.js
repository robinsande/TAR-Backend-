const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/authMiddleware");
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
} = require("../controllers/notificationController");

const router = express.Router();

router.use(authenticate);

router.get("/", asyncHandler(listNotifications));
router.patch("/mark-all-read", asyncHandler(markAllNotificationsRead));
router.delete("/", asyncHandler(clearNotifications));
router.patch("/:id/read", asyncHandler(markNotificationRead));

module.exports = router;
