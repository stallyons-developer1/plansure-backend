const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const Programme = require("../models/Programme");
const Action = require("../models/Action");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");

// Helper function to get accessible projects for planners
const getPlannerAccessibleProjects = async (admin) => {
  // Get projects directly assigned to the planner
  const userAssignedProjects = (admin.projects || []).map((p) => p.toString());

  // Get projects from actions assigned to the planner
  const userActions = await Action.find({
    $or: [
      { assignee: admin._id },
      { "previousAssignees.user": admin._id },
    ],
  }).select("programme");

  let actionProjectIds = [];
  if (userActions.length > 0) {
    const programmeIds = [...new Set(userActions.map((a) => a.programme.toString()))];
    const programmes = await Programme.find({
      _id: { $in: programmeIds },
    }).select("project");
    actionProjectIds = programmes.map((p) => p.project?.toString()).filter(Boolean);
  }

  // Get projects where planner is in the team
  const teamProjects = await Project.find({
    "team.user": admin._id,
    status: { $ne: "Cancelled" },
  }).select("_id");
  const teamProjectIds = teamProjects.map((p) => p._id.toString());

  // Combine all project IDs
  return [...new Set([...userAssignedProjects, ...actionProjectIds, ...teamProjectIds])];
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

  // Check if completed (status or "A" suffix in dates means Actual/Complete)
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

router.get("/stats", protect, async (req, res) => {
  try {
    const { projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      // Filter by specific project
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      // Planners see projects they have access to (assigned, team member, or via actions)
      const accessibleProjectIds = await getPlannerAccessibleProjects(req.admin);
      if (accessibleProjectIds.length === 0) {
        return sendSuccess(res, {
          stats: {
            projects: { total: 0, byPhase: {} },
            cycle: { current: "N/A", status: "N/A", dayInfo: null },
            activities: { total: 0, inLookahead: 0, green: 0, amber: 0, red: 0, grey: 0 },
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
      // Admins see all non-cancelled projects
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

      // Find the earliest activity start date from the programme
      const activities = activeProgramme.extractedData?.activities || [];
      let earliestStartDate = null;

      for (const activity of activities) {
        const startDate = parseDate(activity.startDate);
        if (startDate && (!earliestStartDate || startDate < earliestStartDate)) {
          earliestStartDate = startDate;
        }
      }

      if (earliestStartDate) {
        // Calculate weeks from programme start date to today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        earliestStartDate.setHours(0, 0, 0, 0);

        const msPerDay = 1000 * 60 * 60 * 24;
        const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
        const weekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

        currentCycle = `W${weekNumber}`;
      }
    }

    const today = new Date();
    // Start of today (midnight) - actions are only overdue after due date has fully passed
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

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
        new Date(a.dueDate) < startOfToday,
    );
    const pendingActions = openActions.length - overdueActions.length;

    let cycleDayInfo = null;
    if (activeProgramme?.lookaheadStartDate) {
      const today = new Date();

      // Get current day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
      // Convert to Monday-based: Monday = 1, Sunday = 7
      const dayOfWeek = today.getDay();
      const currentDay = dayOfWeek === 0 ? 7 : dayOfWeek; // Sunday becomes 7

      const cycleDuration = 7;
      const daysRemaining = cycleDuration - currentDay;

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
    const { programmeId, projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      // Planners see projects they have access to
      const accessibleProjectIds = await getPlannerAccessibleProjects(req.admin);
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
    const { limit = 10, projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      // Planners see projects they have access to
      const accessibleProjectIds = await getPlannerAccessibleProjects(req.admin);
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

router.get("/governance", protect, async (req, res) => {
  try {
    const { projectId } = req.query;
    const CycleHistory = require("../models/CycleHistory");

    // Get all projects or filter by projectId
    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      // Planners see projects they have access to (assigned, team member, or via actions)
      const accessibleProjectIds = await getPlannerAccessibleProjects(req.admin);
      if (accessibleProjectIds.length === 0) {
        return sendSuccess(res, {
          governance: {
            hasData: false,
            message: "No projects assigned to you. Contact an admin to get assigned to a project.",
          },
        });
      }
      projects = await Project.find({
        _id: { $in: accessibleProjectIds },
        status: { $ne: "Cancelled" },
      });
      projectIds = projects.map((p) => p._id);
    } else {
      // Admins see all projects
      projects = await Project.find({ status: { $ne: "Cancelled" } });
      projectIds = projects.map((p) => p._id);
    }

    // Get all programmes for these projects
    const programmes = await Programme.find({
      project: { $in: projectIds },
    }).sort({ createdAt: -1 });

    // Check if there's any data to show
    if (projects.length === 0 || programmes.length === 0) {
      return sendSuccess(res, {
        governance: {
          hasData: false,
          message: programmes.length === 0
            ? "No programmes uploaded yet. Upload a programme PDF to see governance data."
            : "No projects found. Create a project to get started.",
        },
      });
    }

    const programmeIds = programmes.map((p) => p._id);

    console.log(`[governance] Found ${projects.length} projects, ${programmes.length} programmes`);
    console.log(`[governance] Programme IDs:`, programmeIds);

    // Get all cycle history
    const cycleHistory = await CycleHistory.find({
      programme: { $in: programmeIds },
    })
      .populate("closedBy", "name")
      .sort({ createdAt: -1 });

    console.log(`[governance] Found ${cycleHistory.length} cycle history records`);

    // Only show governance data if at least one week has been closed
    if (cycleHistory.length === 0) {
      return sendSuccess(res, {
        governance: {
          hasData: false,
          message: "No weeks closed yet. Governance data will appear after you close your first week.",
        },
      });
    }

    // Get all actions
    const actions = await Action.find({
      programme: { $in: programmeIds },
    });

    console.log(`[governance] Found ${actions.length} actions`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get earliest and latest dates from all programme activities
    let earliestStartDate = null;
    let latestEndDate = null;
    let allActivities = [];

    // Build a map of project IDs to project names
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

        if (startDate && (!earliestStartDate || startDate < earliestStartDate)) {
          earliestStartDate = startDate;
        }
        if (finishDate && (!latestEndDate || finishDate > latestEndDate)) {
          latestEndDate = finishDate;
        }

        // Add activity with project info (convert Mongoose subdoc to plain object)
        const activityObj = activity.toObject ? activity.toObject() : activity;
        allActivities.push({
          ...activityObj,
          projectId,
          projectName,
        });
      }
    }

    // Calculate total weeks from programme span
    const msPerDay = 1000 * 60 * 60 * 24;
    let totalWeeksFromProgramme = 0;
    let currentWeekNumber = 1;

    if (earliestStartDate && latestEndDate) {
      const totalDays = Math.ceil((latestEndDate - earliestStartDate) / msPerDay);
      totalWeeksFromProgramme = Math.ceil(totalDays / 7);

      // Calculate current week number
      const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

    // Use cycle history count if available, otherwise use calculated weeks
    const totalWeeks = cycleHistory.length > 0 ? cycleHistory.length : Math.min(currentWeekNumber, totalWeeksFromProgramme);

    // Calculate weeks closed on time (Normal Close vs PM Override)
    const weeksClosedOnTime = cycleHistory.filter(
      (c) => c.closeType === "Normal Close"
    ).length;
    const pmOverrides = cycleHistory.filter(
      (c) => c.closeType === "PM Override"
    ).length;

    // Calculate Weeks Closed On Time Score
    // Score = (Normal Close weeks / Total Programme Weeks) × 100
    // This measures how many weeks of the total project have been closed on time
    let weeksClosedOnTimeScore = 0;
    if (totalWeeksFromProgramme > 0) {
      weeksClosedOnTimeScore = Math.round((weeksClosedOnTime / totalWeeksFromProgramme) * 100);
    }
    // If no programme weeks, score remains 0

    // Calculate metrics ONLY from closed weeks (cycleHistory)
    // Sum up stats from all closed weeks
    let totalActionsFromClosedWeeks = 0;
    let closedActionsFromClosedWeeks = 0;
    for (const cycle of cycleHistory) {
      totalActionsFromClosedWeeks += cycle.stats?.actionsTotal || 0;
      closedActionsFromClosedWeeks += cycle.stats?.actionsCompleted || 0;
    }

    // Calculate Overdue Action Rate Score (Weight 25%)
    // Since overdue is not stored in cycle history, calculate from difference
    const overdueFromClosedWeeks = Math.max(0, totalActionsFromClosedWeeks - closedActionsFromClosedWeeks);
    const overdueRate =
      totalActionsFromClosedWeeks > 0
        ? Math.round((overdueFromClosedWeeks / totalActionsFromClosedWeeks) * 100)
        : 0;
    const overdueActionRateScore = totalActionsFromClosedWeeks > 0 ? Math.max(0, 100 - overdueRate * 2) : 100;

    // Calculate Action Closure Speed (Weight 20%)
    const closureRate =
      totalActionsFromClosedWeeks > 0
        ? Math.round((closedActionsFromClosedWeeks / totalActionsFromClosedWeeks) * 100)
        : 0;
    const actionClosureSpeedScore = closureRate;

    // Build weekly data from programme activities (not just cycle history)
    const weeklyReadinessData = [];
    const actionsData = [];
    const ragTrendData = [];
    const historicalWeeks = [];

    // Helper to calculate RAG for activities in a specific week only
    // Helper to calculate RAG counts using stored ragStatus (same as Activities & Lookahead)
    const calculateWeekRAG = (weekStartDate, weekEndDate, activities) => {
      let green = 0, amber = 0, red = 0;

      for (const activity of activities) {
        const actStart = parseDate(activity.startDate);
        const actFinish = parseDate(activity.finishDate);

        if (!actStart) continue;

        // Check if activity STARTS within this week OR is active during this week
        const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

        if (!startsThisWeek && !spansThisWeek) continue;

        // Use the stored ragStatus from the activity (same as Activities & Lookahead page)
        const ragStatus = activity.ragStatus || "Grey";

        if (ragStatus === "Green") {
          green++;
        } else if (ragStatus === "Amber") {
          amber++;
        } else if (ragStatus === "Red") {
          red++;
        }
        // Grey activities are not counted in RAG totals
      }

      return { green, amber, red, total: green + amber + red };
    };

    // Generate weekly data for ALL weeks from programme start to programme end
    if (earliestStartDate) {
      // Show all weeks in the programme (not just until today)
      const weeksToGenerate = totalWeeksFromProgramme;

      for (let weekNum = 1; weekNum <= weeksToGenerate; weekNum++) {
        const weekStartDate = new Date(earliestStartDate);
        weekStartDate.setDate(weekStartDate.getDate() + (weekNum - 1) * 7);
        weekStartDate.setHours(0, 0, 0, 0);

        const weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekStartDate.getDate() + 6);
        weekEndDate.setHours(23, 59, 59, 999);

        const rag = calculateWeekRAG(weekStartDate, weekEndDate, allActivities);
        const readinessPercent = rag.total > 0 ? Math.round((rag.green / rag.total) * 100) : 0;

        // Find matching cycle history if exists
        const matchingCycle = cycleHistory.find((c) => c.weekNumber === weekNum);

        // Only show data from formally closed weeks
        weeklyReadinessData.push({
          week: `W${weekNum}`,
          value: matchingCycle ?
            Math.round(((matchingCycle.stats?.green || 0) / (matchingCycle.stats?.totalActivities || 1)) * 100) :
            0,
        });

        // Only show data from formally closed weeks
        actionsData.push({
          week: `W${weekNum}`,
          raised: matchingCycle ? matchingCycle.stats?.actionsTotal || 0 : 0,
          closed: matchingCycle ? matchingCycle.stats?.actionsCompleted || 0 : 0,
        });

        ragTrendData.push({
          week: `W${weekNum}`,
          green: matchingCycle ? matchingCycle.stats?.green || 0 : 0,
          amber: matchingCycle ? matchingCycle.stats?.amber || 0 : 0,
          red: matchingCycle ? matchingCycle.stats?.red || 0 : 0,
        });

        // Build historical weeks
        const formatDate = (d) => {
          const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          return `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
        };

        // Determine week status based on timing and data
        let weekStatus;
        let weekIcon;
        let closeType;

        if (matchingCycle) {
          // Week has been closed
          weekStatus = matchingCycle.closeType === "Normal Close" ? "Green" : "Amber";
          weekIcon = matchingCycle.closeType === "Normal Close" ? "check" : "warning";
          closeType = matchingCycle.closeType;
        } else if (weekEndDate < today) {
          // Past week - auto-calculated
          weekStatus = rag.red > rag.green ? "Amber" : "Green";
          weekIcon = weekStatus === "Green" ? "check" : "warning";
          closeType = "Auto-calculated";
        } else if (weekStartDate <= today && weekEndDate >= today) {
          // Current week
          weekStatus = "Current";
          weekIcon = "current";
          closeType = "In Progress";
        } else {
          // Future week
          weekStatus = "Upcoming";
          weekIcon = "upcoming";
          closeType = "Upcoming";
        }

        // Get activities with their week-specific RAG for this week
        const weekActivities = [];
        for (const activity of allActivities) {
          const actStart = parseDate(activity.startDate);
          const actFinish = parseDate(activity.finishDate);

          if (!actStart) continue;

          // Check if activity is in this week
          const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
          const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

          if (!startsThisWeek && !spansThisWeek) continue;

          // Check if activity is completed
          const isCompleted = activity.status === "Completed" ||
            (activity.startDate && activity.startDate.includes(" A")) ||
            (activity.finishDate && activity.finishDate.includes(" A"));

          // Use the stored ragStatus from the activity (same as Activities & Lookahead page)
          // This ensures consistency across all views
          const activityRAG = activity.ragStatus || "Grey";

          weekActivities.push({
            activityId: activity.activityId,
            activityName: activity.activityName,
            startDate: activity.startDate,
            finishDate: activity.finishDate,
            duration: activity.duration,
            ragStatus: activityRAG,
            activityStatus: activity.activityStatus || "Ready",
            ownerName: activity.ownerName || "-",
            isCompleted: isCompleted,
            projectName: activity.projectName || "Unknown",
          });
        }

        // Sort activities by RAG (Red first, then Amber, then Green)
        weekActivities.sort((a, b) => {
          const ragOrder = { Red: 1, Amber: 2, Green: 3 };
          return (ragOrder[a.ragStatus] || 4) - (ragOrder[b.ragStatus] || 4);
        });

        historicalWeeks.push({
          week: weekNum,
          date: `${formatDate(weekStartDate)} - ${formatDate(weekEndDate)}`,
          startDate: formatDate(weekStartDate),
          endDate: formatDate(weekEndDate),
          status: weekStatus,
          icon: weekIcon,
          score: matchingCycle?.score || readinessPercent,
          stats: matchingCycle?.stats || {
            totalActivities: rag.total,
            green: rag.green,
            amber: rag.amber,
            red: rag.red,
            actionsTotal: 0,
            actionsCompleted: 0,
          },
          closeType: closeType,
          notes: matchingCycle?.notes || "",
          activities: weekActivities,
        });
      }
    }

    // Calculate average readiness from PAST and CURRENT weeks only (not future weeks)
    const currentWeekIndex = Math.min(currentWeekNumber, weeklyReadinessData.length);
    const pastAndCurrentWeeks = weeklyReadinessData.slice(0, currentWeekIndex);
    const avgReadiness = pastAndCurrentWeeks.length > 0
      ? Math.round(pastAndCurrentWeeks.reduce((sum, w) => sum + w.value, 0) / pastAndCurrentWeeks.length)
      : 0;

    // Calculate Readiness Trend Stability (Weight 15%)
    // Only use past and current weeks, not future weeks
    let readinessTrendScore = 65;
    if (pastAndCurrentWeeks.length >= 2) {
      const readinessValues = pastAndCurrentWeeks.map((w) => w.value);
      const mean = readinessValues.reduce((a, b) => a + b, 0) / readinessValues.length;
      const variance = readinessValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / readinessValues.length;
      readinessTrendScore = Math.max(0, Math.min(100, 100 - Math.sqrt(variance)));
    } else if (pastAndCurrentWeeks.length === 1) {
      // Only 1 week - assume stable (100%)
      readinessTrendScore = 100;
    }

    // Calculate PM Override Frequency Score - AVERAGED PER PROJECT
    // Group cycle history by programme and calculate score for each project
    const cyclesByProgramme = {};
    for (const cycle of cycleHistory) {
      const progId = cycle.programme?.toString() || 'unknown';
      if (!cyclesByProgramme[progId]) {
        cyclesByProgramme[progId] = { total: 0, pmOverrides: 0 };
      }
      cyclesByProgramme[progId].total++;
      if (cycle.closeType === "PM Override") {
        cyclesByProgramme[progId].pmOverrides++;
      }
    }

    // Calculate PM Override score for each project and average them
    // Include ALL programmes (even those without cycle history get 100 score)
    let pmOverrideFrequencyScore = 100; // Default if no programmes
    const allProgrammeScores = [];

    // First, add scores for programmes WITH cycle history
    // Score = (Normal Weeks / Total Weeks) × 100 (week-wise calculation)
    for (const progId of Object.keys(cyclesByProgramme)) {
      const prog = cyclesByProgramme[progId];
      const normalWeeks = prog.total - prog.pmOverrides;
      const projectScore = prog.total > 0 ? Math.round((normalWeeks / prog.total) * 100) : 100;
      allProgrammeScores.push(projectScore);
    }

    // Add 100 score for programmes WITHOUT any cycle history (no PM overrides = perfect)
    for (const prog of programmes) {
      const progId = prog._id.toString();
      if (!cyclesByProgramme[progId]) {
        allProgrammeScores.push(100); // No cycles closed = no PM overrides
      }
    }

    // Average all programme scores
    if (allProgrammeScores.length > 0) {
      const totalScore = allProgrammeScores.reduce((sum, s) => sum + s, 0);
      pmOverrideFrequencyScore = Math.round(totalScore / allProgrammeScores.length);
    }


    // Calculate DYNAMIC WEIGHTS based on scores
    // Higher scores get more weight, proportional to their contribution
    // Metrics with the same score will always have the same weight
    const allScores = {
      weeksClosedOnTime: weeksClosedOnTimeScore,
      overdueActionRate: overdueActionRateScore,
      actionClosureSpeed: actionClosureSpeedScore,
      readinessTrendStability: Math.round(readinessTrendScore),
      pmOverrideFrequency: pmOverrideFrequencyScore,
    };

    // Sum all scores
    const totalScoreSum = Object.values(allScores).reduce((sum, score) => sum + score, 0);

    // Calculate dynamic weights (proportional to each score)
    // Use exact rounding without any adjustment
    const dynamicWeights = {};
    if (totalScoreSum > 0) {
      for (const [key, score] of Object.entries(allScores)) {
        const rawWeight = (score / totalScoreSum) * 100;
        dynamicWeights[key] = Math.round(rawWeight);
      }
    } else {
      // Equal distribution if no scores
      for (const key of Object.keys(allScores)) {
        dynamicWeights[key] = 20;
      }
    }

    // Calculate overall governance score using dynamic weights
    const governanceScore = Math.round(
      (allScores.weeksClosedOnTime * dynamicWeights.weeksClosedOnTime +
       allScores.overdueActionRate * dynamicWeights.overdueActionRate +
       allScores.actionClosureSpeed * dynamicWeights.actionClosureSpeed +
       allScores.readinessTrendStability * dynamicWeights.readinessTrendStability +
       allScores.pmOverrideFrequency * dynamicWeights.pmOverrideFrequency) / 100
    );

    // Determine governance status based on score
    let governanceStatus = "GREEN";
    if (governanceScore < 50) governanceStatus = "RED";
    else if (governanceScore < 70) governanceStatus = "AMBER";

    // Calculate overdue trend from closed weeks only
    // Since we don't have historical overdue data per week, use stable
    const overdueTrend = "Stable";

    // Get blocked activities to determine recurring blockers
    let blockerTypes = new Set();
    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];
      activities.forEach((a) => {
        if (a.isBlocked && a.blocker) {
          blockerTypes.add(a.blocker.split(" ")[0]);
        }
      });
    }

    // Build constraint intelligence data using DYNAMIC activity analysis
    const constraintData = [];
    const activityTypeMap = {};

    // Helper function to extract activity type dynamically from name
    const extractActivityType = (activityName) => {
      const name = (activityName || "").toLowerCase().trim();

      // Remove common prefixes (activity IDs, numbers, etc.)
      const cleanName = name
        .replace(/^[a-z]{1,3}[-_]?\d+[-_:]?\s*/i, "") // Remove IDs like "A1-001", "WP-FW-001"
        .replace(/^(phase|stage|step|task)\s*\d*[-:]?\s*/i, "") // Remove "Phase 1", "Stage 2"
        .replace(/\s*(phase|stage)\s*\d*$/i, "") // Remove trailing "Phase 1"
        .replace(/[-_]/g, " ")
        .trim();

      // Extract main activity type (first 2-3 key words)
      const words = cleanName.split(/\s+/).filter(w => w.length > 2);

      // Common construction activity patterns - group similar activities
      const activityPatterns = {
        "Foundation": ["foundation", "footing", "pile", "piling", "excavation", "ground"],
        "Structural": ["steel", "structure", "column", "beam", "slab", "concrete", "rebar", "structural"],
        "MEP Works": ["mep", "electrical", "plumbing", "hvac", "mechanical", "piping", "wiring"],
        "Facade & Cladding": ["facade", "cladding", "curtain", "glazing", "external", "envelope"],
        "Interior Fit-Out": ["interior", "fit-out", "fitout", "partition", "ceiling", "flooring", "tiling", "painting", "plastering"],
        "Roofing": ["roof", "roofing", "waterproof", "membrane"],
        "Site Works": ["site", "mobilization", "survey", "clearing", "demolition"],
        "Testing & Commissioning": ["test", "testing", "commission", "commissioning", "inspection", "handover", "snag"],
        "Design & Approvals": ["design", "drawing", "approval", "permit", "submittal"],
        "Procurement": ["material", "delivery", "procurement", "supply", "order"],
      };

      // Find matching pattern
      for (const [type, keywords] of Object.entries(activityPatterns)) {
        if (keywords.some(kw => cleanName.includes(kw))) {
          return type;
        }
      }

      // If no pattern matched, use first 2 meaningful words as type
      if (words.length >= 2) {
        return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      } else if (words.length === 1) {
        return words[0].charAt(0).toUpperCase() + words[0].slice(1);
      }

      return "General Works";
    };

    // Step 1: Collect ALL activities from all projects with their status
    const allActivitiesByType = {};

    for (const prog of programmes) {
      const activities = prog.extractedData?.activities || [];
      const projectId = prog.project?.toString();
      const projectName = projects.find(p => p._id.toString() === projectId)?.name || "Unknown";

      activities.forEach((a) => {
        const activityType = extractActivityType(a.activityName);
        const finishDate = parseDate(a.finishDate);

        // Determine activity status
        const isCompleted = a.status === "Completed" ||
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

        // Only track overdue and completed activities (ignore future/on-time)
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
          if (!typeData.lastOverdueDate || finishDate > typeData.lastOverdueDate) {
            typeData.lastOverdueDate = finishDate;
          }
        } else if (isCompleted) {
          typeData.projectsWithCompleted.add(projectId);
          typeData.totalCompleted++;
        }
        // Note: Future/on-time activities are ignored for constraint intelligence
      });
    }

    // Step 2: Calculate trends by comparing across projects
    // Trend logic:
    // - "down" = some projects have this activity completed/on-time while others have it overdue (improving)
    // - "stable" = same activity overdue in multiple projects (consistent issue across projects)
    // - "up" = only 1 project has this activity overdue (unique/new problem)

    Object.values(allActivitiesByType)
      .filter(typeData => typeData.totalOverdue > 0) // Only show types with overdue activities
      .sort((a, b) => b.projectsWithOverdue.size - a.projectsWithOverdue.size || b.totalOverdue - a.totalOverdue)
      // No limit - show all constraint types
      .forEach((typeData) => {
        let trend = "stable";

        const overdueProjects = typeData.projectsWithOverdue.size;
        const completedProjects = typeData.projectsWithCompleted.size;
        // Only consider overdue and completed (future activities ignored)
        const totalProjectsWithThisType = new Set([
          ...typeData.projectsWithOverdue,
          ...typeData.projectsWithCompleted,
        ]).size;

        // Smart trend calculation:
        // DOWN = One project completed, other overdue (someone fixed it - improving)
        // STABLE = Same activity overdue in multiple projects (consistent issue)
        // UP = Only 1 project has this activity overdue (unique/new problem)

        if (totalProjectsWithThisType > 1) {
          if (completedProjects > 0) {
            // Some projects have completed, others overdue = improving trend
            trend = "down";
          } else if (overdueProjects > 1) {
            // Same activity overdue in multiple projects = consistent issue
            trend = "stable";
          }
        } else {
          // Only 1 project has this activity type = unique/new problem
          trend = "up";
        }

        // Format last seen date
        let lastSeenStr = "-";
        if (typeData.lastOverdueDate) {
          const daysSince = Math.floor((today - typeData.lastOverdueDate) / msPerDay);
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
          frequency: overdueProjects, // Number of projects with overdue activities of this type
          trend: trend,
          lastSeen: lastSeenStr,
          activities: typeData.overdueActivities.slice(0, 5),
          // Additional context for UI
          stats: {
            overdueCount: typeData.totalOverdue,
            completedCount: typeData.totalCompleted,
            onTimeCount: typeData.totalOnTime,
            projectsAffected: overdueProjects,
            projectsCompleted: completedProjects,
          },
        });
      });

    // Return response
    console.log(`[governance] Returning data with score: ${governanceScore}, status: ${governanceStatus}`);
    return sendSuccess(res, {
      governance: {
        hasData: true,
        score: governanceScore,
        status: governanceStatus,
        metrics: {
          weeksClosedOnTime: {
            score: allScores.weeksClosedOnTime,
            weight: dynamicWeights.weeksClosedOnTime,
            color: allScores.weeksClosedOnTime >= 70 ? "green" : allScores.weeksClosedOnTime >= 50 ? "amber" : "red",
          },
          overdueActionRate: {
            score: allScores.overdueActionRate,
            weight: dynamicWeights.overdueActionRate,
            color: allScores.overdueActionRate >= 70 ? "green" : allScores.overdueActionRate >= 50 ? "amber" : "red",
          },
          actionClosureSpeed: {
            score: allScores.actionClosureSpeed,
            weight: dynamicWeights.actionClosureSpeed,
            color: allScores.actionClosureSpeed >= 70 ? "green" : allScores.actionClosureSpeed >= 50 ? "amber" : "red",
          },
          readinessTrendStability: {
            score: allScores.readinessTrendStability,
            weight: dynamicWeights.readinessTrendStability,
            color: allScores.readinessTrendStability >= 70 ? "green" : allScores.readinessTrendStability >= 50 ? "amber" : "red",
          },
          pmOverrideFrequency: {
            score: allScores.pmOverrideFrequency,
            weight: dynamicWeights.pmOverrideFrequency,
            color: allScores.pmOverrideFrequency >= 70 ? "green" : allScores.pmOverrideFrequency >= 50 ? "amber" : "red",
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
        constraintData: constraintData.length > 0 ? constraintData : [
          { type: "No blockers", frequency: 0, trend: "stable", lastSeen: "-" },
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
    const { projectId } = req.query;

    let projects;
    let projectIds;

    if (projectId) {
      const project = await Project.findById(projectId);
      projects = project ? [project] : [];
      projectIds = projects.map((p) => p._id);
    } else if (req.admin.role === "planner") {
      // Planners see projects they have access to
      const accessibleProjectIds = await getPlannerAccessibleProjects(req.admin);
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

    // Find the earliest activity start date from the programme
    const programmeActivities = activeProgramme?.extractedData?.activities || [];
    let earliestStartDate = null;

    for (const activity of programmeActivities) {
      const actStartDate = parseDate(activity.startDate);
      if (actStartDate && (!earliestStartDate || actStartDate < earliestStartDate)) {
        earliestStartDate = actStartDate;
      }
    }

    if (earliestStartDate) {
      // Calculate weeks from programme start date to today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      earliestStartDate.setHours(0, 0, 0, 0);

      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
      const weekNum = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

      weekNumber = `Week ${weekNum}`;

      // Calculate current week's start and end dates
      const currentWeekStart = new Date(earliestStartDate);
      currentWeekStart.setDate(currentWeekStart.getDate() + (weekNum - 1) * 7);

      const currentWeekEnd = new Date(currentWeekStart);
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

      weekDates = `(${currentWeekStart.getDate()}-${currentWeekEnd.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][currentWeekStart.getMonth()]} ${currentWeekStart.getFullYear()})`;
      weekOpened = formatDate(currentWeekStart);
      closeDeadline = formatDate(currentWeekEnd);
      cycleStatus = activeProgramme?.cycleStatus || "Draft";
    }

    const rawActivities = activeProgramme?.extractedData?.activities || [];
    const today = new Date();
    // Start of today (midnight) - actions are only overdue after due date has fully passed
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

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
        new Date(a.dueDate) < startOfToday,
    );

    // readyForClose logic based on cycle status:
    // - Draft / Uploaded / Meeting Open: Always false (not ready to close)
    // - Execution / Close-Out Eligible: true if all actions complete (openActions === 0)
    let readyForClose = false;
    if (cycleStatus === "Draft" || cycleStatus === "Uploaded" || cycleStatus === "Meeting Open") {
      readyForClose = false;
    } else if (cycleStatus === "Execution" || cycleStatus === "Close-Out Eligible") {
      readyForClose = openActions.length === 0;
    }

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
            linkedAction && new Date(linkedAction.dueDate) < startOfToday
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
