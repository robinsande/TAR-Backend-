const multer = require("multer");
const path = require("path");
const { importEmployeesFromBuffer } = require("../services/employeeImportService");

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

module.exports = {
  upload,
  importEmployees,
};
