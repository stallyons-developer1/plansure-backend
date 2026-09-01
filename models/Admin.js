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
    /* Only the hash is stored, as with the invite token: a database dump must
       not hand out working reset links. */
    resetPasswordToken: String,
    resetPasswordTokenExpiry: Date,
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    lastLogin: Date,
    avatar: String,
    fcmTokens: [
      {
        token: {
          type: String,
          required: true,
        },
        deviceInfo: {
          type: String,
          default: "Unknown device",
        },
        // Site the token was issued for. Each deployment URL is a separate
        // origin with its own token, so an account signed into several of
        // them would otherwise be pushed to once per deployment.
        origin: {
          type: String,
          default: null,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
        lastUsed: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    pushNotificationsEnabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

adminSchema.methods.generateInviteToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.inviteToken = crypto.createHash("sha256").update(token).digest("hex");
  this.inviteTokenExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return token;
};

/* Short-lived by design. An invite can sit in an inbox for a week because it
   is expected to; a reset link is requested and used in one sitting, and the
   longer it lives the longer a forwarded or logged URL stays usable. */
adminSchema.methods.generatePasswordResetToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
  this.resetPasswordTokenExpiry = Date.now() + 60 * 60 * 1000;
  return token;
};

adminSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("Admin", adminSchema);
