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
      type: String, // "Week 23"
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
      type: Number, // Score out of 100
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
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    notes: String,
  },
  { timestamps: true }
);

// Index for faster queries
cycleHistorySchema.index({ programme: 1, weekNumber: -1 });

module.exports = mongoose.model("CycleHistory", cycleHistorySchema);
