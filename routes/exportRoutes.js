const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");
const Project = require("../models/Project");
const Programme = require("../models/Programme");
const Action = require("../models/Action");
const Export = require("../models/Export");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");
const auditLogger = require("../utils/auditLogger");

// Ensure exports directory exists
const exportsDir = path.join(__dirname, "../uploads/exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

// Helper to calculate RAG status
const calculateRAG = (activity, today) => {
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
    const months = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
    if (!match) return null;
    const day = parseInt(match[1]);
    const month = months[match[2]];
    let year = parseInt(match[3]);
    year = year < 50 ? 2000 + year : 1900 + year;
    return new Date(year, month, day);
  };

  const startDate = parseDate(activity.startDate);
  const finishDate = parseDate(activity.finishDate);

  const isCompleted =
    activity.status === "Completed" ||
    (activity.startDate && activity.startDate.includes(" A")) ||
    (activity.finishDate && activity.finishDate.includes(" A"));

  if (isCompleted) return "Green";
  if (!startDate) return "Grey";

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilStart = Math.ceil((startDate - today) / msPerDay);
  const weeksUntilStart = Math.ceil(daysUntilStart / 7);

  if (daysUntilStart < 0) {
    if (finishDate && finishDate < today) return "Red";
    return "Green";
  }

  if (weeksUntilStart <= 2) return "Green";
  else if (weeksUntilStart <= 4) return "Amber";
  else if (weeksUntilStart <= 6) return "Red";
  else return "Grey";
};

