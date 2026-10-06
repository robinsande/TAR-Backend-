const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const { scopeRequestQuery } = require("../middleware/requestScopeMiddleware");
const { validationErrorHandler } = require("../middleware/errorHandler");
const { uploadRequestAttachments } = require("../middleware/requestUpload");
const {
  createTravelRequestValidator,
  resubmitTravelRequestValidator,
  rejectTravelRequestValidator,
  approveTravelRequestValidator,
  rerouteApprovalValidator,
} = require("../validators/requestValidators");
const {
  createRequest,
  listRequests,
  getRequestById,
  remindApprover,
  remindAllPendingApprovers,
  approveRequest,
  getPendingMyBudgetApproval,
  approveBudgetHolderRequest,
  rejectBudgetHolderRequest,
  rejectRequest,
  resubmitRequest,
  getPendingMyApproval,
  uploadRequestAttachments: saveRequestAttachments,
  downloadRequestAttachment,
  deleteRequestAttachment,
  deleteRequest,
  rerouteApproval,
} = require("../controllers/requestController");

const router = express.Router();

router.use(authenticate);

router.get(
  "/pending-my-approval",
  requireRole("admin", "superadmin"),
  asyncHandler(getPendingMyApproval)
);

router.get(
  "/pending-my-budget-approval",
  requireRole("user", "admin"),
  asyncHandler(getPendingMyBudgetApproval)
);

router.patch(
  "/:id/budget-holder/approve",
  requireRole("user", "admin"),
  approveTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(approveBudgetHolderRequest)
);

router.patch(
  "/:id/budget-holder/reject",
  requireRole("user", "admin"),
  rejectTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(rejectBudgetHolderRequest)
);

router.post(
  "/",
  requireRole("user", "admin", "superadmin"),
  createTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(createRequest)
);

router.get("/", scopeRequestQuery, asyncHandler(listRequests));
router.get("/:id", asyncHandler(getRequestById));

router.post(
  "/:id/attachments",
  uploadRequestAttachments.fields([
    { name: "scopeDocuments", maxCount: 5 },
    { name: "supportingDocuments", maxCount: 5 },
  ]),
  asyncHandler(saveRequestAttachments)
);

router.get(
  "/:id/attachments/:attachmentId",
  asyncHandler(downloadRequestAttachment)
);

router.delete(
  "/:id/attachments/:attachmentId",
  requireRole("superadmin"),
  asyncHandler(deleteRequestAttachment)
);

router.post(
  "/:id/remind-approver",
  requireRole("user", "admin", "superadmin"),
  asyncHandler(remindApprover)
);

router.post(
  "/remind-pending",
  requireRole("superadmin"),
  asyncHandler(remindAllPendingApprovers)
);

router.delete(
  "/:id",
  requireRole("superadmin"),
  asyncHandler(deleteRequest)
);

router.patch(
  "/:id/reroute-approval",
  requireRole("superadmin"),
  rerouteApprovalValidator,
  validationErrorHandler,
  asyncHandler(rerouteApproval)
);

router.patch(
  "/:id/approve",
  requireRole("admin"),
  approveTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(approveRequest)
);

router.patch(
  "/:id/reject",
  requireRole("admin"),
  rejectTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(rejectRequest)
);

router.patch(
  "/:id",
  requireRole("user", "admin", "superadmin"),
  resubmitTravelRequestValidator,
  validationErrorHandler,
  asyncHandler(resubmitRequest)
);

module.exports = router;
