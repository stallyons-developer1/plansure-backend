const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const Programme = require("../models/Programme");
const Action = require("../models/Action");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");
const { syncProgrammesGovernance } = require("../utils/governance");

const getPlannerAccessibleProjects = async (admin) => {
  const userAssignedProjects = (admin.projects || []).map((p) => p.toString());

  const userActions = await Action.find({
    $or: [{ assignee: admin._id }, { "previousAssignees.user": admin._id }],
  }).select("programme");

  let actionProjectIds = [];
  if (userActions.length > 0) {
    const programmeIds = [
      ...new Set(userActions.map((a) => a.programme.toString())),
    ];
    const programmes = await Programme.find({
      _id: { $in: programmeIds },
    }).select("project");
    actionProjectIds = programmes
      .map((p) => p.project?.toString())
      .filter(Boolean);
  }

  const teamProjects = await Project.find({
    "team.user": admin._id,
    status: { $ne: "Cancelled" },
  }).select("_id");
  const teamProjectIds = teamProjects.map((p) => p._id.toString());

  return [
    ...new Set([
      ...userAssignedProjects,
      ...actionProjectIds,
      ...teamProjectIds,
    ]),
  ];
};

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

const calculateRAG = (activity, today) => {
  const startDate = parseDate(activity.startDate);
  const finishDate = parseDate(activity.finishDate);

  const isCompleted =
    activity.status === "Completed" ||
    activity.activityStatus === "Complete" ||
    activity.activityStatus === "Completed" ||
    (activity.startDate && activity.startDate.includes(" A")) ||
    (activity.finishDate && activity.finishDate.includes(" A"));

  if (isCompleted) {
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

const storedRag = (activity) => {
  const rag = activity.ragStatus || "Grey";
  if (rag === "Blue") return "Green";
  if (rag === "Green" || rag === "Amber" || rag === "Red") return rag;
  return "Grey";
};

router.get("/stats", protect, async (req, res) => {
  try {
    const { projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      const accessibleProjectIds = await getPlannerAccessibleProjects(
        req.admin,
      );
      if (accessibleProjectIds.length === 0) {
        return sendSuccess(res, {
          stats: {
            projects: { total: 0, byPhase: {} },
            cycle: { current: "N/A", status: "N/A", dayInfo: null },
            activities: {
              total: 0,
              inLookahead: 0,
              green: 0,
              amber: 0,
              red: 0,
              grey: 0,
            },
            actions: { open: 0, overdue: 0, pending: 0 },
          },
        });
      }
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    } else {
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    }

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
    await syncProgrammesGovernance(programmes, Action);

    let totalActivities = 0;
    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let greyCount = 0;
    let currentCycle = null;
    let cycleStatus = null;
    let activeProgramme = null;
    let closedCycleCount = 0;
    let cycleWeekStart = null;

    const sortedProgrammes = programmes.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    if (sortedProgrammes.length > 0) {
      activeProgramme = sortedProgrammes[0];
      cycleStatus = activeProgramme.cycleStatus;

      const activities = activeProgramme.extractedData?.activities || [];
      let earliestStartDate = null;

      for (const activity of activities) {
        const startDate = parseDate(activity.startDate);
        if (
          startDate &&
          (!earliestStartDate || startDate < earliestStartDate)
        ) {
          earliestStartDate = startDate;
        }
      }

      // Mirror the Weekly Dashboard: the week shown is the project's latest
      // CLOSED week, counted cumulatively across all of its programmes. The
      // old calendar-drift maths ignored closes entirely and clamped to W1
      // whenever the programme's first activity was still in the future.
      const CycleHistoryForWeek = require("../models/CycleHistory");
      closedCycleCount = await CycleHistoryForWeek.countDocuments({
        programme: { $in: programmeIds },
      });

      if (closedCycleCount > 0) {
        currentCycle = `W${closedCycleCount}`;
        const latestCycle = await CycleHistoryForWeek.findOne({
          programme: { $in: programmeIds },
        })
          .sort({ createdAt: -1 })
          .lean();
        cycleWeekStart = latestCycle?.dateRange?.startDate
          ? new Date(latestCycle.dateRange.startDate)
          : new Date(latestCycle.createdAt);
        cycleWeekStart.setHours(0, 0, 0, 0);
      } else if (earliestStartDate) {
        // Nothing closed yet: the first week is the one in progress.
        earliestStartDate.setHours(0, 0, 0, 0);
        currentCycle = "W1";
        cycleWeekStart = new Date(earliestStartDate);
      }
    }

    const today = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];

      totalActivities += activities.length;

      for (const activity of activities) {
        const rag = storedRag(activity);
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
        new Date(a.dueDate) < startOfToday,
    );
    const pendingActions = openActions.length - overdueActions.length;

    // Days elapsed within the week itself, not the day of the calendar week.
    // The old version used today.getDay() against a hardcoded 14, so it read
    // "Day 4 of 14" on any Thursday and reset every Monday.
    let cycleDayInfo = null;
    if (cycleWeekStart) {
      const CYCLE_DAYS = 7;
      const msPerDay = 1000 * 60 * 60 * 24;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const elapsed = Math.floor((todayStart - cycleWeekStart) / msPerDay) + 1;
      const currentDay = Math.min(CYCLE_DAYS, Math.max(1, elapsed));

      cycleDayInfo = {
        currentDay,
        totalDays: CYCLE_DAYS,
        daysRemaining: Math.max(0, CYCLE_DAYS - currentDay),
        closedWeeks: closedCycleCount,
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
    const { programmeId, projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      const accessibleProjectIds = await getPlannerAccessibleProjects(
        req.admin,
      );
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    } else {
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    }

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

    await syncProgrammesGovernance(programmes, Action);

    let totalActivities = 0;
    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let greyCount = 0;

    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];

      for (const activity of activities) {
        const rag = storedRag(activity);
        if (rag !== "Grey") {
          totalActivities++;
          if (rag === "Green") greenCount++;
          else if (rag === "Amber") amberCount++;
          else if (rag === "Red") redCount++;
        } else {
          greyCount++;
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
        // Not part of the ring's denominator; reported so the UI can render a
        // grey placeholder ring (and say how many) when nothing is assessed.
        grey: { count: greyCount },
      },
    });
  } catch (error) {
    console.error("RAG distribution error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/recent-activity", protect, async (req, res) => {
  try {
    const { limit = 10, projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      const accessibleProjectIds = await getPlannerAccessibleProjects(
        req.admin,
      );
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    } else {
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    }

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

    const recentProjects = projectId
      ? projects
      : await Project.find({ status: { $ne: "Cancelled" } })
          .sort({ createdAt: -1 })
          .limit(3)
          .populate("createdBy", "name email");

    const CycleHistoryModel = require("../models/CycleHistory");
    const recentCycles = await CycleHistoryModel.find({
      programme: { $in: programmeIds },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("closedBy", "name email")
      .populate({
        path: "programme",
        select: "name project",
        populate: { path: "project", select: "name" },
      });

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

    // Week closes live in CycleHistory, not in Programme/Action/Project, so
    // they need their own pass or they never reach the feed at all.
    for (const cycle of recentCycles) {
      const isOverride = cycle.closeType === "PM Override";
      const weekLabel = cycle.weekLabel || `Week ${cycle.weekNumber}`;
      const progName = cycle.programme?.name;
      const parts = [weekLabel];
      if (progName) parts.push(progName);
      if (isOverride) {
        if (cycle.notes) parts.push(`reason: ${cycle.notes}`);
      } else if (cycle.stats?.totalActivities) {
        parts.push(
          `${cycle.stats.green || 0}/${cycle.stats.totalActivities} activities on track`,
        );
      }

      activities.push({
        id: cycle._id,
        type: isOverride ? "cycle_override" : "cycle_closed",
        title: isOverride ? "Week closed via PM Override" : "Week closed",
        description: parts.join(" — "),
        // CycleHistory has no closedAt field; createdAt IS the close time.
        timestamp: cycle.createdAt,
        author: cycle.closedBy?.name || "System",
        projectName: cycle.programme?.project?.name,
        color: isOverride ? "amber" : "green",
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

router.get("/governance", protect, async (req, res) => {
  try {
    const { projectId } = req.query;
    const CycleHistory = require("../models/CycleHistory");

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "admin") {
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    } else {
      const accessibleProjectIds = await getPlannerAccessibleProjects(
        req.admin,
      );
      if (accessibleProjectIds.length === 0) {
        return sendSuccess(res, {
          governance: {
            hasData: false,
            message:
              "No projects assigned to you. Contact an admin to get assigned to a project.",
          },
        });
      }
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    }

    const programmes = await Programme.find({
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    if (projects.length === 0 || programmes.length === 0) {
      return sendSuccess(res, {
        governance: {
          hasData: false,
          message:
            programmes.length === 0
              ? "No programmes uploaded yet. Upload a programme PDF to see governance data."
              : "No projects found. Create a project to get started.",
        },
      });
    }

    const programmeIds = programmes.map((p) => p._id);

    const cycleHistory = await CycleHistory.find({
      programme: { $in: programmeIds },
    })
      .populate("closedBy", "name")
      .sort({ createdAt: -1 });

    if (cycleHistory.length === 0) {
      return sendSuccess(res, {
        governance: {
          hasData: false,
          message:
            "No weeks closed yet. Governance data will appear after you close your first week.",
        },
      });
    }

    const actions = await Action.find({
      programme: { $in: programmeIds },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let earliestStartDate = null;
    let latestEndDate = null;
    let allActivities = [];

    const projectMap = {};
    for (const project of projects) {
      projectMap[project._id.toString()] = project.name;
    }

    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];
      const projectId = prog.project?.toString();
      const projectName = projectMap[projectId] || "Unknown Project";

      for (const activity of activities) {
        const startDate = parseDate(activity.startDate);
        const finishDate = parseDate(activity.finishDate);

        if (
          startDate &&
          (!earliestStartDate || startDate < earliestStartDate)
        ) {
          earliestStartDate = startDate;
        }
        if (finishDate && (!latestEndDate || finishDate > latestEndDate)) {
          latestEndDate = finishDate;
        }

        const activityObj = activity.toObject ? activity.toObject() : activity;
        allActivities.push({
          ...activityObj,
          projectId,
          projectName,
        });
      }
    }

    const msPerDay = 1000 * 60 * 60 * 24;
    let totalWeeksFromProgramme = 0;
    let currentWeekNumber = 1;

    if (earliestStartDate && latestEndDate) {
      const totalDays = Math.ceil(
        (latestEndDate - earliestStartDate) / msPerDay,
      );
      totalWeeksFromProgramme = Math.ceil(totalDays / 7);

      const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

    const totalWeeks =
      cycleHistory.length > 0
        ? cycleHistory.length
        : Math.min(currentWeekNumber, totalWeeksFromProgramme);

    const weeksClosedOnTime = cycleHistory.filter(
      (c) => c.closeType === "Normal Close",
    ).length;
    const pmOverrides = cycleHistory.filter(
      (c) => c.closeType === "PM Override",
    ).length;
    let weeksClosedOnTimeScore = 0;
    if (totalWeeksFromProgramme > 0) {
      weeksClosedOnTimeScore = Math.round(
        (weeksClosedOnTime / totalWeeksFromProgramme) * 100,
      );
    }

    let totalActionsFromClosedWeeks = 0;
    let closedActionsFromClosedWeeks = 0;
    for (const cycle of cycleHistory) {
      totalActionsFromClosedWeeks += cycle.stats?.actionsTotal || 0;
      closedActionsFromClosedWeeks += cycle.stats?.actionsCompleted || 0;
    }

    const overdueFromClosedWeeks = Math.max(
      0,
      totalActionsFromClosedWeeks - closedActionsFromClosedWeeks,
    );
    const overdueRate =
      totalActionsFromClosedWeeks > 0
        ? Math.round(
            (overdueFromClosedWeeks / totalActionsFromClosedWeeks) * 100,
          )
        : 0;
    const overdueActionRateScore =
      totalActionsFromClosedWeeks > 0
        ? Math.max(0, 100 - overdueRate * 2)
        : 100;

    const closureRate =
      totalActionsFromClosedWeeks > 0
        ? Math.round(
            (closedActionsFromClosedWeeks / totalActionsFromClosedWeeks) * 100,
          )
        : 0;
    const actionClosureSpeedScore = closureRate;

    const weeklyReadinessData = [];
    const actionsData = [];
    const ragTrendData = [];
    const historicalWeeks = [];
    const calculateWeekRAG = (weekStartDate, weekEndDate, activities) => {
      let green = 0,
        amber = 0,
        red = 0;

      for (const activity of activities) {
        const actStart = parseDate(activity.startDate);
        const actFinish = parseDate(activity.finishDate);

        if (!actStart) continue;

        const startsThisWeek =
          actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek =
          actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

        if (!startsThisWeek && !spansThisWeek) continue;

        const ragStatus = storedRag(activity);

        if (ragStatus === "Green") {
          green++;
        } else if (ragStatus === "Amber") {
          amber++;
        } else if (ragStatus === "Red") {
          red++;
        }
      }

      return { green, amber, red, total: green + amber + red };
    };

    const progToProject = {};
    for (const p of programmes) {
      progToProject[String(p._id)] = String(p.project);
    }
    const cyclesByProject = {};
    for (const c of cycleHistory) {
      const projId = progToProject[String(c.programme)];
      if (!projId) continue;
      (cyclesByProject[projId] = cyclesByProject[projId] || []).push(c);
    }
    for (const projId of Object.keys(cyclesByProject)) {
      cyclesByProject[projId].sort(
        (a, b) =>
          new Date(a.closedAt || a.createdAt) -
          new Date(b.closedAt || b.createdAt),
      );
    }
    let maxCycles = 0;
    for (const projId of Object.keys(cyclesByProject)) {
      maxCycles = Math.max(maxCycles, cyclesByProject[projId].length);
    }

    for (let seq = 1; seq <= maxCycles; seq++) {
      const cohort = [];
      for (const projId of Object.keys(cyclesByProject)) {
        const c = cyclesByProject[projId][seq - 1];
        if (c) cohort.push(c);
      }
      if (cohort.length === 0) continue;
      const n = cohort.length;
      const sum = (fn) => cohort.reduce((s, c) => s + (fn(c) || 0), 0);
      const totGreen = sum((c) => c.stats?.green);
      const totAmber = sum((c) => c.stats?.amber);
      const totRed = sum((c) => c.stats?.red);
      const totActivities = sum((c) => c.stats?.totalActivities);
      const totActionsRaised = sum((c) => c.stats?.actionsTotal);
      const totActionsClosed = sum((c) => c.stats?.actionsCompleted);
      const readiness =
        totActivities > 0 ? Math.round((totGreen / totActivities) * 100) : 0;
      const pmOverrides = cohort.filter(
        (c) => c.closeType === "PM Override",
      ).length;
      const status = pmOverrides > 0 ? "Amber" : "Green";
      const icon = pmOverrides > 0 ? "warning" : "check";
      // Emit the bare close type. The old `${pmOverrides}/${n} PM Override`
      // form never matched the UI's `closeType === "PM Override"` checks, and
      // the per-project count is already carried by projectCount below.
      const closeType = pmOverrides > 0 ? "PM Override" : "Normal Close";

      weeklyReadinessData.push({ week: `W${seq}`, value: readiness });
      actionsData.push({
        week: `W${seq}`,
        raised: totActionsRaised,
        closed: totActionsClosed,
      });
      ragTrendData.push({
        week: `W${seq}`,
        green: totGreen,
        amber: totAmber,
        red: totRed,
      });
      historicalWeeks.push({
        week: seq,
        date: `Combined total · ${n} project${n === 1 ? "" : "s"}`,
        startDate: "",
        endDate: "",
        status,
        icon,
        score: readiness,
        stats: {
          totalActivities: totActivities,
          green: totGreen,
          amber: totAmber,
          red: totRed,
          actionsTotal: totActionsRaised,
          actionsCompleted: totActionsClosed,
        },
        closeType,
        notes: `${n} project${n === 1 ? "" : "s"} completed Week ${seq}`,
        activities: [],
        projectCount: n,
      });
    }

    const pastAndCurrentWeeks = weeklyReadinessData;
    const avgReadiness =
      pastAndCurrentWeeks.length > 0
        ? Math.round(
            pastAndCurrentWeeks.reduce((sum, w) => sum + w.value, 0) /
              pastAndCurrentWeeks.length,
          )
        : 0;
    let readinessTrendScore = 65;
    if (pastAndCurrentWeeks.length >= 2) {
      const readinessValues = pastAndCurrentWeeks.map((w) => w.value);
      const mean =
        readinessValues.reduce((a, b) => a + b, 0) / readinessValues.length;
      const variance =
        readinessValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
        readinessValues.length;
      readinessTrendScore = Math.max(
        0,
        Math.min(100, 100 - Math.sqrt(variance)),
      );
    } else if (pastAndCurrentWeeks.length === 1) {
      readinessTrendScore = 100;
    }

    const cyclesByProgramme = {};
    for (const cycle of cycleHistory) {
      const progId = cycle.programme?.toString() || "unknown";
      if (!cyclesByProgramme[progId]) {
        cyclesByProgramme[progId] = { total: 0, pmOverrides: 0 };
      }
      cyclesByProgramme[progId].total++;
      if (cycle.closeType === "PM Override") {
        cyclesByProgramme[progId].pmOverrides++;
      }
    }

    let pmOverrideFrequencyScore = 100;
    const allProgrammeScores = [];

    for (const progId of Object.keys(cyclesByProgramme)) {
      const prog = cyclesByProgramme[progId];
      const normalWeeks = prog.total - prog.pmOverrides;
      const projectScore =
        prog.total > 0 ? Math.round((normalWeeks / prog.total) * 100) : 100;
      allProgrammeScores.push(projectScore);
    }

    for (const prog of programmes) {
      const progId = prog._id.toString();
      if (!cyclesByProgramme[progId]) {
        allProgrammeScores.push(100);
      }
    }

    if (allProgrammeScores.length > 0) {
      const totalScore = allProgrammeScores.reduce((sum, s) => sum + s, 0);
      pmOverrideFrequencyScore = Math.round(
        totalScore / allProgrammeScores.length,
      );
    }

    const allScores = {
      weeksClosedOnTime: weeksClosedOnTimeScore,
      overdueActionRate: overdueActionRateScore,
      actionClosureSpeed: actionClosureSpeedScore,
      readinessTrendStability: Math.round(readinessTrendScore),
      pmOverrideFrequency: pmOverrideFrequencyScore,
    };

    const totalScoreSum = Object.values(allScores).reduce(
      (sum, score) => sum + score,
      0,
    );

    const dynamicWeights = {};
    if (totalScoreSum > 0) {
      for (const [key, score] of Object.entries(allScores)) {
        const rawWeight = (score / totalScoreSum) * 100;
        dynamicWeights[key] = Math.round(rawWeight);
      }
    } else {
      for (const key of Object.keys(allScores)) {
        dynamicWeights[key] = 20;
      }
    }

    const governanceScore = Math.round(
      (allScores.weeksClosedOnTime * dynamicWeights.weeksClosedOnTime +
        allScores.overdueActionRate * dynamicWeights.overdueActionRate +
        allScores.actionClosureSpeed * dynamicWeights.actionClosureSpeed +
        allScores.readinessTrendStability *
          dynamicWeights.readinessTrendStability +
        allScores.pmOverrideFrequency * dynamicWeights.pmOverrideFrequency) /
        100,
    );

    let governanceStatus = "GREEN";
    if (governanceScore < 50) governanceStatus = "RED";
    else if (governanceScore < 70) governanceStatus = "AMBER";

    const overdueTrend = "Stable";

    let blockerTypes = new Set();
    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];
      activities.forEach((a) => {
        if (a.isBlocked && a.blocker) {
          blockerTypes.add(a.blocker.split(" ")[0]);
        }
      });
    }

    const constraintData = [];
    const activityTypeMap = {};

    const extractActivityType = (activityName) => {
      const name = (activityName || "").toLowerCase().trim();

      const cleanName = name
        .replace(/^[a-z]{1,3}[-_]?\d+[-_:]?\s*/i, "")
        .replace(/^(phase|stage|step|task)\s*\d*[-:]?\s*/i, "")
        .replace(/\s*(phase|stage)\s*\d*$/i, "")
        .replace(/[-_]/g, " ")
        .trim();

      const words = cleanName.split(/\s+/).filter((w) => w.length > 2);

      const activityPatterns = {
        Foundation: [
          "foundation",
          "footing",
          "pile",
          "piling",
          "excavation",
          "ground",
        ],
        Structural: [
          "steel",
          "structure",
          "column",
          "beam",
          "slab",
          "concrete",
          "rebar",
          "structural",
        ],
        "MEP Works": [
          "mep",
          "electrical",
          "plumbing",
          "hvac",
          "mechanical",
          "piping",
          "wiring",
        ],
        "Facade & Cladding": [
          "facade",
          "cladding",
          "curtain",
          "glazing",
          "external",
          "envelope",
        ],
        "Interior Fit-Out": [
          "interior",
          "fit-out",
          "fitout",
          "partition",
          "ceiling",
          "flooring",
          "tiling",
          "painting",
          "plastering",
        ],
        Roofing: ["roof", "roofing", "waterproof", "membrane"],
        "Site Works": [
          "site",
          "mobilization",
          "survey",
          "clearing",
          "demolition",
        ],
        "Testing & Commissioning": [
          "test",
          "testing",
          "commission",
          "commissioning",
          "inspection",
          "handover",
          "snag",
        ],
        "Design & Approvals": [
          "design",
          "drawing",
          "approval",
          "permit",
          "submittal",
        ],
        Procurement: ["material", "delivery", "procurement", "supply", "order"],
      };

      for (const [type, keywords] of Object.entries(activityPatterns)) {
        if (keywords.some((kw) => cleanName.includes(kw))) {
          return type;
        }
      }

      if (words.length >= 2) {
        return words
          .slice(0, 2)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      } else if (words.length === 1) {
        return words[0].charAt(0).toUpperCase() + words[0].slice(1);
      }

      return "General Works";
    };

    const allActivitiesByType = {};

    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];
      const projectId = prog.project?.toString();
      const projectName =
        projects.find((p) => p._id.toString() === projectId)?.name || "Unknown";

      activities.forEach((a) => {
        const activityType = extractActivityType(a.activityName);
        const finishDate = parseDate(a.finishDate);

        const isCompleted =
          a.status === "Completed" ||
          (a.finishDate && a.finishDate.includes(" A"));
        const isOverdue = finishDate && finishDate < today && !isCompleted;
        const isOnTime = finishDate && finishDate >= today && !isCompleted;

        if (!allActivitiesByType[activityType]) {
          allActivitiesByType[activityType] = {
            type: activityType,
            projectsWithOverdue: new Set(),
            projectsWithOnTime: new Set(),
            projectsWithCompleted: new Set(),
            overdueActivities: [],
            lastOverdueDate: null,
            totalOverdue: 0,
            totalOnTime: 0,
            totalCompleted: 0,
          };
        }

        const typeData = allActivitiesByType[activityType];

        if (isOverdue) {
          typeData.projectsWithOverdue.add(projectId);
          typeData.totalOverdue++;
          typeData.overdueActivities.push({
            activityId: a.activityId,
            activityName: a.activityName,
            projectName: projectName,
            finishDate: a.finishDate,
            status: "Overdue",
          });
          if (
            !typeData.lastOverdueDate ||
            finishDate > typeData.lastOverdueDate
          ) {
            typeData.lastOverdueDate = finishDate;
          }
        } else if (isCompleted) {
          typeData.projectsWithCompleted.add(projectId);
          typeData.totalCompleted++;
        }
      });
    }

    Object.values(allActivitiesByType)
      .filter((typeData) => typeData.totalOverdue > 0)
      .sort(
        (a, b) =>
          b.projectsWithOverdue.size - a.projectsWithOverdue.size ||
          b.totalOverdue - a.totalOverdue,
      )
      .forEach((typeData) => {
        let trend = "stable";

        const overdueProjects = typeData.projectsWithOverdue.size;
        const completedProjects = typeData.projectsWithCompleted.size;
        const totalProjectsWithThisType = new Set([
          ...typeData.projectsWithOverdue,
          ...typeData.projectsWithCompleted,
        ]).size;

        if (totalProjectsWithThisType > 1) {
          if (completedProjects > 0) {
            trend = "down";
          } else if (overdueProjects > 1) {
            trend = "stable";
          }
        } else {
          trend = "up";
        }

        let lastSeenStr = "-";
        if (typeData.lastOverdueDate) {
          const daysSince = Math.floor(
            (today - typeData.lastOverdueDate) / msPerDay,
          );
          if (daysSince === 0) {
            lastSeenStr = "Today";
          } else if (daysSince === 1) {
            lastSeenStr = "Yesterday";
          } else if (daysSince < 7) {
            lastSeenStr = `${daysSince} days ago`;
          } else {
            const weekNum = Math.ceil(daysSince / 7);
            lastSeenStr = `${weekNum} week${weekNum > 1 ? "s" : ""} ago`;
          }
        }

        constraintData.push({
          type: typeData.type,
          frequency: overdueProjects,
          trend: trend,
          lastSeen: lastSeenStr,
          activities: typeData.overdueActivities.slice(0, 5),
          stats: {
            overdueCount: typeData.totalOverdue,
            completedCount: typeData.totalCompleted,
            onTimeCount: typeData.totalOnTime,
            projectsAffected: overdueProjects,
            projectsCompleted: completedProjects,
          },
        });
      });

    return sendSuccess(res, {
      governance: {
        hasData: true,
        score: governanceScore,
        status: governanceStatus,
        metrics: {
          weeksClosedOnTime: {
            score: allScores.weeksClosedOnTime,
            weight: dynamicWeights.weeksClosedOnTime,
            color:
              allScores.weeksClosedOnTime >= 70
                ? "green"
                : allScores.weeksClosedOnTime >= 50
                  ? "amber"
                  : "red",
          },
          overdueActionRate: {
            score: allScores.overdueActionRate,
            weight: dynamicWeights.overdueActionRate,
            color:
              allScores.overdueActionRate >= 70
                ? "green"
                : allScores.overdueActionRate >= 50
                  ? "amber"
                  : "red",
          },
          actionClosureSpeed: {
            score: allScores.actionClosureSpeed,
            weight: dynamicWeights.actionClosureSpeed,
            color:
              allScores.actionClosureSpeed >= 70
                ? "green"
                : allScores.actionClosureSpeed >= 50
                  ? "amber"
                  : "red",
          },
          readinessTrendStability: {
            score: allScores.readinessTrendStability,
            weight: dynamicWeights.readinessTrendStability,
            color:
              allScores.readinessTrendStability >= 70
                ? "green"
                : allScores.readinessTrendStability >= 50
                  ? "amber"
                  : "red",
          },
          pmOverrideFrequency: {
            score: allScores.pmOverrideFrequency,
            weight: dynamicWeights.pmOverrideFrequency,
            color:
              allScores.pmOverrideFrequency >= 70
                ? "green"
                : allScores.pmOverrideFrequency >= 50
                  ? "amber"
                  : "red",
          },
        },
        stats: {
          totalWeeks: totalWeeksFromProgramme || totalWeeks,
          avgReadiness: `${avgReadiness}%`,
          totalActionsRaised: totalActionsFromClosedWeeks,
          totalClosed: closedActionsFromClosedWeeks,
          overdueTrend,
          recurringBlockers: blockerTypes.size,
        },
        weeklyReadinessData,
        actionsData,
        ragTrendData,
        constraintData:
          constraintData.length > 0
            ? constraintData
            : [
                {
                  type: "No blockers",
                  frequency: 0,
                  trend: "stable",
                  lastSeen: "-",
                },
              ],
        historicalWeeks,
      },
    });
  } catch (error) {
    console.error("[governance] ERROR:", error);
    console.error("[governance] Stack:", error.stack);
    return sendError(res, "Server error");
  }
});

router.get("/weekly", protect, async (req, res) => {
  try {
    const { projectId, weekNumber: requestedWeekNumber } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      const accessibleProjectIds = await getPlannerAccessibleProjects(
        req.admin,
      );
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    } else {
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    }

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

    await syncProgrammesGovernance(programmes, Action);

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
    let currentWeekStart = null;
    let currentWeekEnd = null;

    // The Weekly Dashboard shows the project's LATEST COMPLETED week, cumulative
    // across all of its programmes/cycles, using the ACTUAL open -> close dates
    // (week start -> the day it was actually closed), not a fixed 7-day window.
    const CycleHistoryModel = require("../models/CycleHistory");
    const completedCycles = await CycleHistoryModel.find({
      programme: { $in: programmeIds },
    })
      .sort({ createdAt: 1 })
      .lean();
    const completedSnapshot =
      completedCycles.length > 0
        ? completedCycles[completedCycles.length - 1]
        : null;
    const MONTHS_SHORT = [
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
    const fmtWeekDate = (d) =>
      `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
    // Spells out both months so a week spanning a month boundary reads
    // "(30 Jul - 5 Aug 2026)" rather than collapsing to a single month.
    const fmtWeekRange = (start, end) =>
      `(${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} - ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()})`;

    const programmeActivities =
      activeProgramme?.extractedData?.activities || [];
    let earliestStartDate = null;

    for (const activity of programmeActivities) {
      const actStartDate = parseDate(activity.startDate);
      if (
        actStartDate &&
        (!earliestStartDate || actStartDate < earliestStartDate)
      ) {
        earliestStartDate = actStartDate;
      }
    }

    if (completedSnapshot) {
      const openDate = completedSnapshot.dateRange?.startDate
        ? new Date(completedSnapshot.dateRange.startDate)
        : new Date(completedSnapshot.createdAt);
      openDate.setHours(0, 0, 0, 0);
      const closeDate = new Date(completedSnapshot.createdAt);

      // The deadline is always the 7th day of the week (inclusive of the day it
      // opened), independent of when the week was actually closed. Opened
      // 30 Jul -> deadline 5 Aug.
      const closeDeadlineDate = new Date(openDate);
      closeDeadlineDate.setDate(openDate.getDate() + 6);

      currentWeekStart = new Date(openDate);
      currentWeekEnd = new Date(closeDate);
      currentWeekEnd.setHours(23, 59, 59, 999);

      weekNumber = `Week ${completedCycles.length}`;
      weekOpened = fmtWeekDate(openDate);
      closeDeadline = fmtWeekDate(closeDeadlineDate);
      weekDates = fmtWeekRange(openDate, closeDeadlineDate);
      cycleStatus = "Closed";
    } else if (earliestStartDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      earliestStartDate.setHours(0, 0, 0, 0);

      const anchorDate = projects[0]?.startDate
        ? new Date(projects[0].startDate)
        : new Date(earliestStartDate);
      anchorDate.setHours(0, 0, 0, 0);

      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((today - anchorDate) / msPerDay);
      const weekNum = requestedWeekNumber
        ? parseInt(requestedWeekNumber)
        : Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      weekNumber = `Week ${weekNum}`;

      currentWeekStart = new Date(anchorDate);
      currentWeekStart.setDate(anchorDate.getDate() + (weekNum - 1) * 7);
      currentWeekEnd = new Date(currentWeekStart);
      currentWeekEnd.setDate(currentWeekStart.getDate() + 6);

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

      weekDates = fmtWeekRange(currentWeekStart, currentWeekEnd);
      weekOpened = formatDate(currentWeekStart);
      closeDeadline = formatDate(currentWeekEnd);
      cycleStatus = activeProgramme?.cycleStatus || "Draft";
    }

    const rawActivities = activeProgramme?.extractedData?.activities || [];
    const today = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const activityStartsInWeek = (activity) => {
      if (!currentWeekStart || !currentWeekEnd) return true;
      const actStart = parseDate(activity.startDate);
      if (!actStart) return false;
      return actStart >= currentWeekStart && actStart <= currentWeekEnd;
    };

    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let blockedCount = 0;

    const activities = [];
    for (const activity of rawActivities) {
      const activityObj = activity.toObject ? activity.toObject() : activity;

      if (!activityStartsInWeek(activityObj)) continue;

      const rag = storedRag(activityObj);
      if (rag !== "Grey") {
        activities.push({ ...activityObj, ragStatus: rag });
        if (rag === "Green") greenCount++;
        else if (rag === "Amber") amberCount++;
        else if (rag === "Red") redCount++;

        if (rag === "Red") blockedCount++;
      }
    }

    const totalActivities = activities.length;
    const ragTotal = greenCount + amberCount + redCount;
    const greenPercentage =
      ragTotal > 0 ? Math.round((greenCount / ragTotal) * 100) : 0;

    const allActions = await Action.find({ programme: { $in: programmeIds } })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const actions = allActions.filter((a) => {
      if (!currentWeekStart || !currentWeekEnd) return true;
      const dueDate = new Date(a.dueDate);
      return dueDate >= currentWeekStart && dueDate <= currentWeekEnd;
    });

    const openActions = actions.filter(
      (a) => a.status !== "Completed" && a.status !== "Cancelled",
    );
    const closedActions = actions.filter((a) => a.status === "Completed");
    const overdueActions = actions.filter(
      (a) =>
        a.status !== "Completed" &&
        a.status !== "Cancelled" &&
        new Date(a.dueDate) < startOfToday,
    );

    const openRequiredActions = allActions.filter(
      (a) =>
        a.type === "Required" &&
        (a.status === "Open" || a.status === "In Progress"),
    );

    let readyForClose = false;
    if (
      cycleStatus === "Draft" ||
      cycleStatus === "Uploaded" ||
      cycleStatus === "Meeting Open"
    ) {
      readyForClose = false;
    } else if (
      cycleStatus === "Execution" ||
      cycleStatus === "Close-Out Eligible"
    ) {
      readyForClose = openRequiredActions.length === 0;
    }

    const actionMap = {};
    allActions.forEach((action) => {
      const actId = action.linkedActivity?.activityId;
      if (actId) {
        if (!actionMap[actId]) {
          actionMap[actId] = [];
        }
        const isOverdue =
          action.dueDate && new Date(action.dueDate) < startOfToday;
        actionMap[actId].push({
          _id: action._id,
          actionId: `ACN-${String(action._id).slice(-4).toUpperCase()}`,
          title: action.title,
          status: action.status,
          priority: action.priority || "Medium",
          assignee: action.assignee?.name || "-",
          assigneeId: action.assignee?._id?.toString() || null,
          dueDate: action.dueDate,
          isOverdue:
            isOverdue &&
            action.status !== "Completed" &&
            action.status !== "Cancelled",
        });
      }
    });

    const blockedActivities = activities
      .filter(
        (a) =>
          a.isBlocked ||
          a.activityStatus === "Blocked" ||
          a.activityStatus === "At Risk" ||
          a.ragStatus === "Red" ||
          a.ragStatus === "Amber",
      )
      .slice(0, 20)
      .map((a) => {
        const linkedActions = actionMap[a.activityId] || [];
        const openAction = linkedActions.find(
          (act) => act.status !== "Completed" && act.status !== "Cancelled",
        );
        const overdueAction = linkedActions.find((act) => act.isOverdue);
        const linkedAction = overdueAction || openAction || linkedActions[0];

        return {
          activityId: a.activityId,
          activityName: a.activityName,
          ragStatus: a.ragStatus,
          activityStatus: a.isBlocked
            ? "Blocked"
            : a.activityStatus || "At Risk",
          isBlocked: a.isBlocked || a.activityStatus === "Blocked",
          owner: linkedAction?.assignee || a.ownerName || "-",
          blocker: a.isBlocked
            ? a.blocker || "Activity blocked"
            : linkedAction?.title || "Requires attention",
          linkedAction: linkedAction
            ? {
                actionId: linkedAction.actionId,
                title: linkedAction.title,
                status: linkedAction.isOverdue
                  ? "Overdue"
                  : linkedAction.status,
              }
            : null,
        };
      });

    const sortedActivities = [...activities].sort((a, b) => {
      const ragOrder = { Green: 1, Amber: 2, Red: 3 };
      return (ragOrder[a.ragStatus] || 4) - (ragOrder[b.ragStatus] || 4);
    });

    const weeklyPlanPreview = sortedActivities
      .filter((a) => {
        const linkedActions = actionMap[a.activityId] || [];
        return linkedActions.length > 0;
      })
      .slice(0, 20)
      .map((a) => {
        const linkedActions = actionMap[a.activityId] || [];
        let displayRag = a.ragStatus;
        if (displayRag === "Grey") {
          if (a.activityStatus === "Blocked" || a.isBlocked) {
            displayRag = "Red";
          } else if (a.activityStatus === "At Risk") {
            displayRag = "Amber";
          } else {
            displayRag = "Green";
          }
        }
        return {
          activityId: a.activityId,
          activityName: a.activityName,
          weekZone:
            displayRag === "Green"
              ? "Weeks 1-2"
              : displayRag === "Amber"
                ? "Weeks 3-4"
                : "Weeks 5-6",
          startDate: a.startDate,
          finishDate: a.finishDate,
          duration: a.duration,
          ragStatus: displayRag,
          owner: a.ownerName || "-",
          activityStatus: a.activityStatus || "Ready",
          actionsCount: linkedActions.length,
          openActionsCount: linkedActions.filter(
            (act) => act.status !== "Completed" && act.status !== "Cancelled",
          ).length,
          linkedActions: linkedActions.map((act) => ({
            _id: act._id?.toString(),
            actionId: act.actionId,
            title: act.title,
            status: act.isOverdue ? "Overdue" : act.status,
            priority: act.priority,
            assignee: act.assignee,
            assigneeId: act.assigneeId,
            dueDate: act.dueDate,
            isOverdue: act.isOverdue,
          })),
        };
      });

    const formatActionDate = (d) => {
      if (!d) return "-";
      const date = new Date(d);
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
      return `${date.getDate()} ${months[date.getMonth()]}`;
    };

    const plannerToDo = openActions.slice(0, 20).map((action) => {
      const isOverdue =
        action.dueDate && new Date(action.dueDate) < startOfToday;
      const linkedActivity = activities.find(
        (a) => a.activityId === action.linkedActivity?.activityId,
      );
      return {
        activityId: action.linkedActivity?.activityId || "-",
        activityName: action.linkedActivity?.activityName || action.title,
        ragStatus: linkedActivity?.ragStatus || "Amber",
        owner: action.assignee?.name || "-",
        todoItem: action.title,
        actionId: `ACN-${String(action._id).slice(-4).toUpperCase()}`,
        actionStatus: isOverdue ? "Overdue" : action.status,
        priority: action.priority || "Medium",
        dueDate: formatActionDate(action.dueDate),
      };
    });

    const activitiesByWeek = [];
    const todayForChart = new Date();
    todayForChart.setHours(0, 0, 0, 0);

    for (let w = 1; w <= 6; w++) {
      const weekStart = new Date(todayForChart);
      weekStart.setDate(todayForChart.getDate() + (w - 1) * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      let weekGreen = 0;
      let weekAmber = 0;
      let weekRed = 0;

      for (const activity of rawActivities) {
        const actStart = parseDate(activity.startDate);
        if (!actStart) continue;

        if (actStart >= weekStart && actStart <= weekEnd) {
          const rag = storedRag(activity);
          if (rag === "Red") {
            weekRed++;
          } else if (rag === "Amber") {
            weekAmber++;
          } else if (rag === "Green") {
            weekGreen++;
          }
        }
      }

      activitiesByWeek.push({
        week: `Week ${w}`,
        green: weekGreen,
        amber: weekAmber,
        red: weekRed,
      });
    }

    // When showing a completed week, report that cycle's close-time snapshot
    // instead of live figures.
    const snapStats = completedSnapshot?.stats || {};
    const outActivities = completedSnapshot
      ? snapStats.totalActivities || 0
      : totalActivities;
    const outGreen = completedSnapshot ? snapStats.green || 0 : greenCount;
    const outAmber = completedSnapshot ? snapStats.amber || 0 : amberCount;
    const outRed = completedSnapshot ? snapStats.red || 0 : redCount;
    const outGreenPct = completedSnapshot
      ? snapStats.totalActivities
        ? Math.round((snapStats.green / snapStats.totalActivities) * 100)
        : 0
      : greenPercentage;
    const outActionsClosed = completedSnapshot
      ? snapStats.actionsCompleted || 0
      : closedActions.length;
    const outActionsTotal = completedSnapshot
      ? snapStats.actionsTotal || 0
      : openActions.length + closedActions.length;
    const outOpenActions = completedSnapshot
      ? Math.max(0, outActionsTotal - outActionsClosed)
      : openActions.length;
    const outBlocked = completedSnapshot ? 0 : blockedCount;
    const outOverdue = completedSnapshot ? 0 : overdueActions.length;
    const outOpenRequired = completedSnapshot ? 0 : openRequiredActions.length;
    const outReadyForClose = completedSnapshot ? false : readyForClose;

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
          completedCount: completedCycles.length,
          planner: activeProgramme?.uploadedBy?.name || "-",
        },
        stats: {
          activitiesInLookahead: outActivities,
          greenActivities: outGreen,
          greenPercentage: outGreenPct,
          blockedByActions: outBlocked,
          openActions: outOpenActions,
          overdueActions: outOverdue,
          openRequiredActions: outOpenRequired,
          readyForClose: outReadyForClose,
        },
        ragDistribution: {
          green: outGreen,
          amber: outAmber,
          red: outRed,
        },
        actionsByStatus: {
          open: outOpenActions,
          closed: outActionsClosed,
          overdue: outOverdue,
        },
        blockedActivities,
        weeklyPlanPreview,
        plannerToDo,
        activitiesByWeek,
        isProjectEnded: false,
      },
    });
  } catch (error) {
    console.error("Weekly dashboard error:", error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
