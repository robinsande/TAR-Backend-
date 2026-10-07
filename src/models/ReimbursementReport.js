const mongoose = require("mongoose");

const decisionSchema = new mongoose.Schema(
  {
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    comment: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "rejected",
        "SUPERVISOR_DECLINED",
        "LINE_MANAGER_DECLINED",
        "FINANCE_DECLINED",
      ],
      required: true,
    },
    decision: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    editedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const reimbursementReportSchema = new mongoose.Schema(
  {
    travelRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TravelRequest",
      required: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    selected_approver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lineManagerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    financeAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    financeCcAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    requesterSignedName: { type: String, trim: true, default: null },
    requesterSignedAt: { type: Date, default: Date.now },
    requesterSignature: { type: String, trim: true, default: null },
    paymentRequestPurpose: { type: String, trim: true, default: null },
    paymentDetails: {
      paymentMethod: {
        type: String,
        enum: ["cheque", "bank_transfer", "safe_cash"],
        default: "bank_transfer",
      },
      chequeNumber: { type: String, trim: true, default: "" },
      pickedUpBy: { type: String, trim: true, default: "" },
      mailedTo: { type: String, trim: true, default: "" },
      mobileNumber: { type: String, trim: true, default: "" },
      bankName: { type: String, trim: true, default: "" },
      bankAddress: { type: String, trim: true, default: "" },
      bankAccountNumber: { type: String, trim: true, default: "" },
      swiftCode: { type: String, trim: true, default: "" },
      beneficiaryName: { type: String, trim: true, default: "" },
      sortCode: { type: String, trim: true, default: "" },
      intermediaryBankAddress: { type: String, trim: true, default: "" },
      intermediaryBankAccountNumber: { type: String, trim: true, default: "" },
      intermediarySwiftAba: { type: String, trim: true, default: "" },
    },
    supervisorSignedName: { type: String, trim: true, default: null },
    lineManagerSignedName: { type: String, trim: true, default: null },
    financeSignedName: { type: String, trim: true, default: null },
    attachments: {
      type: [{
        category: {
          type: String,
          enum: ["financial", "supervisor", "line_manager"],
          required: true,
        },
        originalName: { type: String, required: true, trim: true },
        storageId: { type: String, required: true, trim: true },
        mimeType: { type: String, required: true, trim: true },
        size: { type: Number, required: true, min: 1 },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        uploadedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    approvalHistory: {
      type: [{
        approvalLevel: {
          type: String,
          enum: ["SYSTEM", "SUPERVISOR", "LINE_MANAGER", "FINANCE_ADMIN"],
          required: true,
        },
        action: { type: String, required: true, trim: true },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        performedByRole: { type: String, required: true, trim: true },
        resultingStatus: { type: String, trim: true, default: null },
        occurredAt: { type: Date, default: Date.now },
        comments: { type: String, trim: true, default: null },
        reason: { type: String, trim: true, default: null },
        ipAddress: { type: String, trim: true, default: null },
      }],
      default: [],
    },
    employeeNumber: {
      type: String,
      trim: true,
      required: true,
    },
    department: {
      type: String,
      trim: true,
      required: true,
    },
    position: {
      type: String,
      trim: true,
      required: true,
    },
    baseLocation: {
      type: String,
      trim: true,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "rejected",
        "DRAFT",
        "SUBMITTED_TO_SUPERVISOR",
        "SUPERVISOR_REVIEW",
        "SUPERVISOR_APPROVED",
        "SUPERVISOR_DECLINED",
        "SUBMITTED_TO_LINE_MANAGER",
        "LINE_MANAGER_REVIEW",
        "LINE_MANAGER_APPROVED",
        "LINE_MANAGER_DECLINED",
        "SUBMITTED_TO_FINANCE",
        "FINANCE_REVIEW",
        "FINANCE_APPROVED",
        "FINANCE_DECLINED",
        "PAYMENT_PROCESSING",
        "COMPLETED",
      ],
      default: "pending",
    },
    totalAmountKsh: {
      type: mongoose.Schema.Types.Decimal128,
      default: () => mongoose.Types.Decimal128.fromString("0"),
      get: (value) => (value ? parseFloat(value.toString()) : 0),
    },
    decision: {
      type: decisionSchema,
      default: () => ({}),
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    history: {
      type: [historySchema],
      default: [],
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    supervisorApprovedAt: { type: Date, default: null },
    supervisorApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    supervisorDeclinedAt: { type: Date, default: null },
    supervisorDeclinedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    supervisorDeclineReason: { type: String, trim: true, default: null },
    lineManagerApprovedAt: { type: Date, default: null },
    lineManagerApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lineManagerDeclinedAt: { type: Date, default: null },
    lineManagerDeclinedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lineManagerDeclineReason: { type: String, trim: true, default: null },
    financeApprovedAt: { type: Date, default: null },
    financeApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    financeDeclinedAt: { type: Date, default: null },
    financeDeclinedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    financeDeclineReason: { type: String, trim: true, default: null },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

reimbursementReportSchema.index(
  { travelRequest: 1, submittedBy: 1 },
  { unique: true }
);
reimbursementReportSchema.index({ submittedBy: 1, createdAt: -1 });
reimbursementReportSchema.index({ selected_approver_id: 1, status: 1 });
reimbursementReportSchema.index({ supervisorId: 1, status: 1 });
reimbursementReportSchema.index({ lineManagerId: 1, status: 1 });
reimbursementReportSchema.index({ financeAdminId: 1, status: 1 });

reimbursementReportSchema.pre(
  ["findOneAndDelete", "deleteOne"],
  { document: true, query: false },
  async function deleteLinkedLineItems() {
    const ExpenseLineItem = mongoose.model("ExpenseLineItem");
    await ExpenseLineItem.deleteMany({ report: this._id });
  }
);

reimbursementReportSchema.pre("findOneAndDelete", async function deleteLineItemsForQuery() {
  const doc = await this.model.findOne(this.getFilter()).select("_id");
  if (doc) {
    const ExpenseLineItem = mongoose.model("ExpenseLineItem");
    await ExpenseLineItem.deleteMany({ report: doc._id });
  }
});

module.exports = mongoose.model("ReimbursementReport", reimbursementReportSchema);
