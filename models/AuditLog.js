const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "USER_LOGIN",
        "USER_LOGOUT",
        "USER_LOGIN_FAILED",
        "PASSWORD_CHANGED",
        "PASSWORD_RESET_REQUESTED",

        "USER_CREATED",
        "USER_UPDATED",
        "USER_DELETED",
        "USER_ROLE_CHANGED",

        "PROJECT_CREATED",
        "PROJECT_UPDATED",
        "PROJECT_DELETED",
        "PROJECT_STATUS_CHANGED",
        "PROJECT_TEAM_MEMBER_ADDED",
        "PROJECT_TEAM_MEMBER_REMOVED",

        "PROGRAMME_UPLOADED",
        "PROGRAMME_PROCESSED",
        "PROGRAMME_UPDATED",
        "PROGRAMME_DELETED",
        "PROGRAMME_REPROCESSED",

        "ACTIVITY_STATUS_CHANGED",
        "ACTIVITY_RAG_CHANGED",
        "ACTIVITY_UPDATED",

        "ACTION_CREATED",
        "ACTION_UPDATED",
        "ACTION_STATUS_CHANGED",
        "ACTION_ASSIGNED",
        "ACTION_REASSIGNED",
        "ACTION_DELETED",
        "ACTION_COMPLETED",
        "ACTION_CANCELLED",
        "ACTION_PM_OVERRIDE",

        "WEEK_CLOSED",
        "WEEK_CLOSED_PM_OVERRIDE",
        "WEEK_REOPENED",
        "CYCLE_STATUS_CHANGED",

        "WEEKLY_PLAN_EXPORTED",
        "PLANNER_TODO_EXPORTED",
        "EXPORT_DOWNLOADED",

        "SYSTEM_SETTINGS_CHANGED",
        "DATA_IMPORTED",
        "DATA_EXPORTED",
      ],
    },

    category: {
      type: String,
      required: true,
      enum: [
        "AUTH",
        "USER",
        "PROJECT",
        "PROGRAMME",
        "ACTIVITY",
        "ACTION",
        "WEEK",
        "EXPORT",
        "SYSTEM",
      ],
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    performedByName: {
      type: String,
    },
    performedByEmail: {
      type: String,
    },
    performedByRole: {
      type: String,
    },

    resourceType: {
      type: String,
      enum: [
        "User",
        "Project",
        "Programme",
        "Activity",
        "Action",
        "Week",
        "Export",
        "System",
        null,
      ],
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    resourceName: {
      type: String,
    },

    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    projectName: {
      type: String,
    },

    description: {
      type: String,
      required: true,
    },

    changes: {
      before: {
        type: mongoose.Schema.Types.Mixed,
      },
      after: {
        type: mongoose.Schema.Types.Mixed,
      },
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },

    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },

    status: {
      type: String,
      enum: ["SUCCESS", "FAILED", "PENDING"],
      default: "SUCCESS",
    },

    errorMessage: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ project: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
