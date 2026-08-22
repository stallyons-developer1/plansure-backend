const mongoose = require("mongoose");

const actionSchema = new mongoose.Schema(
  {
    programme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Programme",
      required: true,
    },
    linkedActivity: {
      activityId: {
        type: String,
        required: true,
      },
      activityName: {
        type: String,
        required: true,
      },
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["Required", "Optional", "Urgent", "Follow-up"],
      default: "Required",
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Medium",
    },
    assignee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    assigneeName: {
      type: String,
      trim: true,
    },
    previousAssignees: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Admin",
        },
        reassignedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["Open", "In Progress", "Completed", "Cancelled", "PM Override"],
      default: "Open",
    },
    // Set only when a PM force-closes this single action. Retained for audit:
    // the review requires who overrode it, when, and why.
    overrideReason: {
      type: String,
      trim: true,
    },
    overriddenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    overriddenAt: {
      type: Date,
    },
    // Set when a person deliberately moves an action off PM Override. The
    // automatic overdue sweep skips these, so a human decision is not undone
    // by the system on the next page load.
    autoOverrideExempt: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    completedAt: {
      type: Date,
    },
    // Optional free-text note captured when the action is completed, so the
    // completion carries context in the action record. Cleared on reopen.
    completionNote: {
      type: String,
      trim: true,
    },
    comments: [
      {
        text: String,
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Admin",
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true },
);

actionSchema.index({ programme: 1, "linkedActivity.activityId": 1 });
actionSchema.index({ assignee: 1, status: 1 });
actionSchema.index({ dueDate: 1 });

module.exports = mongoose.model("Action", actionSchema);
