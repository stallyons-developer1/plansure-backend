const express = require("express");
const router = express.Router();
const Action = require("../models/Action");
const Programme = require("../models/Programme");
const Notification = require("../models/Notification");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");
const { sendPushForNotification } = require("../services/fcmService");

const checkProgrammeLocked = async (programmeId) => {
  const programme = await Programme.findById(programmeId);
  if (!programme) return { locked: false, error: "Programme not found" };
  return { locked: programme.isLocked, programme };
};

// Helper to parse activity dates
const parseActivityDate = (dateStr) => {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const month = months[match[2]];
  let year = parseInt(match[3]);
  year = year < 50 ? 2000 + year : 1900 + year;
  return new Date(year, month, day);
};

// Check if project has ended (last activity date passed)
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

// Helper function to update linked activity status when action is completed
const updateLinkedActivityStatus = async (programmeId, activityId, isCompleted) => {
  try {
    const programme = await Programme.findById(programmeId);
    if (!programme || !programme.extractedData?.activities) return;

    const activityIndex = programme.extractedData.activities.findIndex(
      (a) => a.activityId === activityId
    );

    if (activityIndex === -1) return;

    if (isCompleted) {
      // Mark activity as Complete and remove blocked/at-risk status
      programme.extractedData.activities[activityIndex].activityStatus = "Complete";
      programme.extractedData.activities[activityIndex].status = "Completed";
      programme.extractedData.activities[activityIndex].ragStatus = "Green";
      programme.extractedData.activities[activityIndex].isBlocked = false;
      programme.extractedData.activities[activityIndex].blocker = "";
    }

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

    // TEMPORARILY COMMENTED OUT FOR TESTING
    // Check if project has ended - no more actions allowed
    // if (checkProjectEnded(programme.extractedData?.activities)) {
    //   return sendError(
    //     res,
    //     "Project has ended. No new actions can be created.",
    //     400,
    //   );
    // }

    if (!["Meeting Open", "Execution"].includes(programme.cycleStatus)) {
      return sendError(
        res,
        `Cannot create actions when cycle status is "${programme.cycleStatus}". Actions can only be created during "Meeting Open" or "Execution" stages.`,
        400,
      );
    }

    // Get assignee name
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
      assignee,
      assigneeName,
      dueDate,
      createdBy: req.admin._id,
    });

    const populatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

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
      .populate("previousAssignees.user", "name email");

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

    return sendSuccess(res, { action });
  } catch (error) {
    console.error(error);
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
      programmeId,
      linkedActivity,
    } = req.body;

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const { locked, programme } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot update actions.",
        403,
      );
    }

    // TEMPORARILY COMMENTED OUT FOR TESTING
    // Check if project has ended - no more actions allowed
    // if (programme && checkProjectEnded(programme.extractedData?.activities)) {
    //   return sendError(
    //     res,
    //     "Project has ended. No actions can be updated.",
    //     400,
    //   );
    // }

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
      // Update assigneeName
      const Admin = require("../models/Admin");
      const newAssigneeUser = await Admin.findById(assignee).select("name");
      action.assigneeName = newAssigneeUser?.name || "";
    }

    if (dueDate) action.dueDate = dueDate;
    if (status) {
      action.status = status;
      if (status === "Completed") {
        action.completedAt = new Date();
        // Update linked activity status to Complete
        if (action.linkedActivity?.activityId) {
          await updateLinkedActivityStatus(
            action.programme,
            action.linkedActivity.activityId,
            true
          );
        }
      } else {
        action.completedAt = null;
      }
    }

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name");

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

    if (req.admin.role !== "admin") {
      if (action.assignee?.toString() !== req.admin._id.toString()) {
        return sendError(
          res,
          "Only the assigned user can complete this action",
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

    // TEMPORARILY COMMENTED OUT FOR TESTING
    // Check if project has ended - no more actions allowed
    // if (programme && checkProjectEnded(programme.extractedData?.activities)) {
    //   return sendError(
    //     res,
    //     "Project has ended. No actions can be modified.",
    //     400,
    //   );
    // }

    const wasCompleted = action.status === "Completed";

    if (action.status === "Completed") {
      action.status = "Open";
      action.completedAt = null;
    } else {
      action.status = "Completed";
      action.completedAt = new Date();
      // Update linked activity status to Complete
      if (action.linkedActivity?.activityId) {
        await updateLinkedActivityStatus(
          action.programme,
          action.linkedActivity.activityId,
          true
        );
      }
    }

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

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

router.delete("/:id", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(
        res,
        "This week is closed and read-only. Cannot delete actions.",
        403,
      );
    }

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
                    { $lt: ["$dueDate", new Date()] },
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
