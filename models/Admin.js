const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const adminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
    },
    name: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["admin", "planner", "user"],
      default: "user",
    },
    status: {
      type: String,
      enum: ["pending", "active", "inactive", "blocked"],
      default: "pending",
    },
    projects: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
      },
    ],
    inviteToken: String,
    inviteTokenExpiry: Date,
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    lastLogin: Date,
    avatar: String,
  },
  { timestamps: true }
);

// Generate invite token
adminSchema.methods.generateInviteToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.inviteToken = crypto.createHash("sha256").update(token).digest("hex");
  this.inviteTokenExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  return token;
};

// Hash password before saving
adminSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("Admin", adminSchema);