// GET /api/exports/gating-status - Get export gating status
router.get("/gating-status", protect, async (req, res) => {
  try {
    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    if (programmes.length === 0) {
      return sendSuccess(res, {
        isGated: true,
        cycleStatus: "No Programme",
        currentWeek: "N/A",
        message: "No active programmes found",
      });
    }

    const activeProgramme = programmes[0];
    const cycleStatus = activeProgramme.cycleStatus || "Draft";

    // Exports are ungated if cycle is in Close-Out Eligible, Approved, or Closed
    const ungatedStatuses = ["Close-Out Eligible", "Approved", "Closed"];
    const isGated = !ungatedStatuses.includes(cycleStatus);

    // Calculate current week
    let currentWeek = "N/A";
    if (activeProgramme.lookaheadStartDate) {
      const startOfYear = new Date(
        new Date(activeProgramme.lookaheadStartDate).getFullYear(),
        0,
        1
      );
      const days = Math.floor(
        (new Date(activeProgramme.lookaheadStartDate) - startOfYear) /
          (24 * 60 * 60 * 1000)
      );
      currentWeek = `W${Math.ceil((days + 1) / 7)}`;
    }

    return sendSuccess(res, {
      isGated,
      cycleStatus,
      currentWeek,
      programmeId: activeProgramme._id,
      programmeName: activeProgramme.name,
    });
  } catch (error) {
    console.error("Get gating status error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/exports/history - Get export history
router.get("/history", protect, async (req, res) => {
  try {
    const exports = await Export.find()
      .populate("generatedBy", "name email")
      .populate("project", "name")
      .sort({ createdAt: -1 })
      .limit(20);

    const formattedExports = exports.map((exp) => ({
      _id: exp._id,
      date: exp.createdAt,
      type: exp.type,
      week: exp.week,
      generatedBy: exp.generatedBy?.name || "System",
      status: exp.status,
      fileName: exp.fileName,
    }));

    return sendSuccess(res, { exports: formattedExports });
  } catch (error) {
    console.error("Get export history error:", error);
    return sendError(res, "Server error");
  }
});

// POST /api/exports/weekly-plan - Generate Weekly Plan export (green activities only)
router.post("/weekly-plan", protect, async (req, res) => {
  try {
    // Get weekNumber from request body (sent from frontend)
    const requestedWeekNumber = req.body.weekNumber ? parseInt(req.body.weekNumber) : null;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    if (programmes.length === 0) {
      return sendError(res, "No active programmes found", 404);
    }

    const activeProgramme = programmes[0];
    const activities = activeProgramme.extractedData?.activities || [];
    const today = new Date();

    // Helper to parse date strings
    const parseActivityDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
      const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
      };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Find programme start date (earliest activity)
    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    // Calculate current week number and 2-week date range
    let currentWeekNumber = 1;
    let weekStartDate = earliestDate;
    let weekEndDate = earliestDate ? new Date(earliestDate) : null;

    if (earliestDate) {
      earliestDate.setHours(0, 0, 0, 0);
      const todayStart = new Date(today);
      todayStart.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((todayStart - earliestDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      // Use requested week number if provided, otherwise use calculated current week
      if (requestedWeekNumber) {
        currentWeekNumber = requestedWeekNumber;
      }

      // Calculate 2-week date range based on the week number
      weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(earliestDate.getDate() + (currentWeekNumber - 1) * 7);
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 13); // 2 weeks = 14 days
    }

    // Helper to check if activity is in current 2-week period
    const isActivityInWeek = (activity) => {
      if (!weekStartDate || !weekEndDate) return true;
      const actStart = parseActivityDate(activity.startDate);
      const actFinish = parseActivityDate(activity.finishDate);
      if (!actStart) return false;

      // Activity is in week if it starts in this period OR spans this period
      const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
      return startsThisWeek || spansThisWeek;
    };

    // Determine if this is a historical week (week end date is before today)
    const isHistoricalWeek = weekEndDate && weekEndDate < today;

    // Filter activities IN the current 2-week period
    // For historical weeks: include all activities in that week (RAG doesn't apply to past)
    // For current/future weeks: filter by Green RAG status
    const greenActivities = activities.filter((activity) => {
      if (!isActivityInWeek(activity)) return false;

      // For historical weeks, include all activities in that week
      if (isHistoricalWeek) return true;

      // For current/future weeks, only include Green activities
      const rag = calculateRAG(activity, today);
      return rag === "Green";
    });

    // Get actions for this programme
    const actions = await Action.find({
      programme: activeProgramme._id,
      status: { $nin: ["Completed", "Cancelled"] },
    });

    // Filter activities that have no open actions
    const activitiesWithNoOpenActions = greenActivities.filter((activity) => {
      const hasOpenAction = actions.some(
        (action) => action.linkedActivity?.activityId === activity.activityId
      );
      return !hasOpenAction;
    });

    // Use calculated week number for the 2-week period
    const currentWeek = `W${currentWeekNumber}-${currentWeekNumber + 1}`;

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PlanSure";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Weekly Plan");
    sheet.columns = [
      { header: "Activity ID", key: "activityId", width: 15 },
      { header: "Activity Name", key: "activityName", width: 40 },
      { header: "Start Date", key: "startDate", width: 15 },
      { header: "Finish Date", key: "finishDate", width: 15 },
      { header: "Duration", key: "duration", width: 12 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Status", key: "status", width: 12 },
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF22C55E" },
    };
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

    activitiesWithNoOpenActions.forEach((activity) => {
      sheet.addRow({
        activityId: activity.activityId || "-",
        activityName: activity.activityName || "-",
        startDate: activity.startDate || "-",
        finishDate: activity.finishDate || "-",
        duration: activity.duration || "-",
        owner: activity.ownerName || "-",
        status: "Ready",
      });
    });

    // Save file
    const fileName = `Weekly_Plan_${currentWeek}_${Date.now()}.xlsx`;
    const filePath = path.join(exportsDir, fileName);
    await workbook.xlsx.writeFile(filePath);

    // Save export record
    const exportRecord = await Export.create({
      type: "Weekly Plan",
      week: currentWeek,
      programme: activeProgramme._id,
      project: activeProgramme.project,
      generatedBy: req.admin._id,
      status: "Complete",
      filePath: filePath,
      fileName: fileName,
      exportData: {
        activitiesCount: activitiesWithNoOpenActions.length,
      },
    });

    // Audit log: Weekly plan exported
    await auditLogger.weeklyPlanExported(
      req,
      req.admin,
      activeProgramme.project,
      currentWeekNumber,
      activitiesWithNoOpenActions.length
    );

    // Send file
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Export-Id", exportRecord._id.toString());

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Weekly plan export error:", error);
    return sendError(res, "Server error");
  }
});

// POST /api/exports/planner-todo - Generate Planner To-Do export (outstanding actions)
router.post("/planner-todo", protect, async (req, res) => {
  try {
    // Get weekNumber from request body (sent from frontend)
    const requestedWeekNumber = req.body.weekNumber ? parseInt(req.body.weekNumber) : null;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    if (programmes.length === 0) {
      return sendError(res, "No active programmes found", 404);
    }

    const activeProgramme = programmes[0];
    const programmeIds = programmes.map((p) => p._id);
    const activities = activeProgramme.extractedData?.activities || [];

    // Helper to parse date strings
    const parseActivityDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
      const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
      };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Find programme start date (earliest activity)
    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    // Calculate week date range for filtering
    let weekStartDate = null;
    let weekEndDate = null;
    let currentWeekNumber = 1;

    if (earliestDate && requestedWeekNumber) {
      earliestDate.setHours(0, 0, 0, 0);
      currentWeekNumber = requestedWeekNumber;

      // Calculate 2-week date range based on the requested week number
      weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(earliestDate.getDate() + (currentWeekNumber - 1) * 7);
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 13); // 2 weeks = 14 days
    }

    // Get all Open and In Progress actions (not filtered by week - shows all outstanding actions)
    const actions = await Action.find({
      programme: { $in: programmeIds },
      status: { $in: ["Open", "In Progress"] },
    })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    // Note: Planner To-Do shows ALL Open + Overdue actions from all weeks
    // No week filtering - this is the planner's complete to-do list

    // Start of today (midnight) - actions are only overdue after due date has fully passed
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const overdueActions = actions.filter(
      (a) => new Date(a.dueDate) < today
    );
    const pendingActions = actions.filter(
      (a) => new Date(a.dueDate) >= today
    );

    // Calculate current week label
    let currentWeek = requestedWeekNumber ? `W${requestedWeekNumber}` : "N/A";
    if (!requestedWeekNumber && activeProgramme.lookaheadStartDate) {
      const startOfYear = new Date(
        new Date(activeProgramme.lookaheadStartDate).getFullYear(),
        0,
        1
      );
      const days = Math.floor(
        (new Date(activeProgramme.lookaheadStartDate) - startOfYear) /
          (24 * 60 * 60 * 1000)
      );
      currentWeek = `W${Math.ceil((days + 1) / 7)}`;
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PlanSure";
    workbook.created = new Date();

    // Overdue Actions Sheet
    const overdueSheet = workbook.addWorksheet("Overdue Actions");
    overdueSheet.columns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Days Overdue", key: "daysOverdue", width: 15 },
    ];

    overdueSheet.getRow(1).font = { bold: true };
    overdueSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEF4444" },
    };
    overdueSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

    overdueActions.forEach((action) => {
      const daysOverdue = Math.ceil(
        (today - new Date(action.dueDate)) / (24 * 60 * 60 * 1000)
      );
      overdueSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        priority: action.priority || "-",
        daysOverdue: daysOverdue,
      });
    });

    // Pending Actions Sheet
    const pendingSheet = workbook.addWorksheet("Pending Actions");
    pendingSheet.columns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Priority", key: "priority", width: 12 },
    ];

    pendingSheet.getRow(1).font = { bold: true };
    pendingSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF59E0B" },
    };
    pendingSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

    pendingActions.forEach((action) => {
      pendingSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        priority: action.priority || "-",
      });
    });

    // Summary Sheet
    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = [
      { header: "Metric", key: "metric", width: 30 },
      { header: "Value", key: "value", width: 20 },
    ];

    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A5F" },
    };
    summarySheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

    summarySheet.addRow({ metric: "Report Generated", value: new Date().toLocaleDateString() });
    summarySheet.addRow({ metric: "Week", value: currentWeek });
    summarySheet.addRow({ metric: "", value: "" });
    summarySheet.addRow({ metric: "Total Open Actions", value: actions.length });
    summarySheet.addRow({ metric: "Overdue Actions", value: overdueActions.length });
    summarySheet.addRow({ metric: "Pending Actions", value: pendingActions.length });

    // Save file
    const fileName = `Planner_ToDo_${currentWeek}_${Date.now()}.xlsx`;
    const filePath = path.join(exportsDir, fileName);
    await workbook.xlsx.writeFile(filePath);

    // Save export record
    const exportRecord = await Export.create({
      type: "Planner To-Do",
      week: currentWeek,
      programme: activeProgramme._id,
      project: activeProgramme.project,
      generatedBy: req.admin._id,
      status: "Complete",
      filePath: filePath,
      fileName: fileName,
      exportData: {
        actionsCount: actions.length,
      },
    });

    // Audit log: Planner to-do exported
    await auditLogger.plannerTodoExported(
      req,
      req.admin,
      activeProgramme.project,
      currentWeekNumber,
      actions.length
    );

    // Send file
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Export-Id", exportRecord._id.toString());

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Planner to-do export error:", error);
    return sendError(res, "Server error");
  }
});

