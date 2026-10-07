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
    /* The single owner account. Modelled as a flag on the admin role rather
       than a fourth role: the client's PM is an admin account, and every
       governance gate in the app already reads role === "admin". Adding a role
       above it would silently exclude the owner from all of them. */
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },
    /* What the account holds, project by project. One person can run one
       programme as its PM and only watch another as a User, which is how the
       client's own teams work.

       `role` and `projects` above are kept in step with this list rather than
       set by hand: `role` is the highest membership held, used to decide where
       a sign-in lands, and `projects` is the set of projects reached. Every
       existing scope check reads those two, so they stay correct without being
       rewritten. A decision about one project reads memberships directly. */
    memberships: [
      {
        project: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Project",
          required: true,
        },
        /*
         * Each project's place is invited for separately, so each carries its
         * own state and its own link. Deliberately no default: memberships
         * written before invitations were split per project have no status at
         * all, and those count as accepted — an absent field must never take
         * access away from somebody who already has it.
         */
        status: {
          type: String,
          enum: ["pending", "active"],
        },
        inviteToken: String,
        inviteTokenExpiry: Date,
        role: {
          type: String,
          enum: ["admin", "planner", "user"],
          required: true,
        },
      },
    ],
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

/*
 * A link for one role's invitation. Every project held at that role shares it,
 * because they are offered in a single email; opening it takes up all of them
 * and leaves the account's other roles untouched.
 */
adminSchema.methods.generateMembershipInviteToken = function (role) {
  const token = crypto.randomBytes(32).toString("hex");
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;

  let stamped = 0;
  (this.memberships || []).forEach((m) => {
    if (m.role !== role || m.status !== "pending") return;
    m.inviteToken = hashed;
    m.inviteTokenExpiry = expiry;
    stamped += 1;
  });

  if (stamped === 0) return null;
  this.markModified("memberships");
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

/* Highest first, so "the strongest role this account holds" is a max. */
const ROLE_RANK = { user: 1, planner: 2, admin: 3 };

/* Anything not explicitly pending counts as taken up — see the note on the
   field. */
const isAccepted = (m) => m.status !== "pending";

/* The role this account holds on one project. A Super Admin reaches every
   project as an admin, which is the whole point of the flag. */
adminSchema.methods.roleOn = function (projectId) {
  if (this.isSuperAdmin) return "admin";
  if (!projectId) return null;
  const target = String(projectId);
  const found = (this.memberships || []).find(
    (m) => isAccepted(m) && String(m.project?._id || m.project) === target,
  );
  return found ? found.role : null;
};

/* Keeps `role` and `projects` as a summary of the memberships, so the scope
   checks written against them stay true. Called before every save. */
adminSchema.methods.syncFromMemberships = function () {
  if (!Array.isArray(this.memberships) || this.memberships.length === 0) return;

  /* Access follows the invitations actually taken up. */
  this.projects = [
    ...new Map(
      this.memberships.filter(isAccepted).map((m) => [
        String(m.project?._id || m.project),
        m.project?._id || m.project,
      ]),
    ).values(),
  ];

  /* The role is what the account has been granted, accepted or not, so a
     Planner whose invitation is still outstanding is listed as a Planner
     rather than dropping to User. */
  this.role = this.memberships.reduce(
    (best, m) =>
      (ROLE_RANK[m.role] || 0) > (ROLE_RANK[best] || 0) ? m.role : best,
    "user",
  );
};

/* Promise-style, like the hashing hook below. Taking a `next` callback here
   broke every save on the model. */
adminSchema.pre("save", async function () {
  if (this.isModified("memberships")) {
    this.syncFromMemberships();
  }
});

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
