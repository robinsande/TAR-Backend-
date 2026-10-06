const mongoose = require("mongoose");

const budgetHolderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    fundCode: { type: String, trim: true, default: null },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

budgetHolderSchema.index({ email: 1, fundCode: 1 }, { unique: true });
budgetHolderSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model("BudgetHolder", budgetHolderSchema);
