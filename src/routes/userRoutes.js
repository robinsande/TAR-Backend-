const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const {
  getMe,
  updateMe,
  getTarDraft,
  saveTarDraft,
  deleteTarDraft,
  getUserTarDraft,
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
const { validationErrorHandler } = require("../middleware/errorHandler");
const {
  createUserValidator,
  updateUserRoleValidator,
  updateUserProfileValidator,
  resetUserPasswordValidator,
  updateUserStatusValidator,
  deleteUserValidator,
  bulkInviteValidator,
} = require("../validators/userValidators");

const router = express.Router();

router.use(authenticate);

router.get("/me", asyncHandler(getMe));
router.patch("/me", asyncHandler(updateMe));
router.get("/me/tar-draft", asyncHandler(getTarDraft));
router.put("/me/tar-draft", asyncHandler(saveTarDraft));
router.delete("/me/tar-draft", asyncHandler(deleteTarDraft));
router.get("/:id/tar-draft", requireRole("superadmin"), asyncHandler(getUserTarDraft));
router.get("/approvers", asyncHandler(listApprovers));
router.get("/passengers", asyncHandler(listPassengers));
router.post(
  "/",
  requireRole("admin", "superadmin"),
  ...createUserValidator,
  validationErrorHandler,
  asyncHandler(createUser)
);
router.post(
  "/bulk-invite",
  requireRole("superadmin"),
  ...bulkInviteValidator,
  validationErrorHandler,
  asyncHandler(sendBulkInvitations)
);
router.patch(
  "/:id/role",
  requireRole("superadmin"),
  ...updateUserRoleValidator,
  validationErrorHandler,
  asyncHandler(updateUserRole)
);
router.patch(
  "/:id/profile",
  requireRole("superadmin"),
  ...updateUserProfileValidator,
  validationErrorHandler,
  asyncHandler(updateUserProfile)
);
router.post(
  "/:id/reset-password",
  requireRole("superadmin"),
  ...resetUserPasswordValidator,
  validationErrorHandler,
  asyncHandler(resetUserPassword)
);
router.patch(
  "/:id/status",
  requireRole("superadmin"),
  ...updateUserStatusValidator,
  validationErrorHandler,
  asyncHandler(updateUserStatus)
);
router.delete(
  "/:id",
  requireRole("superadmin"),
  ...deleteUserValidator,
  validationErrorHandler,
  asyncHandler(deleteUser)
);
router.get("/", requireRole("superadmin"), asyncHandler(listUsers));

module.exports = router;
