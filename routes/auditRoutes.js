const express = require("express");
const router = express.Router();
const AuditLog = require("../models/AuditLog");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");

router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      category,
      action,
      userId,
      projectId,
      weekNumber,
      startDate,
      endDate,
      search,
    } = req.query;

    const filter = {};

    // Week lives in metadata, written by the close-week, PM-override and
    // export events. Entries without one simply drop out of a week filter.
    if (weekNumber !== undefined && weekNumber !== "") {
      const parsedWeek = parseInt(weekNumber);
      if (!Number.isNaN(parsedWeek)) {
        filter["metadata.weekNumber"] = parsedWeek;
      }
    }

    if (category) {
      filter.category = category;
    }

    if (action) {
      filter.action = action;
    }

    if (userId) {
      filter.performedBy = userId;
    }

    if (projectId) {
      filter.project = projectId;
    }

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

router.get("/actions", protect, adminOnly, async (req, res) => {
  try {
    const actions = await AuditLog.distinct("action");
    return sendSuccess(res, { actions });
  } catch (error) {
    console.error("Get actions error:", error);
    return sendError(res, "Server error");
  }
});

/* Week numbers that actually appear in the log, for the filter dropdown.
   Must stay above "/:id" or Express treats "weeks" as an id. */
router.get("/weeks", protect, adminOnly, async (req, res) => {
  try {
    const { projectId } = req.query;
    const scope = projectId ? { project: projectId } : {};

    const values = await AuditLog.distinct("metadata.weekNumber", scope);
    const weeks = values
      .map((v) => parseInt(v))
      .filter((v) => Number.isInteger(v))
      .sort((a, b) => a - b);

    return sendSuccess(res, { weeks: [...new Set(weeks)] });
  } catch (error) {
    console.error("Get audit weeks error:", error);
    return sendError(res, "Server error");
  }
});

/* Projects that actually appear in the log, so the dropdown only offers
   options that can return rows. Names are read from the Project collection
   rather than the denormalised projectName: most call sites pass a bare
   ObjectId as `project`, so projectName is usually null on the entry. */
router.get("/projects", protect, adminOnly, async (req, res) => {
  try {
    const Project = require("../models/Project");

    const ids = await AuditLog.distinct("project", { project: { $ne: null } });
    if (ids.length === 0) {
      return sendSuccess(res, { projects: [] });
    }

    const projects = await Project.find({ _id: { $in: ids } })
      .select("name")
      .sort({ name: 1 })
      .lean();

    return sendSuccess(res, {
      projects: projects.map((p) => ({
        _id: p._id,
        name: p.name || "Unnamed project",
      })),
    });
  } catch (error) {
    console.error("Get audit projects error:", error);
    return sendError(res, "Server error");
  }
});

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

    const topUsers = await AuditLog.aggregate([
      {
        $match: { createdAt: { $gte: startDate }, performedBy: { $ne: null } },
      },
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

router.delete("/all", protect, adminOnly, async (req, res) => {
  try {
    const result = await AuditLog.deleteMany({});
    return sendSuccess(
      res,
      { deleted: result.deletedCount },
      "All audit logs deleted",
    );
  } catch (error) {
    console.error("Delete all audit logs error:", error);
    return sendError(res, "Server error");
  }
});

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
