const { body, param } = require("express-validator");

const optionalText = (field, message) =>
  body(field).optional({ values: "null" }).isString().trim().isLength({ max: 200 }).withMessage(message);

const userIdParamValidator = [
  param("id").isMongoId().withMessage("A valid user ID is required"),
];

const createUserValidator = [
  body("name").isString().trim().isLength({ min: 1, max: 160 }).withMessage("Name is required"),
  body("email").isEmail().normalizeEmail().withMessage("A valid email is required"),
  optionalText("employeeNumber", "Employee number must be text"),
  optionalText("position", "Position must be text"),
  optionalText("office", "Office must be text"),
  optionalText("department", "Department must be text"),
  body("role").optional().isIn(["user", "admin", "superadmin", "super_superadmin"]).withMessage("Invalid user role"),
];

const updateUserRoleValidator = [
  ...userIdParamValidator,
  body("role").isIn(["user", "admin", "superadmin", "super_superadmin"]).withMessage("Invalid user role"),
];

const updateUserProfileValidator = [
  ...userIdParamValidator,
  body("name").isString().trim().isLength({ min: 1, max: 160 }).withMessage("Name is required"),
  body("email").isEmail().normalizeEmail().withMessage("A valid email is required"),
  optionalText("employeeNumber", "Employee number must be text"),
  optionalText("position", "Position must be text"),
  optionalText("office", "Office must be text"),
  optionalText("department", "Department must be text"),
  body("managerId").optional({ values: "null" }).isMongoId().withMessage("Manager must be a valid user"),
  body("alternateApproverIds")
    .optional()
    .isArray()
    .withMessage("Alternative approvers must be a list"),
  body("alternateApproverIds.*")
    .optional()
    .isMongoId()
    .withMessage("Alternative approvers must be valid users"),
];

const resetUserPasswordValidator = userIdParamValidator;

const updateUserStatusValidator = [
  ...userIdParamValidator,
  body("isActive").isBoolean().withMessage("isActive must be true or false"),
];

const deleteUserValidator = userIdParamValidator;

const bulkInviteValidator = [
  body("userIds").optional().isArray().withMessage("userIds must be a list"),
  body("userIds.*").optional().isMongoId().withMessage("userIds must contain valid users"),
  body("all").optional().isBoolean().withMessage("all must be true or false"),
];

module.exports = {
  createUserValidator,
  updateUserRoleValidator,
  updateUserProfileValidator,
  resetUserPasswordValidator,
  updateUserStatusValidator,
  deleteUserValidator,
  bulkInviteValidator,
};
