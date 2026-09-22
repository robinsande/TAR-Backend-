const mongoose = require("mongoose");

function getBucket() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB is not connected");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "tarAttachments" });
}

function storeAttachment(file, metadata = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = getBucket().openUploadStream(file.originalname, {
      contentType: file.mimetype || "application/octet-stream",
      metadata,
    });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(String(uploadStream.id)));
    uploadStream.end(file.buffer);
  });
}

function streamAttachment(storageId, res) {
  const id = new mongoose.Types.ObjectId(storageId);
  const downloadStream = getBucket().openDownloadStream(id);
  downloadStream.on("error", (error) => {
    if (!res.headersSent) res.status(404).json({ message: "Attachment file not found" });
  });
  downloadStream.pipe(res);
}

async function deleteAttachment(storageId) {
  const bucket = getBucket();
  await bucket.delete(new mongoose.Types.ObjectId(storageId));
}

module.exports = {
  storeAttachment,
  streamAttachment,
  deleteAttachment,
};
