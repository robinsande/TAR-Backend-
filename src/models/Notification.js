const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "new_request",
        "passenger_added",
        "approved",
        "rejected",
        "resubmitted",
        "reimbursement_submitted",
        "reimbursement_resubmitted",
        "reimbursement_approved",
        "reimbursement_rejected",
      ],
      required: true,
    },
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TravelRequest",
      default: null,
    },
    reimbursement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReimbursementReport",
      default: null,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
