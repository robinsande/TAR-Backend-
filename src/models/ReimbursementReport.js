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
      enum: ["pending", "approved", "rejected"],
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
      required: true,
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
      enum: ["pending", "approved", "rejected"],
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
