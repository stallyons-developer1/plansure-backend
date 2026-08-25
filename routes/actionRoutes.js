const express = require("express");
const router = express.Router();
const Action = require("../models/Action");
const Programme = require("../models/Programme");
const Notification = require("../models/Notification");
const Project = require("../models/Project");
const {
  protect,
  adminOnly,
  plannerOnly,
} = require("../middleware/authMiddleware");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");
const { sendPushForNotification } = require("../services/fcmService");
const auditLogger = require("../utils/auditLogger");
const {
  computeGovernanceStatus,
  getCycleEndDate,
  isActionOpen,
  autoOverrideOverdueActions,
  announceCloseOutEligible,
} = require("../utils/governance");
const {
  notifyPlannersIfAllActionsClosed,
} = require("../utils/plannerNotifications");
const {
  sendActionAssignedEmail,
  sendActionStatusChangedEmail,
} = require("../utils/email");

/*
 * Emails a status change to the two people with a stake in it: whoever the
 * action sits with, and whoever raised it. The actor is skipped — they just
 * made the change and do not need telling. Every send is isolated so a mail
 * failure cannot fail the status change, which is already persisted.
 */
const emailStatusChange = async ({
  action,
  previousStatus,
  actor,
  reason,
  project,
}) => {
  if (!previousStatus || previousStatus === action.status) return;

  // programme.project is an unpopulated id at most call sites.
  const projectDoc =
    project && !project.name
      ? await Project.findById(project).select("name")
      : project;

  const seen = new Set();
  const recipients = [];
  for (const person of [action.assignee, action.createdBy]) {
    if (!person?.email) continue;
    const id = String(person._id || person);
    if (seen.has(id) || (actor && id === String(actor._id))) continue;
    seen.add(id);
    recipients.push(person);
  }

  for (const person of recipients) {
    try {
      await sendActionStatusChangedEmail({
        email: person.email,
        name: person.name,
        actionTitle: action.title,
        previousStatus,
        newStatus: action.status,
        reason,
        projectName: projectDoc?.name,
        linkedActivity: action.linkedActivity?.activityName,
        dueDate: action.dueDate,
        changedByName: actor?.name,
        changedByEmail: actor?.email,
      });
    } catch (emailError) {
      console.error("Action status email failed:", emailError);
    }
  }
};

/* Editable fields on an action, captured before and after a PUT so the audit
   entry carries a precise diff. Status and assignee are deliberately excluded:
   they already have their own ACTION_STATUS_CHANGED / ACTION_REASSIGNED events. */
const snapshotEditableFields = (action) => ({
  title: action.title,
  description: action.description,
  type: action.type,
  priority: action.priority,
  dueDate: action.dueDate,
  linkedActivityId: action.linkedActivity?.activityId,
  linkedActivityName: action.linkedActivity?.activityName,
  programme: action.programme,
});

/* Normalise for comparison: Dates by instant, ObjectIds by string, and
   null/undefined/"" all as empty so an untouched blank field is not a change. */
const auditValue = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return value.toString();
};

/* Returns only the fields that actually changed, ready for changes.before/after. */
const diffEditableFields = (before, after) => {
  const changedBefore = {};
  const changedAfter = {};
  for (const key of Object.keys(before)) {
    const from = auditValue(before[key]);
    const to = auditValue(after[key]);
    if (from !== to) {
      changedBefore[key] = from;
      changedAfter[key] = to;
    }
  }
  return { changedBefore, changedAfter, changedKeys: Object.keys(changedAfter) };
};

const checkProgrammeLocked = async (programmeId) => {
  const programme = await Programme.findById(programmeId);
  if (!programme) return { locked: false, error: "Programme not found" };
  return { locked: programme.isLocked, programme };
};

const parseActivityDate = (dateStr) => {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };
  const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const month = months[match[2]];
  let year = parseInt(match[3]);
  year = year < 50 ? 2000 + year : 1900 + year;
  return new Date(year, month, day);
};

