const AuditLog = require("../models/AuditLog");

const ACTION_CATEGORIES = {
  USER_LOGIN: "AUTH",
  USER_LOGOUT: "AUTH",
  USER_LOGIN_FAILED: "AUTH",
  PASSWORD_CHANGED: "AUTH",
  PASSWORD_RESET_REQUESTED: "AUTH",

  USER_CREATED: "USER",
  USER_UPDATED: "USER",
  USER_DELETED: "USER",
  USER_ROLE_CHANGED: "USER",

  PROJECT_CREATED: "PROJECT",
  PROJECT_UPDATED: "PROJECT",
  PROJECT_DELETED: "PROJECT",
  PROJECT_STATUS_CHANGED: "PROJECT",
  PROJECT_TEAM_MEMBER_ADDED: "PROJECT",
  PROJECT_TEAM_MEMBER_REMOVED: "PROJECT",

  PROGRAMME_UPLOADED: "PROGRAMME",
  PROGRAMME_PROCESSED: "PROGRAMME",
  PROGRAMME_UPDATED: "PROGRAMME",
  PROGRAMME_DELETED: "PROGRAMME",
  PROGRAMME_REPROCESSED: "PROGRAMME",

  ACTIVITY_STATUS_CHANGED: "ACTIVITY",
  ACTIVITY_RAG_CHANGED: "ACTIVITY",
  ACTIVITY_UPDATED: "ACTIVITY",

  ACTION_CREATED: "ACTION",
  ACTION_UPDATED: "ACTION",
  ACTION_STATUS_CHANGED: "ACTION",
  ACTION_ASSIGNED: "ACTION",
  ACTION_REASSIGNED: "ACTION",
  ACTION_DELETED: "ACTION",
  ACTION_COMPLETED: "ACTION",
  ACTION_CANCELLED: "ACTION",

  WEEK_CLOSED: "WEEK",
  WEEK_CLOSED_PM_OVERRIDE: "WEEK",
  WEEK_REOPENED: "WEEK",
  CYCLE_STATUS_CHANGED: "WEEK",

  WEEKLY_PLAN_EXPORTED: "EXPORT",
  PLANNER_TODO_EXPORTED: "EXPORT",
  EXPORT_DOWNLOADED: "EXPORT",

  SYSTEM_SETTINGS_CHANGED: "SYSTEM",
  DATA_IMPORTED: "SYSTEM",
  DATA_EXPORTED: "SYSTEM",
};

const getIpAddress = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
};

const getUserAgent = (req) => {
  return req.headers["user-agent"] || "unknown";
};

/**
 * Main audit log function
 * @param {Object} options - Audit log options
 * @param {string} options.action - The action being logged (e.g., "USER_LOGIN")
 * @param {Object} options.req - Express request object (optional, for IP/user agent)
 * @param {Object} options.user - User performing the action
 * @param {string} options.resourceType - Type of resource affected
 * @param {string} options.resourceId - ID of resource affected
 * @param {string} options.resourceName - Name of resource affected
 * @param {Object} options.project - Related project (optional)
 * @param {string} options.description - Human-readable description
 * @param {Object} options.changes - Before/after values for updates
 * @param {Object} options.metadata - Additional metadata
 * @param {string} options.status - SUCCESS, FAILED, or PENDING
 * @param {string} options.errorMessage - Error message if failed
 */
const logAudit = async (options) => {
  try {
    const {
      action,
      req,
      user,
      resourceType,
      resourceId,
      resourceName,
      project,
      description,
      changes,
      metadata,
      status = "SUCCESS",
      errorMessage,
    } = options;

    const category = ACTION_CATEGORIES[action] || "SYSTEM";

    const auditEntry = new AuditLog({
      action,
      category,
      performedBy: user?._id || user?.id,
      performedByName: user?.name,
      performedByEmail: user?.email,
      performedByRole: user?.role,
      resourceType,
      resourceId,
      resourceName,
      project: project?._id || project,
      projectName: project?.name,
      description,
      changes,
      metadata,
      ipAddress: req ? getIpAddress(req) : null,
      userAgent: req ? getUserAgent(req) : null,
      status,
      errorMessage,
    });

    await auditEntry.save();
    return auditEntry;
  } catch (error) {
    console.error("Failed to create audit log:", error);
    return null;
  }
};

