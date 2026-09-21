const mongoose = require("mongoose");

const passengerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    employeeNumber: {
      type: String,
      trim: true,
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    businessUnit: { type: String, required: true, trim: true },
    fundCode: { type: String, required: true, trim: true },
    projectId: { type: String, required: true, trim: true },
    departmentId: { type: String, required: true, trim: true },
    activityId: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const itinerarySchema = new mongoose.Schema(
  {
    dateFrom: { type: Date, required: true },
    dateTo: { type: Date, required: true },
    destination: { type: String, required: true, trim: true },
    accommodationNeeded: { type: Boolean, default: false },
  },
  { _id: false }
);

const travelSegmentSchema = new mongoose.Schema(
  {
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    destination: { type: String, required: true, trim: true },
    dateFrom: { type: Date, required: true },
    dateTo: { type: Date, required: true },
  },
  { _id: false }
);

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
    signature: {
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

const travelRequestSchema = new mongoose.Schema(
  {
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    selected_approver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    project: {
      type: projectSchema,
      required: true,
    },
    assignedAreaOfOperation: {
      type: String,
      required: true,
      trim: true,
    },
    employeeOffice: {
      type: String,
      trim: true,
      default: null,
    },
    purposeOfTrip: {
      type: String,
      required: true,
      trim: true,
    },
    requesterSignature: {
      type: String,
      trim: true,
      default: null,
    },
    modeOfTravel: {
      careVehicle: { type: Boolean, default: false },
      publicTransport: { type: Boolean, default: false },
      aircraft: { type: Boolean, default: false },
    },
    itinerary: {
      type: itinerarySchema,
      required: true,
    },
    travelSegments: {
      type: [travelSegmentSchema],
      default: [],
    },
    passengers: {
      type: [passengerSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
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
  },
  {
    timestamps: true,
  }
);

travelRequestSchema.index({ requestedBy: 1, createdAt: -1 });
travelRequestSchema.index({ "passengers.user": 1, createdAt: -1 });
travelRequestSchema.index({ selected_approver_id: 1, status: 1 });
travelRequestSchema.index({ status: 1 });
travelRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("TravelRequest", travelRequestSchema);
