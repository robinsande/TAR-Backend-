const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const { validationErrorHandler } = require("../middleware/errorHandler");
const {
  createReimbursementValidator,
  updateReimbursementValidator,
  updateReimbursementStatusValidator,
} = require("../validators/reimbursementValidators");
const {
  createReimbursement,
  getMyReimbursements,
  getPendingApprovals,
  getTeamReimbursements,
  getReimbursementById,
  updateReimbursement,
  updateReimbursementStatus,
  downloadReimbursementPdf,
  getExpenseCategories,
} = require("../controllers/reimbursementController");

const router = express.Router();

router.use(authenticate);

router.get("/expense-categories", asyncHandler(getExpenseCategories));
router.get("/my-requests", asyncHandler(getMyReimbursements));
router.get(
  "/pending-approvals",
  requireRole("admin"),
  asyncHandler(getPendingApprovals)
);
router.get("/team", requireRole("admin"), asyncHandler(getTeamReimbursements));

router.post(
  "/",
  requireRole("user", "admin"),
  ...createReimbursementValidator,
  validationErrorHandler,
  asyncHandler(createReimbursement)
);

router.patch(
  "/:id",
  requireRole("user", "admin"),
  ...updateReimbursementValidator,
  validationErrorHandler,
  asyncHandler(updateReimbursement)
);

router.get("/:id", asyncHandler(getReimbursementById));
router.get("/:id/pdf", asyncHandler(downloadReimbursementPdf));

router.patch(
  "/:id/status",
  requireRole("admin"),
  ...updateReimbursementStatusValidator,
  validationErrorHandler,
  asyncHandler(updateReimbursementStatus)
);

module.exports = router;