const auditLogger = {
  log: logAudit,

  loginSuccess: (req, user) =>
    logAudit({
      action: "USER_LOGIN",
      req,
      user,
      resourceType: "User",
      resourceId: user._id,
      resourceName: user.name,
      description: `${user.name} logged in successfully`,
    }),

  loginFailed: (req, email, reason) =>
    logAudit({
      action: "USER_LOGIN_FAILED",
      req,
      resourceType: "User",
      description: `Failed login attempt for ${email}: ${reason}`,
      metadata: { email },
      status: "FAILED",
      errorMessage: reason,
    }),

  logout: (req, user) =>
    logAudit({
      action: "USER_LOGOUT",
      req,
      user,
      resourceType: "User",
      resourceId: user._id,
      resourceName: user.name,
      description: `${user.name} logged out`,
    }),

  projectCreated: (req, user, project) =>
    logAudit({
      action: "PROJECT_CREATED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Created project "${project.name}"`,
      metadata: { phase: project.phase, status: project.status },
    }),

  projectUpdated: (req, user, project, changes) =>
    logAudit({
      action: "PROJECT_UPDATED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Updated project "${project.name}"`,
      changes,
    }),

  projectStatusChanged: (req, user, project, oldStatus, newStatus) =>
    logAudit({
      action: "PROJECT_STATUS_CHANGED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Changed project "${project.name}" status from ${oldStatus} to ${newStatus}`,
      changes: { before: { status: oldStatus }, after: { status: newStatus } },
    }),

  teamMemberAdded: (req, user, project, member, role) =>
    logAudit({
      action: "PROJECT_TEAM_MEMBER_ADDED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Added ${member.name} as ${role} to project "${project.name}"`,
      metadata: { memberId: member._id, memberName: member.name, role },
    }),

  teamMemberRemoved: (req, user, project, member) =>
    logAudit({
      action: "PROJECT_TEAM_MEMBER_REMOVED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Removed ${member.name} from project "${project.name}"`,
      metadata: { memberId: member._id, memberName: member.name },
    }),

  programmeUploaded: (req, user, programme, project) =>
    logAudit({
      action: "PROGRAMME_UPLOADED",
      req,
      user,
      resourceType: "Programme",
      resourceId: programme._id,
      resourceName: programme.name,
      project,
      description: `Uploaded programme "${programme.name}" to project "${project?.name || "Unknown"}"`,
      metadata: {
        fileName: programme.fileName,
        activityCount: programme.extractedData?.activities?.length || 0,
      },
    }),

  programmeProcessed: (req, user, programme, project) =>
    logAudit({
      action: "PROGRAMME_PROCESSED",
      req,
      user,
      resourceType: "Programme",
      resourceId: programme._id,
      resourceName: programme.name,
      project,
      description: `Processed programme "${programme.name}"`,
      metadata: {
        activityCount: programme.extractedData?.activities?.length || 0,
      },
    }),

  actionCreated: (req, user, action, project) =>
    logAudit({
      action: "ACTION_CREATED",
      req,
      user,
      resourceType: "Action",
      resourceId: action._id,
      resourceName: action.title,
      project,
      description: `Created action "${action.title}"`,
      metadata: {
        priority: action.priority,
        dueDate: action.dueDate,
        assignee: action.assignee?.name,
        linkedActivity: action.linkedActivity?.activityName,
      },
    }),

  actionStatusChanged: (req, user, action, oldStatus, newStatus, project) =>
    logAudit({
      action: "ACTION_STATUS_CHANGED",
      req,
      user,
      resourceType: "Action",
      resourceId: action._id,
      resourceName: action.title,
      project,
      description: `Changed action "${action.title}" status from ${oldStatus} to ${newStatus}`,
      changes: { before: { status: oldStatus }, after: { status: newStatus } },
    }),

  actionCompleted: (req, user, action, project, completionNote) =>
    logAudit({
      action: "ACTION_COMPLETED",
      req,
      user,
      resourceType: "Action",
      resourceId: action._id,
      resourceName: action.title,
      project,
      description: completionNote
        ? `Completed action "${action.title}" — ${completionNote}`
        : `Completed action "${action.title}"`,
      metadata: completionNote ? { completionNote } : undefined,
    }),

  weekClosed: (req, user, weekNumber, project, stats) =>
    logAudit({
      action: "WEEK_CLOSED",
      req,
      user,
      resourceType: "Week",
      resourceName: `Week ${weekNumber}`,
      project,
      description: `Closed Week ${weekNumber} for project "${project?.name || "Unknown"}"`,
      metadata: { weekNumber, stats },
    }),

  weekClosedPMOverride: (req, user, weekNumber, project, reason, stats) =>
    logAudit({
      action: "WEEK_CLOSED_PM_OVERRIDE",
      req,
      user,
      resourceType: "Week",
      resourceName: `Week ${weekNumber}`,
      project,
      description: `PM Override: Closed Week ${weekNumber} for project "${project?.name || "Unknown"}"`,
      metadata: { weekNumber, reason, stats },
    }),

  cycleStatusChanged: (req, user, project, oldStatus, newStatus) =>
    logAudit({
      action: "CYCLE_STATUS_CHANGED",
      req,
      user,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      project,
      description: `Changed cycle status from ${oldStatus} to ${newStatus}`,
      changes: {
        before: { cycleStatus: oldStatus },
        after: { cycleStatus: newStatus },
      },
    }),

  weeklyPlanExported: (req, user, project, weekNumber, activityCount) =>
    logAudit({
      action: "WEEKLY_PLAN_EXPORTED",
      req,
      user,
      resourceType: "Export",
      project,
      description: `Exported Weekly Plan for Week ${weekNumber}`,
      metadata: { weekNumber, activityCount },
    }),

  plannerTodoExported: (req, user, project, weekNumber, actionCount) =>
    logAudit({
      action: "PLANNER_TODO_EXPORTED",
      req,
      user,
      resourceType: "Export",
      project,
      description: `Exported Planner To-Do for Week ${weekNumber}`,
      metadata: { weekNumber, actionCount },
    }),
};

module.exports = auditLogger;
