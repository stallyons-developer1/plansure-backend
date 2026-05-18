const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Programme = require("../models/Programme");
const Project = require("../models/Project");
const Action = require("../models/Action");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { uploadToDisk } = require("../middleware/upload");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
} = require("../utils/errorResponse");

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const checkProgrammeAccess = async (user, programmeId, projectId = null) => {
  if (user.role === "admin") {
    return { hasAccess: true };
  }

  let projId = projectId;
  if (!projId && programmeId) {
    const programme = await Programme.findById(programmeId).select("project");
    projId = programme?.project?.toString();
  }

  if (!projId) {
    return { hasAccess: false };
  }

  const projectProgrammes = await Programme.find({ project: projId }).select(
    "_id",
  );
  const programmeIds = projectProgrammes.map((p) => p._id);

  const userActionCount =
    programmeIds.length > 0
      ? await Action.countDocuments({
          programme: { $in: programmeIds },
          $or: [{ assignee: user._id }, { "previousAssignees.user": user._id }],
        })
      : 0;

  if (user.role === "planner") {
    const userProjects = user.projects || [];
    const isAssigned = userProjects.some((p) => p.toString() === projId);
    return { hasAccess: isAssigned || userActionCount > 0 };
  }

  return { hasAccess: userActionCount > 0 };
};

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

const generateWeekZones = (startDate, numWeeks = 6) => {
  const zones = [];
  const start = new Date(startDate);

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

const getWeekZone = (activityStartDate, weekZones) => {
  const startDate = parseDate(activityStartDate);
  if (!startDate) return null;

  for (const zone of weekZones) {
    if (startDate >= zone.startDate && startDate <= zone.endDate) {
      if (zone.weekNumber <= 2) return "Weeks 1-2";
      if (zone.weekNumber <= 4) return "Weeks 3-4";
      return "Weeks 5-6";
    }
  }

  const lastZone = weekZones[weekZones.length - 1];
  if (startDate > lastZone.endDate) {
    return "Beyond Lookahead";
  }

  return "Before Lookahead";
};

const calculateActivityStatus = (activity, ragStatus, today) => {
  if (activity.status === "Completed") {
    return "Complete";
  }
  if (activity.isBlocked) {
    return "Blocked";
  }

  const finishDate = parseDate(activity.finishDate);
  const startDate = parseDate(activity.startDate);

  if (startDate && finishDate && today) {
    if (
      startDate < today &&
      finishDate < today &&
      activity.status !== "Completed"
    ) {
      return "At Risk";
    }
  }

  return "Ready";
};

router.post(
  "/upload",
  protect,
  uploadToDisk.single("programme"),
  async (req, res) => {
    try {
      const errors = [];

      if (!req.file) {
        errors.push({
          field: "programme",
          message: "Please upload a PDF file",
        });
      }

      const { name, project } = req.body;
      if (!name || !name.trim()) {
        errors.push({ field: "name", message: "Programme name is required" });
      }

      if (errors.length > 0) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return sendValidationError(res, errors);
      }

      const pdfBuffer = fs.readFileSync(req.file.path);

      const uint8Array = new Uint8Array(pdfBuffer);
      const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

      const pageCount = pdfDoc.numPages;
      const activities = [];

      for (let i = 1; i <= pageCount; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();

        const rows = {};
        textContent.items.forEach((item) => {
          if (!item.str.trim()) return;
          const y = Math.round(item.transform[5] / 3) * 3;
          const x = Math.round(item.transform[4]);

          if (x > 780) return;

          if (!rows[y]) rows[y] = [];
          rows[y].push({ text: item.str.trim(), x });
        });

        const sortedYPositions = Object.keys(rows)
          .map(Number)
          .sort((a, b) => b - a);

        const activityIdPattern =
          /^([A-Z]{1,6}[-_][A-Z0-9]{1,6}[-_]?\d*[\.\d]*|[A-Z]{1,4}\d+[\.\d]*|[A-Z]{2,}[-_][A-Z0-9]+-?\d*|VI_+[A-Z0-9]+|[A-Z]+-\d+|STAGE-\d+)/;
        const datePattern = /\d{2}-[A-Za-z]{3}-\d{2}/;

        const idXPositions = [];
        const dateXPositions = [];
        const textXPositions = [];

        sortedYPositions.slice(0, 50).forEach((y) => {
          const row = rows[y];
          row.sort((a, b) => a.x - b.x);

          row.forEach((item, idx) => {
            if (
              activityIdPattern.test(item.text) &&
              item.x < 200 &&
              idx === 0
            ) {
              idXPositions.push(item.x);
            }
            if (datePattern.test(item.text)) {
              dateXPositions.push(item.x);
            }
            if (
              item.text.length > 5 &&
              !datePattern.test(item.text) &&
              !/^\d+$/.test(item.text) &&
              !activityIdPattern.test(item.text)
            ) {
              textXPositions.push(item.x);
            }
          });
        });

        const uniqueIdX = [...new Set(idXPositions)].sort((a, b) => a - b);
        const idColumnX = uniqueIdX.length > 0 ? uniqueIdX[0] : 30;
        const idColumnMaxX =
          uniqueIdX.length > 0 ? Math.max(...uniqueIdX) + 80 : 145;

        const uniqueTextX = [...new Set(textXPositions)].sort((a, b) => a - b);
        const nameColumnMinX =
          uniqueTextX.length > 0
            ? Math.min(...uniqueTextX.filter((x) => x > idColumnX)) - 10
            : 100;

        const sortedDateX = [...new Set(dateXPositions)].sort((a, b) => a - b);
        let finishColumnThreshold = 603;
        if (sortedDateX.length >= 4) {
          const dateGaps = [];
          for (let j = 1; j < sortedDateX.length; j++) {
            if (sortedDateX[j] - sortedDateX[j - 1] > 20) {
              dateGaps.push({
                gap: sortedDateX[j] - sortedDateX[j - 1],
                midpoint: (sortedDateX[j] + sortedDateX[j - 1]) / 2,
              });
            }
          }
          if (dateGaps.length > 0) {
            finishColumnThreshold = dateGaps[0].midpoint;
          }
        } else if (sortedDateX.length >= 2) {
          finishColumnThreshold =
            (sortedDateX[0] + sortedDateX[sortedDateX.length - 1]) / 2;
        }

        sortedYPositions.forEach((y) => {
          const row = rows[y];
          row.sort((a, b) => a.x - b.x);

          const idItem = row.find(
            (item) =>
              item.x >= 0 &&
              item.x < idColumnMaxX &&
              activityIdPattern.test(item.text),
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

            const dateItems = row
              .filter((item) => item.x < 780 && datePattern.test(item.text))
              .sort((a, b) => a.x - b.x);

            const minDateX =
              dateItems.length > 0
                ? Math.min(...dateItems.map((d) => d.x))
                : 780;
            const nameColumnMaxX = Math.min(minDateX - 20, 550);

            row.forEach((item) => {
              if (
                item.x >= 0 &&
                item.x < idColumnMaxX &&
                activityIdPattern.test(item.text)
              ) {
                activity.activityId = item.text;
                if (item.text.startsWith("MS-")) {
                  activity.isMilestone = true;
                }
              } else if (
                item.x >= nameColumnMinX &&
                item.x < nameColumnMaxX &&
                item.text.length > 2 &&
                !datePattern.test(item.text) &&
                !/^\d+$/.test(item.text)
              ) {
                if (activity.activityName) {
                  activity.activityName += " " + item.text;
                } else {
                  activity.activityName = item.text;
                }
              } else if (
                /^\d+$/.test(item.text) &&
                parseInt(item.text) < 2000 &&
                item.x < minDateX
              ) {
                activity.duration = item.text;
                activity.durationDays = parseInt(item.text) || 0;
                if (item.text === "0") {
                  activity.isMilestone = true;
                }
              }
            });

            if (dateItems.length >= 2) {
              activity.startDate = dateItems[0].text;
              activity.finishDate = dateItems[1].text;
            } else if (dateItems.length === 1) {
              if (dateItems[0].x >= finishColumnThreshold) {
                activity.finishDate = dateItems[0].text;
              } else {
                activity.startDate = dateItems[0].text;
              }
            }

            activity.startDateParsed = parseDate(activity.startDate);
            activity.finishDateParsed = parseDate(activity.finishDate);

            if (activity.finishDate.includes(" A")) {
              activity.status = "Completed";
            } else if (
              activity.startDate.includes(" A") &&
              !activity.finishDate.includes(" A")
            ) {
              activity.status = "In Progress";
            } else if (
              activity.finishDate.includes("*") ||
              activity.startDate.includes("*")
            ) {
              activity.status = "Forecast";
            } else {
              activity.status = "Planned";
            }

            const today = new Date();
            activity.ragStatus = calculateRAG(activity, today);

            activity.activityStatus = calculateActivityStatus(
              activity,
              activity.ragStatus,
              today,
            );

            if (activity.activityName) {
              activities.push(activity);
            }
          }
        });
      }

      const today = new Date();
      const weekZones = generateWeekZones(today, 6);

      activities.forEach((activity) => {
        activity.weekZone = getWeekZone(activity.startDate, weekZones);
      });

      const lookaheadActivities = activities.filter(
        (a) =>
          a.weekZone &&
          !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone),
      );

      const summary = {
        total: activities.length,
        inLookahead: lookaheadActivities.length,
        completed: activities.filter((a) => a.status === "Completed").length,
        inProgress: activities.filter((a) => a.status === "In Progress").length,
        planned: activities.filter(
          (a) => a.status === "Planned" || a.status === "Forecast",
        ).length,
        red: activities.filter((a) => a.ragStatus === "Red").length,
        amber: activities.filter((a) => a.ragStatus === "Amber").length,
        green: activities.filter((a) => a.ragStatus === "Green").length,
        blocked: activities.filter((a) => a.activityStatus === "Blocked")
          .length,
        atRisk: activities.filter((a) => a.activityStatus === "At Risk").length,
        ready: activities.filter((a) => a.activityStatus === "Ready").length,
      };

      // TODO: Uncomment when ready to use date validation
      // Validate activity dates against project dates
      // if (project) {
      //   const projectData = await Project.findById(project).select("startDate endDate name");
      //   if (projectData && projectData.startDate) {
      //     const projectStartDate = new Date(projectData.startDate);
      //     projectStartDate.setHours(0, 0, 0, 0);

      //     // Find activities with dates before project start date
      //     const invalidActivities = activities.filter((activity) => {
      //       if (activity.startDateParsed) {
      //         const activityStart = new Date(activity.startDateParsed);
      //         activityStart.setHours(0, 0, 0, 0);
      //         return activityStart < projectStartDate;
      //       }
      //       return false;
      //     });

      //     if (invalidActivities.length > 0) {
      //       // Clean up uploaded file
      //       if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      //         fs.unlinkSync(req.file.path);
      //       }

      //       const projectStartFormatted = projectStartDate.toISOString().split('T')[0];
      //       const sampleActivities = invalidActivities.slice(0, 3).map(a => a.activityId).join(", ");
      //       const moreCount = invalidActivities.length > 3 ? ` and ${invalidActivities.length - 3} more` : "";

      //       return sendValidationError(res, [{
      //         field: "programme",
      //         message: `Programme contains ${invalidActivities.length} activities with dates before the project start date (${projectStartFormatted}). Activities: ${sampleActivities}${moreCount}. Please upload a programme with dates matching the project timeline.`
      //       }]);
      //     }
      //   }
      // }

      const startOfYear = new Date(today.getFullYear(), 0, 1);
      const days = Math.floor((today - startOfYear) / (24 * 60 * 60 * 1000));
      const weekNumber = Math.ceil((days + 1) / 7);

      const programme = await Programme.create({
        name,
        project: project || null,
        originalFileName: req.file.originalname,
        filePath: req.file.path,
        cycleStatus: "Uploaded",
        weekNumber,
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
            activities: activities,
            createdAt: programme.createdAt,
            lastUpdated: programme.updatedAt,
          },
        },
        "Programme uploaded and processed successfully",
        201,
      );
    } catch (error) {
      console.error("PDF Upload Error:", error);
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return sendError(res, "Error processing PDF");
    }
  },
);

