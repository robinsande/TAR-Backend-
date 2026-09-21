const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDirectory = path.resolve(__dirname, "../../uploads/requests");
fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
  },
});

const uploadRequestAttachments = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

module.exports = {
  uploadDirectory,
  uploadRequestAttachments,
};