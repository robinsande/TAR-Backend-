const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const {
  upload,
  importEmployees,
  resendApprovedTarNotifications,
} = require("../controllers/adminController");

const router = express.Router();

router.use(authenticate, requireRole("superadmin"));

router.post(
  "/import-employees",
  upload.single("file"),
  asyncHandler(importEmployees)
);

router.post(
  "/resend-approved-tar-notifications",
  asyncHandler(resendApprovedTarNotifications)
);

module.exports = router;
