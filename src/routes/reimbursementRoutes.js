const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const { validationErrorHandler } = require("../middleware/errorHandler");
const { uploadRequestAttachments } = require("../middleware/requestUpload");
const HttpError = require("../utils/httpError");
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

function parseReimbursementPreviewPayload(req, res, next) {
  try {
    const payload = req.body.payload ? JSON.parse(req.body.payload) : req.body;
    const attachments = req.body.previewAttachments
      ? JSON.parse(req.body.previewAttachments)
      : [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid reimbursement preview payload");
    }
    if (!Array.isArray(attachments)) {
      throw new Error("Invalid reimbursement preview attachments");
    }
    req.body = { ...payload, previewAttachments: attachments };
    next();
  } catch (error) {
    next(new HttpError(400, error.message || "Invalid reimbursement preview request"));
  }
}

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
  uploadRequestAttachments.array("attachments", 10),
  parseReimbursementPreviewPayload,
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
