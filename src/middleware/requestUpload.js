const multer = require("multer");
const path = require("path");

const uploadDirectory = path.resolve(__dirname, "../../uploads/requests");

const uploadRequestAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

module.exports = {
  uploadDirectory,
  uploadRequestAttachments,
};