const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
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
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    position: {
      type: String,
      trim: true,
      default: null,
    },
    office: {
      type: String,
      trim: true,
      default: null,
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
    role: {
      type: String,
      enum: ["user", "admin", "superadmin"],
      default: "user",
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    managerEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    mustSetPassword: {
      type: Boolean,
      default: false,
    },
    inviteToken: {
      type: String,
      default: null,
    },
    inviteTokenExpires: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ managerId: 1 });
userSchema.index({ role: 1 });

module.exports = mongoose.model("User", userSchema);
