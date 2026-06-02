const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const Programme = require("../models/Programme");
const Action = require("../models/Action");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");
const auditLogger = require("../utils/auditLogger");

router.post("/", protect, adminOnly, async (req, res) => {
  try {
    const { name, phase, description, startDate, endDate } = req.body;

    const errors = validateRequired({ name, phase, startDate });

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const project = await Project.create({
      name,
      phase,
      description,
      startDate,
      endDate,
      createdBy: req.admin._id,
      team: [{ user: req.admin._id, role: "Project Manager" }],
    });

    const populatedProject = await Project.findById(project._id)
      .populate("createdBy", "name email")
      .populate("team.user", "name email");

    // Log project creation
    await auditLogger.projectCreated(req, req.admin, populatedProject);

    return sendSuccess(
      res,
      { project: populatedProject },
      "Project created successfully",
      201,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const { status, phase } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (phase) filter.phase = phase;

    if (req.admin.role !== "admin") {
      let projectIds = [];

      if (req.admin.role === "planner") {
        const userAssignedProjects = (req.admin.projects || []).map((p) =>
          p.toString(),
        );

        const userActions = await Action.find({
          $or: [
            { assignee: req.admin._id },
            { "previousAssignees.user": req.admin._id },
          ],
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

        projectIds = [
          ...new Set([...userAssignedProjects, ...actionProjectIds]),
        ];
      } else {
        const userActions = await Action.find({
          $or: [
            { assignee: req.admin._id },
            { "previousAssignees.user": req.admin._id },
          ],
        }).select("programme");

        if (userActions.length > 0) {
          const programmeIds = [
            ...new Set(userActions.map((a) => a.programme.toString())),
          ];
          const programmes = await Programme.find({
            _id: { $in: programmeIds },
          }).select("project");
          projectIds = [
            ...new Set(
              programmes.map((p) => p.project?.toString()).filter(Boolean),
            ),
          ];
        }
      }

      if (projectIds.length === 0) {
        return sendSuccess(res, { projects: [] });
      }

      filter._id = { $in: projectIds };
    }

    const projects = await Project.find(filter)
      .populate("createdBy", "name email")
      .populate("team.user", "name email")
      .populate("programmes", "name status")
      .sort({ createdAt: -1 });

    // Enrich projects with activities count, open actions, and governance score
    const CycleHistory = require("../models/CycleHistory");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const enrichedProjects = await Promise.all(
      projects.map(async (project) => {
        const projectObj = project.toObject();

        // Get all programmes for this project
        const programmes = await Programme.find({
          project: project._id,
          status: { $in: ["processed", "pending"] },
        });

        // Get programme IDs for queries
        const programmeIds = programmes.map((p) => p._id);

        // Get cycle history to check closed weeks
        const cycleHistory = await CycleHistory.find({
          programme: { $in: programmeIds },
        });

        // Calculate total activities and weeks
        let totalActivities = 0;
        let completedActivities = 0;
        let totalWeeks = 0;
        let closedWeeks = cycleHistory.length;

        // Helper to parse dates
        const parseDateForProgress = (dateStr) => {
          if (!dateStr) return null;
          const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
          const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
          const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
          if (!match) return null;
          const day = parseInt(match[1]);
          const month = months[match[2]];
          let year = parseInt(match[3]);
          year = year < 50 ? 2000 + year : 1900 + year;
          return new Date(year, month, day);
        };

        let earliestDate = null;
        let latestDate = null;

        for (const prog of programmes) {
          const activities = prog.extractedData?.activities || [];
          totalActivities += activities.length;

          // Count completed activities
          completedActivities += activities.filter(
            (a) =>
              a.status === "Completed" ||
              (a.finishDate && a.finishDate.includes(" A"))
          ).length;

          // Calculate total weeks from programme duration or activity dates
          const summary = prog.extractedData?.summary;
          if (summary?.programmeDuration) {
            const weekMatch = summary.programmeDuration.match(/(\d+)\s*weeks?/i);
            if (weekMatch) {
              totalWeeks = Math.max(totalWeeks, parseInt(weekMatch[1]));
            }
          }

          // Fallback: calculate weeks from activity dates
          for (const activity of activities) {
            const startDate = parseDateForProgress(activity.startDate);
            const finishDate = parseDateForProgress(activity.finishDate);
            if (startDate && (!earliestDate || startDate < earliestDate)) {
              earliestDate = startDate;
            }
            if (finishDate && (!latestDate || finishDate > latestDate)) {
              latestDate = finishDate;
            }
          }
        }

        // Calculate totalWeeks from dates if not found in summary
        if (totalWeeks === 0 && earliestDate && latestDate) {
          const msPerDay = 1000 * 60 * 60 * 24;
          const totalDays = Math.ceil((latestDate - earliestDate) / msPerDay);
          totalWeeks = Math.ceil(totalDays / 7);
        }

        // Get actions data
        const actions = programmeIds.length > 0
          ? await Action.find({ programme: { $in: programmeIds } })
          : [];

        const openActionsCount = actions.filter(
          (a) => a.status !== "Completed" && a.status !== "Cancelled"
        ).length;

        const overdueActions = actions.filter(
          (a) =>
            a.status !== "Completed" &&
            a.status !== "Cancelled" &&
            new Date(a.dueDate) < today
        );

        const closedActions = actions.filter((a) => a.status === "Completed");

        // Calculate progress percentage based on closed weeks
        // Progress = (Closed Weeks / Total Weeks) × 100, capped at 100%
        let progress = 0;
        if (totalWeeks > 0) {
          progress = Math.min(100, Math.round((closedWeeks / totalWeeks) * 100));
        }

        // Determine if project should be marked as completed
        // Project is complete if all weeks are closed OR all activities are completed
        const isProjectComplete = (totalWeeks > 0 && closedWeeks >= totalWeeks) ||
          (totalActivities > 0 && completedActivities === totalActivities);

        // Update project status if it should be completed
        if (isProjectComplete && project.status === "Active") {
          await Project.findByIdAndUpdate(project._id, { status: "Completed" });
          projectObj.status = "Completed";
        }

        // Calculate governance score using SAME logic as governance dashboard
        let governanceScore = 0;

        if (programmes.length > 0) {
          // Helper to parse dates
          const parseDate = (dateStr) => {
            if (!dateStr) return null;
            const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
            const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
            if (!match) return null;
            const day = parseInt(match[1]);
            const month = months[match[2]];
            let year = parseInt(match[3]);
            year = year < 50 ? 2000 + year : 1900 + year;
            return new Date(year, month, day);
          };

          // Collect all activities and calculate date ranges
          let allActivities = [];
          let earliestStartDate = null;
          let latestEndDate = null;
          for (const prog of programmes) {
            const activities = prog.extractedData?.activities || [];
            allActivities = allActivities.concat(activities);
            for (const activity of activities) {
              const startDate = parseDate(activity.startDate);
              const finishDate = parseDate(activity.finishDate);
              if (startDate && (!earliestStartDate || startDate < earliestStartDate)) {
                earliestStartDate = startDate;
              }
              if (finishDate && (!latestEndDate || finishDate > latestEndDate)) {
                latestEndDate = finishDate;
              }
            }
          }

          // Calculate total weeks from programme span
          const msPerDay = 1000 * 60 * 60 * 24;
          let totalWeeksFromProgramme = 0;
          if (earliestStartDate && latestEndDate) {
            const totalDays = Math.ceil((latestEndDate - earliestStartDate) / msPerDay);
            totalWeeksFromProgramme = Math.ceil(totalDays / 7);
          }

          // 1. Weeks Closed On Time Score
          // Score = (Normal Close weeks / Total Programme Weeks) × 100
          const weeksClosedOnTime = cycleHistory.filter(
            (c) => c.closeType === "Normal Close"
          ).length;
          const weeksClosedOnTimeScore = totalWeeksFromProgramme > 0
            ? Math.round((weeksClosedOnTime / totalWeeksFromProgramme) * 100)
            : 0;

          // 2. Overdue Action Rate Score
          const overdueRate = actions.length > 0
            ? Math.round((overdueActions.length / actions.length) * 100)
            : 0;
          const overdueActionRateScore = actions.length > 0
            ? Math.max(0, 100 - overdueRate * 2)
            : 100;

          // 3. Action Closure Speed Score
          const actionClosureSpeedScore = actions.length > 0
            ? Math.round((closedActions.length / actions.length) * 100)
            : 0;

          // Calculate weekly readiness using SAME RAG logic as governance dashboard
          const calculateWeekRAG = (weekStartDate, weekEndDate, activities) => {
            let green = 0, amber = 0, red = 0;

            for (const activity of activities) {
              const actStart = parseDate(activity.startDate);
              const actFinish = parseDate(activity.finishDate);

              if (!actStart) continue;

              const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
              const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

              if (!startsThisWeek && !spansThisWeek) continue;

              const isCompleted = activity.status === "Completed" ||
                (activity.startDate && activity.startDate.includes(" A")) ||
                (activity.finishDate && activity.finishDate.includes(" A"));

              if (isCompleted) {
                green++;
              } else if (actFinish && actFinish < weekEndDate) {
                // Should have finished by this week - overdue
                red++;
              } else if (actStart <= weekEndDate) {
                // Starting this week or already started - check if on track
                if (weekStartDate > today) {
                  // Future week - assume on track unless blocked
                  if (activity.isBlocked) {
                    red++;
                  } else {
                    amber++; // Future activities are amber (need monitoring)
                  }
                } else {
                  green++; // Current/past week activities that started
                }
              } else {
                amber++; // Activity spans but hasn't started yet
              }
            }

            return { green, amber, red, total: green + amber + red };
          };

          // 4. Readiness Trend Stability Score
          let readinessTrendScore = 65;
          if (earliestStartDate && allActivities.length > 0) {
            const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
            const currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));

            // Generate weekly readiness data for all weeks
            const weeklyReadinessData = [];
            const weeksToGenerate = totalWeeksFromProgramme || currentWeekNumber;

            for (let weekNum = 1; weekNum <= weeksToGenerate; weekNum++) {
              const weekStartDate = new Date(earliestStartDate);
              weekStartDate.setDate(weekStartDate.getDate() + (weekNum - 1) * 7);
              const weekEndDate = new Date(weekStartDate);
              weekEndDate.setDate(weekStartDate.getDate() + 6);

              const rag = calculateWeekRAG(weekStartDate, weekEndDate, allActivities);
              const readinessPercent = rag.total > 0 ? Math.round((rag.green / rag.total) * 100) : 0;

              // Find matching cycle history if exists
              const matchingCycle = cycleHistory.find((c) => c.weekNumber === weekNum);

              weeklyReadinessData.push({
                week: `W${weekNum}`,
                value: matchingCycle ?
                  Math.round(((matchingCycle.stats?.green || 0) / (matchingCycle.stats?.totalActivities || 1)) * 100) :
                  readinessPercent,
              });
            }

            // Only use past and current weeks (same as dashboard)
            const currentWeekIndex = Math.min(currentWeekNumber, weeklyReadinessData.length);
            const pastAndCurrentWeeks = weeklyReadinessData.slice(0, currentWeekIndex);

            // Calculate stability from variance (same as dashboard)
            if (pastAndCurrentWeeks.length >= 2) {
              const readinessValues = pastAndCurrentWeeks.map((w) => w.value);
              const mean = readinessValues.reduce((a, b) => a + b, 0) / readinessValues.length;
              const variance = readinessValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / readinessValues.length;
              readinessTrendScore = Math.max(0, Math.min(100, 100 - Math.sqrt(variance)));
            } else if (pastAndCurrentWeeks.length === 1) {
              readinessTrendScore = 100;
            }
          }

          // 5. PM Override Frequency Score (week-wise calculation)
          // Score = (Normal Weeks / Total Weeks) × 100
          const pmOverrides = cycleHistory.filter(
            (c) => c.closeType === "PM Override"
          ).length;
          const normalWeeks = cycleHistory.length - pmOverrides;
          const pmOverrideFrequencyScore = cycleHistory.length > 0
            ? Math.round((normalWeeks / cycleHistory.length) * 100)
            : 100;

          // Calculate dynamic weights
          const allScores = {
            weeksClosedOnTime: weeksClosedOnTimeScore,
            overdueActionRate: overdueActionRateScore,
            actionClosureSpeed: actionClosureSpeedScore,
            readinessTrendStability: Math.round(readinessTrendScore),
            pmOverrideFrequency: pmOverrideFrequencyScore,
          };

          const totalScoreSum = Object.values(allScores).reduce((sum, score) => sum + score, 0);

          const dynamicWeights = {};
          if (totalScoreSum > 0) {
            for (const [key, score] of Object.entries(allScores)) {
              dynamicWeights[key] = Math.round((score / totalScoreSum) * 100);
            }
          } else {
            for (const key of Object.keys(allScores)) {
              dynamicWeights[key] = 20;
            }
          }

          // Calculate weighted governance score
          governanceScore = Math.round(
            (allScores.weeksClosedOnTime * dynamicWeights.weeksClosedOnTime +
             allScores.overdueActionRate * dynamicWeights.overdueActionRate +
             allScores.actionClosureSpeed * dynamicWeights.actionClosureSpeed +
             allScores.readinessTrendStability * dynamicWeights.readinessTrendStability +
             allScores.pmOverrideFrequency * dynamicWeights.pmOverrideFrequency) / 100
          );
        }

        return {
          ...projectObj,
          totalActivities,
          openActions: openActionsCount,
          progress,
          governanceScore,
        };
      })
    );

    return sendSuccess(res, { projects: enrichedProjects });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("team.user", "name email")
      .populate({
        path: "programmes",
        select: "name status cycleStatus extractedData.summary createdAt",
      });

    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    if (req.admin.role !== "admin") {
      const allProgrammes = await Programme.find({
        project: req.params.id,
      }).select("_id");
      const allProgrammeIds = allProgrammes.map((p) => p._id);

      const userActionCount =
        allProgrammeIds.length > 0
          ? await Action.countDocuments({
              programme: { $in: allProgrammeIds },
              $or: [
                { assignee: req.admin._id },
                { "previousAssignees.user": req.admin._id },
              ],
            })
          : 0;

      if (req.admin.role === "planner") {
        const userProjects = req.admin.projects || [];
        const isAssigned = userProjects.some(
          (p) => p.toString() === req.params.id,
        );

        if (!isAssigned && userActionCount === 0) {
          return sendError(res, "Access denied", 403);
        }
      } else {
        if (userActionCount === 0) {
          return sendError(res, "Access denied", 403);
        }
      }
    }

    return sendSuccess(res, { project });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.put("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, phase, description, startDate, endDate, status } = req.body;

    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    // Store old values for audit log
    const oldValues = {
      name: project.name,
      phase: project.phase,
      description: project.description,
      startDate: project.startDate,
      endDate: project.endDate,
      status: project.status,
    };
    const oldStatus = project.status;

    if (name) project.name = name;
    if (phase) project.phase = phase;
    if (description !== undefined) project.description = description;
    if (startDate) project.startDate = startDate;
    if (endDate !== undefined) project.endDate = endDate;
    if (status) project.status = status;

    await project.save();

    const updatedProject = await Project.findById(project._id)
      .populate("createdBy", "name email")
      .populate("team.user", "name email");

    // Log project update
    const newValues = { name, phase, description, startDate, endDate, status };
    await auditLogger.projectUpdated(req, req.admin, updatedProject, {
      before: oldValues,
      after: newValues,
    });

    // Log status change separately if status changed
    if (status && status !== oldStatus) {
      await auditLogger.projectStatusChanged(req, req.admin, updatedProject, oldStatus, status);
    }

    return sendSuccess(
      res,
      { project: updatedProject },
      "Project updated successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    // Log project deletion before deleting
    await auditLogger.log({
      action: "PROJECT_DELETED",
      req,
      user: req.admin,
      resourceType: "Project",
      resourceId: project._id,
      resourceName: project.name,
      description: `Deleted project "${project.name}"`,
    });

    await Project.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "Project deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/team", protect, adminOnly, async (req, res) => {
  try {
    const { userId, role } = req.body;

    const errors = validateRequired({ userId, role });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    const existingMember = project.team.find(
      (member) => member.user.toString() === userId,
    );
    if (existingMember) {
      return sendValidationError(res, [
        { field: "userId", message: "User already in team" },
      ]);
    }

    project.team.push({ user: userId, role });
    await project.save();

    const updatedProject = await Project.findById(project._id).populate(
      "team.user",
      "name email",
    );

    // Find the added member for audit log
    const Admin = require("../models/Admin");
    const addedMember = await Admin.findById(userId).select("name email");
    if (addedMember) {
      await auditLogger.teamMemberAdded(req, req.admin, project, addedMember, role);
    }

    return sendSuccess(
      res,
      { team: updatedProject.team },
      "Team member added successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id/team/:userId", protect, adminOnly, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    // Find the member being removed for audit log
    const Admin = require("../models/Admin");
    const removedMember = await Admin.findById(req.params.userId).select("name email");

    project.team = project.team.filter(
      (member) => member.user.toString() !== req.params.userId,
    );
    await project.save();

    // Log team member removal
    if (removedMember) {
      await auditLogger.teamMemberRemoved(req, req.admin, project, removedMember);
    }

    return sendSuccess(res, {}, "Team member removed successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/programmes", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId } = req.body;

    const errors = validateRequired({ programmeId });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    if (project.programmes.includes(programmeId)) {
      return sendValidationError(res, [
        { field: "programmeId", message: "Programme already linked" },
      ]);
    }

    project.programmes.push(programmeId);
    await project.save();

    const updatedProject = await Project.findById(project._id).populate(
      "programmes",
      "name status",
    );

    return sendSuccess(
      res,
      { programmes: updatedProject.programmes },
      "Programme linked successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/meta/phases", protect, async (req, res) => {
  res.json({
    phases: [
      "Planning",
      "Design",
      "Pre-Construction",
      "Construction",
      "Commissioning",
      "Handover",
      "Completed",
    ],
  });
});

module.exports = router;
