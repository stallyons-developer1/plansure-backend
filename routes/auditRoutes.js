const express = require("express");
const router = express.Router();
const AuditLog = require("../models/AuditLog");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");

// GET /api/audit-logs - Get audit logs with filtering and pagination
router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      category,
      action,
      userId,
      projectId,
      startDate,
      endDate,
      search,
    } = req.query;

    const filter = {};

    // Filter by category
    if (category) {
      filter.category = category;
    }

    // Filter by action type
    if (action) {
      filter.action = action;
    }

    // Filter by user who performed the action
    if (userId) {
      filter.performedBy = userId;
    }

    // Filter by project
    if (projectId) {
      filter.project = projectId;
    }

    // Filter by date range
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Search in description or resource name
    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: "i" } },
        { resourceName: { $regex: search, $options: "i" } },
        { performedByName: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("performedBy", "name email")
        .populate("project", "name"),
      AuditLog.countDocuments(filter),
    ]);

    return sendSuccess(res, {
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Get audit logs error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/audit-logs/categories - Get available categories
router.get("/categories", protect, adminOnly, async (req, res) => {
  try {
    const categories = [
      { value: "AUTH", label: "Authentication" },
      { value: "USER", label: "User Management" },
      { value: "PROJECT", label: "Project Management" },
      { value: "PROGRAMME", label: "Programme Management" },
      { value: "ACTIVITY", label: "Activity Management" },
      { value: "ACTION", label: "Action Management" },
      { value: "WEEK", label: "Week Management" },
      { value: "EXPORT", label: "Exports" },
      { value: "SYSTEM", label: "System" },
    ];

    return sendSuccess(res, { categories });
  } catch (error) {
    console.error("Get categories error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/audit-logs/actions - Get available action types
router.get("/actions", protect, adminOnly, async (req, res) => {
  try {
    const actions = await AuditLog.distinct("action");
    return sendSuccess(res, { actions });
  } catch (error) {
    console.error("Get actions error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/audit-logs/stats - Get audit log statistics
router.get("/stats", protect, adminOnly, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const stats = await AuditLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const totalLogs = stats.reduce((sum, s) => sum + s.count, 0);

    // Get recent activity by day
    const activityByDay = await AuditLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Get top users by activity
    const topUsers = await AuditLog.aggregate([
      { $match: { createdAt: { $gte: startDate }, performedBy: { $ne: null } } },
      {
        $group: {
          _id: "$performedBy",
          name: { $first: "$performedByName" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);

    return sendSuccess(res, {
      totalLogs,
      byCategory: stats,
      activityByDay,
      topUsers,
      period: `Last ${days} days`,
    });
  } catch (error) {
    console.error("Get audit stats error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/audit-logs/:id - Get a specific audit log entry
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const log = await AuditLog.findById(req.params.id)
      .populate("performedBy", "name email")
      .populate("project", "name");

    if (!log) {
      return sendError(res, "Audit log not found", 404);
    }

    return sendSuccess(res, { log });
  } catch (error) {
    console.error("Get audit log error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/audit-logs/resource/:type/:id - Get audit logs for a specific resource
router.get("/resource/:type/:id", protect, adminOnly, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const filter = {
      resourceType: type,
      resourceId: id,
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("performedBy", "name email"),
      AuditLog.countDocuments(filter),
    ]);

    return sendSuccess(res, {
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Get resource audit logs error:", error);
    return sendError(res, "Server error");
  }
});

// DELETE /api/audit-logs/all - Delete all audit logs
router.delete("/all", protect, adminOnly, async (req, res) => {
  try {
    const result = await AuditLog.deleteMany({});
    return sendSuccess(res, { deleted: result.deletedCount }, "All audit logs deleted");
  } catch (error) {
    console.error("Delete all audit logs error:", error);
    return sendError(res, "Server error");
  }
});

// DELETE /api/audit-logs/:id - Delete a specific audit log
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const log = await AuditLog.findByIdAndDelete(req.params.id);
    if (!log) {
      return sendError(res, "Audit log not found", 404);
    }
    return sendSuccess(res, {}, "Audit log deleted successfully");
  } catch (error) {
    console.error("Delete audit log error:", error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
