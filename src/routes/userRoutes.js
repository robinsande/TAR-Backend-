const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/authMiddleware");
const {
  getMe,
  updateMe,
  listUsers,
  createUser,
  updateUserRole,
  listApprovers,
  listPassengers,
} = require("../controllers/userController");

const router = express.Router();

router.use(authenticate);

router.get("/me", asyncHandler(getMe));
router.patch("/me", asyncHandler(updateMe));
router.get("/approvers", asyncHandler(listApprovers));
router.get("/passengers", asyncHandler(listPassengers));
router.post("/", requireRole("admin", "superadmin"), asyncHandler(createUser));
router.patch("/:id/role", requireRole("superadmin"), asyncHandler(updateUserRole));
router.get("/", requireRole("superadmin"), asyncHandler(listUsers));

module.exports = router;