router.get("/", protect, async (req, res) => {
  try {
    let filter = {};

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
        return sendSuccess(res, { programmes: [] });
      }
      filter.project = { $in: projectIds };
    }

    const programmes = await Programme.find(filter)
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    return sendSuccess(res, { programmes });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/by-project/:projectId", protect, async (req, res) => {
  try {
    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      null,
      req.params.projectId,
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    let programme = await Programme.findOne({
      project: req.params.projectId,
      cycleStatus: { $ne: "Closed" },
    })
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    if (!programme) {
      programme = await Programme.findOne({ project: req.params.projectId })
        .populate("uploadedBy", "name email")
        .sort({ createdAt: -1 });
    }

    if (!programme) {
      return sendSuccess(res, { programme: null });
    }

    return sendSuccess(res, { programme });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/project/:projectId/history", protect, async (req, res) => {
  try {
    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      null,
      req.params.projectId,
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const programmes = await Programme.find({ project: req.params.projectId })
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    const currentProgramme = programmes.find((p) => p.cycleStatus !== "Closed");
    const history = programmes.filter((p) => p.cycleStatus === "Closed");

    return sendSuccess(res, {
      currentProgramme: currentProgramme || null,
      history,
      canUploadNew:
        !currentProgramme || currentProgramme.cycleStatus === "Closed",
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/project/:projectId/activities", protect, async (req, res) => {
  try {
    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      null,
      req.params.projectId,
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const { page = 1, limit = 10, search = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let programme = await Programme.findOne({
      project: req.params.projectId,
      cycleStatus: { $ne: "Closed" },
    }).sort({ createdAt: -1 });

    if (!programme) {
      programme = await Programme.findOne({
        project: req.params.projectId,
      }).sort({ createdAt: -1 });
    }

    if (
      !programme ||
      !programme.extractedData ||
      !programme.extractedData.activities
    ) {
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

    let activities = programme.extractedData.activities.map((a) => ({
      activityId: a.activityId,
      activityName: a.activityName,
      startDate: a.startDate,
      finishDate: a.finishDate,
      status: a.status,
      ragStatus: a.ragStatus,
    }));

    if (search) {
      const searchLower = search.toLowerCase();
      activities = activities.filter(
        (a) =>
          a.activityId.toLowerCase().includes(searchLower) ||
          a.activityName.toLowerCase().includes(searchLower),
      );
    }

    const totalActivities = activities.length;
    const totalPages = Math.ceil(totalActivities / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

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

router.get("/:id", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id).populate(
      "uploadedBy",
      "name email",
    );

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      req.params.id,
      programme.project?.toString(),
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    return sendSuccess(res, { programme });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id/lookahead", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id)
      .populate("uploadedBy", "name email")
      .populate("extractedData.activities.owner", "name email");

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      req.params.id,
      programme.project?.toString(),
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

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

    const today = new Date();
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const ragStatus = calculateRAG(activityObj, today);
      const activityStatus = calculateActivityStatus(
        activityObj,
        ragStatus,
        today,
      );
      return {
        ...activityObj,
        ragStatus,
        activityStatus,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
        actionsCount: actionCountMap[activityObj.activityId]?.total || 0,
        openActionsCount: actionCountMap[activityObj.activityId]?.open || 0,
      };
    });

    const lookaheadActivities = activities;

    const activitiesByWeekZone = {
      "Weeks 1-2": lookaheadActivities.filter(
        (a) => a.weekZone === "Weeks 1-2",
      ),
      "Weeks 3-4": lookaheadActivities.filter(
        (a) => a.weekZone === "Weeks 3-4",
      ),
      "Weeks 5-6": lookaheadActivities.filter(
        (a) => a.weekZone === "Weeks 5-6",
      ),
    };

    const blockedRiskActivities = lookaheadActivities.filter(
      (a) =>
        a.ragStatus === "Red" ||
        a.ragStatus === "Amber" ||
        a.activityStatus === "Blocked",
    );

    const actionStats = {
      total: actions.length,
      open: actions.filter((a) => a.status === "Open").length,
      inProgress: actions.filter((a) => a.status === "In Progress").length,
      completed: actions.filter((a) => a.status === "Completed").length,
      overdue: actions.filter(
        (a) =>
          a.dueDate < today &&
          a.status !== "Completed" &&
          a.status !== "Cancelled",
      ).length,
    };

    const summary = {
      total: activities.length,
      inLookahead: lookaheadActivities.length,
      completed: activities.filter((a) => a.status === "Completed").length,
      inProgress: activities.filter((a) => a.status === "In Progress").length,
      planned: activities.filter(
        (a) => a.status === "Planned" || a.status === "Forecast",
      ).length,
      red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
      amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
      green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
      blocked: lookaheadActivities.filter((a) => a.activityStatus === "Blocked")
        .length,
      atRisk: lookaheadActivities.filter((a) => a.activityStatus === "At Risk")
        .length,
      ready: lookaheadActivities.filter((a) => a.activityStatus === "Ready")
        .length,
    };

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
        overdue: actionStats.overdue,
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
      activities: activities,
      lookaheadActivities: lookaheadActivities,
      recentActions: actions.slice(0, 10),
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/:id/activity/:activityId", protect, async (req, res) => {
  try {
    const { owner, ownerName, activityStatus, notes, isBlocked, blocker } =
      req.body;

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    if (programme.isLocked) {
      return sendError(
        res,
        "This week is closed and read-only. No changes allowed.",
        403,
      );
    }

    const activityIndex = programme.extractedData.activities.findIndex(
      (a) => a.activityId === req.params.activityId,
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

    if (isBlocked !== undefined) {
      const today = new Date();
      activity.activityStatus = calculateActivityStatus(
        activity,
        activity.ragStatus,
        today,
      );
    }

    await programme.save();

    return sendSuccess(
      res,
      { activity: programme.extractedData.activities[activityIndex] },
      "Activity updated successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id/overview", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id).populate(
      "uploadedBy",
      "name email",
    );

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      req.params.id,
      programme.project?.toString(),
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const Action = require("../models/Action");
    const CycleHistory = require("../models/CycleHistory");

    const actions = await Action.find({ programme: req.params.id });
    const today = new Date();

    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const ragStatus = calculateRAG(activityObj, today);
      const activityStatus = calculateActivityStatus(
        activityObj,
        ragStatus,
        today,
      );
      return {
        ...activityObj,
        ragStatus,
        activityStatus,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
      };
    });

    const lookaheadActivities = activities.filter(
      (a) =>
        a.ragStatus !== "Grey" &&
        a.weekZone &&
        !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone),
    );

    const greenActivities = lookaheadActivities.filter(
      (a) => a.ragStatus === "Green",
    );
    const greenAndReady = greenActivities.filter(
      (a) => a.activityStatus === "Ready" || a.activityStatus === "Complete",
    );

    const openActions = actions.filter(
      (a) => a.status === "Open" || a.status === "In Progress",
    ).length;

    const overdueActions = actions.filter(
      (a) =>
        a.dueDate < today &&
        a.status !== "Completed" &&
        a.status !== "Cancelled",
    ).length;

    const ragDistribution = {
      green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
      amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
      red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
    };

    const cycleHistory = await CycleHistory.find({ programme: req.params.id })
      .sort({ weekNumber: -1 })
      .limit(5)
      .populate("closedBy", "name");

    const recentCycleHistory = cycleHistory.map((cycle) => ({
      weekNumber: cycle.weekNumber,
      weekLabel: cycle.weekLabel,
      dateRange:
        cycle.dateRange.startDate && cycle.dateRange.endDate
          ? `${formatDateShort(cycle.dateRange.startDate)} - ${formatDateShort(cycle.dateRange.endDate)}`
          : "",
      closeType: cycle.closeType,
      score: cycle.score,
    }));

    res.json({
      stats: {
        activitiesInLookahead: lookaheadActivities.length,
        greenAndReady: {
          count: greenAndReady.length,
          ofGreen: greenActivities.length,
        },
        openActions: openActions,
        overdueActions: overdueActions,
      },
      ragDistribution: {
        green: ragDistribution.green,
        amber: ragDistribution.amber,
        red: ragDistribution.red,
      },
      recentCycleHistory: recentCycleHistory,
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

const formatDateShort = (date) => {
  const d = new Date(date);
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
  return `${d.getDate().toString().padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

router.post("/:id/close-cycle", protect, async (req, res) => {
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

    const currentWeek = weekZones[0];

    const lastCycle = await CycleHistory.findOne({
      programme: req.params.id,
    }).sort({ weekNumber: -1 });
    const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const ragStatus = calculateRAG(activityObj, today);
      return {
        ...activityObj,
        ragStatus,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
      };
    });

    // Get only activities that START within the current week being closed
    const weekStartDate = new Date(currentWeek.startDate);
    const weekEndDate = new Date(currentWeek.endDate);
    weekStartDate.setHours(0, 0, 0, 0);
    weekEndDate.setHours(23, 59, 59, 999);

    const weekActivities = activities.filter((a) => {
      const actStart = parseDate(a.startDate);
      const actFinish = parseDate(a.finishDate);
      if (!actStart) return false;

      // Activity is in this week if:
      // 1. It starts within this week, OR
      // 2. It spans this week (started before and finishes during/after)
      const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

      return startsThisWeek || spansThisWeek;
    });

    // Fallback to lookahead activities if no week-specific activities found
    const lookaheadActivities = weekActivities.length > 0 ? weekActivities : activities.filter(
      (a) =>
        a.ragStatus !== "Grey" &&
        a.weekZone &&
        !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone),
    );

    const actions = await Action.find({ programme: req.params.id });
    const completedActions = actions.filter(
      (a) => a.status === "Completed",
    ).length;

    const greenCount = lookaheadActivities.filter(
      (a) => a.ragStatus === "Green",
    ).length;
    const totalCount = lookaheadActivities.length || 1;
    const actionCompletion =
      actions.length > 0 ? (completedActions / actions.length) * 100 : 100;
    const ragScore = (greenCount / totalCount) * 100;
    const score = Math.round(ragScore * 0.7 + actionCompletion * 0.3);

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
        completed: lookaheadActivities.filter((a) => a.status === "Completed")
          .length,
        green: lookaheadActivities.filter((a) => a.ragStatus === "Green")
          .length,
        amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber")
          .length,
        red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
        blocked: lookaheadActivities.filter((a) => a.isBlocked).length,
        actionsCompleted: completedActions,
        actionsTotal: actions.length,
      },
      closedBy: req.admin._id,
      notes: notes,
    });

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
      201,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id/cycle-history", protect, async (req, res) => {
  try {
    const CycleHistory = require("../models/CycleHistory");

    const { hasAccess } = await checkProgrammeAccess(req.admin, req.params.id);
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const history = await CycleHistory.find({ programme: req.params.id })
      .sort({ weekNumber: -1 })
      .populate("closedBy", "name email");

    return sendSuccess(res, { history });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id/weekly-control", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id).populate(
      "uploadedBy",
      "name email",
    );

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      req.params.id,
      programme.project?.toString(),
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    // Get weekNumber from query params (optional)
    const requestedWeekNumber = req.query.weekNumber ? parseInt(req.query.weekNumber) : null;

    const Action = require("../models/Action");
    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const today = new Date();

    // Parse date helper
    const parseActivityDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Find programme start date for week calculations
    let earliestDate = null;
    for (const activity of programme.extractedData?.activities || []) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    // Calculate current week number and week date range
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
    }

    // Use requested week or current week
    const targetWeekNumber = requestedWeekNumber || currentWeekNumber;

    // Calculate week date range
    if (earliestDate) {
      weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(earliestDate.getDate() + (targetWeekNumber - 1) * 7);
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 6);
    }

    const actionsByStatus = {
      open: actions.filter((a) => a.status === "Open").length,
      inProgress: actions.filter((a) => a.status === "In Progress").length,
      closed: actions.filter((a) => a.status === "Completed").length,
      overdue: actions.filter(
        (a) =>
          a.dueDate < today &&
          a.status !== "Completed" &&
          a.status !== "Cancelled",
      ).length,
    };

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
        isOverdue:
          action.dueDate < today &&
          action.status !== "Completed" &&
          action.status !== "Cancelled",
      });
    });

    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const ragStatus = calculateRAG(activityObj, today);
      const activityStatus = calculateActivityStatus(
        activityObj,
        ragStatus,
        today,
      );
      return {
        ...activityObj,
        ragStatus,
        activityStatus,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
        linkedActions: actionMap[activityObj.activityId] || [],
      };
    });

    // Filter activities to only those in the target week
    const isActivityInWeek = (activity) => {
      if (!weekStartDate || !weekEndDate) return true; // Show all if no date range
      const actStart = parseActivityDate(activity.startDate);
      const actFinish = parseActivityDate(activity.finishDate);
      if (!actStart) return false;

      // Activity is in week if it starts in this week OR spans this week
      const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
      return startsThisWeek || spansThisWeek;
    };

    const allActivities = activities.filter((a) => a.ragStatus !== "Grey" && isActivityInWeek(a));

    const ragDistribution = {
      green: allActivities.filter((a) => a.ragStatus === "Green").length,
      amber: allActivities.filter((a) => a.ragStatus === "Amber").length,
      red: allActivities.filter((a) => a.ragStatus === "Red").length,
    };

    const blockedRiskActivities = allActivities
      .filter(
        (a) => a.ragStatus === "Red" || a.ragStatus === "Amber" || a.isBlocked,
      )
      .slice(0, 20)
      .map((a) => {
        const linkedAction = a.linkedActions[0];
        return {
          activityId: a.activityId,
          activityName: a.activityName,
          ragStatus: a.ragStatus,
          owner: a.ownerName || "",
          blocker: a.blocker || "",
          linkedAction: linkedAction
            ? {
                actionId: linkedAction.actionId,
                status: linkedAction.isOverdue
                  ? "Overdue"
                  : linkedAction.status,
              }
            : null,
        };
      });

    const blocked = allActivities.filter(
      (a) => a.isBlocked || a.activityStatus === "Blocked",
    ).length;

    const openActions = actionsByStatus.open + actionsByStatus.inProgress;

    const readyToClose =
      allActivities.length > 0 &&
      blocked === 0 &&
      ragDistribution.red === 0 &&
      actionsByStatus.overdue === 0;

    const weeklyPlanPreview = allActivities.slice(0, 20).map((a) => ({
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

    const plannerToDo = allActivities
      .filter(
        (a) =>
          a.isBlocked ||
          a.activityStatus === "Blocked" ||
          a.activityStatus === "At Risk" ||
          a.ragStatus === "Red" ||
          a.ragStatus === "Amber" ||
          (a.linkedActions && a.linkedActions.length > 0),
      )
      .slice(0, 20)
      .map((a) => ({
        activityId: a.activityId,
        activityName: a.activityName,
        ragStatus: a.ragStatus,
        owner: a.ownerName || "",
        todoItem:
          a.isBlocked || a.activityStatus === "Blocked"
            ? "Resolve blocker"
            : a.ragStatus === "Red"
              ? "Address critical issue"
              : a.linkedActions && a.linkedActions.length > 0
                ? `Complete ${a.linkedActions.length} action(s)`
                : "Review status",
        priority: a.ragStatus === "Red" || a.isBlocked ? "High" : "Medium",
        dueDate: a.finishDate,
      }));

    // Format dates for display
    const formatDate = (d) => {
      if (!d) return "";
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    };

    res.json({
      stats: {
        cycleStatus: programme.cycleStatus,
        inLookahead: allActivities.length,
        green: ragDistribution.green,
        blocked: blocked,
        openActions: openActions,
        overdue: actionsByStatus.overdue,
        readyToClose: readyToClose ? "Yes" : "No",
      },
      ragDistribution: {
        green: ragDistribution.green,
        amber: ragDistribution.amber,
        red: ragDistribution.red,
      },
      actionsByStatus: {
        open: actionsByStatus.open,
        inProgress: actionsByStatus.inProgress,
        closed: actionsByStatus.closed,
        overdue: actionsByStatus.overdue,
      },
      blockedRiskActivities: blockedRiskActivities,
      weeklyPlanPreview: weeklyPlanPreview,
      plannerToDo: plannerToDo,
      programme: {
        _id: programme._id,
        name: programme.name,
        lastUpdated: programme.updatedAt,
      },
      weekInfo: {
        weekNumber: targetWeekNumber,
        currentWeekNumber: currentWeekNumber,
        dateRange: weekStartDate && weekEndDate ? `${formatDate(weekStartDate)} - ${formatDate(weekEndDate)}` : "",
        totalActivities: allActivities.length,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

const CYCLE_TRANSITIONS = {
  Uploaded: ["Meeting Open"],
  "Meeting Open": ["Execution"],
  Execution: ["Close-Out Eligible"],
  "Close-Out Eligible": ["Closed"],
  Closed: [],
};

const checkCloseOutEligible = async (programmeId) => {
  const Action = require("../models/Action");
  const programme = await Programme.findById(programmeId);

  if (!programme) return { eligible: false, reason: "Programme not found" };

  const today = new Date();
  const activities = programme.extractedData?.activities || [];

  const greenActivities = activities.filter((a) => {
    const rag = calculateRAG(a, today);
    return rag === "Green";
  });

  if (greenActivities.length === 0) {
    return { eligible: true, reason: "No GREEN activities to check" };
  }

  const actions = await Action.find({ programme: programmeId });

  for (const activity of greenActivities) {
    const activityActions = actions.filter(
      (a) =>
        a.linkedActivity?.activityId === activity.activityId &&
        a.type === "Required" &&
        a.status !== "Completed" &&
        a.status !== "Cancelled",
    );

    if (activityActions.length > 0) {
      return {
        eligible: false,
        reason: `Activity "${activity.activityName}" has ${activityActions.length} open required action(s)`,
        openActions: activityActions.length,
      };
    }
  }

  const overdueActions = actions.filter(
    (a) =>
      a.status !== "Completed" &&
      a.status !== "Cancelled" &&
      new Date(a.dueDate) < today,
  );

  if (overdueActions.length > 0) {
    return {
      eligible: false,
      reason: `${overdueActions.length} overdue action(s) remaining`,
      overdueActions: overdueActions.length,
    };
  }

  const blockedActivities = greenActivities.filter((a) => a.isBlocked);
  if (blockedActivities.length > 0) {
    return {
      eligible: false,
      reason: `${blockedActivities.length} blocked activity/activities`,
      blockedActivities: blockedActivities.length,
    };
  }

  return { eligible: true, reason: "All conditions met" };
};

router.patch("/:id/cycle-status", protect, async (req, res) => {
  try {
    const { cycleStatus, overrideReason } = req.body;

    const errors = validateRequired({ cycleStatus });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const validStatuses = [
      "Uploaded",
      "Meeting Open",
      "Execution",
      "Close-Out Eligible",
      "Closed",
    ];
    if (!validStatuses.includes(cycleStatus)) {
      return sendValidationError(res, [
        {
          field: "cycleStatus",
          message: `Invalid cycle status. Must be one of: ${validStatuses.join(", ")}`,
        },
      ]);
    }

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    if (programme.isLocked) {
      return sendError(
        res,
        "This week is closed and read-only. No changes allowed.",
        403,
      );
    }

    const currentStatus = programme.cycleStatus;
    const allowedTransitions = CYCLE_TRANSITIONS[currentStatus] || [];

    if (!allowedTransitions.includes(cycleStatus)) {
      if (cycleStatus === "Closed" && currentStatus !== "Closed") {
        if (!overrideReason || overrideReason.trim() === "") {
          return sendValidationError(res, [
            {
              field: "overrideReason",
              message: "PM Override requires a reason",
            },
          ]);
        }

        programme.cycleStatus = "Closed";
        programme.closeType = "PM Override";
        programme.overrideReason = overrideReason;
        programme.closedAt = new Date();
        programme.closedBy = req.admin._id;
        programme.isLocked = true;

        // Create CycleHistory record for PM Override
        const CycleHistory = require("../models/CycleHistory");
        const Action = require("../models/Action");

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastCycle = await CycleHistory.findOne({
          programme: req.params.id,
        }).sort({ weekNumber: -1 });
        const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

        // Find programme start date
        const activities = programme.extractedData?.activities || [];
        let earliestStartDate = null;
        for (const act of activities) {
          const actStart = parseDate(act.startDate);
          if (actStart && (!earliestStartDate || actStart < earliestStartDate)) {
            earliestStartDate = actStart;
          }
        }

        // Calculate current week boundaries
        let weekStartDate = today;
        let weekEndDate = new Date(today);
        weekEndDate.setDate(today.getDate() + 6);

        if (earliestStartDate) {
          const msPerDay = 1000 * 60 * 60 * 24;
          const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
          const currentWeekNum = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
          weekStartDate = new Date(earliestStartDate);
          weekStartDate.setDate(earliestStartDate.getDate() + (currentWeekNum - 1) * 7);
          weekEndDate = new Date(weekStartDate);
          weekEndDate.setDate(weekStartDate.getDate() + 6);
        }
        weekEndDate.setHours(23, 59, 59, 999);

        // Get only activities for this specific week
        const weekActivities = activities.filter((a) => {
          const actStart = parseDate(a.startDate);
          const actFinish = parseDate(a.finishDate);
          if (!actStart) return false;
          const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
          const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
          return startsThisWeek || spansThisWeek;
        }).map((a) => ({
          ...a,
          ragStatus: calculateRAG(a, today),
        }));

        const actions = await Action.find({ programme: req.params.id });
        const completedActions = actions.filter((a) => a.status === "Completed").length;

        const greenCount = weekActivities.filter((a) => a.ragStatus === "Green").length;
        const amberCount = weekActivities.filter((a) => a.ragStatus === "Amber").length;
        const redCount = weekActivities.filter((a) => a.ragStatus === "Red").length;
        const totalCount = weekActivities.length || 1;

        const actionCompletion = actions.length > 0 ? (completedActions / actions.length) * 100 : 100;
        const ragScore = (greenCount / totalCount) * 100;
        const score = Math.round(ragScore * 0.7 + actionCompletion * 0.3);

        await CycleHistory.create({
          programme: req.params.id,
          weekNumber: newWeekNumber,
          weekLabel: `Week ${newWeekNumber}`,
          dateRange: {
            startDate: weekStartDate,
            endDate: weekEndDate,
          },
          closeType: "PM Override",
          score: score,
          stats: {
            totalActivities: weekActivities.length,
            completed: weekActivities.filter((a) => a.status === "Completed").length,
            green: greenCount,
            amber: amberCount,
            red: redCount,
            blocked: weekActivities.filter((a) => a.isBlocked).length,
            actionsCompleted: completedActions,
            actionsTotal: actions.length,
          },
          closedBy: req.admin._id,
          notes: overrideReason,
        });

        await programme.save();

        return sendSuccess(
          res,
          {
            cycleStatus: programme.cycleStatus,
            closeType: programme.closeType,
            message: "Week closed with PM Override",
          },
          "Week closed with PM Override",
        );
      }

      return sendError(
        res,
        `Cannot transition from "${currentStatus}" to "${cycleStatus}". Allowed: ${allowedTransitions.join(", ") || "None (week is closed)"}`,
        400,
      );
    }

    if (cycleStatus === "Close-Out Eligible") {
      const eligibility = await checkCloseOutEligible(req.params.id);
      if (!eligibility.eligible) {
        return sendError(
          res,
          `Cannot mark as Close-Out Eligible: ${eligibility.reason}`,
          400,
        );
      }
    }

    if (cycleStatus === "Closed") {
      programme.closeType = "Normal Close";
      programme.closedAt = new Date();
      programme.closedBy = req.admin._id;
      programme.isLocked = true;

      // Create CycleHistory record for governance tracking
      const CycleHistory = require("../models/CycleHistory");
      const Action = require("../models/Action");

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Get last cycle to determine week number
      const lastCycle = await CycleHistory.findOne({
        programme: req.params.id,
      }).sort({ weekNumber: -1 });
      const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

      // Calculate stats from activities - ONLY for current week
      const activities = programme.extractedData?.activities || [];

      // Find programme start date
      let earliestStartDate = null;
      for (const act of activities) {
        const actStart = parseDate(act.startDate);
        if (actStart && (!earliestStartDate || actStart < earliestStartDate)) {
          earliestStartDate = actStart;
        }
      }

      // Calculate current week boundaries
      let weekStartDate = today;
      let weekEndDate = new Date(today);
      weekEndDate.setDate(today.getDate() + 6);

      if (earliestStartDate) {
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysSinceStart = Math.floor((today - earliestStartDate) / msPerDay);
        const currentWeekNum = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
        weekStartDate = new Date(earliestStartDate);
        weekStartDate.setDate(earliestStartDate.getDate() + (currentWeekNum - 1) * 7);
        weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekStartDate.getDate() + 6);
      }
      weekEndDate.setHours(23, 59, 59, 999);

      // Get only activities for this specific week
      const weekActivities = activities.filter((a) => {
        const actStart = parseDate(a.startDate);
        const actFinish = parseDate(a.finishDate);
        if (!actStart) return false;
        const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
        return startsThisWeek || spansThisWeek;
      }).map((a) => ({
        ...a,
        ragStatus: calculateRAG(a, today),
      }));

      const actions = await Action.find({ programme: req.params.id });
      const completedActions = actions.filter((a) => a.status === "Completed").length;

      const greenCount = weekActivities.filter((a) => a.ragStatus === "Green").length;
      const amberCount = weekActivities.filter((a) => a.ragStatus === "Amber").length;
      const redCount = weekActivities.filter((a) => a.ragStatus === "Red").length;
      const totalCount = weekActivities.length || 1;

      const actionCompletion = actions.length > 0 ? (completedActions / actions.length) * 100 : 100;
      const ragScore = (greenCount / totalCount) * 100;
      const score = Math.round(ragScore * 0.7 + actionCompletion * 0.3);

      await CycleHistory.create({
        programme: req.params.id,
        weekNumber: newWeekNumber,
        weekLabel: `Week ${newWeekNumber}`,
        dateRange: {
          startDate: weekStartDate,
          endDate: weekEndDate,
        },
        closeType: "Normal Close",
        score: score,
        stats: {
          totalActivities: weekActivities.length,
          completed: weekActivities.filter((a) => a.status === "Completed").length,
          green: greenCount,
          amber: amberCount,
          red: redCount,
          blocked: weekActivities.filter((a) => a.isBlocked).length,
          actionsCompleted: completedActions,
          actionsTotal: actions.length,
        },
        closedBy: req.admin._id,
        notes: "",
      });
    }

    programme.cycleStatus = cycleStatus;
    await programme.save();

    return sendSuccess(
      res,
      {
        cycleStatus: programme.cycleStatus,
        closeType: programme.closeType || null,
      },
      `Cycle status updated to "${cycleStatus}"`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id/close-eligibility", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(
      req.admin,
      req.params.id,
      programme.project?.toString(),
    );
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    const eligibility = await checkCloseOutEligible(req.params.id);

    return sendSuccess(res, {
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      currentStatus: programme.cycleStatus,
      openActions: eligibility.openActions || 0,
      overdueActions: eligibility.overdueActions || 0,
      blockedActivities: eligibility.blockedActivities || 0,
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/recalculate-rag", protect, adminOnly, async (req, res) => {
  try {
    const today = new Date();
    const programmes = await Programme.find({ status: "processed" });

    let totalUpdated = 0;
    let totalActivities = 0;

    for (const programme of programmes) {
      if (!programme.extractedData?.activities) continue;

      const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

      for (let i = 0; i < programme.extractedData.activities.length; i++) {
        const activity = programme.extractedData.activities[i];

        const newRagStatus = calculateRAG(activity, today);
        const newActivityStatus = calculateActivityStatus(
          activity,
          newRagStatus,
          today,
        );
        const newWeekZone = getWeekZone(activity.startDate, weekZones);

        programme.extractedData.activities[i].ragStatus = newRagStatus;
        programme.extractedData.activities[i].activityStatus =
          newActivityStatus;
        programme.extractedData.activities[i].weekZone = newWeekZone;

        totalActivities++;
      }

      const activities = programme.extractedData.activities;
      const lookaheadActivities = activities.filter(
        (a) => a.ragStatus !== "Grey",
      );

      programme.extractedData.summary = {
        total: activities.length,
        inLookahead: lookaheadActivities.length,
        completed: activities.filter((a) => a.status === "Completed").length,
        inProgress: activities.filter((a) => a.status === "In Progress").length,
        planned: activities.filter(
          (a) => a.status === "Planned" || a.status === "Forecast",
        ).length,
        red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
        amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber")
          .length,
        green: lookaheadActivities.filter((a) => a.ragStatus === "Green")
          .length,
        blocked: lookaheadActivities.filter(
          (a) => a.activityStatus === "Blocked",
        ).length,
        atRisk: lookaheadActivities.filter(
          (a) => a.activityStatus === "At Risk",
        ).length,
        ready: lookaheadActivities.filter((a) => a.activityStatus === "Ready")
          .length,
      };

      programme.weekZones = weekZones;
      // Don't reset lookaheadStartDate - it should stay as the original upload date

      await programme.save();
      totalUpdated++;
    }

    return sendSuccess(
      res,
      {
        programmesUpdated: totalUpdated,
        activitiesRecalculated: totalActivities,
      },
      `Recalculated RAG for ${totalUpdated} programmes (${totalActivities} activities)`,
    );
  } catch (error) {
    console.error("Recalculate RAG error:", error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/recalculate-rag", protect, adminOnly, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id);

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    if (!programme.extractedData?.activities) {
      return sendError(res, "No activities found in programme", 400);
    }

    const today = new Date();
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);

    for (let i = 0; i < programme.extractedData.activities.length; i++) {
      const activity = programme.extractedData.activities[i];

      const newRagStatus = calculateRAG(activity, today);
      const newActivityStatus = calculateActivityStatus(
        activity,
        newRagStatus,
        today,
      );
      const newWeekZone = getWeekZone(activity.startDate, weekZones);

      programme.extractedData.activities[i].ragStatus = newRagStatus;
      programme.extractedData.activities[i].activityStatus = newActivityStatus;
      programme.extractedData.activities[i].weekZone = newWeekZone;
    }

    const activities = programme.extractedData.activities;
    const lookaheadActivities = activities.filter(
      (a) => a.ragStatus !== "Grey",
    );

    programme.extractedData.summary = {
      total: activities.length,
      inLookahead: lookaheadActivities.length,
      completed: activities.filter((a) => a.status === "Completed").length,
      inProgress: activities.filter((a) => a.status === "In Progress").length,
      planned: activities.filter(
        (a) => a.status === "Planned" || a.status === "Forecast",
      ).length,
      red: lookaheadActivities.filter((a) => a.ragStatus === "Red").length,
      amber: lookaheadActivities.filter((a) => a.ragStatus === "Amber").length,
      green: lookaheadActivities.filter((a) => a.ragStatus === "Green").length,
      blocked: lookaheadActivities.filter((a) => a.activityStatus === "Blocked")
        .length,
      atRisk: lookaheadActivities.filter((a) => a.activityStatus === "At Risk")
        .length,
      ready: lookaheadActivities.filter((a) => a.activityStatus === "Ready")
        .length,
    };

    programme.weekZones = weekZones;
    // Don't reset lookaheadStartDate - it should stay as the original upload date

    await programme.save();

    return sendSuccess(
      res,
      {
        programme: {
          _id: programme._id,
          name: programme.name,
          summary: programme.extractedData.summary,
        },
      },
      `Recalculated RAG for ${activities.length} activities`,
    );
  } catch (error) {
    console.error("Recalculate RAG error:", error);
    return sendError(res, "Server error");
  }
});

router.delete("/all", protect, adminOnly, async (req, res) => {
  try {
    const Action = require("../models/Action");
    const CycleHistory = require("../models/CycleHistory");

    const programmes = await Programme.find();

    for (const programme of programmes) {
      if (programme.filePath && fs.existsSync(programme.filePath)) {
        fs.unlinkSync(programme.filePath);
      }
    }

    const deletedActions = await Action.deleteMany({});
    const deletedCycleHistory = await CycleHistory.deleteMany({});
    const deletedProgrammes = await Programme.deleteMany({});

    return sendSuccess(
      res,
      {
        deleted: {
          programmes: deletedProgrammes.deletedCount,
          actions: deletedActions.deletedCount,
          cycleHistory: deletedCycleHistory.deletedCount,
        },
      },
      `Deleted ${deletedProgrammes.deletedCount} programmes, ${deletedActions.deletedCount} actions, and ${deletedCycleHistory.deletedCount} cycle history records`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const Action = require("../models/Action");
    const programme = await Programme.findById(req.params.id);

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    await Action.deleteMany({ programme: req.params.id });

    if (fs.existsSync(programme.filePath)) {
      fs.unlinkSync(programme.filePath);
    }

    await Programme.findByIdAndDelete(req.params.id);

    return sendSuccess(
      res,
      {},
      "Programme and related actions deleted successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Clear all CycleHistory records (for fixing incorrect data)
router.delete("/clear-cycle-history/all", protect, adminOnly, async (req, res) => {
  try {
    const CycleHistory = require("../models/CycleHistory");

    const result = await CycleHistory.deleteMany({});

    // Also unlock all programmes so they can be closed again
    await Programme.updateMany(
      { isLocked: true },
      {
        $set: {
          isLocked: false,
          cycleStatus: "Draft",
          closeType: null,
          closedAt: null,
          closedBy: null
        }
      }
    );

    return sendSuccess(
      res,
      {
        deletedCount: result.deletedCount,
      },
      `Cleared ${result.deletedCount} cycle history records. Programmes unlocked.`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Get programme weeks status (which weeks are closed, current week, etc.)
router.get("/:id/weeks-status", protect, async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(req.admin, req.params.id);
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    // Parse dates helper
    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Calculate total weeks from activities
    const activities = programme.extractedData?.activities || [];
    let earliestDate = null;
    let latestDate = null;

    for (const activity of activities) {
      const startDate = parseDate(activity.startDate);
      const finishDate = parseDate(activity.finishDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
      if (finishDate && (!latestDate || finishDate > latestDate)) {
        latestDate = finishDate;
      }
    }

    let totalWeeks = programme.totalWeeks || 0;
    if (totalWeeks === 0 && earliestDate && latestDate) {
      const msPerDay = 1000 * 60 * 60 * 24;
      const totalDays = Math.ceil((latestDate - earliestDate) / msPerDay);
      totalWeeks = Math.ceil(totalDays / 7);
      // Save totalWeeks to programme
      programme.totalWeeks = totalWeeks;
      await programme.save();
    }

    // Determine current week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentWeekNumber = 1;
    if (earliestDate) {
      earliestDate.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((today - earliestDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

    // Get closed weeks
    const closedWeeks = programme.closedWeeks || [];
    const closedWeekNumbers = closedWeeks.map(w => w.weekNumber);

    // Build weeks array
    const weeks = [];
    for (let i = 1; i <= totalWeeks; i++) {
      const weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(weekStartDate.getDate() + (i - 1) * 7);
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 6);

      // Count activities in this week
      let weekActivities = { total: 0, green: 0, amber: 0, red: 0 };
      for (const activity of activities) {
        const actStart = parseDate(activity.startDate);
        const actFinish = parseDate(activity.finishDate);
        if (!actStart) continue;

        const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
        if (startsThisWeek || spansThisWeek) {
          weekActivities.total++;
          const isCompleted = activity.status === "Completed" ||
            (activity.finishDate && activity.finishDate.includes(" A"));
          if (isCompleted) {
            weekActivities.green++;
          } else if (actFinish && actFinish < today) {
            weekActivities.red++;
          } else {
            weekActivities.amber++;
          }
        }
      }

      const isClosed = closedWeekNumbers.includes(i);
      const closedWeekData = closedWeeks.find(w => w.weekNumber === i);

      let status = "upcoming";
      if (isClosed) {
        status = "closed";
      } else if (i === currentWeekNumber) {
        status = "current";
      } else if (i < currentWeekNumber) {
        status = "past"; // Past but not closed
      }

      // Can close if: current or past week AND not already closed AND previous weeks are closed
      const previousWeeksClosed = closedWeekNumbers.filter(n => n < i).length === i - 1;
      const canClose = !isClosed && i <= currentWeekNumber && previousWeeksClosed;

      weeks.push({
        weekNumber: i,
        startDate: weekStartDate,
        endDate: weekEndDate,
        status,
        isClosed,
        canClose,
        closedAt: closedWeekData?.closedAt || null,
        closeType: closedWeekData?.closeType || null,
        stats: isClosed ? closedWeekData?.stats : weekActivities,
      });
    }

    return sendSuccess(res, {
      totalWeeks,
      currentWeekNumber: Math.min(currentWeekNumber, totalWeeks),
      closedWeeksCount: closedWeeks.length,
      progress: totalWeeks > 0 ? Math.round((closedWeeks.length / totalWeeks) * 100) : 0,
      isFullyClosed: closedWeeks.length >= totalWeeks,
      weeks,
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Close a specific week within a programme
router.post("/:id/close-week/:weekNumber", protect, async (req, res) => {
  try {
    const { closeType, notes } = req.body;
    const weekNumber = parseInt(req.params.weekNumber);
    const CycleHistory = require("../models/CycleHistory");

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const { hasAccess } = await checkProgrammeAccess(req.admin, req.params.id);
    if (!hasAccess) {
      return sendError(res, "Access denied", 403);
    }

    // Check if week is already closed
    const closedWeeks = programme.closedWeeks || [];
    if (closedWeeks.some(w => w.weekNumber === weekNumber)) {
      return sendError(res, `Week ${weekNumber} is already closed`, 400);
    }

    // Check if previous weeks are closed (sequential closure required)
    const closedWeekNumbers = closedWeeks.map(w => w.weekNumber);
    for (let i = 1; i < weekNumber; i++) {
      if (!closedWeekNumbers.includes(i)) {
        return sendError(res, `Cannot close Week ${weekNumber}. Week ${i} must be closed first.`, 400);
      }
    }

    // Parse dates helper
    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
      if (!match) return null;
      const day = parseInt(match[1]);
      const month = months[match[2]];
      let year = parseInt(match[3]);
      year = year < 50 ? 2000 + year : 1900 + year;
      return new Date(year, month, day);
    };

    // Find programme start date
    const activities = programme.extractedData?.activities || [];
    let earliestDate = null;
    let latestDate = null;

    for (const activity of activities) {
      const startDate = parseDate(activity.startDate);
      const finishDate = parseDate(activity.finishDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
      if (finishDate && (!latestDate || finishDate > latestDate)) {
        latestDate = finishDate;
      }
    }

    if (!earliestDate) {
      return sendError(res, "Cannot determine programme start date", 400);
    }

    // Calculate week dates
    const weekStartDate = new Date(earliestDate);
    weekStartDate.setDate(weekStartDate.getDate() + (weekNumber - 1) * 7);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);

    // Calculate stats for this week
    const today = new Date();
    let weekStats = { totalActivities: 0, green: 0, amber: 0, red: 0 };

    for (const activity of activities) {
      const actStart = parseDate(activity.startDate);
      const actFinish = parseDate(activity.finishDate);
      if (!actStart) continue;

      const startsThisWeek = actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek = actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

      if (startsThisWeek || spansThisWeek) {
        weekStats.totalActivities++;
        const isCompleted = activity.status === "Completed" ||
          (activity.finishDate && activity.finishDate.includes(" A"));
        if (isCompleted) {
          weekStats.green++;
        } else if (actFinish && actFinish < today) {
          weekStats.red++;
        } else {
          weekStats.amber++;
        }
      }
    }

    // Add to closedWeeks array
    programme.closedWeeks.push({
      weekNumber,
      closedAt: new Date(),
      closedBy: req.admin._id,
      closeType: closeType || "Normal Close",
      stats: weekStats,
    });

    // Calculate totalWeeks if not set
    if (!programme.totalWeeks && earliestDate && latestDate) {
      const msPerDay = 1000 * 60 * 60 * 24;
      const totalDays = Math.ceil((latestDate - earliestDate) / msPerDay);
      programme.totalWeeks = Math.ceil(totalDays / 7);
    }

    // Check if all weeks are now closed
    const totalWeeks = programme.totalWeeks || 0;
    const isFullyClosed = programme.closedWeeks.length >= totalWeeks;

    if (isFullyClosed) {
      programme.cycleStatus = "Closed";
      programme.isLocked = true;
      programme.closedAt = new Date();
      programme.closedBy = req.admin._id;
      programme.closeType = closeType || "Normal Close";
    }

    await programme.save();

    // Create CycleHistory record for governance tracking
    const formatDateShort = (d) => {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${d.getDate().toString().padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
    };

    await CycleHistory.create({
      programme: req.params.id,
      weekNumber,
      weekLabel: `Week ${weekNumber}`,
      dateRange: {
        startDate: weekStartDate,
        endDate: weekEndDate,
      },
      closeType: closeType || "Normal Close",
      score: weekStats.totalActivities > 0 ? Math.round((weekStats.green / weekStats.totalActivities) * 100) : 0,
      stats: weekStats,
      closedBy: req.admin._id,
      notes: notes || "",
    });

    return sendSuccess(
      res,
      {
        weekNumber,
        closedAt: new Date(),
        closeType: closeType || "Normal Close",
        stats: weekStats,
        progress: totalWeeks > 0 ? Math.round((programme.closedWeeks.length / totalWeeks) * 100) : 0,
        isFullyClosed,
      },
      `Week ${weekNumber} closed successfully`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// Reopen a closed week (admin only)
router.post("/:id/reopen-week/:weekNumber", protect, adminOnly, async (req, res) => {
  try {
    const weekNumber = parseInt(req.params.weekNumber);
    const CycleHistory = require("../models/CycleHistory");

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    // Check if week is closed
    const weekIndex = programme.closedWeeks.findIndex(w => w.weekNumber === weekNumber);
    if (weekIndex === -1) {
      return sendError(res, `Week ${weekNumber} is not closed`, 400);
    }

    // Can only reopen the last closed week
    const maxClosedWeek = Math.max(...programme.closedWeeks.map(w => w.weekNumber));
    if (weekNumber !== maxClosedWeek) {
      return sendError(res, `Can only reopen the last closed week (Week ${maxClosedWeek})`, 400);
    }

    // Remove from closedWeeks
    programme.closedWeeks.splice(weekIndex, 1);

    // Unlock programme if it was fully closed
    if (programme.isLocked) {
      programme.isLocked = false;
      programme.cycleStatus = "Execution";
      programme.closedAt = null;
      programme.closedBy = null;
      programme.closeType = null;
    }

    await programme.save();

    // Remove CycleHistory record
    await CycleHistory.deleteOne({
      programme: req.params.id,
      weekNumber,
    });

    const totalWeeks = programme.totalWeeks || 0;

    return sendSuccess(
      res,
      {
        weekNumber,
        progress: totalWeeks > 0 ? Math.round((programme.closedWeeks.length / totalWeeks) * 100) : 0,
      },
      `Week ${weekNumber} reopened successfully`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
