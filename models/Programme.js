const mongoose = require("mongoose");

const programmeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    originalFileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    // Week Cycle Statuses per PlanSure spec:
    // 1. Uploaded - PDF uploaded, activities extracted, planner hasn't reviewed
    // 2. Meeting Open - Planner confirmed activities, actions can be created
    // 3. Execution - Week is live, owners working on actions
    // 4. Close-Out Eligible - All required actions on GREEN activities done (automatic)
    // 5. Closed - Week is locked forever, read-only
    cycleStatus: {
      type: String,
      enum: ["Uploaded", "Meeting Open", "Execution", "Close-Out Eligible", "Closed"],
      default: "Uploaded",
    },
    // Tracking when cycle was closed
    closedAt: {
      type: Date,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    // Close type: "Normal Close" or "PM Override"
    closeType: {
      type: String,
      enum: ["Normal Close", "PM Override"],
    },
    // Required reason if PM Override was used
    overrideReason: {
      type: String,
    },
    // Week number for this cycle
    weekNumber: {
      type: Number,
    },
    // Flag to indicate if week is locked (read-only)
    isLocked: {
      type: Boolean,
      default: false,
    },
    lookaheadWeeks: {
      type: Number,
      default: 6,
    },
    lookaheadStartDate: {
      type: Date,
      default: Date.now,
    },
    weekZones: [
      {
        weekNumber: Number,
        label: String,
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
            enum: [
              "Not Started",
              "In Progress",
              "Completed",
              "Planned",
              "Forecast",
            ],
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
            type: String,
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
  { timestamps: true },
);

module.exports = mongoose.model("Programme", programmeSchema);