const checkProjectEnded = (activities) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let latestFinishDate = null;
  for (const activity of activities || []) {
    const finishDate = parseActivityDate(activity.finishDate);
    if (finishDate && (!latestFinishDate || finishDate > latestFinishDate)) {
      latestFinishDate = finishDate;
    }
  }

  if (!latestFinishDate) return false;

  latestFinishDate.setHours(23, 59, 59, 999);
  return today > latestFinishDate;
};
const updateLinkedActivityStatus = async (programmeId, activityId) => {
  try {
    const programme = await Programme.findById(programmeId);
    if (!programme || !programme.extractedData?.activities) return;

    const activityIndex = programme.extractedData.activities.findIndex(
      (a) => a.activityId === activityId,
    );

    if (activityIndex === -1) return;

    const activity = programme.extractedData.activities[activityIndex];

    if (activity.assignmentState !== "ActionAssigned") {
      activity.assignmentState = "ActionAssigned";
    }

    const allLinkedActions = await Action.find({
      programme: programmeId,
      "linkedActivity.activityId": activityId,
    });

    const derived = computeGovernanceStatus(
      activity,
      allLinkedActions,
      getCycleEndDate(programme),
      new Date(),
    );
    activity.ragStatus = derived.ragStatus;
    activity.activityStatus = derived.activityStatus;
    activity.isBlocked = derived.activityStatus === "Blocked";
    if (derived.activityStatus === "Completed") activity.blocker = "";

    programme.markModified("extractedData.activities");
    await programme.save();
  } catch (error) {
    console.error("Error updating linked activity status:", error);
  }
};

