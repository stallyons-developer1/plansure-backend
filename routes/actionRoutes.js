const express = require("express");
const router = express.Router();
const Action = require("../models/Action");
const Programme = require("../models/Programme");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");

// Helper to check if programme is locked (read-only)
const checkProgrammeLocked = async (programmeId) => {
  const programme = await Programme.findById(programmeId);
  if (!programme) return { locked: false, error: "Programme not found" };
  return { locked: programme.isLocked, programme };
};

// Allow admin and planner to create actions
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

    // Check if week is closed (read-only)
    if (programme.isLocked) {
      return sendError(res, "This week is closed and read-only. Cannot create new actions.", 403);
    }

    // Check if cycle status allows action creation (only in Meeting Open or Execution)
    if (!["Meeting Open", "Execution"].includes(programme.cycleStatus)) {
      return sendError(
        res,
        `Cannot create actions when cycle status is "${programme.cycleStatus}". Actions can only be created during "Meeting Open" or "Execution" stages.`,
        400
      );
    }

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
      dueDate,
      createdBy: req.admin._id,
    });

    const populatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

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

    // If non-admin, filter actions by user's assigned projects
    if (req.admin.role !== "admin") {
      const userProjects = req.admin.projects || [];

      if (userProjects.length === 0) {
        return sendSuccess(res, { actions: [] });
      }

      // Get programmes for user's projects
      const programmes = await Programme.find({ project: { $in: userProjects } }).select("_id");
      const programmeIds = programmes.map((p) => p._id);

      if (programmeIds.length === 0) {
        return sendSuccess(res, { actions: [] });
      }

      filter.programme = { $in: programmeIds };
    }

    const actions = await Action.find(filter)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { actions });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/programme/:programmeId", protect, async (req, res) => {
  try {
    // Check if non-admin user has access to this programme's project
    if (req.admin.role !== "admin") {
      const programme = await Programme.findById(req.params.programmeId);
      if (programme && programme.project) {
        const userProjects = req.admin.projects || [];
        const hasAccess = userProjects.some(
          (p) => p.toString() === programme.project.toString()
        );
        if (!hasAccess) {
          return sendError(res, "Access denied", 403);
        }
      }
    }

    const actions = await Action.find({ programme: req.params.programmeId })
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
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

    const filter = { "linkedActivity.activityId": req.params.activityId };
    if (programmeId) filter.programme = programmeId;

    // Check if non-admin user has access
    if (req.admin.role !== "admin" && programmeId) {
      const programme = await Programme.findById(programmeId);
      if (programme && programme.project) {
        const userProjects = req.admin.projects || [];
        const hasAccess = userProjects.some(
          (p) => p.toString() === programme.project.toString()
        );
        if (!hasAccess) {
          return sendError(res, "Access denied", 403);
        }
      }
    }

    const actions = await Action.find(filter)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
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
      .populate("comments.createdBy", "name email");

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    // Check if non-admin user has access to this action's programme's project
    if (req.admin.role !== "admin" && action.programme && action.programme.project) {
      const userProjects = req.admin.projects || [];
      const hasAccess = userProjects.some(
        (p) => p.toString() === action.programme.project.toString()
      );
      if (!hasAccess) {
        return sendError(res, "Access denied", 403);
      }
    }

    return sendSuccess(res, { action });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Allow admin and planner to update actions
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

    // Check if the action's programme is locked
    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(res, "This week is closed and read-only. Cannot update actions.", 403);
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
    if (assignee) action.assignee = assignee;
    if (dueDate) action.dueDate = dueDate;
    if (status) {
      action.status = status;
      if (status === "Completed") {
        action.completedAt = new Date();
      } else {
        action.completedAt = null;
      }
    }

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name");

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

// Allow admin and planner to add comments
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

    // Check if the action's programme is locked
    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(res, "This week is closed and read-only. Cannot add comments.", 403);
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

// Allow admin and planner to toggle complete status
router.patch("/:id/complete", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    // Check if the action's programme is locked
    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(res, "This week is closed and read-only. Cannot modify actions.", 403);
    }

    if (action.status === "Completed") {
      action.status = "Open";
      action.completedAt = null;
    } else {
      action.status = "Completed";
      action.completedAt = new Date();
    }

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

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

// Allow admin and planner to delete actions
router.delete("/:id", protect, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    // Check if the action's programme is locked
    const { locked } = await checkProgrammeLocked(action.programme);
    if (locked) {
      return sendError(res, "This week is closed and read-only. Cannot delete actions.", 403);
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

    // If non-admin, filter by user's assigned projects
    if (req.admin.role !== "admin" && !programmeId) {
      const userProjects = req.admin.projects || [];
      if (userProjects.length === 0) {
        return sendSuccess(res, {
          stats: { total: 0, open: 0, inProgress: 0, completed: 0, overdue: 0, highPriority: 0 },
        });
      }
      const programmes = await Programme.find({ project: { $in: userProjects } }).select("_id");
      const programmeIds = programmes.map((p) => p._id);
      filter.programme = { $in: programmeIds };
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