// GET /api/exports/download/:id - Download a previous export
router.get("/download/:id", protect, async (req, res) => {
  try {
    const exportRecord = await Export.findById(req.params.id);

    if (!exportRecord) {
      return sendError(res, "Export not found", 404);
    }

    if (!exportRecord.filePath || !fs.existsSync(exportRecord.filePath)) {
      return sendError(res, "Export file not found", 404);
    }

    // Audit log: Export downloaded
    await auditLogger.log({
      action: "EXPORT_DOWNLOADED",
      req,
      user: req.admin,
      resourceType: "Export",
      resourceId: exportRecord._id,
      resourceName: exportRecord.fileName,
      project: exportRecord.project,
      description: `Downloaded export "${exportRecord.fileName}"`,
      metadata: {
        exportType: exportRecord.type,
        week: exportRecord.week,
      },
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportRecord.fileName}"`
    );

    const fileStream = fs.createReadStream(exportRecord.filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("Download export error:", error);
    return sendError(res, "Server error");
  }
});

// POST /api/exports/activities-pdf - Generate Activities PDF with blocked indicator
router.post("/activities-pdf", protect, async (req, res) => {
  try {
    const requestedWeekNumber = req.body.weekNumber ? parseInt(req.body.weekNumber) : null;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    if (programmes.length === 0) {
      return sendError(res, "No active programmes found", 404);
    }

    const activeProgramme = programmes[0];
    const activities = activeProgramme.extractedData?.activities || [];
    const today = new Date();

    // Helper to parse date strings
    const parseActivityDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
      const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
      };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Find programme start date (earliest activity)
    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    // Calculate week number and date range
    let currentWeekNumber = 1;
    let weekStartDate = earliestDate;
    let weekEndDate = earliestDate ? new Date(earliestDate) : null;

    if (earliestDate) {
      earliestDate.setHours(0, 0, 0, 0);
      const todayStart = new Date(today);
      todayStart.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((todayStart - earliestDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      if (requestedWeekNumber) {
        currentWeekNumber = requestedWeekNumber;
      }

      weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(earliestDate.getDate() + (currentWeekNumber - 1) * 7);
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 13);
    }

    // Helper to check if activity is in current 2-week period
    const isActivityInWeek = (activity) => {
      if (!weekStartDate || !weekEndDate) return true;
      const actStart = parseActivityDate(activity.startDate);
      const actFinish = parseActivityDate(activity.finishDate);
      if (!actStart) return false;

      const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
      return startsThisWeek || spansThisWeek;
    };

    // Filter activities in week and add indicators
    const weekActivities = activities
      .filter(isActivityInWeek)
      .map((activity) => {
        const isCompleted = activity.status === "Completed" ||
          (activity.startDate && activity.startDate.includes(" A")) ||
          (activity.finishDate && activity.finishDate.includes(" A"));
        const isBlocked = activity.isBlocked === true;

        // Add indicators to dates
        let startDate = activity.startDate || "-";
        let finishDate = activity.finishDate || "-";

        // Clean existing indicators first
        const cleanStart = startDate.replace(/\s*[AB\*]$/, "").trim();
        const cleanFinish = finishDate.replace(/\s*[AB\*]$/, "").trim();

        if (isCompleted) {
          startDate = cleanStart + " A";
          finishDate = cleanFinish + " A";
        } else if (isBlocked) {
          startDate = cleanStart + " B";
          finishDate = cleanFinish + " B";
        } else {
          startDate = cleanStart;
          finishDate = cleanFinish;
        }

        // Determine status
        let status = "Ready";
        if (isCompleted) status = "Complete";
        else if (isBlocked) status = "Blocked";
        else if (activity.activityStatus) status = activity.activityStatus;

        return {
          ...activity,
          startDate,
          finishDate,
          displayStatus: status,
          isCompleted,
          isBlocked,
        };
      });

    const currentWeek = `W${currentWeekNumber}-${currentWeekNumber + 1}`;

    // Create PDF
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });

    const fileName = `Activities_${currentWeek}_${Date.now()}.pdf`;
    const filePath = path.join(exportsDir, fileName);
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    // Header
    doc.fontSize(18).font("Helvetica-Bold").text("Activities Report", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(12).font("Helvetica").text(`Week: ${currentWeek}`, { align: "center" });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
    doc.moveDown(0.5);

    // Legend
    doc.fontSize(9).font("Helvetica-Bold").text("Legend:", { continued: false });
    doc.font("Helvetica").text("A = Completed  |  B = Blocked", { continued: false });
    doc.moveDown(0.5);

    // Table setup
    const tableTop = doc.y;
    const colWidths = [60, 200, 80, 80, 60, 70, 80];
    const headers = ["Activity ID", "Activity Name", "Start Date", "End Date", "Duration", "Status", "Owner"];
    const rowHeight = 20;

    // Draw header row
    let x = 40;
    doc.font("Helvetica-Bold").fontSize(9);
    doc.rect(40, tableTop, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill("#1E3A5F");

    x = 40;
    doc.fillColor("white");
    headers.forEach((header, i) => {
      doc.text(header, x + 3, tableTop + 5, { width: colWidths[i] - 6, align: "left" });
      x += colWidths[i];
    });

    // Draw data rows
    doc.font("Helvetica").fontSize(8).fillColor("black");
    let y = tableTop + rowHeight;

    weekActivities.forEach((activity, index) => {
      // Check for page break
      if (y + rowHeight > doc.page.height - 40) {
        doc.addPage({ margin: 40, size: "A4", layout: "landscape" });
        y = 40;

        // Redraw header on new page
        x = 40;
        doc.font("Helvetica-Bold").fontSize(9);
        doc.rect(40, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill("#1E3A5F");

        x = 40;
        doc.fillColor("white");
        headers.forEach((header, i) => {
          doc.text(header, x + 3, y + 5, { width: colWidths[i] - 6, align: "left" });
          x += colWidths[i];
        });

        doc.font("Helvetica").fontSize(8).fillColor("black");
        y += rowHeight;
      }

      // Alternating row colors
      const bgColor = index % 2 === 0 ? "#F8F9FA" : "#FFFFFF";
      doc.rect(40, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(bgColor);

      // Row border
      doc.rect(40, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).stroke("#E5E7EB");

      // Status color indicator
      let statusColor = "#6B7280"; // grey default
      if (activity.isCompleted) statusColor = "#22C55E"; // green
      else if (activity.isBlocked) statusColor = "#EF4444"; // red
      else if (activity.displayStatus === "At Risk") statusColor = "#F59E0B"; // amber

      const rowData = [
        activity.activityId || "-",
        (activity.activityName || "-").substring(0, 40),
        activity.startDate || "-",
        activity.finishDate || "-",
        activity.duration || "-",
        activity.displayStatus || "-",
        (activity.ownerName || "-").substring(0, 15),
      ];

      x = 40;
      doc.fillColor("black");
      rowData.forEach((cell, i) => {
        // Special coloring for status column
        if (i === 5) {
          doc.fillColor(statusColor);
        }
        doc.text(String(cell), x + 3, y + 5, { width: colWidths[i] - 6, align: "left" });
        if (i === 5) {
          doc.fillColor("black");
        }
        x += colWidths[i];
      });

      y += rowHeight;
    });

    // Summary
    doc.moveDown(1);
    const summaryY = y + 20;
    doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
    doc.text(`Total Activities: ${weekActivities.length}`, 40, summaryY);
    doc.text(`Completed: ${weekActivities.filter(a => a.isCompleted).length}`, 200, summaryY);
    doc.text(`Blocked: ${weekActivities.filter(a => a.isBlocked).length}`, 350, summaryY);

    doc.end();

    // Wait for PDF to finish writing
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Save export record
    const exportRecord = await Export.create({
      type: "Activities PDF",
      week: currentWeek,
      programme: activeProgramme._id,
      project: activeProgramme.project,
      generatedBy: req.admin._id,
      status: "Complete",
      filePath: filePath,
      fileName: fileName,
      exportData: {
        activitiesCount: weekActivities.length,
        completedCount: weekActivities.filter(a => a.isCompleted).length,
        blockedCount: weekActivities.filter(a => a.isBlocked).length,
      },
    });

    // Audit log
    await auditLogger.log({
      action: "ACTIVITIES_PDF_EXPORTED",
      req,
      user: req.admin,
      resourceType: "Export",
      resourceId: exportRecord._id,
      resourceName: fileName,
      project: activeProgramme.project,
      description: `Exported activities PDF for ${currentWeek}`,
      metadata: {
        week: currentWeekNumber,
        activitiesCount: weekActivities.length,
      },
    });

    // Send file
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Export-Id", exportRecord._id.toString());

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("Activities PDF export error:", error);
    return sendError(res, "Server error");
  }
});

// Keep the old project-based exports for backward compatibility
router.get("/projects", protect, async (req, res) => {
  try {
    const projects = await Project.find({ status: { $ne: "Cancelled" } })
      .select("name phase status")
      .sort({ name: 1 });

    return sendSuccess(res, { projects });
  } catch (error) {
    console.error("Get projects for export error:", error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
