const multer = require("multer");
const path = require("path");
const { importEmployeesFromBuffer } = require("../services/employeeImportService");
const TravelRequest = require("../models/TravelRequest");
const { notifyFlightBookingSuperAdmins } = require("../services/notificationService");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (![".xlsx", ".xls"].includes(extension)) {
      const error = new Error("Only .xlsx and .xls files are allowed");
      error.statusCode = 400;
      return callback(error);
    }

    return callback(null, true);
  },
});

async function importEmployees(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: "An Excel file is required" });
  }

  const summary = await importEmployeesFromBuffer(req.file.buffer, { sendInvites: true });

  return res.json({
    message: "Employee import completed",
    summary,
  });
}

async function resendApprovedTarNotifications(req, res) {
  const requests = await TravelRequest.find({ status: "approved" })
    .populate("requestedBy", "name email")
    .sort({ createdAt: 1 });
  let emailCount = 0;

  for (const request of requests) {
    const notifications = await notifyFlightBookingSuperAdmins(request);
    emailCount += notifications.filter(Boolean).length;
  }

  return res.json({
    message: "Approved TAR notifications resent",
    requests: requests.length,
    emailCount,
  });
}

module.exports = {
  upload,
  importEmployees,
  resendApprovedTarNotifications,
};
