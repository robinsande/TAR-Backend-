const { body } = require("express-validator");
const { EXPENSE_CATEGORIES } = require("../constants/expenseCategories");

const selectedApproverValidator = body("selected_approver_id")
  .isMongoId()
  .withMessage("A valid selected approver ID is required");

const reimbursementHeaderValidators = [
  selectedApproverValidator,
  body("baseLocation").isString().notEmpty().withMessage("Base location is required"),
  body("employeeNumber").optional().isString(),
  body("department").optional().isString(),
  body("position").optional().isString(),
];

const reimbursementLineItemValidators = [
  body("lineItems").isArray({ min: 1 }).withMessage("At least one expense line item is required"),
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
    .isIn(["approved", "rejected"])
    .withMessage("Status must be approved or rejected"),
  body("comment")
    .if(body("status").equals("rejected"))
    .isString()
    .notEmpty()
    .withMessage("Rejection comment is required"),
  body("comment").optional({ values: "null" }).isString(),
];

module.exports = {
  createReimbursementValidator,
  updateReimbursementValidator,
  updateReimbursementStatusValidator,
};
