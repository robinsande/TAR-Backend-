const { body } = require("express-validator");

const loginValidator = [
  body("email").isEmail().withMessage("A valid email is required").normalizeEmail(),
  body("password")
    .isString()
    .isLength({ min: 1 })
    .withMessage("Password is required"),
];

const activateAccountValidator = [
  body("email").isEmail().withMessage("A valid email is required").normalizeEmail(),
  body("token").isString().notEmpty().withMessage("Activation token is required"),
  body("newPassword")
    .isString()
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters"),
];

const setPasswordValidator = [
  body("currentPassword")
    .isString()
    .isLength({ min: 1 })
    .withMessage("Current password is required"),
  body("newPassword")
    .isString()
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters"),
];

const verifyMfaValidator = [
  body("code")
    .isString()
    .trim()
    .matches(/^\d{6}$/)
    .withMessage("Enter the six-digit code from your authenticator app"),
];

module.exports = {
  loginValidator,
  activateAccountValidator,
  setPasswordValidator,
  verifyMfaValidator,
};
