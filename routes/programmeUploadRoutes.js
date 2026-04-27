const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Programme = require("../models/Programme");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { uploadToDisk } = require("../middleware/upload");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");

// PDF.js for text extraction
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// Helper function to parse date strings like "24-Nov-21" or "22-Apr-24 A"
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  // Remove suffixes like " A" or "*"
  const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const month = months[match[2]];
  let year = parseInt(match[3]);
  // Convert 2-digit year to 4-digit (assume 20xx for years < 50, 19xx otherwise)
  year = year < 50 ? 2000 + year : 1900 + year;
  return new Date(year, month, day);
};

// Calculate RAG status based on dates
const calculateRAG = (activity, today) => {
  const finishDate = parseDate(activity.finishDate);
  const startDate = parseDate(activity.startDate);

  // If completed, always Green
  if (activity.status === "Completed") {
    return "Green";
  }

  if (!finishDate) {
    return "Grey"; // Unknown/No date
  }

  const daysUntilFinish = Math.ceil((finishDate - today) / (1000 * 60 * 60 * 24));

  // Past finish date and not completed = Red
  if (daysUntilFinish < 0) {
    return "Red";
  }

  // Within 14 days of finish and not completed = Amber
  if (daysUntilFinish <= 14) {
    return "Amber";
  }

  // Future finish date = Green
  return "Green";
};

// Generate week zones for lookahead (6 weeks by default)
const generateWeekZones = (startDate, numWeeks = 6) => {
  const zones = [];
  const start = new Date(startDate);

  // Adjust to Monday of current week
  const dayOfWeek = start.getDay();
  const diff = start.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);

  for (let i = 0; i < numWeeks; i++) {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + i * 7);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    let category;
    if (i < 2) {
      category = "Committed";
    } else if (i < 4) {
      category = "Readiness";
    } else {
      category = "Strategic";
    }

    zones.push({
      weekNumber: i + 1,
      label: `Week ${i + 1}`,
      category,
      startDate: weekStart,
      endDate: weekEnd,
    });
  }

  return zones;
};

// Calculate which week zone an activity falls into
const getWeekZone = (activityStartDate, weekZones) => {
  const startDate = parseDate(activityStartDate);
  if (!startDate) return null;

  for (const zone of weekZones) {
    if (startDate >= zone.startDate && startDate <= zone.endDate) {
      // Determine zone group
      if (zone.weekNumber <= 2) return "Weeks 1-2";
      if (zone.weekNumber <= 4) return "Weeks 3-4";
      return "Weeks 5-6";
    }
  }

  // Check if it's beyond the lookahead
  const lastZone = weekZones[weekZones.length - 1];
  if (startDate > lastZone.endDate) {
    return "Beyond Lookahead";
  }

  return "Before Lookahead";
};

// Calculate activity status (Ready, Blocked, At Risk, etc.)
const calculateActivityStatus = (activity, ragStatus) => {
  if (activity.status === "Completed") {
    return "Complete";
  }
  if (activity.isBlocked) {
    return "Blocked";
  }
  if (ragStatus === "Red") {
    return "Blocked";
  }
  if (ragStatus === "Amber") {
    return "At Risk";
  }
  return "Ready";
};

