const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // What action was performed
    action: {
      type: String,
      required: true,
      enum: [
        // Authentication
        "USER_LOGIN",
        "USER_LOGOUT",
        "USER_LOGIN_FAILED",
        "PASSWORD_CHANGED",
        "PASSWORD_RESET_REQUESTED",

        // User Management
        "USER_CREATED",
        "USER_UPDATED",
        "USER_DELETED",
        "USER_ROLE_CHANGED",

        // Project Management
        "PROJECT_CREATED",
        "PROJECT_UPDATED",
        "PROJECT_DELETED",
        "PROJECT_STATUS_CHANGED",
        "PROJECT_TEAM_MEMBER_ADDED",
        "PROJECT_TEAM_MEMBER_REMOVED",

        // Programme Management
        "PROGRAMME_UPLOADED",
        "PROGRAMME_PROCESSED",
        "PROGRAMME_UPDATED",
        "PROGRAMME_DELETED",
        "PROGRAMME_REPROCESSED",

        // Activity Management
        "ACTIVITY_STATUS_CHANGED",
        "ACTIVITY_RAG_CHANGED",
        "ACTIVITY_UPDATED",

        // Action Management
        "ACTION_CREATED",
        "ACTION_UPDATED",
        "ACTION_STATUS_CHANGED",
        "ACTION_ASSIGNED",
        "ACTION_REASSIGNED",
        "ACTION_DELETED",
        "ACTION_COMPLETED",
        "ACTION_CANCELLED",

        // Week Management
        "WEEK_CLOSED",
        "WEEK_CLOSED_PM_OVERRIDE",
        "WEEK_REOPENED",
        "CYCLE_STATUS_CHANGED",

        // Export Management
        "WEEKLY_PLAN_EXPORTED",
        "PLANNER_TODO_EXPORTED",
        "EXPORT_DOWNLOADED",

        // System
        "SYSTEM_SETTINGS_CHANGED",
        "DATA_IMPORTED",
        "DATA_EXPORTED",
      ],
    },

    // Category for filtering
    category: {
      type: String,
      required: true,
      enum: ["AUTH", "USER", "PROJECT", "PROGRAMME", "ACTIVITY", "ACTION", "WEEK", "EXPORT", "SYSTEM"],
    },

    // Who performed the action
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

    // What resource was affected
    resourceType: {
      type: String,
      enum: ["User", "Project", "Programme", "Activity", "Action", "Week", "Export", "System", null],
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    resourceName: {
      type: String,
    },

    // Related project (for filtering by project)
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    projectName: {
      type: String,
    },

    // Human-readable description
    description: {
      type: String,
      required: true,
    },

    // Detailed changes (for updates)
    changes: {
      before: {
        type: mongoose.Schema.Types.Mixed,
      },
      after: {
        type: mongoose.Schema.Types.Mixed,
      },
    },

    // Additional metadata
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Request context
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },

    // Status of the action
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED", "PENDING"],
      default: "SUCCESS",
    },

    // Error details if failed
    errorMessage: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ project: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
