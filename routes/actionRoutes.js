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

// @route   POST /api/actions
// @desc    Create a new action
// @access  Private (Admin only)
router.post("/", protect, adminOnly, async (req, res) => {
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

    // Validate required fields
    const errors = validateRequired({ programmeId, title, assignee, dueDate });

    // Validate linkedActivity
    if (!linkedActivity || !linkedActivity.activityId) {
      errors.push({ field: "linkedActivity", message: "Linked activity is required" });
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    // Verify programme exists
    const programme = await Programme.findById(programmeId);
    if (!programme) {
      return sendValidationError(res, [
        { field: "programmeId", message: "Programme not found" },
      ], 404);
    }

    // Create action
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
      201
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/actions
// @desc    Get all actions (with filters)
// @access  Private (Admin only)
router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId, status, priority, assignee } = req.query;

    // Build filter
    const filter = {};
    if (programmeId) filter.programme = programmeId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignee) filter.assignee = assignee;

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

// @route   GET /api/actions/programme/:programmeId
// @desc    Get all actions for a specific programme
// @access  Private (Admin only)
router.get("/programme/:programmeId", protect, adminOnly, async (req, res) => {
  try {
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

// @route   GET /api/actions/activity/:activityId
// @desc    Get all actions for a specific activity
// @access  Private (Admin only)
router.get("/activity/:activityId", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId } = req.query;

    const filter = { "linkedActivity.activityId": req.params.activityId };
    if (programmeId) filter.programme = programmeId;

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

// @route   GET /api/actions/:id
// @desc    Get single action by ID
// @access  Private (Admin only)
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("programme", "name")
      .populate("comments.createdBy", "name email");

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    return sendSuccess(res, { action });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PUT /api/actions/:id
// @desc    Update an action
// @access  Private (Admin only)
router.put("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { title, description, type, priority, assignee, dueDate, status } =
      req.body;

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    // Update fields
    if (title) action.title = title;
    if (description !== undefined) action.description = description;
    if (type) action.type = type;
    if (priority) action.priority = priority;
    if (assignee) action.assignee = assignee;
    if (dueDate) action.dueDate = dueDate;
    if (status) {
      action.status = status;
      // Set completedAt if status is Completed
      if (status === "Completed") {
        action.completedAt = new Date();
      } else {
        action.completedAt = null;
      }
    }

    await action.save();

    const updatedAction = await Action.findById(action._id)
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    return sendSuccess(res, { action: updatedAction }, "Action updated successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   POST /api/actions/:id/comments
// @desc    Add a comment to an action
// @access  Private (Admin only)
router.post("/:id/comments", protect, adminOnly, async (req, res) => {
  try {
    const { text } = req.body;

    // Validate required fields
    const errors = validateRequired({ text });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const action = await Action.findById(req.params.id);
    if (!action) {
      return sendError(res, "Action not found", 404);
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

    return sendSuccess(res, { action: updatedAction }, "Comment added successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PATCH /api/actions/:id/complete
// @desc    Mark action as completed (quick toggle)
// @access  Private (Admin only)
router.patch("/:id/complete", protect, adminOnly, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    // Toggle completion status
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

    return sendSuccess(res, { action: updatedAction }, `Action marked as ${action.status}`);
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   DELETE /api/actions/:id
// @desc    Delete an action
// @access  Private (Admin only)
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const action = await Action.findById(req.params.id);

    if (!action) {
      return sendError(res, "Action not found", 404);
    }

    await Action.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "Action deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/actions/stats/summary
// @desc    Get action statistics
// @access  Private (Admin only)
router.get("/stats/summary", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId } = req.query;

    const filter = {};
    if (programmeId) filter.programme = programmeId;

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
              $cond: [
                { $in: ["$priority", ["High", "Critical"]] },
                1,
                0,
              ],
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
