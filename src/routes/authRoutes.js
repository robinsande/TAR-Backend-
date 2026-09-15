const express = require("express");
const rateLimit = require("express-rate-limit");
const asyncHandler = require("../utils/asyncHandler");
const { login, activateAccount, setPassword } = require("../controllers/authController");
const {
  loginValidator,
  activateAccountValidator,
  setPasswordValidator,
} = require("../validators/authValidators");
const { validationErrorHandler } = require("../middleware/errorHandler");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts. Please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

router.use(authLimiter);

router.post("/login", ...loginValidator, validationErrorHandler, asyncHandler(login));
router.post(
  "/activate",
  ...activateAccountValidator,
  validationErrorHandler,
  asyncHandler(activateAccount)
);
router.post(
  "/set-password",
  ...setPasswordValidator,
  validationErrorHandler,
  asyncHandler(setPassword)
);

module.exports = router;
