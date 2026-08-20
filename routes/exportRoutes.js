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
const {
  notifyPlannersOfTodoGenerated,
} = require("../utils/plannerNotifications");

const exportsDir = path.join(__dirname, "../uploads/exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

const calculateRAG = (activity, today) => {
  const parseDate = (dateStr) => {
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

    const ungatedStatuses = [
      "Execution",
      "Close-Out Eligible",
      "Approved",
      "Closed",
    ];
    const isGated = !ungatedStatuses.includes(cycleStatus);

    let currentWeek = "N/A";
    if (activeProgramme.lookaheadStartDate) {
      const startOfYear = new Date(
        new Date(activeProgramme.lookaheadStartDate).getFullYear(),
        0,
        1,
      );
      const days = Math.floor(
        (new Date(activeProgramme.lookaheadStartDate) - startOfYear) /
          (24 * 60 * 60 * 1000),
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

router.delete("/delete-all", protect, async (req, res) => {
  try {
    const result = await Export.deleteMany({});
    return sendSuccess(res, {
      message: "All exports deleted",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Delete all exports error:", error);
    return sendError(res, "Server error");
  }
});

router.post("/weekly-plan", protect, async (req, res) => {
  try {
    const { programmeId } = req.body;
    const requestedWeekNumber = req.body.weekNumber
      ? parseInt(req.body.weekNumber)
      : null;

    let activeProgramme;
    if (programmeId) {
      activeProgramme = await Programme.findById(programmeId);
      if (!activeProgramme) {
        return sendError(res, "Programme not found", 404);
      }
    } else {
      const projects = await Project.find({ status: { $ne: "Cancelled" } });
      const projectIds = projects.map((p) => p._id);

      const programmes = await Programme.find({
        status: { $in: ["processed", "pending"] },
        project: { $in: projectIds },
      }).sort({ createdAt: -1 });

      if (programmes.length === 0) {
        return sendError(res, "No active programmes found", 404);
      }
      activeProgramme = programmes[0];
    }
    const activities = activeProgramme.extractedData?.activities || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Owner is recorded on the activity, so actions resolve it by activity id.
    const ownerFor = (activityId) =>
      activities.find((a) => a.activityId === activityId)?.ownerName || "-";

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

    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    let weekStartDate = null;
    let weekEndDate = null;
    let currentWeekNumber = 1;

    const referenceDate = activeProgramme.lookaheadStartDate
      ? new Date(activeProgramme.lookaheadStartDate)
      : earliestDate;

    if (referenceDate) {
      referenceDate.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((today - referenceDate) / msPerDay);
      currentWeekNumber =
        requestedWeekNumber || Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      // A single governance week. This previously snapped to the odd-numbered
      // week of a pair and spanned 14 days, so an export labelled "W3" also
      // carried W4's actions.
      weekStartDate = new Date(referenceDate);
      weekStartDate.setDate(
        referenceDate.getDate() + (currentWeekNumber - 1) * 7,
      );
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 6);
    }

    const allActions = await Action.find({
      programme: activeProgramme._id,
    })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const actionsThisWeek =
      weekStartDate && weekEndDate
        ? allActions.filter((a) => {
            if (!a.dueDate) return false;
            const due = new Date(a.dueDate);
            return due >= weekStartDate && due <= weekEndDate;
          })
        : allActions;

    const completedActions = actionsThisWeek.filter(
      (a) => a.status === "Completed",
    );
    const overdueActions = actionsThisWeek.filter(
      (a) =>
        a.status !== "Completed" &&
        a.status !== "Cancelled" &&
        a.status !== "PM Override" &&
        a.dueDate &&
        new Date(a.dueDate) < today,
    );
    const pmOverrideActions = actionsThisWeek.filter(
      (a) => a.status === "PM Override",
    );

    const actionsByActivity = {};
    allActions.forEach((action) => {
      const actId = action.linkedActivity?.activityId;
      if (actId) {
        if (!actionsByActivity[actId]) {
          actionsByActivity[actId] = [];
        }
        actionsByActivity[actId].push(action);
      }
    });

    const isActivityCompletedViaActions = (activity) => {
      const linkedActions = actionsByActivity[activity.activityId] || [];
      if (linkedActions.length > 0) {
        return linkedActions.every(
          (action) =>
            action.status === "Completed" ||
            action.status === "Complete" ||
            action.status === "Cancelled",
        );
      }
      return false;
    };

    const isNoActionActivity = (activity) =>
      activity.assignmentState === "NoAction";

    const isMarkedComplete = (a) =>
      a.status === "Completed" ||
      a.activityStatus === "Complete" ||
      a.activityStatus === "Completed" ||
      (a.startDate && a.startDate.includes(" A")) ||
      (a.finishDate && a.finishDate.includes(" A"));

    const noActionActivities = activities.filter(isNoActionActivity);

    const readyActivities = activities.filter(
      (a) =>
        !isNoActionActivity(a) &&
        (isMarkedComplete(a) || isActivityCompletedViaActions(a)),
    );

    const readinessBasis = (activity) => {
      const linked = actionsByActivity[activity.activityId] || [];
      if (linked.length > 0) {
        const done = linked.filter(
          (x) =>
            x.status === "Completed" ||
            x.status === "Complete" ||
            x.status === "Cancelled",
        ).length;
        return `${done} of ${linked.length} action${linked.length === 1 ? "" : "s"} complete`;
      }
      return "Marked complete";
    };

    const blockedActivities = activities.filter((a) => a.isBlocked === true);

    const atRiskActivities = activities.filter((a) => {
      if (
        a.status === "Completed" ||
        a.activityStatus === "Complete" ||
        a.activityStatus === "Completed" ||
        (a.startDate && a.startDate.includes(" A")) ||
        (a.finishDate && a.finishDate.includes(" A")) ||
        isActivityCompletedViaActions(a)
      ) {
        return false;
      }
      if (a.isBlocked === true) {
        return false;
      }
      if (a.finishDate) {
        const cleanDate = a.finishDate.replace(/\s*[AB\*]$/, "").trim();
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
        if (match) {
          const day = parseInt(match[1]);
          const month = months[match[2]];
          let year = parseInt(match[3]);
          year = year < 50 ? 2000 + year : 1900 + year;
          const finishDate = new Date(year, month, day);
          return finishDate < today;
        }
      }
      return false;
    });

    const currentWeek = `W${currentWeekNumber}`;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PlanSure";
    workbook.created = new Date();

    const completedSheet = workbook.addWorksheet("Completed Actions");
    completedSheet.columns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Description", key: "description", width: 50 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Type", key: "type", width: 12 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Status", key: "status", width: 14 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Completed Date", key: "completedDate", width: 15 },
    ];
    completedSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    completedSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF22C55E" },
    };

    completedActions.forEach((action) => {
      completedSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        description: action.description || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        type: action.type || "-",
        status: action.status || "-",
        owner: ownerFor(action.linkedActivity?.activityId),
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        completedDate: action.updatedAt
          ? new Date(action.updatedAt).toLocaleDateString()
          : "-",
        priority: action.priority || "-",
      });
    });

    const overdueSheet = workbook.addWorksheet("Overdue Actions");
    overdueSheet.columns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Description", key: "description", width: 50 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Type", key: "type", width: 12 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Status", key: "status", width: 14 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Days Overdue", key: "daysOverdue", width: 15 },
    ];
    overdueSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    overdueSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEF4444" },
    };

    overdueActions.forEach((action) => {
      const daysOverdue = Math.ceil(
        (today - new Date(action.dueDate)) / (24 * 60 * 60 * 1000),
      );
      overdueSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        description: action.description || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        type: action.type || "-",
        status: action.status || "-",
        owner: ownerFor(action.linkedActivity?.activityId),
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        daysOverdue: daysOverdue,
        priority: action.priority || "-",
      });
    });

    const pmOverrideSheet = workbook.addWorksheet("PM Override Actions");
    pmOverrideSheet.columns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Description", key: "description", width: 50 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Type", key: "type", width: 12 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Status", key: "status", width: 14 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Override Date", key: "overrideDate", width: 15 },
    ];
    pmOverrideSheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    pmOverrideSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF9333EA" },
    };

    pmOverrideActions.forEach((action) => {
      pmOverrideSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        description: action.description || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        type: action.type || "-",
        status: action.status || "-",
        owner: ownerFor(action.linkedActivity?.activityId),
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        overrideDate: action.updatedAt
          ? new Date(action.updatedAt).toLocaleDateString()
          : "-",
        priority: action.priority || "-",
      });
    });

    const readyActivitiesSheet = workbook.addWorksheet("Ready Activities");
    readyActivitiesSheet.columns = [
      { header: "Activity ID", key: "activityId", width: 15 },
      { header: "Activity Name", key: "activityName", width: 40 },
      { header: "Start Date", key: "startDate", width: 15 },
      { header: "Finish Date", key: "finishDate", width: 15 },
      { header: "Duration", key: "duration", width: 12 },
      { header: "Basis", key: "basis", width: 26 },
      { header: "Owner", key: "owner", width: 20 },
    ];
    readyActivitiesSheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    readyActivitiesSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF22C55E" },
    };

    readyActivities.forEach((activity) => {
      readyActivitiesSheet.addRow({
        activityId: activity.activityId || "-",
        activityName: activity.activityName || "-",
        startDate: activity.startDate || "-",
        finishDate: activity.finishDate || "-",
        duration: activity.duration || "-",
        basis: readinessBasis(activity),
        owner: activity.ownerName || "-",
      });
    });

    const noActionSheet = workbook.addWorksheet("Completed with No Actions");
    noActionSheet.columns = [
      { header: "Activity ID", key: "activityId", width: 15 },
      { header: "Activity Name", key: "activityName", width: 40 },
      { header: "Start Date", key: "startDate", width: 15 },
      { header: "Finish Date", key: "finishDate", width: 15 },
      { header: "Duration", key: "duration", width: 12 },
      { header: "RAG Zone", key: "ragZone", width: 14 },
      { header: "Owner", key: "owner", width: 20 },
    ];
    noActionSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    noActionSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF22C55E" },
    };

    noActionActivities.forEach((activity) => {
      noActionSheet.addRow({
        activityId: activity.activityId || "-",
        activityName: activity.activityName || "-",
        startDate: activity.startDate || "-",
        finishDate: activity.finishDate || "-",
        duration: activity.duration || "-",
        ragZone: activity.weekZone || "-",
        owner: activity.ownerName || "-",
      });
    });

    const blockedActivitiesSheet = workbook.addWorksheet("Blocked Activities");
    blockedActivitiesSheet.columns = [
      { header: "Activity ID", key: "activityId", width: 15 },
      { header: "Activity Name", key: "activityName", width: 40 },
      { header: "Start Date", key: "startDate", width: 15 },
      { header: "Finish Date", key: "finishDate", width: 15 },
      { header: "Duration", key: "duration", width: 12 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Blocker", key: "blocker", width: 30 },
    ];
    blockedActivitiesSheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    blockedActivitiesSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF59E0B" },
    };

    blockedActivities.forEach((activity) => {
      blockedActivitiesSheet.addRow({
        activityId: activity.activityId || "-",
        activityName: activity.activityName || "-",
        startDate: activity.startDate || "-",
        finishDate: activity.finishDate || "-",
        duration: activity.duration || "-",
        owner: activity.ownerName || "-",
        blocker: activity.blocker || "-",
      });
    });

    const atRiskActivitiesSheet = workbook.addWorksheet("At Risk Activities");
    atRiskActivitiesSheet.columns = [
      { header: "Activity ID", key: "activityId", width: 15 },
      { header: "Activity Name", key: "activityName", width: 40 },
      { header: "Start Date", key: "startDate", width: 15 },
      { header: "Finish Date", key: "finishDate", width: 15 },
      { header: "Duration", key: "duration", width: 12 },
      { header: "Owner", key: "owner", width: 20 },
      { header: "Days Overdue", key: "daysOverdue", width: 15 },
    ];
    atRiskActivitiesSheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    atRiskActivitiesSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEF4444" },
    };

    atRiskActivities.forEach((activity) => {
      let daysOverdue = 0;
      if (activity.finishDate) {
        const cleanDate = activity.finishDate.replace(/\s*[AB\*]$/, "").trim();
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
        if (match) {
          const day = parseInt(match[1]);
          const month = months[match[2]];
          let year = parseInt(match[3]);
          year = year < 50 ? 2000 + year : 1900 + year;
          const finishDate = new Date(year, month, day);
          daysOverdue = Math.ceil((today - finishDate) / (24 * 60 * 60 * 1000));
        }
      }
      atRiskActivitiesSheet.addRow({
        activityId: activity.activityId || "-",
        activityName: activity.activityName || "-",
        startDate: activity.startDate || "-",
        finishDate: activity.finishDate || "-",
        duration: activity.duration || "-",
        owner: activity.ownerName || "-",
        daysOverdue: daysOverdue,
      });
    });

    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = [
      { header: "Category", key: "category", width: 25 },
      { header: "Count", key: "count", width: 15 },
    ];
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.addRow({ category: "--- ACTIONS ---", count: "" });
    summarySheet.addRow({
      category: "Completed Actions",
      count: completedActions.length,
    });
    summarySheet.addRow({
      category: "Overdue Actions",
      count: overdueActions.length,
    });
    summarySheet.addRow({
      category: "PM Override Actions",
      count: pmOverrideActions.length,
    });
    summarySheet.addRow({ category: "", count: "" });
    summarySheet.addRow({ category: "--- ACTIVITIES ---", count: "" });
    summarySheet.addRow({
      category: "Ready Activities (actions complete)",
      count: readyActivities.length,
    });
    summarySheet.addRow({
      category: "Completed with No Actions",
      count: noActionActivities.length,
    });
    summarySheet.addRow({
      category: "Blocked Activities",
      count: blockedActivities.length,
    });
    summarySheet.addRow({
      category: "At Risk (Overdue) Activities",
      count: atRiskActivities.length,
    });

    const totalActions =
      completedActions.length +
      overdueActions.length +
      pmOverrideActions.length;
    const totalActivities =
      readyActivities.length +
      noActionActivities.length +
      blockedActivities.length +
      atRiskActivities.length;
    const totalItems = totalActions + totalActivities;

    const fileName = `Weekly_Plan_${currentWeek}_${Date.now()}.xlsx`;
    const filePath = path.join(exportsDir, fileName);
    await workbook.xlsx.writeFile(filePath);

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
        completedActionsCount: completedActions.length,
        overdueActionsCount: overdueActions.length,
        pmOverrideActionsCount: pmOverrideActions.length,
        completedActivitiesCount: readyActivities.length,
        blockedActivitiesCount: blockedActivities.length,
        atRiskActivitiesCount: atRiskActivities.length,
        totalCount: totalItems,
      },
    });

    await auditLogger.weeklyPlanExported(
      req,
      req.admin,
      activeProgramme.project,
      currentWeekNumber,
      totalItems,
    );

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

