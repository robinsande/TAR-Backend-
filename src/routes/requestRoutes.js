const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const { scopeRequestQuery } = require("../middleware/requestScopeMiddleware");
const { validationErrorHandler } = require("../middleware/errorHandler");
const {
  createTravelRequestValidator,
  resubmitTravelRequestValidator,
  rejectTravelRequestValidator,
  approveTravelRequestValidator,
} = require("../validators/requestValidators");
const {
  createRequest,
  listRequests,
  getRequestById,
  remindApprover,
  approveRequest,
  rejectRequest,
  resubmitRequest,
  getPendingMyApproval,
} = require("../controllers/requestController");

const router = express.Router();

router.use(authenticate);

router.get(
  "/pending-my-approval",
  requireRole("admin", "superadmin"),
  asyncHandler(getPendingMyApproval)
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
  "/:id/remind-approver",
  requireRole("user", "admin", "superadmin"),
  asyncHandler(remindApprover)
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
