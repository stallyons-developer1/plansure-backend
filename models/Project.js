const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phase: {
      type: String,
      required: true,
      enum: [
        "Planning",
        "Design",
        "Pre-Construction",
        "Construction",
        "Commissioning",
        "Handover",
        "Completed",
      ],
    },
    description: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["Active", "On Hold", "Completed", "Cancelled"],
      default: "Active",
    },
    programmes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Programme",
      },
    ],
    team: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Admin",
        },
        role: {
          type: String,
          enum: ["Project Manager", "Planner", "Engineer", "Viewer"],
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    /* MS-05 B6/AC1: whether the planning meeting for the current cycle has
       been opened. Once a programme exists its cycleStatus carries this, but
       the meeting is opened before the upload — and that gap used to live in
       the opener's localStorage, so nobody else saw the cycle had started.
       Cleared when a closed week is acknowledged and the next one begins. */
    meetingOpen: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

projectSchema.index({ name: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ createdBy: 1 });

module.exports = mongoose.model("Project", projectSchema);