router.post("/planner-todo", protect, async (req, res) => {
  try {
    const { programmeId, weekNumber: reqWeekNumber } = req.body;
    const requestedWeekNumber = reqWeekNumber ? parseInt(reqWeekNumber) : null;

    if (!programmeId) {
      return sendError(res, "Programme ID is required", 400);
    }

    const activeProgramme = await Programme.findById(programmeId);

    if (!activeProgramme) {
      return sendError(res, "Programme not found", 404);
    }
    const activities = activeProgramme.extractedData?.activities || [];

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

    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    let weekStartDate = null;
    let weekEndDate = null;
    let currentWeekNumber = 1;

    const referenceDate = activeProgramme.lookaheadStartDate
      ? new Date(activeProgramme.lookaheadStartDate)
      : earliestDate;

    if (referenceDate) {
      referenceDate.setHours(0, 0, 0, 0);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor(
        (todayStart - referenceDate) / msPerDay,
      );
      currentWeekNumber =
        requestedWeekNumber || Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      // A single governance week. This previously snapped to the odd-numbered
      // week of a pair and spanned 14 days, so an export labelled "W3" also
      // carried W4's actions.
      weekStartDate = new Date(referenceDate);
      weekStartDate.setDate(
        referenceDate.getDate() + (currentWeekNumber - 1) * 7,
      );
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 6);
    }

    let actions = await Action.find({
      programme: programmeId,
    })
      .populate("assignee", "name email")
      .populate("createdBy", "name email")
      .populate("overriddenBy", "name email");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (weekStartDate && weekEndDate) {
      actions = actions.filter((action) => {
        if (!action.dueDate) return false;
        const dueDate = new Date(action.dueDate);
        return dueDate >= weekStartDate && dueDate <= weekEndDate;
      });
    }

    const openActions = actions.filter(
      (a) =>
        (a.status === "Open" || !a.status) &&
        a.status !== "Completed" &&
        a.status !== "PM Override" &&
        a.status !== "Cancelled" &&
        a.status !== "In Progress",
    );

    const inProgressActions = actions.filter((a) => a.status === "In Progress");

    // Force-closed actions still belong on the Planner To-Do: the work was not
    // done, so the Planner has to reflect that in the programme update.
    const overriddenActions = actions.filter((a) => a.status === "PM Override");

    const currentWeek = `W${currentWeekNumber}`;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PlanSure";
    workbook.created = new Date();

    // Owner is recorded on the activity, so actions resolve it by activity id.
    const ownerFor = (activityId) =>
      activities.find((a) => a.activityId === activityId)?.ownerName || "-";

    const addActionRows = (sheet, actionList, includeOverdue = false) => {
      actionList.forEach((action) => {
        const row = {
          actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
          title: action.title || "-",
          description: action.description || "-",
          linkedActivity: action.linkedActivity?.activityName || "-",
          type: action.type || "-",
          priority: action.priority || "-",
          assignee: action.assignee?.name || "-",
          dueDate: action.dueDate
            ? new Date(action.dueDate).toLocaleDateString()
            : "-",
          status: action.status || "-",
          owner: ownerFor(action.linkedActivity?.activityId),
        };
        if (includeOverdue) {
          row.daysOverdue = action.dueDate
            ? Math.ceil(
                (today - new Date(action.dueDate)) / (24 * 60 * 60 * 1000),
              )
            : 0;
        }
        sheet.addRow(row);
      });
    };

    // Mirrors the fields captured on the action form.
    const baseColumns = [
      { header: "Action ID", key: "actionId", width: 15 },
      { header: "Title", key: "title", width: 40 },
      { header: "Description", key: "description", width: 50 },
      { header: "Linked Activity", key: "linkedActivity", width: 30 },
      { header: "Type", key: "type", width: 12 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Assignee", key: "assignee", width: 20 },
      { header: "Due Date", key: "dueDate", width: 15 },
      { header: "Status", key: "status", width: 14 },
      { header: "Owner", key: "owner", width: 20 },
    ];

    const openSheet = workbook.addWorksheet("Open Actions");
    openSheet.columns = [...baseColumns];
    openSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    openSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF59E0B" },
    };
    addActionRows(openSheet, openActions);

    const inProgressSheet = workbook.addWorksheet("In Progress Actions");
    inProgressSheet.columns = [...baseColumns];
    inProgressSheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    inProgressSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF3B82F6" },
    };
    addActionRows(inProgressSheet, inProgressActions);

    // Always created, like the sheets above, so an empty tab still tells the
    // Planner that nothing was force-closed this week.
    const overrideSheet = workbook.addWorksheet("PM Override Actions");
    overrideSheet.columns = [
      ...baseColumns,
      { header: "Override Reason", key: "overrideReason", width: 50 },
      { header: "Overridden By", key: "overriddenBy", width: 20 },
      { header: "Overridden At", key: "overriddenAt", width: 22 },
    ];
    overrideSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    overrideSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD97706" },
    };
    overriddenActions.forEach((action) => {
      overrideSheet.addRow({
        actionId: `ACT-${String(action._id).slice(-4).toUpperCase()}`,
        title: action.title || "-",
        description: action.description || "-",
        linkedActivity: action.linkedActivity?.activityName || "-",
        type: action.type || "-",
        priority: action.priority || "-",
        assignee: action.assignee?.name || "-",
        dueDate: action.dueDate
          ? new Date(action.dueDate).toLocaleDateString()
          : "-",
        status: action.status || "-",
        owner: ownerFor(action.linkedActivity?.activityId),
        overrideReason: action.overrideReason || "-",
        overriddenBy: action.overriddenBy?.name || "-",
        overriddenAt: action.overriddenAt
          ? new Date(action.overriddenAt).toLocaleString()
          : "-",
      });
    });

    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = [
      { header: "Metric", key: "metric", width: 30 },
      { header: "Value", key: "value", width: 20 },
    ];
    summarySheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    summarySheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A5F" },
    };

    summarySheet.addRow({
      metric: "Report Generated",
      value: new Date().toLocaleDateString(),
    });
    summarySheet.addRow({ metric: "Week", value: currentWeek });
    if (weekStartDate && weekEndDate) {
      const formatDate = (d) =>
        d.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });
      summarySheet.addRow({
        metric: "Date Range",
        value: `${formatDate(weekStartDate)} - ${formatDate(weekEndDate)}`,
      });
    }
    summarySheet.addRow({ metric: "", value: "" });
    summarySheet.addRow({
      metric: "Total Actions (Current Week)",
      value:
        openActions.length +
        inProgressActions.length +
        overriddenActions.length,
    });
    summarySheet.addRow({ metric: "", value: "" });
    summarySheet.addRow({ metric: "Open Actions", value: openActions.length });
    summarySheet.addRow({
      metric: "In Progress Actions",
      value: inProgressActions.length,
    });
    // Broken out so the total reconciles: overridden actions were counted in
    // "Total Actions" but had no line of their own.
    summarySheet.addRow({
      metric: "PM Override Actions",
      value: overriddenActions.length,
    });

    const fileName = `Planner_ToDo_${currentWeek}_${Date.now()}.xlsx`;
    const filePath = path.join(exportsDir, fileName);
    await workbook.xlsx.writeFile(filePath);

    const totalActions =
      openActions.length + inProgressActions.length + overriddenActions.length;
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
        totalActionsCount: totalActions,
        openActionsCount: openActions.length,
        inProgressActionsCount: inProgressActions.length,
      },
    });

    await auditLogger.plannerTodoExported(
      req,
      req.admin,
      activeProgramme.project,
      currentWeekNumber,
      totalActions,
    );

    // Tell planners the list has been issued (MS-05 §5). Isolated so a
    // notification failure cannot fail the download.
    try {
      await notifyPlannersOfTodoGenerated({
        programme: activeProgramme,
        weekNumber: currentWeekNumber,
        totalActions,
        sender: req.admin,
      });
    } catch (notifyError) {
      console.error("Planner To-Do notification failed:", notifyError);
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

router.get("/download/:id", protect, async (req, res) => {
  try {
    const exportRecord = await Export.findById(req.params.id);

    if (!exportRecord) {
      return sendError(res, "Export not found", 404);
    }

    if (!exportRecord.filePath || !fs.existsSync(exportRecord.filePath)) {
      return sendError(res, "Export file not found", 404);
    }

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
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportRecord.fileName}"`,
    );

    const fileStream = fs.createReadStream(exportRecord.filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("Download export error:", error);
    return sendError(res, "Server error");
  }
});

