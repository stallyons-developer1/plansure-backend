const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const Programme = require("../models/Programme");
const Action = require("../models/Action");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");

const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
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

const calculateRAG = (activity, today) => {
  const startDate = parseDate(activity.startDate);
  const finishDate = parseDate(activity.finishDate);

  if (activity.status === "Completed") {
    return "Green";
  }

  if (!startDate) {
    return "Grey";
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilStart = Math.ceil((startDate - today) / msPerDay);
  const weeksUntilStart = Math.ceil(daysUntilStart / 7);

  if (daysUntilStart < 0) {
    if (finishDate && finishDate < today) {
      return "Red";
    }
    return "Green";
  }

  if (weeksUntilStart <= 2) {
    return "Green";
  } else if (weeksUntilStart <= 4) {
    return "Amber";
  } else if (weeksUntilStart <= 6) {
    return "Red";
  } else {
    return "Grey";
  }
};

router.get("/stats", protect, async (req, res) => {
  try {
    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const projectsByPhase = projects.reduce((acc, p) => {
      const phase = p.phase || "Other";
      acc[phase] = (acc[phase] || 0) + 1;
      return acc;
    }, {});

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    });
    const programmeIds = programmes.map((p) => p._id);

    let totalActivities = 0;
    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let greyCount = 0;
    let currentCycle = null;
    let cycleStatus = null;
    let activeProgramme = null;

    const sortedProgrammes = programmes.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    if (sortedProgrammes.length > 0) {
      activeProgramme = sortedProgrammes[0];
      cycleStatus = activeProgramme.cycleStatus;

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
        currentCycle = `W${Math.ceil((days + 1) / 7)}`;
      }
    }

    const today = new Date();
    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];

      totalActivities += activities.length;

      for (const activity of activities) {
        const rag = calculateRAG(activity, today);
        if (rag === "Green") greenCount++;
        else if (rag === "Amber") amberCount++;
        else if (rag === "Red") redCount++;
        else greyCount++;
      }
    }

    const actions = await Action.find({
      programme: { $in: programmeIds },
    });
    const openActions = actions.filter(
      (a) => a.status !== "Completed" && a.status !== "Cancelled",
    );
    const overdueActions = actions.filter(
      (a) =>
        a.status !== "Completed" &&
        a.status !== "Cancelled" &&
        new Date(a.dueDate) < new Date(),
    );
    const pendingActions = openActions.length - overdueActions.length;

    let cycleDayInfo = null;
    if (activeProgramme?.lookaheadStartDate) {
      const cycleStart = new Date(activeProgramme.lookaheadStartDate);
      const today = new Date();
      const daysSinceStart = Math.floor(
        (today - cycleStart) / (24 * 60 * 60 * 1000),
      );
      const cycleDuration = 5;
      const currentDay = Math.min(daysSinceStart + 1, cycleDuration);
      const daysRemaining = Math.max(0, cycleDuration - currentDay);

      cycleDayInfo = {
        currentDay,
        totalDays: cycleDuration,
        daysRemaining,
      };
    }

    return sendSuccess(res, {
      stats: {
        projects: {
          total: projects.length,
          byPhase: projectsByPhase,
        },
        cycle: {
          current: currentCycle || "N/A",
          status: cycleStatus || "N/A",
          dayInfo: cycleDayInfo,
          programmeId: activeProgramme?._id,
          programmeName: activeProgramme?.name,
        },
        activities: {
          total: totalActivities,
          inLookahead: greenCount + amberCount + redCount,
          green: greenCount,
          amber: amberCount,
          red: redCount,
          grey: greyCount,
        },
        actions: {
          open: openActions.length,
          overdue: overdueActions.length,
          pending: pendingActions,
        },
      },
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/rag-distribution", protect, async (req, res) => {
  try {
    const { programmeId } = req.query;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    let programmes;
    if (programmeId) {
      const programme = await Programme.findById(programmeId);
      programmes = programme ? [programme] : [];
    } else {
      programmes = await Programme.find({
        status: { $in: ["processed", "pending"] },
        project: { $in: projectIds },
      });
    }

    let totalActivities = 0;
    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;

    const today = new Date();
    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];

      for (const activity of activities) {
        const rag = calculateRAG(activity, today);
        if (rag !== "Grey") {
          totalActivities++;
          if (rag === "Green") greenCount++;
          else if (rag === "Amber") amberCount++;
          else if (rag === "Red") redCount++;
        }
      }
    }

    const ragAssignedTotal = greenCount + amberCount + redCount;

    const greenPercentage =
      ragAssignedTotal > 0
        ? Math.round((greenCount / ragAssignedTotal) * 100)
        : 0;
    const amberPercentage =
      ragAssignedTotal > 0
        ? Math.round((amberCount / ragAssignedTotal) * 100)
        : 0;
    const redPercentage =
      ragAssignedTotal > 0
        ? Math.round((redCount / ragAssignedTotal) * 100)
        : 0;

    return sendSuccess(res, {
      distribution: {
        total: ragAssignedTotal,
        green: { count: greenCount, percentage: greenPercentage },
        amber: { count: amberCount, percentage: amberPercentage },
        red: { count: redCount, percentage: redPercentage },
      },
    });
  } catch (error) {
    console.error("RAG distribution error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/recent-activity", protect, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    const existingProgrammes = await Programme.find({
      project: { $in: projectIds },
    });
    const programmeIds = existingProgrammes.map((p) => p._id);

    const recentProgrammes = await Programme.find({
      project: { $in: projectIds },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("uploadedBy", "name email")
      .populate("project", "name");

    const recentActions = await Action.find({
      programme: { $in: programmeIds },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("createdBy", "name email")
      .populate("assignee", "name email");

    const recentProjects = await Project.find({ status: { $ne: "Cancelled" } })
      .sort({ createdAt: -1 })
      .limit(3)
      .populate("createdBy", "name email");

    const activities = [];

    for (const prog of recentProgrammes) {
      activities.push({
        id: prog._id,
        type: "programme_upload",
        title: "Programme PDF uploaded",
        description: `${prog.originalFileName} — ${prog.extractedData?.totalActivities || 0} activities parsed`,
        timestamp: prog.createdAt,
        author: prog.uploadedBy?.name || "System",
        projectName: prog.project?.name,
        color: "blue",
      });
    }

    for (const action of recentActions) {
      const isCompleted = action.status === "Completed";
      activities.push({
        id: action._id,
        type: isCompleted ? "action_completed" : "action_created",
        title: isCompleted ? "Action completed" : "Action created",
        description: `${action.title}${action.linkedActivity?.activityName ? ` — linked to ${action.linkedActivity.activityName}` : ""}`,
        timestamp: isCompleted ? action.completedAt : action.createdAt,
        author: action.createdBy?.name || "System",
        color: isCompleted ? "green" : "red",
      });
    }

    for (const project of recentProjects) {
      activities.push({
        id: project._id,
        type: "project_created",
        title: "Project created",
        description: `${project.name} — ${project.phase} phase`,
        timestamp: project.createdAt,
        author: project.createdBy?.name || "System",
        color: "blue",
      });
    }

    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limitedActivities = activities.slice(0, parseInt(limit));

    return sendSuccess(res, { activities: limitedActivities });
  } catch (error) {
    console.error("Recent activity error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/weekly", protect, async (req, res) => {
  try {
    const { projectId } = req.query;

    const projects = await Project.find({ status: { $ne: "Cancelled" } });
    const projectIds = projects.map((p) => p._id);

    if (projects.length === 0) {
      return sendSuccess(res, {
        weekly: {
          project: null,
          cycle: null,
          stats: {
            activitiesInLookahead: 0,
            greenActivities: 0,
            greenPercentage: 0,
            blockedByActions: 0,
            openActions: 0,
            overdueActions: 0,
            readyForClose: false,
          },
          ragDistribution: { green: 0, amber: 0, red: 0 },
          actionsByStatus: { open: 0, closed: 0, overdue: 0 },
          blockedActivities: [],
          weeklyPlanPreview: [],
          plannerToDo: [],
        },
      });
    }

    const programmes = await Programme.find({
      status: { $in: ["processed", "pending"] },
      project: { $in: projectIds },
    })
      .populate("project", "name")
      .populate("uploadedBy", "name");

    const sortedProgrammes = programmes.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    const activeProgramme = sortedProgrammes[0];
    const programmeIds = programmes.map((p) => p._id);

    let weekNumber = "N/A";
    let weekDates = "";
    let weekOpened = "";
    let closeDeadline = "";
    let cycleStatus = "Draft";

    if (activeProgramme?.lookaheadStartDate) {
      const startDate = new Date(activeProgramme.lookaheadStartDate);
      const startOfYear = new Date(startDate.getFullYear(), 0, 1);
      const days = Math.floor(
        (startDate - startOfYear) / (24 * 60 * 60 * 1000),
      );
      weekNumber = `Week ${Math.ceil((days + 1) / 7)}`;

      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);

      const formatDate = (d) => {
        const day = d.getDate();
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
      };

      const formatShort = (d) => {
        const day = d.getDate();
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        return `${day}-${day + 6} ${months[d.getMonth()]} ${d.getFullYear()}`;
      };

      weekDates = `(${startDate.getDate()}-${endDate.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][startDate.getMonth()]} ${startDate.getFullYear()})`;
      weekOpened = formatDate(startDate);
      closeDeadline = formatDate(endDate);
      cycleStatus = activeProgramme.cycleStatus || "Draft";
    }

    const rawActivities = activeProgramme?.extractedData?.activities || [];
    const today = new Date();

    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let blockedCount = 0;

    const activities = [];
    for (const activity of rawActivities) {
      const rag = calculateRAG(activity, today);
      if (rag !== "Grey") {
        activities.push({ ...activity, ragStatus: rag });
        if (rag === "Green") greenCount++;
        else if (rag === "Amber") amberCount++;
        else if (rag === "Red") redCount++;

        if (activity.isBlocked) blockedCount++;
      }
    }

    const totalActivities = activities.length;
    const ragTotal = greenCount + amberCount + redCount;
    const greenPercentage =
      ragTotal > 0 ? Math.round((greenCount / ragTotal) * 100) : 0;

    const actions = await Action.find({ programme: { $in: programmeIds } })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const openActions = actions.filter(
      (a) => a.status !== "Completed" && a.status !== "Cancelled",
    );
    const closedActions = actions.filter((a) => a.status === "Completed");
    const overdueActions = actions.filter(
      (a) =>
        a.status !== "Completed" &&
        a.status !== "Cancelled" &&
        new Date(a.dueDate) < new Date(),
    );

    const readyForClose = overdueActions.length === 0 && blockedCount === 0;

    const blockedActivities = activities
      .filter(
        (a) => a.isBlocked || a.ragStatus === "Red" || a.ragStatus === "Amber",
      )
      .slice(0, 10)
      .map((a) => {
        const linkedAction = actions.find(
          (act) => act.linkedActivity?.activityId === a.activityId,
        );
        return {
          id: a.activityId,
          name: a.activityName,
          rag: a.ragStatus,
          owner: a.ownerName || "-",
          blocker: a.blocker || (a.isBlocked ? "Blocked" : "Needs attention"),
          linkedAction: linkedAction
            ? `ACT-${String(linkedAction._id).slice(-4).toUpperCase()}`
            : "-",
          status:
            linkedAction && new Date(linkedAction.dueDate) < today
              ? "Overdue"
              : "Open",
        };
      });

    const sortedActivities = [...activities].sort((a, b) => {
      const ragOrder = { Green: 1, Amber: 2, Red: 3 };
      return (ragOrder[a.ragStatus] || 4) - (ragOrder[b.ragStatus] || 4);
    });

    const weeklyPlanPreview = sortedActivities.slice(0, 10).map((a) => ({
      activityId: a.activityId,
      activityName: a.activityName,
      weekZone:
        a.ragStatus === "Green"
          ? "Weeks 1-2"
          : a.ragStatus === "Amber"
            ? "Weeks 3-4"
            : "Weeks 5-6",
      startDate: a.startDate,
      finishDate: a.finishDate,
      duration: a.duration,
      ragStatus: a.ragStatus,
      owner: a.ownerName || "-",
      activityStatus: a.activityStatus || "Ready",
    }));

    const plannerToDo = openActions.slice(0, 10).map((action) => ({
      activityId: action.linkedActivity?.activityId || "-",
      activityName: action.linkedActivity?.activityName || action.title,
      ragStatus: "Amber",
      owner: action.assignee?.name || "-",
      todoItem: action.title,
      priority: action.priority || "Medium",
      dueDate: action.dueDate,
    }));

    return sendSuccess(res, {
      weekly: {
        project: {
          id: activeProgramme?.project?._id,
          name: activeProgramme?.project?.name || "No Project",
        },
        programme: {
          id: activeProgramme?._id,
          name: activeProgramme?.name,
        },
        cycle: {
          weekNumber,
          weekDates,
          status: cycleStatus,
          weekOpened,
          closeDeadline,
          planner: activeProgramme?.uploadedBy?.name || "-",
        },
        stats: {
          activitiesInLookahead: totalActivities,
          greenActivities: greenCount,
          greenPercentage,
          blockedByActions: blockedCount,
          openActions: openActions.length,
          overdueActions: overdueActions.length,
          readyForClose,
        },
        ragDistribution: {
          green: greenCount,
          amber: amberCount,
          red: redCount,
        },
        actionsByStatus: {
          open: openActions.length,
          closed: closedActions.length,
          overdue: overdueActions.length,
        },
        blockedActivities,
        weeklyPlanPreview,
        plannerToDo,
      },
    });
  } catch (error) {
    console.error("Weekly dashboard error:", error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
