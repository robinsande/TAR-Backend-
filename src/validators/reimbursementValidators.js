const { body } = require("express-validator");
const { EXPENSE_CATEGORIES } = require("../constants/expenseCategories");

const selectedSupervisorValidator = body("supervisorId")
  .optional({ values: "falsy" })
  .isMongoId()
  .withMessage("Select a valid Supervisor");

const reimbursementHeaderValidators = [
  selectedSupervisorValidator,
  body("financeAdminId")
    .isMongoId()
    .withMessage("A valid Finance Admin is required"),
  body("financeCcAdminId")
    .optional({ values: "falsy" })
    .isMongoId()
    .withMessage("Select a valid Finance Admin to copy"),
  body("requesterSignedName")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Your signature is required"),
  body("requesterSignature")
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 1500000 })
    .withMessage("Draw or type your signature before continuing"),
  body("baseLocation").isString().notEmpty().withMessage("Base location is required"),
  body("employeeNumber").optional().isString(),
  body("department").optional().isString(),
  body("position").optional().isString(),
  body("paymentRequestPurpose")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Payment Request purpose is required"),
  body("paymentDetails.paymentMethod")
    .equals("mpesa")
    .withMessage("M-PESA is the supported reimbursement payment method"),
  body("paymentDetails.mpesaNumber")
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 40 })
    .withMessage("Enter the mobile number registered for M-PESA"),
];

const reimbursementLineItemValidators = [
  body("lineItems")
    .isArray({ min: 1, max: 300 })
    .withMessage("Provide between 1 and 300 expense entries"),
  body("lineItems.*.expenseDate").isISO8601().withMessage("Each line item needs a valid expense date"),
  body("lineItems.*.location").isString().notEmpty().withMessage("Each line item needs a location"),
  body("lineItems.*.category")
    .isString()
    .isIn(EXPENSE_CATEGORIES)
    .withMessage(`Each line item category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`),
  body("lineItems.*.description")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("Line item description must be a string"),
  body("lineItems.*.invoiceNumber")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ max: 100 })
    .withMessage("Invoice number must be 100 characters or fewer"),
  body("lineItems.*.amount")
    .isFloat({ min: 0.01 })
    .withMessage("Each line item amount must be greater than zero"),
];

const createReimbursementValidator = [
  body("travelRequestId").isMongoId().withMessage("A valid travel request ID is required"),
  ...reimbursementHeaderValidators,
  ...reimbursementLineItemValidators,
];

const updateReimbursementValidator = [
  ...reimbursementHeaderValidators,
  ...reimbursementLineItemValidators,
];

const updateReimbursementStatusValidator = [
  body("status")
    .isIn(["review_started", "approved", "rejected", "acknowledged", "completed"])
    .withMessage("Status must be review_started, approved, rejected, acknowledged, or completed"),
  body("comment")
    .if(body("status").equals("rejected"))
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Rejection comment is required"),
  body("comment").optional({ values: "null" }).isString(),
  body("signature")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ max: 1500000 })
    .withMessage("Approval signature must be valid text or a saved signature image"),
];

module.exports = {
  createReimbursementValidator,
  updateReimbursementValidator,
  updateReimbursementStatusValidator,
};
