const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "request_created",
        "request_approved",
        "request_rejected",
        "request_resubmitted",
        "reimbursement_created",
        "reimbursement_updated",
        "reimbursement_resubmitted",
        "reimbursement_approved",
        "reimbursement_rejected",
      ],
      required: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    targetRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TravelRequest",
      default: null,
    },
    targetReimbursement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReimbursementReport",
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

auditLogSchema.index({ targetRequest: 1, timestamp: -1 });
auditLogSchema.index({ targetReimbursement: 1, timestamp: -1 });
auditLogSchema.index({ performedBy: 1, timestamp: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
