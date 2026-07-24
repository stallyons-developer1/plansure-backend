const mongoose = require("mongoose");

const exportSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Weekly Plan", "Planner To-Do"],
      required: true,
    },
    week: {
      type: String,
      required: true,
    },
    programme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Programme",
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    status: {
      type: String,
      enum: ["Complete", "Pending", "Failed"],
      default: "Complete",
    },
    filePath: {
      type: String,
    },
    fileName: {
      type: String,
    },
    exportData: {
      activitiesCount: Number,
      actionsCount: Number,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Export", exportSchema);