router.post("/activities-pdf", protect, async (req, res) => {
  try {
    const requestedWeekNumber = req.body.weekNumber
      ? parseInt(req.body.weekNumber)
      : null;

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

    let earliestDate = null;
    for (const activity of activities) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

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
      weekStartDate.setDate(
        earliestDate.getDate() + (currentWeekNumber - 1) * 7,
      );
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 13);
    }

    const isActivityInWeek = (activity) => {
      if (!weekStartDate || !weekEndDate) return true;
      const actStart = parseActivityDate(activity.startDate);
      const actFinish = parseActivityDate(activity.finishDate);
      if (!actStart) return false;

      const startsThisWeek =
        actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek =
        actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
      return startsThisWeek || spansThisWeek;
    };

    const weekActivities = activities
      .filter(isActivityInWeek)
      .map((activity) => {
        const isCompleted =
          activity.status === "Completed" ||
          (activity.startDate && activity.startDate.includes(" A")) ||
          (activity.finishDate && activity.finishDate.includes(" A"));
        const isBlocked = activity.isBlocked === true;

        let startDate = activity.startDate || "-";
        let finishDate = activity.finishDate || "-";

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

    const currentWeek = `W${currentWeekNumber}`;

    const doc = new PDFDocument({
      margin: 40,
      size: "A4",
      layout: "landscape",
    });

    const fileName = `Activities_${currentWeek}_${Date.now()}.pdf`;
    const filePath = path.join(exportsDir, fileName);
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text("Activities Report", { align: "center" });
    doc.moveDown(0.3);
    doc
      .fontSize(12)
      .font("Helvetica")
      .text(`Week: ${currentWeek}`, { align: "center" });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleDateString()}`, {
      align: "center",
    });
    doc.moveDown(0.5);

    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .text("Legend:", { continued: false });
    doc
      .font("Helvetica")
      .text("A = Completed  |  B = Blocked", { continued: false });
    doc.moveDown(0.5);

    const tableTop = doc.y;
    const colWidths = [60, 200, 80, 80, 60, 70, 80];
    const headers = [
      "Activity ID",
      "Activity Name",
      "Start Date",
      "End Date",
      "Duration",
      "Status",
      "Owner",
    ];
    const rowHeight = 20;

    let x = 40;
    doc.font("Helvetica-Bold").fontSize(9);
    doc
      .rect(
        40,
        tableTop,
        colWidths.reduce((a, b) => a + b, 0),
        rowHeight,
      )
      .fill("#1E3A5F");

    x = 40;
    doc.fillColor("white");
    headers.forEach((header, i) => {
      doc.text(header, x + 3, tableTop + 5, {
        width: colWidths[i] - 6,
        align: "left",
      });
      x += colWidths[i];
    });

    doc.font("Helvetica").fontSize(8).fillColor("black");
    let y = tableTop + rowHeight;

    weekActivities.forEach((activity, index) => {
      if (y + rowHeight > doc.page.height - 40) {
        doc.addPage({ margin: 40, size: "A4", layout: "landscape" });
        y = 40;

        x = 40;
        doc.font("Helvetica-Bold").fontSize(9);
        doc
          .rect(
            40,
            y,
            colWidths.reduce((a, b) => a + b, 0),
            rowHeight,
          )
          .fill("#1E3A5F");

        x = 40;
        doc.fillColor("white");
        headers.forEach((header, i) => {
          doc.text(header, x + 3, y + 5, {
            width: colWidths[i] - 6,
            align: "left",
          });
          x += colWidths[i];
        });

        doc.font("Helvetica").fontSize(8).fillColor("black");
        y += rowHeight;
      }

      const bgColor = index % 2 === 0 ? "#F8F9FA" : "#FFFFFF";
      doc
        .rect(
          40,
          y,
          colWidths.reduce((a, b) => a + b, 0),
          rowHeight,
        )
        .fill(bgColor);

      doc
        .rect(
          40,
          y,
          colWidths.reduce((a, b) => a + b, 0),
          rowHeight,
        )
        .stroke("#E5E7EB");

      let statusColor = "#6B7280";
      if (activity.isCompleted) statusColor = "#22C55E";
      else if (activity.isBlocked) statusColor = "#EF4444";
      else if (activity.displayStatus === "At Risk") statusColor = "#F59E0B";

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
        if (i === 5) {
          doc.fillColor(statusColor);
        }
        doc.text(String(cell), x + 3, y + 5, {
          width: colWidths[i] - 6,
          align: "left",
        });
        if (i === 5) {
          doc.fillColor("black");
        }
        x += colWidths[i];
      });

      y += rowHeight;
    });

    doc.moveDown(1);
    const summaryY = y + 20;
    doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
    doc.text(`Total Activities: ${weekActivities.length}`, 40, summaryY);
    doc.text(
      `Completed: ${weekActivities.filter((a) => a.isCompleted).length}`,
      200,
      summaryY,
    );
    doc.text(
      `Blocked: ${weekActivities.filter((a) => a.isBlocked).length}`,
      350,
      summaryY,
    );

    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

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
        completedCount: weekActivities.filter((a) => a.isCompleted).length,
        blockedCount: weekActivities.filter((a) => a.isBlocked).length,
      },
    });

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
