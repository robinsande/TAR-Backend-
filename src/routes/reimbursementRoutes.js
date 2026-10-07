const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const { validationErrorHandler } = require("../middleware/errorHandler");
const { uploadRequestAttachments } = require("../middleware/requestUpload");
const {
  createReimbursementValidator,
  updateReimbursementValidator,
  updateReimbursementStatusValidator,
} = require("../validators/reimbursementValidators");
const {
  createReimbursement,
  previewReimbursement,
  getMyReimbursements,
  getPendingApprovals,
  getTeamReimbursements,
  getReimbursementById,
  updateReimbursement,
  updateReimbursementStatus,
  downloadReimbursementPdf,
  downloadPaymentVoucherPdf,
  uploadReimbursementAttachment,
  downloadReimbursementAttachment,
  getExpenseCategories,
} = require("../controllers/reimbursementController");

const router = express.Router();

router.use(authenticate);

router.get("/expense-categories", asyncHandler(getExpenseCategories));
router.get("/template/ter.pdf", asyncHandler((req, res) => {
  const { buildEmptyTravelExpenseReportPdf } = require("../services/pdfService");
  buildEmptyTravelExpenseReportPdf(res);
}));
router.get("/my-requests", asyncHandler(getMyReimbursements));
router.get(
  "/pending-approvals",
  requireRole("admin", "approver_budget_holder", "supervisor", "finance_admin"),
  asyncHandler(getPendingApprovals)
);
router.get(
  "/team",
  requireRole("admin", "approver_budget_holder", "supervisor", "finance_admin", "superadmin", "auditor"),
  asyncHandler(getTeamReimbursements)
);

router.post(
  "/preview",
  requireRole("user", "admin", "approver_budget_holder", "superadmin", "super_superadmin"),
  ...createReimbursementValidator,
  validationErrorHandler,
  asyncHandler(previewReimbursement)
);

router.post(
  "/",
  requireRole("user", "admin", "approver_budget_holder", "superadmin", "super_superadmin"),
  ...createReimbursementValidator,
  validationErrorHandler,
  asyncHandler(createReimbursement)
);

router.patch(
  "/:id",
  requireRole("user", "admin", "approver_budget_holder", "superadmin", "super_superadmin"),
  ...updateReimbursementValidator,
  validationErrorHandler,
  asyncHandler(updateReimbursement)
);

router.get("/:id", asyncHandler(getReimbursementById));
router.get("/:id/pdf", asyncHandler(downloadReimbursementPdf));
router.get("/:id/payment-voucher.pdf", asyncHandler(downloadPaymentVoucherPdf));
router.post(
  "/:id/attachments",
  uploadRequestAttachments.single("file"),
  asyncHandler(uploadReimbursementAttachment)
);
router.get(
  "/:id/attachments/:attachmentId",
  asyncHandler(downloadReimbursementAttachment)
);

router.patch(
  "/:id/status",
  requireRole("admin", "approver_budget_holder", "supervisor", "finance_admin"),
  ...updateReimbursementStatusValidator,
  validationErrorHandler,
  asyncHandler(updateReimbursementStatus)
);

module.exports = router;