router.post("/", protect, async (req, res) => {
  try {
    const {
      programmeId,
      linkedActivity,
      title,
      description,
      type,
      priority,
      assignee,
      dueDate,
      status,
    } = req.body;

    const errors = validateRequired({ programmeId, title, assignee, dueDate });

    if (!linkedActivity || !linkedActivity.activityId) {
      errors.push({
        field: "linkedActivity",
        message: "Linked activity is required",
      });
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const programme = await Programme.findById(programmeId);
    if (!programme) {
      return sendValidationError(
        res,
        [{ field: "programmeId", message: "Programme not found" }],
        404,
      );
    }

    if (programme.isLocked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot create new actions.",
        403,
      );
    }

    if (!["Meeting Open", "Execution"].includes(programme.cycleStatus)) {
      return sendError(
        res,
        `Cannot create actions when cycle status is "${programme.cycleStatus}". Actions can only be created during "Meeting Open" or "Execution" stages.`,
        400,
      );
    }

    const Admin = require("../models/Admin");
    const assigneeUser = await Admin.findById(assignee).select("name");
    const assigneeName = assigneeUser?.name || "";

    const action = await Action.create({
      programme: programmeId,
      linkedActivity: {
        activityId: linkedActivity.activityId,
        activityName: linkedActivity.activityName,
      },
      title,
      description,
      type: type || "Required",
      priority: priority || "Medium",
      // A new action can only start Open or In Progress; the terminal states
      // are reached by completing, cancelling or overriding it.
      status: ["Open", "In Progress"].includes(status) ? status : "Open",
      assignee,
      assigneeName,
      dueDate,
      createdBy: req.admin._id,
    });

    const linkedIdx = programme.extractedData?.activities?.findIndex(
      (a) => a.activityId === linkedActivity.activityId,
    );
    if (linkedIdx !== undefined && linkedIdx !== -1) {
      const linkedActivityDoc = programme.extractedData.activities[linkedIdx];
      linkedActivityDoc.assignmentState = "ActionAssigned";
      linkedActivityDoc.ragStatus = "Amber";
      linkedActivityDoc.activityStatus = "At Risk";
      programme.markModified("extractedData.activities");
      await programme.save();
    }

    const populatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    await auditLogger.actionCreated(
      req,
      req.admin,
      populatedAction,
      programme.project,
    );

    if (assignee.toString() !== req.admin._id.toString()) {
      await Notification.create({
        recipient: assignee,
        sender: req.admin._id,
        type: "action_assigned",
        title: "New Action Assigned",
        message: `${req.admin.name} assigned you a new action: "${title}"`,
        action: action._id,
        programme: programmeId,
        project: programme.project,
      });

      sendPushForNotification(assignee, "action_assigned", {
        title,
        message: `${req.admin.name} assigned you a new action: "${title}"`,
        actionId: action._id,
        programmeId,
        projectId: programme.project,
      });

      /* Email on top of in-app + push. Isolated: a mail failure must not fail
         the assignment, which has already been written. */
      try {
        if (populatedAction.assignee?.email) {
          const project = programme.project
            ? await Project.findById(programme.project).select("name")
            : null;
          await sendActionAssignedEmail({
            email: populatedAction.assignee.email,
            name: populatedAction.assignee.name,
            actionTitle: populatedAction.title,
            description: populatedAction.description,
            projectName: project?.name,
            linkedActivity: populatedAction.linkedActivity?.activityName,
            type: populatedAction.type,
            priority: populatedAction.priority,
            dueDate: populatedAction.dueDate,
            assignedByName: req.admin.name,
            assignedByEmail: req.admin.email,
          });
        }
      } catch (emailError) {
        console.error("Action assigned email failed:", emailError);
      }

      await Notification.create({
        recipient: req.admin._id,
        sender: req.admin._id,
        type: "action_assigned",
        title: "Action Assigned",
        message: `You assigned "${title}" to ${populatedAction.assignee.name}`,
        action: action._id,
        programme: programmeId,
        project: programme.project,
      });

      sendPushForNotification(req.admin._id, "action_assigned", {
        title: "Action Assigned",
        message: `You assigned "${title}" to ${populatedAction.assignee.name}`,
        actionId: action._id,
        programmeId,
        projectId: programme.project,
      });
    }

    return sendSuccess(
      res,
      { action: populatedAction },
      "Action created successfully",
      201,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const { programmeId, status, priority, assignee } = req.query;

    const filter = {};
    if (programmeId) filter.programme = programmeId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignee) filter.assignee = assignee;

    // Close out anything that ran past its due date before listing.
    if (programmeId) {
      await autoOverrideOverdueActions(Action, programmeId);
    }

    if (req.admin.role !== "admin") {
      filter.$or = [
        { assignee: req.admin._id },
        { "previousAssignees.user": req.admin._id },
        { createdBy: req.admin._id },
      ];
    }

    const actions = await Action.find(filter)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name")
      .populate("previousAssignees.user", "name email")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { actions });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/programme/:programmeId", protect, async (req, res) => {
  try {
    let filter = { programme: req.params.programmeId };

    if (req.admin.role !== "admin") {
      filter = {
        programme: req.params.programmeId,
        $or: [
          { assignee: req.admin._id },
          { "previousAssignees.user": req.admin._id },
          { createdBy: req.admin._id },
        ],
      };
    }

    const actions = await Action.find(filter)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("previousAssignees.user", "name email")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { actions });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/activity/:activityId", protect, async (req, res) => {
  try {
    const { programmeId } = req.query;

    let filter = { "linkedActivity.activityId": req.params.activityId };
    if (programmeId) filter.programme = programmeId;

    if (req.admin.role !== "admin") {
      filter.$or = [
        { assignee: req.admin._id },
        { "previousAssignees.user": req.admin._id },
        { createdBy: req.admin._id },
      ];
    }

    const actions = await Action.find(filter)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("previousAssignees.user", "name email")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { actions });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name project")
      .populate("comments.createdBy", "name email")
      .populate("previousAssignees.user", "name email")
      .populate("overriddenBy", "name email");

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    if (req.admin.role !== "admin") {
      const isCurrentAssignee =
        action.assignee?._id?.toString() === req.admin._id.toString();
      const wasPreviouslyAssigned = action.previousAssignees?.some(
        (pa) => pa.user?._id?.toString() === req.admin._id.toString(),
      );

      if (!isCurrentAssignee && !wasPreviouslyAssigned) {
        return sendError(res, "Access denied", 403);
      }
    }

    // The activity's owner lives on the programme, not the action. Resolve it
    // here so callers without programme data (e.g. the Audit Logs detail view)
    // can show the same Owner field the workspace dialogs do.
    let linkedActivityOwnerName = "";
    if (action.linkedActivity?.activityId) {
      const programme = await Programme.findById(
        action.programme?._id || action.programme,
      )
        .select("extractedData.activities uploadedBy")
        .populate("uploadedBy", "name");

      // Nothing writes activity.ownerName yet, so fall back to whoever
      // uploaded the programme — the same value the workspace shows in its
      // Owner column. Without this the two views disagreed.
      linkedActivityOwnerName =
        programme?.extractedData?.activities?.find(
          (a) => a.activityId === action.linkedActivity.activityId,
        )?.ownerName ||
        programme?.uploadedBy?.name ||
        "";
    }

    return sendSuccess(res, {
      action: { ...action.toObject(), linkedActivityOwnerName },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

/* Update history for one action, drawn from the audit log. Deliberately not
   adminOnly: the audit routes are admin-gated, but a planner viewing an action
   record needs to see how it changed. Access mirrors GET /:id. */
router.get("/:id/history", protect, async (req, res) => {
  try {
    const AuditLog = require("../models/AuditLog");

    const action = await Action.findById(req.params.id).select(
      "assignee previousAssignees",
    );
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    if (req.admin.role !== "admin") {
      const isCurrentAssignee =
        action.assignee?.toString() === req.admin._id.toString();
      const wasPreviouslyAssigned = action.previousAssignees?.some(
        (pa) => pa.user?.toString() === req.admin._id.toString(),
      );
      if (!isCurrentAssignee && !wasPreviouslyAssigned) {
        return sendError(res, "Access denied", 403);
      }
    }

    const entries = await AuditLog.find({
      resourceType: "Action",
      resourceId: req.params.id,
    })
      .sort({ createdAt: -1 })
      .select("action description changes metadata createdAt performedByName")
      .lean();

    return sendSuccess(res, { history: entries });
  } catch (error) {
    console.error("Get action history error:", error);
    return sendError(res, "Server error");
  }
});

router.put("/:id", protect, async (req, res) => {
  try {
    const {
      title,
      description,
      type,
      priority,
      assignee,
      dueDate,
      status,
      overrideReason,
      programmeId,
      linkedActivity,
    } = req.body;

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const oldStatus = action.status;
    const oldAssignee = action.assignee?.toString();
    const beforeEdit = snapshotEditableFields(action);

    const { locked, programme } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot update actions.",
        403,
      );
    }

    if (programmeId) {
      const programme = await Programme.findById(programmeId);
      if (!programme) {
        return sendValidationError(
          res,
          [{ field: "programmeId", message: "Programme not found" }],
          404,
        );
      }
      action.programme = programmeId;
    }

    if (linkedActivity && linkedActivity.activityId) {
      action.linkedActivity = {
        activityId: linkedActivity.activityId,
        activityName:
          linkedActivity.activityName || action.linkedActivity?.activityName,
      };
    }

    if (title) action.title = title;
    if (description !== undefined) action.description = description;
    if (type) action.type = type;
    if (priority) action.priority = priority;

    let wasReassigned = false;
    let previousAssigneeId = null;
    if (assignee && assignee !== action.assignee.toString()) {
      wasReassigned = true;
      previousAssigneeId = action.assignee;
      if (!action.previousAssignees) {
        action.previousAssignees = [];
      }
      const alreadyInList = action.previousAssignees.some(
        (pa) => pa.user.toString() === action.assignee.toString(),
      );
      if (!alreadyInList) {
        action.previousAssignees.push({
          user: action.assignee,
          reassignedAt: new Date(),
        });
      }
      action.assignee = assignee;
      const Admin = require("../models/Admin");
      const newAssigneeUser = await Admin.findById(assignee).select("name");
      action.assigneeName = newAssigneeUser?.name || "";
    }

    if (dueDate) action.dueDate = dueDate;

    // A PM Override reached through the edit form must record the same
    // evidence and attribution as the dedicated override endpoint, or the
    // audit trail would show a force-close with no reason and no actor.
    const isNewOverride =
      status === "PM Override" && oldStatus !== "PM Override";
    if (isNewOverride) {
      const reason = (overrideReason || "").trim();
      if (reason.length < 10) {
        return sendValidationError(res, [
          {
            field: "overrideReason",
            message:
              "A reason of at least 10 characters is required to PM Override an action",
          },
        ]);
      }
      action.overrideReason = reason;
      action.overriddenBy = req.admin._id;
      action.overriddenAt = new Date();
    } else if (status === "PM Override" && overrideReason !== undefined) {
      // Already overridden: allow the evidence to be corrected.
      action.overrideReason = (overrideReason || "").trim();
    } else if (status && status !== "PM Override" && oldStatus === "PM Override") {
      // Reverted off an override: drop the evidence and attribution so a stale
      // reason cannot resurface. The ACTION_PM_OVERRIDE audit entry still holds
      // the original record.
      action.overrideReason = undefined;
      action.overriddenBy = undefined;
      action.overriddenAt = undefined;
      // A person has decided this action is live again, so exempt it from the
      // automatic overdue sweep — otherwise the next page load would re-close
      // it and the change would appear not to have saved.
      action.autoOverrideExempt = true;
    }

    if (status) {
      action.status = status;
      if (status === "Completed") {
        action.completedAt = new Date();
        if (action.linkedActivity?.activityId) {
          await updateLinkedActivityStatus(
            action.programme,
            action.linkedActivity.activityId,
            true,
          );
        }
      } else {
        action.completedAt = null;
      }
    }

    await action.save();

    // Announce to planners once nothing is left open on this programme.
    try {
      await notifyPlannersIfAllActionsClosed({
        programmeId: action.programme,
        sender: req.admin,
      });
    } catch (notifyError) {
      console.error("All-actions-closed notification failed:", notifyError);
    }

    // Closing an action can be what makes the week close-out eligible.
    try {
      await announceCloseOutEligible(action.programme);
    } catch (notifyError) {
      console.error("Close-out eligible announcement failed:", notifyError);
    }

    /*
     * Reopening a required action revokes close-out eligibility. Without this a
     * week that qualified while everything was closed stays "Close-Out
     * Eligible" — still offering "Close & Lock Week" — even though work is
     * outstanding again.
     */
    if (
      isActionOpen(action) &&
      action.type === "Required" &&
      programme?.cycleStatus === "Close-Out Eligible"
    ) {
      programme.cycleStatus = "Execution";
      await programme.save();

      try {
        await auditLogger.log({
          action: "CYCLE_STATUS_CHANGED",
          req,
          user: req.admin,
          resourceType: "Programme",
          resourceId: programme._id,
          resourceName: programme.name,
          project: programme.project,
          description: `Close-out eligibility revoked for "${programme.name}": required action "${action.title}" was reopened.`,
          changes: {
            before: { cycleStatus: "Close-Out Eligible" },
            after: { cycleStatus: "Execution" },
          },
          metadata: { actionId: action._id, actionTitle: action.title },
        });
      } catch (auditError) {
        console.error("Audit log failed (eligibility revoked):", auditError);
      }
    }

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name");

    // Record the edit itself. Without this a corrected due date, retitle or
    // priority change left no trace at all — only status and assignee did.
    const { changedBefore, changedAfter, changedKeys } = diffEditableFields(
      beforeEdit,
      snapshotEditableFields(action),
    );
    if (changedKeys.length > 0) {
      await auditLogger.log({
        action: "ACTION_UPDATED",
        req,
        user: req.admin,
        resourceType: "Action",
        resourceId: updatedAction._id,
        resourceName: updatedAction.title,
        project: programme?.project,
        description: `Updated action "${updatedAction.title}" — changed ${changedKeys.join(", ")}`,
        changes: { before: changedBefore, after: changedAfter },
        metadata: {
          fieldsChanged: changedKeys,
          linkedActivity: updatedAction.linkedActivity?.activityName,
        },
      });
    }

    if (isNewOverride) {
      await auditLogger.log({
        action: "ACTION_PM_OVERRIDE",
        category: "ACTION",
        req,
        user: req.admin,
        resourceType: "Action",
        resourceId: updatedAction._id,
        resourceName: updatedAction.title,
        project: programme?.project,
        description: `PM Override force-closed action "${updatedAction.title}". Reason: ${action.overrideReason}`,
        changes: {
          before: { status: oldStatus },
          after: { status: "PM Override" },
        },
        metadata: {
          overrideReason: action.overrideReason,
          overriddenAt: action.overriddenAt,
          linkedActivity: updatedAction.linkedActivity?.activityName,
        },
      });
    }

    if (status && status !== oldStatus) {
      await emailStatusChange({
        action: updatedAction,
        previousStatus: oldStatus,
        actor: req.admin,
        reason: isNewOverride ? action.overrideReason : undefined,
        project: programme?.project,
      });

      await auditLogger.actionStatusChanged(
        req,
        req.admin,
        updatedAction,
        oldStatus,
        status,
        programme?.project,
      );
    }
    if (wasReassigned) {
      const Admin = require("../models/Admin");
      const oldAssigneeUser = await Admin.findById(oldAssignee).select("name");
      await auditLogger.log({
        action: "ACTION_REASSIGNED",
        req,
        user: req.admin,
        resourceType: "Action",
        resourceId: updatedAction._id,
        resourceName: updatedAction.title,
        project: programme?.project,
        description: `Reassigned action "${updatedAction.title}" from ${oldAssigneeUser?.name || "Unknown"} to ${updatedAction.assignee?.name}`,
        metadata: {
          previousAssignee: oldAssigneeUser?.name,
          newAssignee: updatedAction.assignee?.name,
        },
      });
    }

    if (wasReassigned && assignee !== req.admin._id.toString()) {
      const programmeForNotif = await Programme.findById(action.programme);
      await Notification.create({
        recipient: assignee,
        sender: req.admin._id,
        type: "action_reassigned",
        title: "Action Reassigned to You",
        message: `${req.admin.name} reassigned an action to you: "${action.title}"`,
        action: action._id,
        programme: action.programme,
        project: programmeForNotif?.project,
      });

      sendPushForNotification(assignee, "action_reassigned", {
        title: action.title,
        message: `${req.admin.name} reassigned an action to you: "${action.title}"`,
        actionId: action._id,
        programmeId: action.programme,
        projectId: programmeForNotif?.project,
      });

      try {
        if (updatedAction.assignee?.email) {
          const project = programmeForNotif?.project
            ? await Project.findById(programmeForNotif.project).select("name")
            : null;
          await sendActionAssignedEmail({
            email: updatedAction.assignee.email,
            name: updatedAction.assignee.name,
            actionTitle: updatedAction.title,
            description: updatedAction.description,
            projectName: project?.name,
            linkedActivity: updatedAction.linkedActivity?.activityName,
            type: updatedAction.type,
            priority: updatedAction.priority,
            dueDate: updatedAction.dueDate,
            assignedByName: req.admin.name,
            assignedByEmail: req.admin.email,
            isReassignment: true,
          });
        }
      } catch (emailError) {
        console.error("Action reassigned email failed:", emailError);
      }
    }

    return sendSuccess(
      res,
      { action: updatedAction },
      "Action updated successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/comments", protect, async (req, res) => {
  try {
    const { text } = req.body;

    const errors = validateRequired({ text });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot add comments.",
        403,
      );
    }

    action.comments.push({
      text,
      createdBy: req.admin._id,
    });

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("comments.createdBy", "name email");

    return sendSuccess(
      res,
      { action: updatedAction },
      "Comment added successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/:id/complete", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    /* Admins aside, the action can be closed by the person it sits with or by
       whoever raised it: a planner who assigns work to another planner still
       owns the outcome and needs to be able to complete it. */
    if (req.admin.role !== "admin") {
      const actorId = req.admin._id.toString();
      const isAssignee = action.assignee?.toString() === actorId;
      const isCreator = action.createdBy?.toString() === actorId;
      if (!isAssignee && !isCreator) {
        return sendError(
          res,
          "Only the assignee or the person who raised this action can complete it",
          403,
        );
      }
    }

    const { locked, programme } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot modify actions.",
        403,
      );
    }

    /* PM Override is terminal. Reopening one is a deliberate decision made
       through the edit path, which records it and exempts the action from the
       automatic sweep — it is not something completion should do silently. */
    if (action.status === "PM Override") {
      return sendError(
        res,
        "This action was force-closed by PM Override and cannot be completed.",
        400,
      );
    }

    const wasCompleted = action.status === "Completed";

    // Optional: the person completing the action can say how it was resolved.
    const rawNote = req.body?.reason;
    const completionNote =
      typeof rawNote === "string" && rawNote.trim() ? rawNote.trim() : null;

    if (action.status === "Completed") {
      action.status = "Open";
      action.completedAt = null;
      // Reopening discards the note; it described a completion that no
      // longer stands.
      action.completionNote = undefined;
      if (action.linkedActivity?.activityId) {
        await updateLinkedActivityStatus(
          action.programme,
          action.linkedActivity.activityId,
          false,
        );
      }
    } else {
      action.status = "Completed";
      action.completedAt = new Date();
      action.completionNote = completionNote || undefined;
      if (action.linkedActivity?.activityId) {
        await updateLinkedActivityStatus(
          action.programme,
          action.linkedActivity.activityId,
          true,
        );
      }
    }

    await action.save();

    // Announce to planners once nothing is left open on this programme.
    try {
      await notifyPlannersIfAllActionsClosed({
        programmeId: action.programme,
        sender: req.admin,
      });
    } catch (notifyError) {
      console.error("All-actions-closed notification failed:", notifyError);
    }

    // Closing an action can be what makes the week close-out eligible.
    try {
      await announceCloseOutEligible(action.programme);
    } catch (notifyError) {
      console.error("Close-out eligible announcement failed:", notifyError);
    }

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    await emailStatusChange({
      action: updatedAction,
      previousStatus: wasCompleted ? "Completed" : "Open",
      actor: req.admin,
      reason: completionNote,
      project: programme?.project,
    });

    if (!wasCompleted && action.status === "Completed") {
      await auditLogger.actionCompleted(
        req,
        req.admin,
        updatedAction,
        programme?.project,
        completionNote,
      );
    } else if (wasCompleted && action.status === "Open") {
      await auditLogger.actionStatusChanged(
        req,
        req.admin,
        updatedAction,
        "Completed",
        "Open",
        programme?.project,
      );
    }

    if (!wasCompleted && action.status === "Completed") {
      const programmeForNotif = await Programme.findById(action.programme);

      if (action.createdBy?.toString() !== req.admin._id.toString()) {
        await Notification.create({
          recipient: action.createdBy,
          sender: req.admin._id,
          type: "action_completed",
          title: "Action Completed",
          message: `${req.admin.name} completed the action: "${action.title}"`,
          action: action._id,
          programme: action.programme,
          project: programmeForNotif?.project,
        });

        sendPushForNotification(action.createdBy, "action_completed", {
          title: action.title,
          message: `${req.admin.name} completed the action: "${action.title}"`,
          actionId: action._id,
          programmeId: action.programme,
          projectId: programmeForNotif?.project,
        });
      }
    }

    return sendSuccess(
      res,
      { action: updatedAction },
      `Action marked as ${action.status}`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

/* Force-close ONE action. Deliberately scoped to a single action: the previous
   behaviour closed every outstanding action in the week at once, which the
   MS-05 review rejected (B4). Reason is mandatory and the actor is recorded. */
router.patch("/:id/override", protect, plannerOnly, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return sendValidationError(res, [
        { field: "reason", message: "A reason is required for PM Override" },
      ]);
    }

    if (reason.trim().length < 10) {
      return sendValidationError(res, [
        {
          field: "reason",
          message: "Please give a fuller reason (at least 10 characters)",
        },
      ]);
    }

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const { locked, programme } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot override actions.",
        403,
      );
    }

    if (!isActionOpen(action)) {
      return sendError(
        res,
        `This action is already "${action.status}" and cannot be overridden.`,
        400,
      );
    }

    const previousStatus = action.status;
    action.status = "PM Override";
    action.overrideReason = reason.trim();
    action.overriddenBy = req.admin._id;
    action.overriddenAt = new Date();
    await action.save();

    // Announce to planners once nothing is left open on this programme.
    try {
      await notifyPlannersIfAllActionsClosed({
        programmeId: action.programme,
        sender: req.admin,
      });
    } catch (notifyError) {
      console.error("All-actions-closed notification failed:", notifyError);
    }

    // Closing an action can be what makes the week close-out eligible.
    try {
      await announceCloseOutEligible(action.programme);
    } catch (notifyError) {
      console.error("Close-out eligible announcement failed:", notifyError);
    }

    // An override closes the action, so the linked activity must re-derive.
    if (action.linkedActivity?.activityId) {
      await updateLinkedActivityStatus(
        action.programme,
        action.linkedActivity.activityId,
      );
    }

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("overriddenBy", "name email");

    try {
      await auditLogger.log({
        action: "ACTION_PM_OVERRIDE",
        category: "ACTION",
        req,
        user: req.admin,
        resourceType: "Action",
        resourceId: action._id,
        resourceName: action.title,
        project: programme?.project,
        description: `PM Override force-closed action "${action.title}". Reason: ${action.overrideReason}`,
        changes: {
          before: { status: previousStatus },
          after: { status: "PM Override" },
        },
        metadata: {
          overrideReason: action.overrideReason,
          overriddenAt: action.overriddenAt,
          linkedActivity: action.linkedActivity?.activityName,
          assignee: action.assigneeName,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed (action PM override):", auditError);
    }

    // Tell the assignee their action was force-closed and why.
    if (action.assignee?.toString() !== req.admin._id.toString()) {
      await Notification.create({
        recipient: action.assignee,
        sender: req.admin._id,
        type: "general",
        title: "Action Closed by PM Override",
        message: `${req.admin.name} force-closed "${action.title}". Reason: ${action.overrideReason}`,
        action: action._id,
        programme: action.programme,
        project: programme?.project,
      });

      sendPushForNotification(action.assignee, "general", {
        title: "Action Closed by PM Override",
        message: `${req.admin.name} force-closed "${action.title}"`,
        actionId: action._id,
        programmeId: action.programme,
        projectId: programme?.project,
      });
    }

    await emailStatusChange({
      action: updatedAction,
      previousStatus,
      actor: req.admin,
      reason: action.overrideReason,
      project: programme?.project,
    });

    return sendSuccess(
      res,
      { action: updatedAction },
      "Action closed via PM Override",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id).populate(
      "programme",
      "project",
    );

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const { locked } = await checkProgrammeLocked(
      action.programme._id || action.programme,
    );
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot delete actions.",
        403,
      );
    }

    await auditLogger.log({
      action: "ACTION_DELETED",
      req,
      user: req.admin,
      resourceType: "Action",
      resourceId: action._id,
      resourceName: action.title,
      project: action.programme?.project,
      description: `Deleted action "${action.title}"`,
      metadata: {
        linkedActivity: action.linkedActivity?.activityName,
        status: action.status,
        priority: action.priority,
      },
    });

    await Action.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "Action deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/stats/summary", protect, async (req, res) => {
  try {
    const { programmeId } = req.query;

    const filter = {};
    if (programmeId) filter.programme = programmeId;

    if (req.admin.role !== "admin") {
      filter.$or = [
        { assignee: req.admin._id },
        { "previousAssignees.user": req.admin._id },
      ];
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const stats = await Action.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          open: {
            $sum: { $cond: [{ $eq: ["$status", "Open"] }, 1, 0] },
          },
          inProgress: {
            $sum: { $cond: [{ $eq: ["$status", "In Progress"] }, 1, 0] },
          },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $lt: ["$dueDate", startOfToday] },
                    { $ne: ["$status", "Completed"] },
                    { $ne: ["$status", "Cancelled"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          highPriority: {
            $sum: {
              $cond: [{ $in: ["$priority", ["High", "Critical"]] }, 1, 0],
            },
          },
        },
      },
    ]);

    return sendSuccess(res, {
      stats: stats[0] || {
        total: 0,
        open: 0,
        inProgress: 0,
        completed: 0,
        overdue: 0,
        highPriority: 0,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
