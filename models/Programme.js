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
    fileData: {
      type: Buffer,
      select: false,
    },
    fileMimeType: {
      type: String,
      default: "application/pdf",
    },
    cycleStatus: {
      type: String,
      enum: [
        "Uploaded",
        "Meeting Open",
        "Execution",
        "Close-Out Eligible",
        "Closed",
      ],
      default: "Uploaded",
    },
    closedAt: {
      type: Date,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    closeType: {
      type: String,
      enum: ["Normal Close", "PM Override"],
    },
    overrideReason: {
      type: String,
    },
    weekNumber: {
      type: Number,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    closedWeeks: [
      {
        weekNumber: Number,
        closedAt: Date,
        closedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Admin",
        },
        closeType: {
          type: String,
          enum: ["Normal Close", "PM Override"],
          default: "Normal Close",
        },
        stats: {
          totalActivities: Number,
          green: Number,
          amber: Number,
          red: Number,
        },
      },
    ],
    totalWeeks: {
      type: Number,
      default: 0,
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
            enum: [
              "Ready",
              "Blocked",
              "At Risk",
              "Complete",
              "Completed",
              "Not Ready",
              "Unassigned",
              "Action Open",
              "Action Overdue",
            ],
            default: "Unassigned",
          },
          ragStatus: {
            type: String,
            enum: ["Red", "Amber", "Green", "Grey", "Blue"],
            default: "Grey",
          },
          assignmentState: {
            type: String,
            enum: ["Unassigned", "NoAction", "ActionAssigned"],
            default: "Unassigned",
          },
          overdueAcknowledged: {
            type: Boolean,
            default: false,
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

programmeSchema.index({ project: 1, cycleStatus: 1 });
programmeSchema.index({ project: 1, status: 1 });
programmeSchema.index({ project: 1, createdAt: -1 });

module.exports = mongoose.model("Programme", programmeSchema);
