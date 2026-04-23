const mongoose = require("mongoose");

const activitySchema = mongoose.Schema({
  activityId: { type: String },
  activityName: { type: String },
  originalDuration: { type: Number },
  startDate: { type: String },
  finishDate: { type: String },
  isMilestone: { type: Boolean, default: false },
  ragStatus: {
    type: String,
    enum: ["Green", "Amber", "Red"],
    default: "Green",
  },
  status: { type: String, default: "Ready" },
  owner: { type: String, default: "" },
});

const programmeSchema = mongoose.Schema(
  { activities: [activitySchema] },
  { timestamps: true },
);

module.exports = mongoose.model("Programme", programmeSchema);
