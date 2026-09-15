const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/authMiddleware");
const {
	downloadTravelRequestPdf,
	downloadTravelRequestTemplatePdf,
} = require("../controllers/requestController");

const router = express.Router();

router.use(authenticate);

router.get("/template/pdf", asyncHandler(downloadTravelRequestTemplatePdf));
router.get("/:id/pdf", asyncHandler(downloadTravelRequestPdf));

module.exports = router;
