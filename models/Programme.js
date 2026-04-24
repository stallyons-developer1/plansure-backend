const mongoose = require("mongoose");

const programmeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    originalFileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    // Cycle/Lookahead settings
    cycleStatus: {
      type: String,
      enum: ["Draft", "In Review", "Approved", "Closed"],
      default: "Draft",
    },
    lookaheadWeeks: {
      type: Number,
      default: 6,
    },
    lookaheadStartDate: {
      type: Date,
      default: Date.now,
    },
    // Week zone definitions
    weekZones: [
      {
        weekNumber: Number,
        label: String, // "Week 1", "Week 2", etc.
        category: {
          type: String,
          enum: ["Committed", "Readiness", "Strategic"],
        },
        startDate: Date,
        endDate: Date,
      },
    ],
    extractedData: {
      activities: [
        {
          activityId: String,
          activityName: String,
          duration: String,
          durationDays: Number,
          startDate: String,
          finishDate: String,
          startDateParsed: Date,
          finishDateParsed: Date,
          status: {
            type: String,
            enum: ["Not Started", "In Progress", "Completed", "Planned", "Forecast"],
            default: "Planned",
          },
          activityStatus: {
            type: String,
            enum: ["Ready", "Blocked", "At Risk", "Complete", "Not Ready"],
            default: "Ready",
          },
          ragStatus: {
            type: String,
            enum: ["Red", "Amber", "Green", "Grey"],
            default: "Grey",
          },
          weekZone: {
            type: String, // "Weeks 1-2", "Weeks 3-4", "Weeks 5-6"
          },
          isMilestone: {
            type: Boolean,
            default: false,
          },
          owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
          },
          ownerName: String,
          notes: String,
          dependencies: [String],
          isBlocked: {
            type: Boolean,
            default: false,
          },
          blocker: String,
        },
      ],
      pageCount: {
        type: Number,
      },
      totalActivities: {
        type: Number,
      },
      summary: {
        total: Number,
        completed: Number,
        inProgress: Number,
        planned: Number,
        red: Number,
        amber: Number,
        green: Number,
        blocked: Number,
        atRisk: Number,
        ready: Number,
      },
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "processed", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Programme", programmeSchema);
