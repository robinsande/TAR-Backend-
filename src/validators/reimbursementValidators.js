const { body } = require("express-validator");
const { EXPENSE_CATEGORIES } = require("../constants/expenseCategories");

const selectedSupervisorValidator = body("supervisorId")
  .isMongoId()
  .withMessage("A valid supervisor ID is required");

const reimbursementHeaderValidators = [
  selectedSupervisorValidator,
  body("financeAdminId")
    .isMongoId()
    .withMessage("A valid Finance Admin is required"),
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
    .isIn(["review_started", "approved", "rejected", "completed"])
    .withMessage("Status must be review_started, approved, rejected, or completed"),
  body("comment")
    .if(body("status").equals("rejected"))
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Rejection comment is required"),
  body("comment").optional({ values: "null" }).isString(),
];

module.exports = {
  createReimbursementValidator,
  updateReimbursementValidator,
  updateReimbursementStatusValidator,
};