// @route   POST /api/programmes/upload
// @desc    Upload a programme PDF and extract data
// @access  Private (Admin only)
router.post(
  "/upload",
  protect,
  adminOnly,
  uploadToDisk.single("programme"),
  async (req, res) => {
    try {
      const errors = [];

      if (!req.file) {
        errors.push({ field: "programme", message: "Please upload a PDF file" });
      }

      const { name, project } = req.body;
      if (!name || !name.trim()) {
        errors.push({ field: "name", message: "Programme name is required" });
      }

      if (errors.length > 0) {
        // Delete uploaded file if validation fails
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return sendValidationError(res, errors);
      }

      // Read the uploaded PDF file
      const pdfBuffer = fs.readFileSync(req.file.path);

      // Parse PDF and extract structured data using pdf.js
      const uint8Array = new Uint8Array(pdfBuffer);
      const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

      const pageCount = pdfDoc.numPages;
      const activities = [];

      // Extract structured data from each page
      for (let i = 1; i <= pageCount; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();

        // Group items by Y position (row) - use rounded Y for grouping
        const rows = {};
        textContent.items.forEach((item) => {
          if (!item.str.trim()) return;
          const y = Math.round(item.transform[5] / 3) * 3; // Group nearby Y positions
          const x = Math.round(item.transform[4]); // X position

          // Only include items from the table area (x < 700 to exclude Gantt chart)
          if (x > 680) return;

          if (!rows[y]) rows[y] = [];
          rows[y].push({ text: item.str.trim(), x });
        });

        // Parse each row into structured activity
        Object.values(rows).forEach((row) => {
          row.sort((a, b) => a.x - b.x); // Sort by X position

          // Activity ID patterns: MS-AD-007, A26410, CST_A17090, CE-121, VI____PP40, etc.
          const activityIdPattern = /^([A-Z]{1,4}[-_]?[A-Z]{0,3}[-_]?\d+[\.\d]*|[A-Z]{2,}[-_][A-Z]{0,3}[-_]?\d+|VI_+[A-Z0-9]+)/;

          // Check if this row has an Activity ID
          const idItem = row.find((item) =>
            item.x >= 38 && item.x < 145 && activityIdPattern.test(item.text)
          );

          if (idItem) {
            const activity = {
              activityId: "",
              activityName: "",
              duration: "",
              durationDays: 0,
              startDate: "",
              finishDate: "",
              startDateParsed: null,
              finishDateParsed: null,
              status: "Not Started",
              activityStatus: "Ready",
              ragStatus: "Grey",
              weekZone: null,
              isMilestone: false,
              owner: null,
              ownerName: "",
              notes: "",
              dependencies: [],
              isBlocked: false,
              blocker: "",
            };

            row.forEach((item) => {
              // Activity ID (x 38-145)
              if (item.x >= 38 && item.x < 145 && activityIdPattern.test(item.text)) {
                activity.activityId = item.text;
                // Check if it's a milestone (typically MS- prefix)
                if (item.text.startsWith("MS-")) {
                  activity.isMilestone = true;
                }
              }
              // Activity Name (x 145-510) - strict range to avoid Gantt text
              else if (item.x >= 145 && item.x < 510 && item.text.length > 2) {
                activity.activityName = item.text;
              }
              // Duration (x 530-575)
              else if (item.x >= 530 && item.x < 575 && /^\d+$/.test(item.text)) {
                activity.duration = item.text;
                activity.durationDays = parseInt(item.text) || 0;
                // Duration 0 typically means milestone
                if (item.text === "0") {
                  activity.isMilestone = true;
                }
              }
              // Start Date (x 575-625)
              else if (item.x >= 575 && item.x < 625 && /\d{2}-[A-Za-z]{3}-\d{2}/.test(item.text)) {
                activity.startDate = item.text;
              }
              // Finish Date (x 625-680)
              else if (item.x >= 625 && item.x < 680 && /\d{2}-[A-Za-z]{3}-\d{2}/.test(item.text)) {
                activity.finishDate = item.text;
              }
            });

            // Parse dates
            activity.startDateParsed = parseDate(activity.startDate);
            activity.finishDateParsed = parseDate(activity.finishDate);

            // Determine status based on date patterns
            // "A" suffix = Actual (completed), "*" suffix = Forecast, no suffix = Planned
            if (activity.finishDate.includes(" A")) {
              activity.status = "Completed";
            } else if (activity.startDate.includes(" A") && !activity.finishDate.includes(" A")) {
              activity.status = "In Progress";
            } else if (activity.finishDate.includes("*") || activity.startDate.includes("*")) {
              activity.status = "Forecast";
            } else {
              activity.status = "Planned";
            }

            // Calculate RAG status
            const today = new Date();
            activity.ragStatus = calculateRAG(activity, today);

            // Calculate activity status (Ready, Blocked, At Risk)
            activity.activityStatus = calculateActivityStatus(activity, activity.ragStatus);

            if (activity.activityName) {
              activities.push(activity);
            }
          }
        });
      }

      // Generate week zones (6 weeks from today)
      const today = new Date();
      const weekZones = generateWeekZones(today, 6);

      // Assign week zones to activities
      activities.forEach((activity) => {
        activity.weekZone = getWeekZone(activity.startDate, weekZones);
      });

      // Filter activities within lookahead (next 6 weeks)
      const lookaheadActivities = activities.filter(
        (a) => a.weekZone && !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone)
      );

      // Calculate summary statistics
      const summary = {
        total: activities.length,
        inLookahead: lookaheadActivities.length,
        completed: activities.filter((a) => a.status === "Completed").length,
        inProgress: activities.filter((a) => a.status === "In Progress").length,
        planned: activities.filter((a) => a.status === "Planned" || a.status === "Forecast").length,
        red: activities.filter((a) => a.ragStatus === "Red").length,
        amber: activities.filter((a) => a.ragStatus === "Amber").length,
        green: activities.filter((a) => a.ragStatus === "Green").length,
        blocked: activities.filter((a) => a.activityStatus === "Blocked").length,
        atRisk: activities.filter((a) => a.activityStatus === "At Risk").length,
        ready: activities.filter((a) => a.activityStatus === "Ready").length,
      };

      // Create programme record with extracted data
      const programme = await Programme.create({
        name,
        project: project || null,
        originalFileName: req.file.originalname,
        filePath: req.file.path,
        cycleStatus: "Draft",
        lookaheadWeeks: 6,
        lookaheadStartDate: today,
        weekZones: weekZones,
        extractedData: {
          activities: activities,
          pageCount: pageCount,
          totalActivities: activities.length,
          summary: summary,
        },
        uploadedBy: req.admin._id,
        status: "processed",
      });

      return sendSuccess(
        res,
        {
          programme: {
            _id: programme._id,
            name: programme.name,
            originalFileName: programme.originalFileName,
            cycleStatus: programme.cycleStatus,
            pageCount: programme.extractedData.pageCount,
            totalActivities: programme.extractedData.totalActivities,
            weekZones: weekZones,
            summary: summary,
            status: programme.status,
            activities: activities, // Return all activities
            createdAt: programme.createdAt,
            lastUpdated: programme.updatedAt,
          },
        },
        "Programme uploaded and processed successfully",
        201
      );
    } catch (error) {
      console.error("PDF Upload Error:", error);
      // Clean up file if it exists
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return sendError(res, "Error processing PDF");
    }
  }
);

