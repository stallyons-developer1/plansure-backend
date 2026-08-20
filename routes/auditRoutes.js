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

    /*
     * "Week 1" means everything that happened during that governance week, not
     * only the handful of events that record a week number in metadata.
     *
     * Matching on metadata.weekNumber alone returned just the export and
     * week-close entries — an action created in the same week was invisible.
     * So the week is resolved to its date window per programme (anchor +
     * 7n .. +6 days) and events are matched on when they occurred, with
     * metadata-tagged entries still included so nothing is lost.
     */
    if (weekNumber !== undefined && weekNumber !== "") {
      const parsedWeek = parseInt(weekNumber);
      if (!Number.isNaN(parsedWeek)) {
        const Programme = require("../models/Programme");
        const programmes = await Programme.find(
          projectId ? { project: projectId } : {},
        ).select("project closedWeeks");

        /*
         * A governance week is a cycle, not a calendar span. Deriving windows
         * from lookaheadStartDate + 7n put every cycle uploaded on the same day
         * inside Week 1 and left Week 2 pointing at future dates with nothing
         * in it.
         *
         * So the boundaries come from the closures themselves: week N runs from
         * the close of week N-1 up to the close of week N, and the week in
         * progress runs from the last close to now. Week 1 starts at the
         * beginning of time so the project-creation events land in it.
         */
        const closuresByProject = {};
        for (const programme of programmes) {
          if (!programme.project) continue;
          const key = String(programme.project);
          for (const closed of programme.closedWeeks || []) {
            if (!closed.closedAt) continue;
            (closuresByProject[key] = closuresByProject[key] || []).push({
              project: programme.project,
              at: new Date(closed.closedAt),
            });
          }
          closuresByProject[key] = closuresByProject[key] || [];
        }

        const now = new Date();
        const clauses = [];

        /*
         * The WEEK_CLOSED audit row is written a few milliseconds after the
         * closedAt it records, so an exact boundary pushes a week's own
         * closing event into the following week. A small tolerance keeps it
         * where it belongs without reaching the next closure.
         */
        const BOUNDARY_TOLERANCE_MS = 5000;

        for (const key of Object.keys(closuresByProject)) {
          const closures = closuresByProject[key].sort((a, b) => a.at - b.at);
          // Only the week in progress may exceed the closed count.
          if (parsedWeek > closures.length + 1) continue;

          const project =
            closures[0]?.project ||
            programmes.find((p) => String(p.project) === key)?.project;
          if (!project) continue;

          const start =
            parsedWeek === 1
              ? new Date(0)
              : new Date(
                  closures[parsedWeek - 2].at.getTime() +
                    BOUNDARY_TOLERANCE_MS,
                );
          const end = closures[parsedWeek - 1]
            ? new Date(
                closures[parsedWeek - 1].at.getTime() + BOUNDARY_TOLERANCE_MS,
              )
            : now;

          clauses.push({ project, createdAt: { $gt: start, $lte: end } });
        }

        /*
         * Deliberately NOT falling back to metadata.weekNumber. That field is
         * the PROGRAMME's week number, and every programme closes its own
         * "Week 1" — so a project on its second cycle has two events tagged
         * week 1, and matching on it dragged the second cycle's closure into
         * the project's Week 1. The cycle windows above are complete on their
         * own: per-week counts sum to the project total.
         *
         * No clauses means no project has reached this week, so match nothing
         * rather than falling through to every row.
         */
        filter.$and = [
          ...(filter.$and || []),
          { $or: clauses.length > 0 ? clauses : [{ _id: null }] },
        ];
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

/* Week numbers available to the filter dropdown.
   Must stay above "/:id" or Express treats "weeks" as an id. */
router.get("/weeks", protect, adminOnly, async (req, res) => {
  try {
    const { projectId } = req.query;
    const Programme = require("../models/Programme");

    /*
     * Offer weeks up to the most any PROJECT has actually closed — not the
     * programme's full span, which would list every week of a 12-week job on
     * day one.
     *
     * Weeks accumulate per project, not per programme: each programme is one
     * cycle and closes its own "Week 1", so a project two cycles in has closed
     * two weeks. Counting per programme capped the list at 1 forever. This
     * matches the workspace header ("Week 3 (2 closed)").
     *
     * Across projects the furthest-ahead one sets the ceiling, so projects
     * closing 1, 3 and 2 weeks offer Weeks 1-3.
     */
    const programmes = await Programme.find(
      projectId ? { project: projectId } : {},
    ).select("project closedWeeks");

    const closedByProject = {};
    for (const programme of programmes) {
      const key = String(programme.project || "unassigned");
      closedByProject[key] =
        (closedByProject[key] || 0) + (programme.closedWeeks || []).length;
    }

    let highest = Math.max(0, ...Object.values(closedByProject));

    // metadata.weekNumber is deliberately not consulted here: it is the
    // programme's own week number, so a 6-week programme would offer six weeks
    // for a project that has only closed one cycle.

    // Nothing closed yet, but events still belong to week 1.
    if (highest === 0) {
      const hasEvents = await AuditLog.countDocuments(
        projectId ? { project: projectId } : {},
      );
      if (hasEvents > 0) highest = 1;
    }

    const weeks = Array.from({ length: highest }, (_, i) => i + 1);
    return sendSuccess(res, { weeks });
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
