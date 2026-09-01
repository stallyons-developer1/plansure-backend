const mongoose = require("mongoose");

const cycleHistorySchema = new mongoose.Schema(
  {
    programme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Programme",
      required: true,
    },
    weekNumber: {
      type: Number,
      required: true,
    },
    weekLabel: {
      type: String,
    },
    dateRange: {
      startDate: Date,
      endDate: Date,
    },
    closeType: {
      type: String,
      enum: ["Normal Close", "PM Override", "Auto Close", "Forced Close"],
      default: "Normal Close",
    },
    score: {
      type: Number,
      default: 0,
    },
    stats: {
      totalActivities: Number,
      completed: Number,
      green: Number,
      amber: Number,
      red: Number,
      blocked: Number,
      actionsCompleted: Number,
      actionsTotal: Number,
      /* Force-closed rather than completed. Recorded separately because a week
         closed on overrides is not the same as one closed on delivery, and the
         count is what makes that visible after the fact. */
      actionsOverridden: Number,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    notes: String,
  },
  { timestamps: true },
);

cycleHistorySchema.index({ programme: 1, weekNumber: -1 });

module.exports = mongoose.model("CycleHistory", cycleHistorySchema);