// @route   GET /api/programmes
// @desc    Get all programmes
// @access  Private (Admin only)
router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const programmes = await Programme.find()
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { programmes });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/by-project/:projectId
// @desc    Get programme by project ID
// @access  Private (Admin only)
router.get("/by-project/:projectId", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findOne({ project: req.params.projectId })
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    if (!programme) {
      return sendSuccess(res, { programme: null });
    }

    return sendSuccess(res, { programme });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/project/:projectId/activities
// @desc    Get activities for a project with pagination
// @access  Private
router.get("/project/:projectId/activities", protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    // Find programme for this project
    const programme = await Programme.findOne({ project: req.params.projectId });

    if (!programme || !programme.extractedData || !programme.extractedData.activities) {
      return sendSuccess(res, {
        activities: [],
        pagination: {
          currentPage: pageNum,
          totalPages: 0,
          totalActivities: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });
    }

    // Get all activities
    let activities = programme.extractedData.activities.map((a) => ({
      activityId: a.activityId,
      activityName: a.activityName,
      startDate: a.startDate,
      finishDate: a.finishDate,
      status: a.status,
      ragStatus: a.ragStatus,
    }));

    // Filter by search if provided
    if (search) {
      const searchLower = search.toLowerCase();
      activities = activities.filter(
        (a) =>
          a.activityId.toLowerCase().includes(searchLower) ||
          a.activityName.toLowerCase().includes(searchLower)
      );
    }

    // Calculate pagination
    const totalActivities = activities.length;
    const totalPages = Math.ceil(totalActivities / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

    // Paginate
    const paginatedActivities = activities.slice(startIndex, endIndex);

    return sendSuccess(res, {
      activities: paginatedActivities,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalActivities,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/:id
// @desc    Get single programme by ID
// @access  Private (Admin only)
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id).populate(
      "uploadedBy",
      "name email"
    );

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    return sendSuccess(res, { programme });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/:id/lookahead
// @desc    Get comprehensive lookahead data for dashboard
// @access  Private (Admin only)
router.get("/:id/lookahead", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id)
      .populate("uploadedBy", "name email")
      .populate("extractedData.activities.owner", "name email");

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Get actions for this programme
    const Action = require("../models/Action");
    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    // Count actions per activity
    const actionCountMap = {};
    actions.forEach((action) => {
      const actId = action.linkedActivity.activityId;
      if (!actionCountMap[actId]) {
        actionCountMap[actId] = { total: 0, open: 0 };
      }
      actionCountMap[actId].total++;
      if (action.status !== "Completed" && action.status !== "Cancelled") {
        actionCountMap[actId].open++;
      }
    });

    // Regenerate week zones based on current date
    const today = new Date();
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    // Process activities with action counts and week zones
    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      return {
        ...activityObj,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
        actionsCount: actionCountMap[activityObj.activityId]?.total || 0,
        openActionsCount: actionCountMap[activityObj.activityId]?.open || 0,
      };
    });

    // Use all activities for display purposes (don't filter by lookahead period)
    // This ensures activities are shown regardless of their dates relative to today
    const lookaheadActivities = activities;

    // Group by week zone
    const activitiesByWeekZone = {
      "Weeks 1-2": lookaheadActivities.filter((a) => a.weekZone === "Weeks 1-2"),
      "Weeks 3-4": lookaheadActivities.filter((a) => a.weekZone === "Weeks 3-4"),
      "Weeks 5-6": lookaheadActivities.filter((a) => a.weekZone === "Weeks 5-6"),
    };

    // Get blocked/at risk activities
    const blockedRiskActivities = lookaheadActivities.filter(
      (a) => a.ragStatus === "Red" || a.ragStatus === "Amber" || a.activityStatus === "Blocked"
    );

    // Calculate action stats
    const actionStats = {
      total: actions.length,
      open: actions.filter((a) => a.status === "Open").length,
      inProgress: actions.filter((a) => a.status === "In Progress").length,
      completed: actions.filter((a) => a.status === "Completed").length,
      overdue: actions.filter(
        (a) =>
          a.dueDate < today &&
          a.status !== "Completed" &&
          a.status !== "Cancelled"
      ).length,
    };

    // Calculate summary
    const summary = {
      total: activities.length,
      inLookahead: lookaheadActivities.length,
      completed: activities.filter((a) => a.status === "Completed").length,
      inProgress: activities.filter((a) => a.status === "In Progress").length,
      planned: activities.filter(
        (a) => a.status === "Planned" || a.status === "Forecast"
      ).length,
      red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
      amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
      green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
      blocked: lookaheadActivities.filter((a) => a.activityStatus === "Blocked").length,
      atRisk: lookaheadActivities.filter((a) => a.activityStatus === "At Risk").length,
      ready: lookaheadActivities.filter((a) => a.activityStatus === "Ready").length,
    };

    // Check if ready to close
    const readyToClose =
      summary.inLookahead > 0 &&
      summary.blocked === 0 &&
      summary.red === 0 &&
      actionStats.overdue === 0;

    res.json({
      programme: {
        _id: programme._id,
        name: programme.name,
        cycleStatus: programme.cycleStatus,
        lastUpdated: programme.updatedAt,
      },
      weekZones: weekZones.map((zone) => ({
        ...zone,
        activitiesCount: lookaheadActivities.filter((a) => {
          if (zone.weekNumber <= 2) return a.weekZone === "Weeks 1-2";
          if (zone.weekNumber <= 4) return a.weekZone === "Weeks 3-4";
          return a.weekZone === "Weeks 5-6";
        }).length,
      })),
      dashboard: {
        cycleStatus: programme.cycleStatus,
        inLookahead: summary.inLookahead,
        green: summary.green,
        amber: summary.amber,
        red: summary.red,
        blocked: summary.blocked,
        openActions: actionStats.open + actionStats.inProgress,
        overdue: actionsByStatus.overdue,
        readyToClose: readyToClose ? "Yes" : "No",
      },
      summary,
      actionStats,
      ragDistribution: {
        green: summary.green,
        amber: summary.amber,
        red: summary.red,
      },
      activitiesByWeekZone,
      blockedRiskActivities: blockedRiskActivities.slice(0, 20),
      activities: activities, // Return all activities, not just lookahead
      lookaheadActivities: lookaheadActivities,
      recentActions: actions.slice(0, 10),
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PATCH /api/programmes/:id/activity/:activityId
// @desc    Update activity details (owner, status, notes, blocked)
// @access  Private (Admin only)
router.patch("/:id/activity/:activityId", protect, adminOnly, async (req, res) => {
  try {
    const { owner, ownerName, activityStatus, notes, isBlocked, blocker } = req.body;

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Find and update the activity
    const activityIndex = programme.extractedData.activities.findIndex(
      (a) => a.activityId === req.params.activityId
    );

    if (activityIndex === -1) {
      return sendError(res, "Activity not found", 404);
    }

    const activity = programme.extractedData.activities[activityIndex];

    if (owner !== undefined) activity.owner = owner;
    if (ownerName !== undefined) activity.ownerName = ownerName;
    if (activityStatus !== undefined) activity.activityStatus = activityStatus;
    if (notes !== undefined) activity.notes = notes;
    if (isBlocked !== undefined) activity.isBlocked = isBlocked;
    if (blocker !== undefined) activity.blocker = blocker;

    // Recalculate activity status if blocked changed
    if (isBlocked !== undefined) {
      if (isBlocked) {
        activity.activityStatus = "Blocked";
      } else if (activity.ragStatus === "Amber") {
        activity.activityStatus = "At Risk";
      } else if (activity.status === "Completed") {
        activity.activityStatus = "Complete";
      } else {
        activity.activityStatus = "Ready";
      }
    }

    await programme.save();

    return sendSuccess(
      res,
      { activity: programme.extractedData.activities[activityIndex] },
      "Activity updated successfully"
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/:id/overview
// @desc    Get overview tab dashboard data
// @access  Private (Admin only)
router.get("/:id/overview", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id)
      .populate("uploadedBy", "name email");

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Get actions for this programme
    const Action = require("../models/Action");
    const CycleHistory = require("../models/CycleHistory");

    const actions = await Action.find({ programme: req.params.id });
    const today = new Date();

    // Regenerate week zones
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    // Process activities
    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      return {
        ...activityObj,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
      };
    });

    // Filter lookahead activities
    const lookaheadActivities = activities.filter(
      (a) => a.weekZone && !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone)
    );

    // Calculate stats
    const greenActivities = lookaheadActivities.filter((a) => a.ragStatus === "Green");
    const greenAndReady = greenActivities.filter(
      (a) => a.activityStatus === "Ready" || a.activityStatus === "Complete"
    );

    const openActions = actions.filter(
      (a) => a.status === "Open" || a.status === "In Progress"
    ).length;

    const overdueActions = actions.filter(
      (a) =>
        a.dueDate < today &&
        a.status !== "Completed" &&
        a.status !== "Cancelled"
    ).length;

    // RAG Distribution
    const ragDistribution = {
      green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
      amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
      red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
    };

    // Get recent cycle history (last 5 weeks)
    const cycleHistory = await CycleHistory.find({ programme: req.params.id })
      .sort({ weekNumber: -1 })
      .limit(5)
      .populate("closedBy", "name");

    // Format cycle history for response
    const recentCycleHistory = cycleHistory.map((cycle) => ({
      weekNumber: cycle.weekNumber,
      weekLabel: cycle.weekLabel,
      dateRange: cycle.dateRange.startDate && cycle.dateRange.endDate
        ? `${formatDateShort(cycle.dateRange.startDate)} - ${formatDateShort(cycle.dateRange.endDate)}`
        : "",
      closeType: cycle.closeType,
      score: cycle.score,
    }));

    res.json({
      // Top stats
      stats: {
        activitiesInLookahead: lookaheadActivities.length,
        greenAndReady: {
          count: greenAndReady.length,
          ofGreen: greenActivities.length,
        },
        openActions: openActions,
        overdueActions: overdueActions,
      },
      // RAG Distribution for donut chart
      ragDistribution: {
        green: ragDistribution.green,
        amber: ragDistribution.amber,
        red: ragDistribution.red,
      },
      // Recent Cycle History
      recentCycleHistory: recentCycleHistory,
      // Programme info
      programme: {
        _id: programme._id,
        name: programme.name,
        cycleStatus: programme.cycleStatus,
        lastUpdated: programme.updatedAt,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Helper function to format date as "10 Mar 2026"
const formatDateShort = (date) => {
  const d = new Date(date);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate().toString().padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

// @route   POST /api/programmes/:id/close-cycle
// @desc    Close current cycle and save to history
// @access  Private (Admin only)
router.post("/:id/close-cycle", protect, adminOnly, async (req, res) => {
  try {
    const { closeType, notes } = req.body;
    const CycleHistory = require("../models/CycleHistory");
    const Action = require("../models/Action");

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const today = new Date();
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    // Get current week info
    const currentWeek = weekZones[0];

    // Get last cycle to determine week number
    const lastCycle = await CycleHistory.findOne({ programme: req.params.id })
      .sort({ weekNumber: -1 });
    const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

    // Calculate stats for this cycle
    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      return {
        ...activityObj,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
      };
    });

    const lookaheadActivities = activities.filter(
      (a) => a.weekZone && !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone)
    );

    const actions = await Action.find({ programme: req.params.id });
    const completedActions = actions.filter((a) => a.status === "Completed").length;

    // Calculate score (simple formula - can be customized)
    const greenCount = lookaheadActivities.filter((a) => a.ragStatus === "Green").length;
    const totalCount = lookaheadActivities.length || 1;
    const actionCompletion = actions.length > 0 ? (completedActions / actions.length) * 100 : 100;
    const ragScore = (greenCount / totalCount) * 100;
    const score = Math.round((ragScore * 0.7) + (actionCompletion * 0.3));

    // Create cycle history record
    const cycleHistory = await CycleHistory.create({
      programme: req.params.id,
      weekNumber: newWeekNumber,
      weekLabel: `Week ${newWeekNumber}`,
      dateRange: {
        startDate: currentWeek.startDate,
        endDate: currentWeek.endDate,
      },
      closeType: closeType || "Normal Close",
      score: score,
      stats: {
        totalActivities: lookaheadActivities.length,
        completed: lookaheadActivities.filter((a) => a.status === "Completed").length,
        green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
        amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
        red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
        blocked: lookaheadActivities.filter((a) => a.isBlocked).length,
        actionsCompleted: completedActions,
        actionsTotal: actions.length,
      },
      closedBy: req.admin._id,
      notes: notes,
    });

    // Update programme cycle status
    programme.cycleStatus = "Closed";
    await programme.save();

    return sendSuccess(
      res,
      {
        cycleHistory: {
          weekNumber: cycleHistory.weekNumber,
          weekLabel: cycleHistory.weekLabel,
          closeType: cycleHistory.closeType,
          score: cycleHistory.score,
          dateRange: `${formatDateShort(cycleHistory.dateRange.startDate)} - ${formatDateShort(cycleHistory.dateRange.endDate)}`,
        },
      },
      "Cycle closed successfully",
      201
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/:id/cycle-history
// @desc    Get all cycle history for a programme
// @access  Private (Admin only)
router.get("/:id/cycle-history", protect, adminOnly, async (req, res) => {
  try {
    const CycleHistory = require("../models/CycleHistory");

    const history = await CycleHistory.find({ programme: req.params.id })
      .sort({ weekNumber: -1 })
      .populate("closedBy", "name email");

    return sendSuccess(res, { history });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/programmes/:id/weekly-control
// @desc    Get weekly control dashboard data
// @access  Private (Admin only)
router.get("/:id/weekly-control", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id)
      .populate("uploadedBy", "name email");

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Get actions for this programme
    const Action = require("../models/Action");
    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const today = new Date();

    // Action statistics for bar chart
    const actionsByStatus = {
      open: actions.filter((a) => a.status === "Open").length,
      inProgress: actions.filter((a) => a.status === "In Progress").length,
      closed: actions.filter((a) => a.status === "Completed").length,
      overdue: actions.filter(
        (a) =>
          a.dueDate < today &&
          a.status !== "Completed" &&
          a.status !== "Cancelled"
      ).length,
    };

    // Create action map for linking to activities
    const actionMap = {};
    actions.forEach((action) => {
      const actId = action.linkedActivity.activityId;
      if (!actionMap[actId]) {
        actionMap[actId] = [];
      }
      actionMap[actId].push({
        _id: action._id,
        actionId: `ACN-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title,
        status: action.status,
        isOverdue: action.dueDate < today && action.status !== "Completed" && action.status !== "Cancelled",
      });
    });

    // Regenerate week zones
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    // Process activities
    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      return {
        ...activityObj,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
        linkedActions: actionMap[activityObj.activityId] || [],
      };
    });

    // Use all activities (not filtered by lookahead) for display purposes
    const allActivities = activities;

    // RAG Distribution for donut chart
    const ragDistribution = {
      green: allActivities.filter((a) => a.ragStatus === "Green").length,
      amber: allActivities.filter((a) => a.ragStatus === "Amber").length,
      red: allActivities.filter((a) => a.ragStatus === "Red").length,
    };

    // Blocked/Risk activities with linked actions
    const blockedRiskActivities = allActivities
      .filter((a) => a.ragStatus === "Red" || a.ragStatus === "Amber" || a.isBlocked)
      .slice(0, 20)
      .map((a) => {
        const linkedAction = a.linkedActions[0]; // Get first linked action
        return {
          activityId: a.activityId,
          activityName: a.activityName,
          ragStatus: a.ragStatus,
          owner: a.ownerName || "",
          blocker: a.blocker || "",
          linkedAction: linkedAction ? {
            actionId: linkedAction.actionId,
            status: linkedAction.isOverdue ? "Overdue" : linkedAction.status,
          } : null,
        };
      });

    // Calculate stats
    const blocked = allActivities.filter(
      (a) => a.isBlocked || a.activityStatus === "Blocked"
    ).length;

    const openActions = actionsByStatus.open + actionsByStatus.inProgress;

    const readyToClose =
      allActivities.length > 0 &&
      blocked === 0 &&
      ragDistribution.red === 0 &&
      actionsByStatus.overdue === 0;

    // Weekly Plan Preview - activities sorted by start date
    const weeklyPlanPreview = allActivities
      .slice(0, 20)
      .map((a) => ({
        activityId: a.activityId,
        activityName: a.activityName,
        weekZone: a.weekZone || "-",
        startDate: a.startDate,
        finishDate: a.finishDate,
        duration: a.duration,
        ragStatus: a.ragStatus,
        owner: a.ownerName || "",
        activityStatus: a.activityStatus || "Ready",
      }));

    // Planner To-Do - activities that need attention (blocked, at risk, or with open actions)
    const plannerToDo = allActivities
      .filter((a) =>
        a.isBlocked ||
        a.activityStatus === "Blocked" ||
        a.activityStatus === "At Risk" ||
        a.ragStatus === "Red" ||
        a.ragStatus === "Amber" ||
        (a.linkedActions && a.linkedActions.length > 0)
      )
      .slice(0, 20)
      .map((a) => ({
        activityId: a.activityId,
        activityName: a.activityName,
        ragStatus: a.ragStatus,
        owner: a.ownerName || "",
        todoItem: a.isBlocked || a.activityStatus === "Blocked"
          ? "Resolve blocker"
          : a.ragStatus === "Red"
            ? "Address critical issue"
            : a.linkedActions && a.linkedActions.length > 0
              ? `Complete ${a.linkedActions.length} action(s)`
              : "Review status",
        priority: a.ragStatus === "Red" || a.isBlocked ? "High" : "Medium",
        dueDate: a.finishDate,
      }));

    res.json({
      // Top stats bar
      stats: {
        cycleStatus: programme.cycleStatus,
        inLookahead: allActivities.length,
        green: ragDistribution.green,
        blocked: blocked,
        openActions: openActions,
        overdue: actionsByStatus.overdue,
        readyToClose: readyToClose ? "Yes" : "No",
      },
      // RAG Distribution for donut chart
      ragDistribution: {
        green: ragDistribution.green,
        amber: ragDistribution.amber,
        red: ragDistribution.red,
      },
      // Actions by Status for bar chart
      actionsByStatus: {
        open: actionsByStatus.open,
        inProgress: actionsByStatus.inProgress,
        closed: actionsByStatus.closed,
        overdue: actionsByStatus.overdue,
      },
      // Blocked/Risk Activities table
      blockedRiskActivities: blockedRiskActivities,
      // Weekly Plan Preview table
      weeklyPlanPreview: weeklyPlanPreview,
      // Planner To-Do table
      plannerToDo: plannerToDo,
      // Programme info
      programme: {
        _id: programme._id,
        name: programme.name,
        lastUpdated: programme.updatedAt,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PATCH /api/programmes/:id/cycle-status
// @desc    Update programme cycle status
// @access  Private (Admin only)
router.patch("/:id/cycle-status", protect, adminOnly, async (req, res) => {
  try {
    const { cycleStatus } = req.body;

    // Validate required field
    const errors = validateRequired({ cycleStatus });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    if (!["Draft", "In Review", "Approved", "Closed"].includes(cycleStatus)) {
      return sendValidationError(res, [
        { field: "cycleStatus", message: "Invalid cycle status. Must be: Draft, In Review, Approved, or Closed" },
      ]);
    }

    const programme = await Programme.findByIdAndUpdate(
      req.params.id,
      { cycleStatus },
      { new: true }
    );

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    return sendSuccess(
      res,
      { cycleStatus: programme.cycleStatus },
      "Cycle status updated successfully"
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   DELETE /api/programmes/:id
// @desc    Delete a programme
// @access  Private (Admin only)
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id);

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Delete the file from disk
    if (fs.existsSync(programme.filePath)) {
      fs.unlinkSync(programme.filePath);
    }

    await Programme.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "Programme deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
