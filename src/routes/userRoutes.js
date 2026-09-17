const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const {
  getMe,
  updateMe,
  listUsers,
  createUser,
  updateUserRole,
  updateUserProfile,
  resetUserPassword,
    sendBulkInvitations,
  updateUserStatus,
  deleteUser,
  listApprovers,
  listPassengers,
} = require("../controllers/userController");

const router = express.Router();

router.use(authenticate);

router.get("/me", asyncHandler(getMe));
router.patch("/me", asyncHandler(updateMe));
router.get("/approvers", asyncHandler(listApprovers));
router.get("/passengers", asyncHandler(listPassengers));
router.post("/", requireRole("admin", "superadmin"), asyncHandler(createUser));
router.post("/bulk-invite", requireRole("superadmin"), asyncHandler(sendBulkInvitations));
router.patch("/:id/role", requireRole("superadmin"), asyncHandler(updateUserRole));
router.patch("/:id/profile", requireRole("superadmin"), asyncHandler(updateUserProfile));
router.post("/:id/reset-password", requireRole("superadmin"), asyncHandler(resetUserPassword));
router.patch("/:id/status", requireRole("superadmin"), asyncHandler(updateUserStatus));
router.delete("/:id", requireRole("superadmin"), asyncHandler(deleteUser));
router.get("/", requireRole("superadmin"), asyncHandler(listUsers));

module.exports = router;
