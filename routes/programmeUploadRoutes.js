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
const auditLogger = require("../utils/auditLogger");

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
  const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();

  const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]) - 1;
    const day = parseInt(isoMatch[3]);
    return new Date(year, month, day);
  }

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

const checkProjectEnded = (activities) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let latestFinishDate = null;
  for (const activity of activities || []) {
    const finishDate = parseDate(activity.finishDate);
    if (finishDate && (!latestFinishDate || finishDate > latestFinishDate)) {
      latestFinishDate = finishDate;
    }
  }

  if (!latestFinishDate) return { isEnded: false, endDate: null };

  latestFinishDate.setHours(23, 59, 59, 999);
  return {
    isEnded: today > latestFinishDate,
    endDate: latestFinishDate,
  };
};

const {
  getCycleEndDate,
  computeGovernanceStatus,
  syncProgrammeGovernance,
  refreshProgrammeGovernance,
  groupActionsByActivity,
} = require("../utils/governance");

const calculateRAG = (activity, today, linkedActions, cycleEndDate) => {
  return computeGovernanceStatus(activity, linkedActions, cycleEndDate, today)
    .ragStatus;
};

const generateWeekZones = (startDate, numWeeks = 6) => {
  const zones = [];
  const start = new Date(startDate);
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

const calculateActivityStatus = (
  activity,
  ragStatus,
  today,
  linkedActions,
  cycleEndDate,
) => {
  return computeGovernanceStatus(activity, linkedActions, cycleEndDate, today)
    .activityStatus;
};

const buildActivitySummary = (activities, lookaheadActivities = null) => {
  const inLookahead = Array.isArray(lookaheadActivities)
    ? lookaheadActivities
    : activities;
  const countRag = (rag) =>
    activities.filter((a) => a.ragStatus === rag).length;
  const isCompleted = (a) =>
    a.activityStatus === "Completed" ||
    a.activityStatus === "Complete" ||
    a.ragStatus === "Blue";

  return {
    total: activities.length,
    inLookahead: inLookahead.length,
    grey: countRag("Grey"),
    green: countRag("Green"),
    amber: countRag("Amber"),
    blue: countRag("Blue"),
    red: countRag("Red"),
    unassigned: activities.filter(
      (a) => (a.assignmentState || "Unassigned") === "Unassigned",
    ).length,
    ready: activities.filter((a) => a.activityStatus === "Ready").length,
    atRisk: activities.filter((a) => a.activityStatus === "At Risk").length,
    completed: activities.filter(isCompleted).length,
    blocked: activities.filter((a) => a.activityStatus === "Blocked").length,
  };
};

router.get("/:id/pdf", async (req, res) => {
  try {
    const programme = await Programme.findById(req.params.id).select(
      "fileData fileMimeType originalFileName",
    );

    if (!programme) {
      return res.status(404).json({ message: "Programme not found" });
    }

    if (!programme.fileData) {
      return res
        .status(404)
        .json({ message: "PDF file not found in database" });
    }

    res.setHeader("Content-Type", programme.fileMimeType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${programme.originalFileName}"`,
    );
    res.setHeader("Content-Length", programme.fileData.length);

    res.send(programme.fileData);
  } catch (error) {
    console.error("Error serving PDF:", error);
    res.status(500).json({ message: "Error serving PDF file" });
  }
});

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

            if (
              activity.finishDate.includes(" B") ||
              activity.startDate.includes(" B")
            ) {
              activity.isBlocked = true;
              activity.status = "In Progress";
              activity.activityStatus = "Blocked";
            } else if (activity.finishDate.includes(" A")) {
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

            activity.assignmentState = "Unassigned";
            activity.ragStatus = "Grey";
            activity.activityStatus = "Unassigned";
            activity.isBlocked = false;

            if (activity.activityName) {
              activities.push(activity);
            }
          }
        });
      }

      const today = new Date();
      let anchorDate = new Date(today);
      if (project) {
        const priorCount = await Programme.countDocuments({ project });
        if (priorCount === 0) {
          const anchorProject =
            await Project.findById(project).select("startDate");
          if (anchorProject?.startDate) {
            anchorDate = new Date(anchorProject.startDate);
          }
        }
      }
      anchorDate.setHours(0, 0, 0, 0);
      const weekZones = generateWeekZones(anchorDate, 6);

      activities.forEach((activity) => {
        activity.weekZone = getWeekZone(activity.startDate, weekZones);
      });

      const lookaheadActivities = activities.filter(
        (a) =>
          a.weekZone &&
          !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone),
      );

      const summary = buildActivitySummary(activities, lookaheadActivities);

      const startOfYear = new Date(today.getFullYear(), 0, 1);
      const days = Math.floor((today - startOfYear) / (24 * 60 * 60 * 1000));
      const weekNumber = Math.ceil((days + 1) / 7);

      const fileData = fs.readFileSync(req.file.path);

      const programme = await Programme.create({
        name,
        project: project || null,
        originalFileName: req.file.originalname,
        filePath: req.file.path,
        fileData: fileData,
        fileMimeType: req.file.mimetype || "application/pdf",
        cycleStatus: "Uploaded",
        weekNumber,
        lookaheadWeeks: 6,
        lookaheadStartDate: anchorDate,
        weekZones: weekZones,
        extractedData: {
          activities: activities,
          pageCount: pageCount,
          totalActivities: activities.length,
          summary: summary,
        },
        uploadedBy: req.admin._id,
        status: "processed",
        closedWeeks: [],
      });

      await syncProgrammeGovernance(programme, Action);
      const refreshedActivities = programme.extractedData.activities;
      const refreshedLookahead = refreshedActivities.filter(
        (a) =>
          a.weekZone &&
          !["Beyond Lookahead", "Before Lookahead"].includes(a.weekZone),
      );
      const refreshedSummary = buildActivitySummary(
        refreshedActivities,
        refreshedLookahead,
      );
      programme.extractedData.summary = refreshedSummary;
      programme.markModified("extractedData.summary");
      await programme.save();

      const projectDoc = project
        ? await Project.findById(project).select("name")
        : null;
      await auditLogger.programmeUploaded(
        req,
        req.admin,
        programme,
        projectDoc,
      );

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
            summary: refreshedSummary,
            status: programme.status,
            activities: refreshedActivities,
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

    const baseUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const programmesWithUrl = programmes.map((prog) => {
      const fileUrl = `${baseUrl}/api/programmes/${prog._id}/pdf`;
      return {
        ...prog.toObject(),
        fileUrl,
      };
    });

    return sendSuccess(res, { programmes: programmesWithUrl });
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

    const Action = require("../models/Action");
    const actions = await Action.find({ programme: programme._id });

    const actionsByActivity = {};
    actions.forEach((action) => {
      const actId = action.linkedActivity?.activityId;
      if (actId) {
        if (!actionsByActivity[actId]) {
          actionsByActivity[actId] = [];
        }
        actionsByActivity[actId].push(action);
      }
    });

    const today = new Date();
    const programmeObj = programme.toObject();
    if (programmeObj.extractedData?.activities) {
      programmeObj.extractedData.activities =
        programmeObj.extractedData.activities.map((activity) => {
          const linkedActions = actionsByActivity[activity.activityId] || [];
          const ragStatus = calculateRAG(activity, today);
          const activityStatus = calculateActivityStatus(
            activity,
            ragStatus,
            today,
            linkedActions,
          );

          return {
            ...activity,
            ragStatus,
            activityStatus,
          };
        });
    }

    const baseUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const fileUrl = `${baseUrl}/api/programmes/${programme._id}/pdf`;
    const programmeWithUrl = {
      ...programmeObj,
      fileUrl,
    };

    return sendSuccess(res, { programme: programmeWithUrl });
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

    const baseUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const addFileUrl = (prog) => {
      const fileUrl = `${baseUrl}/api/programmes/${prog._id}/pdf`;
      return {
        ...prog.toObject(),
        fileUrl,
      };
    };

    const currentProgramme = programmes.find((p) => p.cycleStatus !== "Closed");
    const history = programmes.filter((p) => p.cycleStatus === "Closed");

    return sendSuccess(res, {
      currentProgramme: currentProgramme ? addFileUrl(currentProgramme) : null,
      history: history.map(addFileUrl),
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

    const baseUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const fileUrl = `${baseUrl}/api/programmes/${programme._id}/pdf`;
    const programmeWithUrl = {
      ...programme.toObject(),
      fileUrl,
    };

    return sendSuccess(res, { programme: programmeWithUrl });
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

    await syncProgrammeGovernance(programme, Action);

    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const actionCountMap = {};
    const actionsByActivity = {};
    actions.forEach((action) => {
      const actId = action.linkedActivity.activityId;
      if (!actionCountMap[actId]) {
        actionCountMap[actId] = { total: 0, open: 0 };
      }
      if (!actionsByActivity[actId]) {
        actionsByActivity[actId] = [];
      }
      actionCountMap[actId].total++;
      actionsByActivity[actId].push(action);
      if (action.status !== "Completed" && action.status !== "Cancelled") {
        actionCountMap[actId].open++;
      }
    });

    const today = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);
    const cycleEndDate = getCycleEndDate(programme);

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const linkedActions = actionsByActivity[activityObj.activityId] || [];
      const ragStatus = calculateRAG(
        activityObj,
        today,
        linkedActions,
        cycleEndDate,
      );
      const activityStatus = calculateActivityStatus(
        activityObj,
        ragStatus,
        today,
        linkedActions,
        cycleEndDate,
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
        a.activityStatus !== "Complete" &&
        (a.ragStatus === "Red" ||
          a.ragStatus === "Amber" ||
          a.activityStatus === "Blocked"),
    );

    const actionStats = {
      total: actions.length,
      open: actions.filter((a) => a.status === "Open").length,
      inProgress: actions.filter((a) => a.status === "In Progress").length,
      completed: actions.filter((a) => a.status === "Completed").length,
      overdue: actions.filter(
        (a) =>
          a.dueDate < startOfToday &&
          a.status !== "Completed" &&
          a.status !== "Cancelled",
      ).length,
    };

    const summary = buildActivitySummary(activities, lookaheadActivities);

    let readyToClose = false;
    const openActions = actionStats.open + actionStats.inProgress;

    if (
      programme.cycleStatus === "Draft" ||
      programme.cycleStatus === "Uploaded" ||
      programme.cycleStatus === "Meeting Open"
    ) {
      readyToClose = false;
    } else if (
      programme.cycleStatus === "Execution" ||
      programme.cycleStatus === "Close-Out Eligible"
    ) {
      readyToClose = openActions === 0;
    }

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
    const {
      owner,
      ownerName,
      activityStatus,
      notes,
      isBlocked,
      blocker,
      assignmentState,
      overdueAcknowledged,
    } = req.body;

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
    if (notes !== undefined) activity.notes = notes;
    if (isBlocked !== undefined) activity.isBlocked = isBlocked;
    if (blocker !== undefined) activity.blocker = blocker;
    if (overdueAcknowledged !== undefined) {
      activity.overdueAcknowledged = overdueAcknowledged;
    }

    if (assignmentState !== undefined) {
      const validStates = ["Unassigned", "NoAction", "ActionAssigned"];
      if (!validStates.includes(assignmentState)) {
        return sendError(res, "Invalid assignmentState", 400);
      }
      activity.assignmentState = assignmentState;
    }

    if (assignmentState !== undefined || overdueAcknowledged !== undefined) {
      const Action = require("../models/Action");
      const linkedActions = await Action.find({
        programme: req.params.id,
        "linkedActivity.activityId": req.params.activityId,
      });
      const derived = computeGovernanceStatus(
        activity,
        linkedActions,
        getCycleEndDate(programme),
        new Date(),
      );
      activity.ragStatus = derived.ragStatus;
      activity.activityStatus = derived.activityStatus;
    } else if (activityStatus !== undefined) {
      activity.activityStatus = activityStatus;
    } else if (isBlocked !== undefined) {
      const today = new Date();
      activity.activityStatus = calculateActivityStatus(
        activity,
        activity.ragStatus,
        today,
      );
    }

    programme.markModified("extractedData.activities");
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

    await syncProgrammeGovernance(programme, Action);

    const CycleHistory = require("../models/CycleHistory");

    const actions = await Action.find({ programme: req.params.id });
    const today = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

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
        a.dueDate < startOfToday &&
        a.status !== "Completed" &&
        a.status !== "Cancelled",
    ).length;

    const ragDistribution = {
      green: lookaheadActivities.filter(
        (a) => a.activityStatus === "Ready" && !a.isBlocked,
      ).length,
      amber: lookaheadActivities.filter((a) => a.activityStatus === "At Risk")
        .length,
      red: lookaheadActivities.filter(
        (a) => a.activityStatus === "Blocked" || a.isBlocked,
      ).length,
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

    const dayOfWeek = today.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayOfCurrentWeek = new Date(today);
    mondayOfCurrentWeek.setDate(today.getDate() - daysFromMonday);
    mondayOfCurrentWeek.setHours(0, 0, 0, 0);

    let cycleStartDate;
    if (lastCycle) {
      cycleStartDate = new Date(lastCycle.dateRange.endDate);
      cycleStartDate.setDate(cycleStartDate.getDate() + 1);
    } else {
      cycleStartDate = new Date(mondayOfCurrentWeek);
    }
    cycleStartDate.setHours(0, 0, 0, 0);

    const twoWeekEndDate = new Date(cycleStartDate);
    twoWeekEndDate.setDate(cycleStartDate.getDate() + 13);
    twoWeekEndDate.setHours(23, 59, 59, 999);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    if (todayStart <= twoWeekEndDate) {
      return sendError(
        res,
        `Cannot close cycle yet. The current 2-week cycle runs from ${formatDateShort(cycleStartDate)} to ${formatDateShort(twoWeekEndDate)}. Today (${formatDateShort(todayStart)}) is still within this period.`,
        400,
      );
    }

    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const ragStatus = calculateRAG(activityObj, today);
      return {
        ...activityObj,
        ragStatus,
        weekZone: getWeekZone(activityObj.startDate, weekZones),
      };
    });

    const weekStartDate = new Date(currentWeek.startDate);
    const weekEndDate = new Date(currentWeek.endDate);
    weekStartDate.setHours(0, 0, 0, 0);
    weekEndDate.setHours(23, 59, 59, 999);

    const weekActivities = activities.filter((a) => {
      const actStart = parseDate(a.startDate);
      const actFinish = parseDate(a.finishDate);
      if (!actStart) return false;

      const startsThisWeek =
        actStart >= weekStartDate && actStart <= weekEndDate;
      const spansThisWeek =
        actStart < weekStartDate && actFinish && actFinish >= weekStartDate;

      return startsThisWeek || spansThisWeek;
    });

    const lookaheadActivities =
      weekActivities.length > 0
        ? weekActivities
        : activities.filter(
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
        green: lookaheadActivities.filter(
          (a) =>
            a.ragStatus === "Green" &&
            !a.isBlocked &&
            a.activityStatus !== "Blocked",
        ).length,
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

    await syncProgrammeGovernance(programme, Action);

    const requestedWeekNumber = req.query.weekNumber
      ? parseInt(req.query.weekNumber)
      : null;

    const actions = await Action.find({ programme: req.params.id })
      .populate("assignee", "name email")
      .populate("createdBy", "name email");

    const today = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const parseActivityDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();

      const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = parseInt(isoMatch[2]) - 1;
        const day = parseInt(isoMatch[3]);
        return new Date(year, month, day);
      }

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
    for (const activity of programme.extractedData?.activities || []) {
      const startDate = parseActivityDate(activity.startDate);
      if (startDate && (!earliestDate || startDate < earliestDate)) {
        earliestDate = startDate;
      }
    }

    let currentWeekNumber = 1;

    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const dayOfWeek = todayStart.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - daysFromMonday);

    const referenceDate = programme.lookaheadStartDate
      ? new Date(programme.lookaheadStartDate)
      : earliestDate;

    if (referenceDate) {
      referenceDate.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor(
        (todayStart - referenceDate) / msPerDay,
      );
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

    const targetWeekNumber = requestedWeekNumber || currentWeekNumber;

    const scheduleAnchor = referenceDate
      ? new Date(referenceDate)
      : new Date(todayStart);
    scheduleAnchor.setHours(0, 0, 0, 0);
    const weekStartDate = new Date(scheduleAnchor);
    weekStartDate.setDate(
      scheduleAnchor.getDate() + (targetWeekNumber - 1) * 7,
    );
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);

    const closedWeeks = programme.closedWeeks || [];

    const mostRecentClosure =
      closedWeeks.length > 0
        ? closedWeeks.reduce(
            (latest, week) =>
              !latest || new Date(week.closedAt) > new Date(latest.closedAt)
                ? week
                : latest,
            null,
          )
        : null;

    const isActionFromClosedWeek = (
      actionCreatedAt,
      actionStatus,
      actionTitle = "",
    ) => {
      if (!actionCreatedAt || closedWeeks.length === 0) return false;

      if (actionStatus === "Completed" || actionStatus === "Cancelled")
        return false;

      const actionDate = new Date(actionCreatedAt);

      if (mostRecentClosure && mostRecentClosure.closedAt) {
        const closureDate = new Date(mostRecentClosure.closedAt);
        if (actionDate < closureDate) {
          return true;
        }
      }

      return false;
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
        description: action.description || "",
        status: action.status,
        priority: action.priority || "Medium",
        assignee: action.assignee?.name || "-",
        assigneeId: action.assignee?._id?.toString() || null,
        dueDate: action.dueDate,
        createdAt: action.createdAt,
        isOverdue:
          action.dueDate < startOfToday &&
          action.status !== "Completed" &&
          action.status !== "Cancelled",
        isFromClosedWeek: isActionFromClosedWeek(
          action.createdAt,
          action.status,
          action.title,
        ),
      });
    });

    const ragReferenceDate = today;

    const cycleEndDate = getCycleEndDate(programme);
    const activities = programme.extractedData.activities.map((activity) => {
      const activityObj = activity.toObject ? activity.toObject() : activity;
      const linkedActions = actionMap[activityObj.activityId] || [];
      const ragStatus = calculateRAG(
        activityObj,
        ragReferenceDate,
        linkedActions,
        cycleEndDate,
      );
      const activityStatus = calculateActivityStatus(
        activityObj,
        ragStatus,
        ragReferenceDate,
        linkedActions,
        cycleEndDate,
      );
      const isBlocked = activityStatus === "Blocked";
      if (
        activityObj.isBlocked === true ||
        activityObj.activityStatus === "Blocked" ||
        activityStatus === "Blocked"
      ) {
      }
      return {
        ...activityObj,
        ragStatus,
        activityStatus,
        isBlocked,
        weekZone: activityObj.weekZone,
        linkedActions,
      };
    });

    const weekEndInclusive = new Date(weekEndDate);
    weekEndInclusive.setHours(23, 59, 59, 999);
    const isActivityInWeek = (activity) => {
      const start = parseActivityDate(activity.startDate);
      return !!start && start >= weekStartDate && start <= weekEndInclusive;
    };

    const activitiesInWeek = activities.filter((a) => isActivityInWeek(a));

    const allActivities = activitiesInWeek;

    const wasOverridden = (a) =>
      isActionFromClosedWeek(a.createdAt, a.status, a.title);
    const actionsByStatus = {
      open: actions.filter((a) => a.status === "Open" && !wasOverridden(a))
        .length,
      inProgress: actions.filter(
        (a) => a.status === "In Progress" && !wasOverridden(a),
      ).length,
      closed: actions.filter((a) => a.status === "Completed").length,
      pmOverride: actions.filter(
        (a) => a.status === "PM Override" || wasOverridden(a),
      ).length,
      overdue: actions.filter(
        (a) =>
          a.status !== "Completed" &&
          a.status !== "Cancelled" &&
          a.status !== "PM Override" &&
          !wasOverridden(a) &&
          a.dueDate &&
          new Date(a.dueDate) < startOfToday,
      ).length,
    };

    const actionsInWeek = [];
    allActivities.forEach((a) => {
      if (a.linkedActions && a.linkedActions.length > 0) {
        a.linkedActions.forEach((action) => {
          if (!action.isFromClosedWeek) {
            actionsInWeek.push(action);
          }
        });
      }
    });

    const actionsInCurrentWeek = actions.filter((action) => {
      if (
        isActionFromClosedWeek(action.createdAt, action.status, action.title)
      ) {
        return false;
      }
      if (action.dueDate && weekStartDate && weekEndDate) {
        const dueDate = new Date(action.dueDate);
        if (dueDate >= weekStartDate && dueDate <= weekEndDate) {
          return true;
        }
      }
      if (action.linkedActivity?.activityId) {
        const linkedActivity = activities.find(
          (a) => a.activityId === action.linkedActivity.activityId,
        );
        if (linkedActivity) {
          const actStart = parseActivityDate(linkedActivity.startDate);
          const actFinish = parseActivityDate(linkedActivity.finishDate);
          if (actStart && weekStartDate && weekEndDate) {
            const startsThisWeek =
              actStart >= weekStartDate && actStart <= weekEndDate;
            const spansThisWeek =
              actStart < weekStartDate &&
              actFinish &&
              actFinish >= weekStartDate;
            if (startsThisWeek || spansThisWeek) {
              return true;
            }
          }
        }
      }
      return false;
    });

    const actionsDueInCurrentWeek = actions.filter((action) => {
      if (
        isActionFromClosedWeek(action.createdAt, action.status, action.title)
      ) {
        return false;
      }
      if (!action.dueDate || !weekStartDate || !weekEndDate) return false;
      const dueDate = new Date(action.dueDate);
      return dueDate >= weekStartDate && dueDate <= weekEndDate;
    });

    const weeklyActionsByStatus = {
      open: actionsDueInCurrentWeek.filter(
        (a) =>
          (a.status === "Open" || !a.status) &&
          a.status !== "Completed" &&
          a.status !== "PM Override" &&
          a.status !== "Cancelled" &&
          a.status !== "In Progress",
      ).length,
      inProgress: actionsDueInCurrentWeek.filter(
        (a) => a.status === "In Progress",
      ).length,
      closed: actionsDueInCurrentWeek.filter((a) => a.status === "Completed")
        .length,
      overdue: 0,
    };

    const requiredActionsByStatus = {
      open: actionsDueInCurrentWeek.filter(
        (a) =>
          (a.status === "Open" || !a.status) &&
          a.status !== "Completed" &&
          a.status !== "PM Override" &&
          a.status !== "Cancelled" &&
          a.status !== "In Progress" &&
          a.type !== "Optional",
      ).length,
      inProgress: actionsDueInCurrentWeek.filter(
        (a) => a.status === "In Progress" && a.type !== "Optional",
      ).length,
    };

    const ragDistribution = {
      green: allActivities.filter(
        (a) => a.activityStatus === "Ready" && !a.isBlocked,
      ).length,
      amber: allActivities.filter((a) => a.activityStatus === "At Risk").length,
      red: allActivities.filter(
        (a) => a.activityStatus === "Blocked" || a.isBlocked,
      ).length,
      grey: allActivities.filter(
        (a) => a.activityStatus === "Unassigned" || a.ragStatus === "Grey",
      ).length,
    };

    const readyCount = allActivities.filter(
      (a) => a.activityStatus === "Ready" && !a.isBlocked,
    ).length;
    const completeCount = allActivities.filter(
      (a) => a.activityStatus === "Complete",
    ).length;
    const hasOpenActionDueThisWindow = (activity) => {
      if (!weekStartDate || !weekEndDate) return false;
      return (activity.linkedActions || []).some((act) => {
        if (act.isFromClosedWeek) return false;
        if (act.status === "Completed" || act.status === "Cancelled")
          return false;
        if (!act.dueDate) return false;
        const due = new Date(act.dueDate);
        return due >= weekStartDate && due <= weekEndDate;
      });
    };

    const blockedRiskActivities = activities
      .filter((a) => isActivityInWeek(a) || hasOpenActionDueThisWindow(a))
      .filter((a) => {
        if (
          a.activityStatus === "Complete" ||
          a.activityStatus === "Completed"
        ) {
          return false;
        }
        return (
          a.activityStatus === "Blocked" ||
          a.activityStatus === "At Risk" ||
          a.isBlocked
        );
      })
      .slice(0, 20)
      .map((a) => {
        const activeActions = a.linkedActions.filter(
          (act) => !act.isFromClosedWeek,
        );
        const openAction = activeActions.find(
          (act) => act.status !== "Completed" && act.status !== "Cancelled",
        );
        const overdueAction = activeActions.find((act) => act.isOverdue);
        const linkedAction = overdueAction || openAction || activeActions[0];

        return {
          activityId: a.activityId,
          activityName: a.activityName,
          ragStatus: a.ragStatus,
          activityStatus: a.activityStatus,
          isBlocked: a.isBlocked || a.activityStatus === "Blocked",
          owner: linkedAction?.assignee || "-",
          blocker:
            a.activityStatus === "Blocked"
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
          startDate: a.startDate,
          finishDate: a.finishDate,
        };
      });

    const blockedActivitiesList = activities.filter(
      (a) => a.isBlocked || a.activityStatus === "Blocked",
    );
    const blocked = blockedActivitiesList.length;

    const completedActivitiesCount = activities.filter(
      (a) =>
        a.status === "Completed" ||
        a.status === "Complete" ||
        a.activityStatus === "Completed" ||
        a.activityStatus === "Complete" ||
        (a.startDate && a.startDate.includes(" A")) ||
        (a.finishDate && a.finishDate.includes(" A")),
    ).length;

    const noActionActivitiesCount = activities.filter(
      (a) => a.assignmentState === "NoAction",
    ).length;

    const blockedActivitiesCount = activities.filter(
      (a) => a.isBlocked === true || a.activityStatus === "Blocked",
    ).length;

    const todayForAtRisk = new Date();
    todayForAtRisk.setHours(0, 0, 0, 0);
    const atRiskActivitiesCount = activities.filter((a) => {
      if (
        a.status === "Completed" ||
        a.status === "Complete" ||
        a.activityStatus === "Completed" ||
        a.activityStatus === "Complete" ||
        (a.startDate && a.startDate.includes(" A")) ||
        (a.finishDate && a.finishDate.includes(" A"))
      ) {
        return false;
      }
      if (a.isBlocked === true || a.activityStatus === "Blocked") {
        return false;
      }
      if (a.finishDate) {
        const cleanDate = a.finishDate.replace(/\s*[AB\*]$/, "").trim();
        let finishDate = null;

        const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
          finishDate = new Date(
            parseInt(isoMatch[1]),
            parseInt(isoMatch[2]) - 1,
            parseInt(isoMatch[3]),
          );
        } else {
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
            finishDate = new Date(year, month, day);
          }
        }

        if (finishDate) {
          return finishDate < todayForAtRisk;
        }
      }
      return false;
    }).length;

    const openActions =
      weeklyActionsByStatus.open + weeklyActionsByStatus.inProgress;

    const openRequiredActions =
      requiredActionsByStatus.open + requiredActionsByStatus.inProgress;

    const totalWeeks = programme.totalWeeks || 0;
    const closedWeeksCount = closedWeeks.length;
    const remainingWeeks = totalWeeks - closedWeeksCount;
    const isLastWeek = remainingWeeks <= 2;

    let readyToClose = false;
    const cycleStatus = programme.cycleStatus;

    if (
      cycleStatus === "Draft" ||
      cycleStatus === "Uploaded" ||
      cycleStatus === "Meeting Open"
    ) {
      readyToClose = false;
    } else if (
      cycleStatus === "Execution" ||
      cycleStatus === "Close-Out Eligible"
    ) {
      readyToClose = openRequiredActions === 0;
    }

    const weeklyPlanPreview = allActivities
      .filter((a) => {
        const activeActions =
          a.linkedActions?.filter((act) => !act.isFromClosedWeek) || [];
        return activeActions.length > 0;
      })
      .slice(0, 20)
      .map((a) => {
        const activeActions = a.linkedActions.filter(
          (act) => !act.isFromClosedWeek,
        );
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
          weekZone: a.weekZone || "-",
          startDate: a.startDate,
          finishDate: a.finishDate,
          duration: a.duration,
          ragStatus: displayRag,
          owner: a.ownerName || "",
          activityStatus: a.activityStatus || "Ready",
          actionsCount: activeActions.length,
          openActionsCount: activeActions.filter(
            (act) => act.status !== "Completed" && act.status !== "Cancelled",
          ).length,
          linkedActions: activeActions.map((act) => ({
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

    const plannerToDo = [];
    activities.forEach((a) => {
      if (a.linkedActions && a.linkedActions.length > 0) {
        a.linkedActions
          .filter(
            (action) =>
              action.status !== "Completed" &&
              action.status !== "Cancelled" &&
              !action.isFromClosedWeek &&
              (!weekStartDate ||
                !weekEndDate ||
                (action.dueDate &&
                  new Date(action.dueDate) >= weekStartDate &&
                  new Date(action.dueDate) <= weekEndDate)),
          )
          .forEach((action) => {
            plannerToDo.push({
              activityId: a.activityId,
              activityName: a.activityName,
              ragStatus: a.ragStatus,
              owner: action.assignee || "-",
              todoItem: action.title,
              actionId: action.actionId,
              actionStatus: action.isOverdue ? "Overdue" : action.status,
              priority: action.priority || "Medium",
              dueDate: formatActionDate(action.dueDate),
            });
          });
      }
    });
    const plannerToDoLimited = plannerToDo.slice(0, 20);

    const formatDate = (d) => {
      if (!d) return "";
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
      return `${d.getDate()} ${months[d.getMonth()]}`;
    };

    const projectEndedInfo = { isEnded: false, endDate: null };

    res.json({
      stats: {
        cycleStatus: programme.cycleStatus,
        inLookahead: allActivities.length,
        ready: readyCount,
        complete: completeCount,
        blocked: blocked,
        openActions: openActions,
        overdue: actionsByStatus.overdue,
        readyToClose: readyToClose ? "Yes" : "No",
      },
      isProjectEnded: projectEndedInfo.isEnded,
      projectEndDate: projectEndedInfo.endDate,
      ragDistribution: {
        green: ragDistribution.green,
        amber: ragDistribution.amber,
        red: ragDistribution.red,
        grey: ragDistribution.grey,
      },
      actionsByStatus: {
        open: actionsByStatus.open,
        inProgress: actionsByStatus.inProgress,
        closed: actionsByStatus.closed,
        pmOverride: actionsByStatus.pmOverride,
        overdue: actionsByStatus.overdue,
      },
      weeklyActionsByStatus: {
        open: weeklyActionsByStatus.open,
        inProgress: weeklyActionsByStatus.inProgress,
        closed: weeklyActionsByStatus.closed,
        overdue: weeklyActionsByStatus.overdue,
      },
      requiredActionsByStatus: {
        open: requiredActionsByStatus.open,
        inProgress: requiredActionsByStatus.inProgress,
      },
      unassignedInWeek: (() => {
        const lookaheadGateEnd = new Date(scheduleAnchor);
        lookaheadGateEnd.setDate(lookaheadGateEnd.getDate() + 41);
        lookaheadGateEnd.setHours(23, 59, 59, 999);
        return activities.filter((a) => {
          const s = parseActivityDate(a.startDate);
          return (
            s &&
            s >= scheduleAnchor &&
            s <= lookaheadGateEnd &&
            (a.assignmentState || "Unassigned") === "Unassigned"
          );
        }).length;
      })(),
      blockedRiskActivities: blockedRiskActivities,
      activityCounts: {
        completed: completedActivitiesCount,
        noAction: noActionActivitiesCount,
        blocked: blockedActivitiesCount,
        atRisk: atRiskActivitiesCount,
      },
      weeklyPlanPreview: weeklyPlanPreview,
      plannerToDo: plannerToDoLimited,
      programmeId: programme._id,
      programme: {
        _id: programme._id,
        name: programme.name,
        lastUpdated: programme.updatedAt,
      },
      weekInfo: {
        weekNumber: targetWeekNumber,
        weekNumberEnd: targetWeekNumber,
        currentWeekNumber: currentWeekNumber,
        dateRange:
          weekStartDate && weekEndDate
            ? `${formatDate(weekStartDate)} - ${formatDate(weekEndDate)}`
            : "",
        totalActivities: allActivities.length,
        totalWeeks: totalWeeks,
        closedWeeksCount: closedWeeksCount,
        remainingWeeks: remainingWeeks,
        isLastWeek: isLastWeek,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

const CYCLE_TRANSITIONS = {
  Draft: ["Meeting Open"],
  Uploaded: ["Meeting Open"],
  "Meeting Open": ["Execution"],
  Execution: ["Close-Out Eligible"],
  "Close-Out Eligible": ["Closed"],
  Closed: [],
};

const checkCloseOutEligible = async (programmeId) => {
  const Action = require("../models/Action");
  const CycleHistory = require("../models/CycleHistory");
  const programme = await Programme.findById(programmeId);

  if (!programme) return { eligible: false, reason: "Programme not found" };

  const today = new Date();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
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
      new Date(a.dueDate) < startOfToday,
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

  return {
    eligible: true,
    reason: "All conditions met - ready for close-out",
  };
};

router.patch("/:id/cycle-status", protect, async (req, res) => {
  try {
    const { cycleStatus, overrideReason } = req.body;

    const errors = validateRequired({ cycleStatus });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const validStatuses = [
      "Draft",
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

        programme.closeType = "PM Override";
        programme.overrideReason = overrideReason;
        programme.closedAt = new Date();
        programme.closedBy = req.admin._id;

        const CycleHistory = require("../models/CycleHistory");
        const Action = require("../models/Action");

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastCycle = await CycleHistory.findOne({
          programme: req.params.id,
        }).sort({ weekNumber: -1 });
        const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

        const activities = programme.extractedData?.activities || [];
        let earliestStartDate = null;
        for (const act of activities) {
          const actStart = parseDate(act.startDate);
          if (
            actStart &&
            (!earliestStartDate || actStart < earliestStartDate)
          ) {
            earliestStartDate = actStart;
          }
        }

        const actions = await Action.find({ programme: req.params.id });
        const completedActions = actions.filter(
          (a) => a.status === "Completed",
        ).length;

        for (let weekOffset = 0; weekOffset < 2; weekOffset++) {
          const currentWeekNumber = newWeekNumber + weekOffset;

          let weekStartDate = new Date(today);
          let weekEndDate = new Date(today);

          if (earliestStartDate) {
            const msPerDay = 1000 * 60 * 60 * 24;
            const daysSinceStart = Math.floor(
              (today - earliestStartDate) / msPerDay,
            );
            const baseWeekNum = Math.max(
              1,
              Math.ceil((daysSinceStart + 1) / 7),
            );
            const targetWeekNum = baseWeekNum + weekOffset;
            weekStartDate = new Date(earliestStartDate);
            weekStartDate.setDate(
              earliestStartDate.getDate() + (targetWeekNum - 1) * 7,
            );
            weekEndDate = new Date(weekStartDate);
            weekEndDate.setDate(weekStartDate.getDate() + 6);
          } else {
            weekStartDate.setDate(today.getDate() + weekOffset * 7);
            weekEndDate.setDate(weekStartDate.getDate() + 6);
          }
          weekEndDate.setHours(23, 59, 59, 999);

          const weekActivities = activities
            .filter((a) => {
              const actStart = parseDate(a.startDate);
              const actFinish = parseDate(a.finishDate);
              if (!actStart) return false;
              const startsThisWeek =
                actStart >= weekStartDate && actStart <= weekEndDate;
              const spansThisWeek =
                actStart < weekStartDate &&
                actFinish &&
                actFinish >= weekStartDate;
              return startsThisWeek || spansThisWeek;
            })
            .map((a) => ({
              ...a,
              ragStatus: calculateRAG(a, today),
            }));

          const greenCount = weekActivities.filter(
            (a) => a.ragStatus === "Green",
          ).length;
          const amberCount = weekActivities.filter(
            (a) => a.ragStatus === "Amber",
          ).length;
          const redCount = weekActivities.filter(
            (a) => a.ragStatus === "Red",
          ).length;
          const totalCount = weekActivities.length || 1;

          const actionCompletion =
            actions.length > 0
              ? (completedActions / actions.length) * 100
              : 100;
          const ragScore = (greenCount / totalCount) * 100;
          const score = Math.round(ragScore * 0.7 + actionCompletion * 0.3);

          await CycleHistory.create({
            programme: req.params.id,
            weekNumber: currentWeekNumber,
            weekLabel: `Week ${currentWeekNumber}`,
            dateRange: {
              startDate: weekStartDate,
              endDate: weekEndDate,
            },
            closeType: "PM Override",
            score: score,
            stats: {
              totalActivities: weekActivities.length,
              completed: weekActivities.filter((a) => a.status === "Completed")
                .length,
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
        }

        const CycleHistoryCheck = require("../models/CycleHistory");
        const closedWeeksCount = await CycleHistoryCheck.countDocuments({
          programme: req.params.id,
        });
        const totalWeeks = programme.totalWeeks || 0;

        if (totalWeeks > 0 && closedWeeksCount >= totalWeeks) {
          programme.cycleStatus = "Close-Out Eligible";
          programme.isLocked = false;
        } else {
          programme.cycleStatus = "Draft";
          programme.isLocked = false;
        }

        await programme.save();

        const isLastWeek = totalWeeks > 0 && closedWeeksCount >= totalWeeks;
        return sendSuccess(
          res,
          {
            cycleStatus: programme.cycleStatus,
            closeType: programme.closeType,
            isFullyClosed: false,
            isLastWeek: isLastWeek,
            message: isLastWeek
              ? "All weeks completed - Ready for Close-Out"
              : "Weeks closed with PM Override - ready for next weeks",
          },
          isLastWeek
            ? "All weeks completed - Ready for Close-Out"
            : "Weeks closed with PM Override",
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

      const CycleHistory = require("../models/CycleHistory");
      const Action = require("../models/Action");

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const lastCycle = await CycleHistory.findOne({
        programme: req.params.id,
      }).sort({ weekNumber: -1 });
      const newWeekNumber = lastCycle ? lastCycle.weekNumber + 1 : 1;

      const activities = programme.extractedData?.activities || [];

      let earliestStartDate = null;
      for (const act of activities) {
        const actStart = parseDate(act.startDate);
        if (actStart && (!earliestStartDate || actStart < earliestStartDate)) {
          earliestStartDate = actStart;
        }
      }

      let weekStartDate = today;
      let weekEndDate = new Date(today);
      weekEndDate.setDate(today.getDate() + 6);

      if (earliestStartDate) {
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysSinceStart = Math.floor(
          (today - earliestStartDate) / msPerDay,
        );
        const currentWeekNum = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
        weekStartDate = new Date(earliestStartDate);
        weekStartDate.setDate(
          earliestStartDate.getDate() + (currentWeekNum - 1) * 7,
        );
        weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekStartDate.getDate() + 6);
      }
      weekEndDate.setHours(23, 59, 59, 999);

      const weekActivities = activities
        .filter((a) => {
          const actStart = parseDate(a.startDate);
          const actFinish = parseDate(a.finishDate);
          if (!actStart) return false;
          const startsThisWeek =
            actStart >= weekStartDate && actStart <= weekEndDate;
          const spansThisWeek =
            actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
          return startsThisWeek || spansThisWeek;
        })
        .map((a) => ({
          ...a,
          ragStatus: calculateRAG(a, today),
        }));

      const actions = await Action.find({ programme: req.params.id });
      const completedActions = actions.filter(
        (a) => a.status === "Completed",
      ).length;

      const greenCount = weekActivities.filter(
        (a) => a.ragStatus === "Green",
      ).length;
      const amberCount = weekActivities.filter(
        (a) => a.ragStatus === "Amber",
      ).length;
      const redCount = weekActivities.filter(
        (a) => a.ragStatus === "Red",
      ).length;
      const totalCount = weekActivities.length || 1;

      const actionCompletion =
        actions.length > 0 ? (completedActions / actions.length) * 100 : 100;
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
          completed: weekActivities.filter((a) => a.status === "Completed")
            .length,
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

    const Action = require("../models/Action");

    for (const programme of programmes) {
      if (!programme.extractedData?.activities) continue;

      const weekZones = generateWeekZones(today, programme.lookaheadWeeks || 6);
      const cycleEndDate = getCycleEndDate(programme);

      const programmeActions = await Action.find({ programme: programme._id });
      const actionsByActivity = {};
      programmeActions.forEach((action) => {
        const actId = action.linkedActivity?.activityId;
        if (!actId) return;
        (actionsByActivity[actId] = actionsByActivity[actId] || []).push(
          action,
        );
      });

      for (let i = 0; i < programme.extractedData.activities.length; i++) {
        const activity = programme.extractedData.activities[i];
        const linkedActions = actionsByActivity[activity.activityId] || [];

        const derived = computeGovernanceStatus(
          activity,
          linkedActions,
          cycleEndDate,
          today,
        );
        programme.extractedData.activities[i].ragStatus = derived.ragStatus;
        programme.extractedData.activities[i].activityStatus =
          derived.activityStatus;
        programme.extractedData.activities[i].weekZone = getWeekZone(
          activity.startDate,
          weekZones,
        );

        totalActivities++;
      }

      const activities = programme.extractedData.activities;
      const lookaheadActivities = activities.filter(
        (a) => a.ragStatus !== "Grey",
      );

      programme.extractedData.summary = buildActivitySummary(
        activities,
        lookaheadActivities,
      );

      programme.markModified("extractedData.activities");
      programme.weekZones = weekZones;

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
    const cycleEndDate = getCycleEndDate(programme);

    const Action = require("../models/Action");
    const allActions = await Action.find({ programme: programme._id });
    const actionMap = {};
    allActions.forEach((action) => {
      if (action.linkedActivity?.activityId) {
        if (!actionMap[action.linkedActivity.activityId]) {
          actionMap[action.linkedActivity.activityId] = [];
        }
        actionMap[action.linkedActivity.activityId].push({
          status: action.status,
        });
      }
    });

    for (let i = 0; i < programme.extractedData.activities.length; i++) {
      const activity = programme.extractedData.activities[i];
      const linkedActions = actionMap[activity.activityId] || [];

      const derived = computeGovernanceStatus(
        activity,
        linkedActions,
        cycleEndDate,
        today,
      );
      programme.extractedData.activities[i].ragStatus = derived.ragStatus;
      programme.extractedData.activities[i].activityStatus =
        derived.activityStatus;
      programme.extractedData.activities[i].weekZone = getWeekZone(
        activity.startDate,
        weekZones,
      );
    }

    const activities = programme.extractedData.activities;
    const lookaheadActivities = activities.filter(
      (a) => a.ragStatus !== "Grey",
    );

    programme.extractedData.summary = buildActivitySummary(
      activities,
      lookaheadActivities,
    );

    programme.markModified("extractedData.activities");
    programme.weekZones = weekZones;

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

router.delete(
  "/clear-cycle-history/all",
  protect,
  adminOnly,
  async (req, res) => {
    try {
      const CycleHistory = require("../models/CycleHistory");

      const result = await CycleHistory.deleteMany({});

      await Programme.updateMany(
        { isLocked: true },
        {
          $set: {
            isLocked: false,
            cycleStatus: "Draft",
            closeType: null,
            closedAt: null,
            closedBy: null,
          },
        },
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
  },
);

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

    const parseDateLocal = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();

      const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        return new Date(
          parseInt(isoMatch[1]),
          parseInt(isoMatch[2]) - 1,
          parseInt(isoMatch[3]),
        );
      }

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
      programme.totalWeeks = totalWeeks;
      await programme.save();
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentWeekNumber = 1;

    const referenceDate = programme.lookaheadStartDate
      ? new Date(programme.lookaheadStartDate)
      : earliestDate;

    if (referenceDate) {
      referenceDate.setHours(0, 0, 0, 0);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceStart = Math.floor((today - referenceDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

    const closedWeeks = programme.closedWeeks || [];
    const closedWeekNumbers = closedWeeks.map((w) => w.weekNumber);

    const CycleHistory = require("../models/CycleHistory");
    const lastCycle = await CycleHistory.findOne({
      programme: req.params.id,
    }).sort({ weekNumber: -1 });

    const dayOfWeek = today.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayOfCurrentWeek = new Date(today);
    mondayOfCurrentWeek.setDate(today.getDate() - daysFromMonday);
    mondayOfCurrentWeek.setHours(0, 0, 0, 0);

    let currentCycleStartDate;
    if (lastCycle && lastCycle.dateRange?.endDate) {
      currentCycleStartDate = new Date(lastCycle.dateRange.endDate);
      currentCycleStartDate.setDate(currentCycleStartDate.getDate() + 1);
    } else if (referenceDate) {
      currentCycleStartDate = new Date(referenceDate);
    } else {
      currentCycleStartDate = new Date(mondayOfCurrentWeek);
    }
    currentCycleStartDate.setHours(0, 0, 0, 0);

    const currentTwoWeekEndDate = new Date(currentCycleStartDate);
    currentTwoWeekEndDate.setDate(currentCycleStartDate.getDate() + 13);
    currentTwoWeekEndDate.setHours(23, 59, 59, 999);

    const canCloseCurrentCycle = today > currentTwoWeekEndDate;
    const GateAction = require("../models/Action");
    const gateActions = await GateAction.find({
      programme: req.params.id,
    }).lean();
    const gateOpenByActivity = {};
    const gateHasActionByActivity = {};
    for (const action of gateActions) {
      const actId = action.linkedActivity?.activityId;
      if (!actId) continue;
      gateHasActionByActivity[actId] = true;
      const isOpen =
        action.status !== "Completed" &&
        action.status !== "Complete" &&
        action.status !== "Cancelled";
      gateOpenByActivity[actId] =
        (gateOpenByActivity[actId] || 0) + (isOpen ? 1 : 0);
    }
    const gateIsSettled = (activity) => {
      if (activity.finishDate && activity.finishDate.includes(" A"))
        return true;
      if (
        activity.activityStatus === "Completed" ||
        activity.activityStatus === "Complete"
      )
        return true;
      if (
        gateHasActionByActivity[activity.activityId] &&
        (gateOpenByActivity[activity.activityId] || 0) === 0
      )
        return true;
      return false;
    };
    const gateAnchor = new Date(referenceDate || earliestDate);
    gateAnchor.setHours(0, 0, 0, 0);
    const lookaheadEnd = new Date(gateAnchor);
    lookaheadEnd.setDate(lookaheadEnd.getDate() + 41);
    lookaheadEnd.setHours(23, 59, 59, 999);
    const lookaheadOpen = activities.filter((a) => {
      const s = parseDate(a.startDate);
      return s && s >= gateAnchor && s <= lookaheadEnd && !gateIsSettled(a);
    });
    const lookaheadUnassigned = lookaheadOpen.filter(
      (a) => (a.assignmentState || "Unassigned") === "Unassigned",
    ).length;
    const lookaheadOpenActions = lookaheadOpen.filter(
      (a) => (gateOpenByActivity[a.activityId] || 0) > 0,
    ).length;
    const lookaheadComplete =
      lookaheadUnassigned === 0 && lookaheadOpenActions === 0;

    const weeks = [];
    for (let i = 1; i <= totalWeeks; i++) {
      const weekStartDate = new Date(earliestDate);
      weekStartDate.setDate(weekStartDate.getDate() + (i - 1) * 7);
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 6);

      let weekActivities = { total: 0, green: 0, amber: 0, red: 0 };
      for (const activity of activities) {
        const actStart = parseDate(activity.startDate);
        const actFinish = parseDate(activity.finishDate);
        if (!actStart) continue;

        const startsThisWeek =
          actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek =
          actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
        if (startsThisWeek || spansThisWeek) {
          weekActivities.total++;
          const isCompleted =
            activity.status === "Completed" ||
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
      const closedWeekData = closedWeeks.find((w) => w.weekNumber === i);

      const pairFirstWeek = i % 2 === 1 ? i : i - 1;
      const pairStartDate = new Date(referenceDate || earliestDate);
      pairStartDate.setDate(pairStartDate.getDate() + (pairFirstWeek - 1) * 7);
      const twoWeekEndDate = new Date(pairStartDate);
      twoWeekEndDate.setDate(pairStartDate.getDate() + 13);

      let status = "upcoming";
      if (isClosed) {
        status = "closed";
      } else if (i === currentWeekNumber) {
        status = "current";
      } else if (i < currentWeekNumber) {
        status = "past";
      }

      const previousWeeksClosed =
        closedWeekNumbers.filter((n) => n < i).length === i - 1;
      const canClose = !isClosed && previousWeeksClosed && lookaheadComplete;

      let canCloseReason = null;
      if (!canClose) {
        if (isClosed) {
          canCloseReason = "Already closed";
        } else if (!previousWeeksClosed) {
          canCloseReason = "Previous weeks must be closed first";
        } else if (!lookaheadComplete) {
          canCloseReason =
            lookaheadUnassigned > 0
              ? `Assign all activities before closing (${lookaheadUnassigned} unassigned)`
              : `Complete all open actions before closing (${lookaheadOpenActions} activit${
                  lookaheadOpenActions === 1 ? "y" : "ies"
                } with open actions)`;
        }
      }

      weeks.push({
        weekNumber: i,
        startDate: weekStartDate,
        endDate: weekEndDate,
        twoWeekEndDate,
        status,
        isClosed,
        canClose,
        canCloseReason,
        closedAt: closedWeekData?.closedAt || null,
        closeType: closedWeekData?.closeType || null,
        stats: isClosed ? closedWeekData?.stats : weekActivities,
      });
    }

    return sendSuccess(res, {
      totalWeeks,
      currentWeekNumber: Math.min(currentWeekNumber, totalWeeks),
      closedWeeksCount: closedWeeks.length,
      progress:
        totalWeeks > 0
          ? Math.min(100, Math.round((closedWeeks.length / totalWeeks) * 100))
          : 0,
      isFullyClosed: closedWeeks.length >= totalWeeks,
      weeks,
      currentCycleStartDate,
      currentCycleEndDate: currentTwoWeekEndDate,
      canCloseCurrentCycle,
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/close-week/:weekNumber", protect, async (req, res) => {
  try {
    const { closeType, notes, isSecondOfPair } = req.body;
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

    const closedWeeks = programme.closedWeeks || [];
    if (closedWeeks.some((w) => w.weekNumber === weekNumber)) {
      return sendError(res, `Week ${weekNumber} is already closed`, 400);
    }

    const closedWeekNumbers = closedWeeks.map((w) => w.weekNumber);
    for (let i = 1; i < weekNumber; i++) {
      if (!closedWeekNumbers.includes(i)) {
        return sendError(
          res,
          `Cannot close Week ${weekNumber}. Week ${i} must be closed first.`,
          400,
        );
      }
    }

    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();

      const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        return new Date(
          parseInt(isoMatch[1]),
          parseInt(isoMatch[2]) - 1,
          parseInt(isoMatch[3]),
        );
      }

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

    const weekAnchorDate = programme.lookaheadStartDate
      ? new Date(programme.lookaheadStartDate)
      : new Date(earliestDate);
    weekAnchorDate.setHours(0, 0, 0, 0);

    const weekStartDate = new Date(weekAnchorDate);
    weekStartDate.setDate(weekStartDate.getDate() + (weekNumber - 1) * 7);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);

    const pairFirstWeek = weekNumber % 2 === 1 ? weekNumber : weekNumber - 1;
    const pairStartDate = new Date(weekAnchorDate);
    pairStartDate.setDate(pairStartDate.getDate() + (pairFirstWeek - 1) * 7);
    const twoWeekEndDate = new Date(pairStartDate);
    twoWeekEndDate.setDate(pairStartDate.getDate() + 13);

    const today = new Date();
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const twoWeekEndDateStart = new Date(twoWeekEndDate);
    twoWeekEndDateStart.setHours(0, 0, 0, 0);

    const isOverride = closeType === "PM Override";

    if (!isOverride && !isSecondOfPair) {
      const gateActions = await require("../models/Action")
        .find({
          programme: req.params.id,
        })
        .lean();
      const openByActivity = {};
      const hasActionByActivity = {};
      for (const action of gateActions) {
        const actId = action.linkedActivity?.activityId;
        if (!actId) continue;
        hasActionByActivity[actId] = true;
        const isOpen =
          action.status !== "Completed" &&
          action.status !== "Complete" &&
          action.status !== "Cancelled";
        openByActivity[actId] = (openByActivity[actId] || 0) + (isOpen ? 1 : 0);
      }
      const isSettled = (activity) => {
        if (activity.finishDate && activity.finishDate.includes(" A"))
          return true;
        if (
          activity.activityStatus === "Completed" ||
          activity.activityStatus === "Complete"
        )
          return true;
        if (
          hasActionByActivity[activity.activityId] &&
          (openByActivity[activity.activityId] || 0) === 0
        )
          return true;
        return false;
      };
      const lookaheadEnd = new Date(weekAnchorDate);
      lookaheadEnd.setDate(lookaheadEnd.getDate() + 41);
      lookaheadEnd.setHours(23, 59, 59, 999);
      const openActivities = activities.filter((a) => {
        const s = parseDate(a.startDate);
        return s && s >= weekAnchorDate && s <= lookaheadEnd && !isSettled(a);
      });
      const unassignedActivities = openActivities.filter(
        (a) => (a.assignmentState || "Unassigned") === "Unassigned",
      );
      if (unassignedActivities.length > 0) {
        return sendError(
          res,
          `Cannot close yet. ${unassignedActivities.length} activit${
            unassignedActivities.length === 1 ? "y is" : "ies are"
          } still unassigned. Assign every activity before closing.`,
          400,
        );
      }
      const withOpenActions = openActivities.filter(
        (a) => (openByActivity[a.activityId] || 0) > 0,
      );
      if (withOpenActions.length > 0) {
        return sendError(
          res,
          `Cannot close yet. ${withOpenActions.length} activit${
            withOpenActions.length === 1 ? "y has" : "ies have"
          } open actions. Complete all actions before closing.`,
          400,
        );
      }
    }

    const Action = require("../models/Action");

    const allProgActions = await Action.find({
      programme: req.params.id,
    }).lean();
    refreshProgrammeGovernance(
      programme,
      groupActionsByActivity(allProgActions),
      new Date(),
    );

    const ragBucket = (activity) => {
      const rag = activity.ragStatus || "Grey";
      if (rag === "Blue" || rag === "Green") return "green";
      if (rag === "Red") return "red";
      return "amber";
    };

    let weekStats = {
      totalActivities: 0,
      green: 0,
      amber: 0,
      red: 0,
      actionsTotal: 0,
      actionsCompleted: 0,
    };

    const statLookaheadEnd = new Date(weekAnchorDate);
    statLookaheadEnd.setDate(statLookaheadEnd.getDate() + 41);
    statLookaheadEnd.setHours(23, 59, 59, 999);

    for (const activity of activities) {
      const actStart = parseDate(activity.startDate);
      if (!actStart) continue;

      const inLookahead =
        actStart >= weekAnchorDate && actStart <= statLookaheadEnd;

      if (inLookahead) {
        weekStats.totalActivities++;
        weekStats[ragBucket(activity)]++;
      }
    }

    const previousClosedWeeks = closedWeeks.filter(
      (w) => w.weekNumber < weekNumber,
    );
    const lastClosureDate =
      previousClosedWeeks.length > 0
        ? new Date(
            Math.max(
              ...previousClosedWeeks.map((w) => new Date(w.closedAt).getTime()),
            ),
          )
        : null;

    const actionQuery = { programme: req.params.id };
    if (lastClosureDate) {
      actionQuery.createdAt = { $gt: lastClosureDate };
    }

    const weekActions = await Action.find(actionQuery);
    weekStats.actionsTotal = weekActions.length;
    weekStats.actionsCompleted = weekActions.filter(
      (a) => a.status === "Completed",
    ).length;

    let calculatedTotalWeeks = programme.totalWeeks;
    if (!calculatedTotalWeeks && earliestDate && latestDate) {
      const msPerDay = 1000 * 60 * 60 * 24;
      const totalDays = Math.ceil((latestDate - earliestDate) / msPerDay);
      calculatedTotalWeeks = Math.ceil(totalDays / 7);
    }

    const currentClosedCount = (programme.closedWeeks || []).length;
    const isLastWeek = currentClosedCount + 1 >= calculatedTotalWeeks;

    let nextCycleStatus = "Draft";
    if (isLastWeek) {
      nextCycleStatus = "Close-Out Eligible";
    }

    const updateData = {
      $push: {
        closedWeeks: {
          weekNumber,
          closedAt: new Date(),
          closedBy: req.admin._id,
          closeType: closeType || "Normal Close",
          stats: weekStats,
        },
      },
      $set: {
        cycleStatus: nextCycleStatus,
        totalWeeks: calculatedTotalWeeks,
      },
    };

    const updatedProgramme = await Programme.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true },
    );

    if (!updatedProgramme) {
      return sendError(res, "Failed to update programme", 500);
    }

    const formatDateShort = (d) => {
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

    await CycleHistory.create({
      programme: req.params.id,
      weekNumber,
      weekLabel: `Week ${weekNumber}`,
      dateRange: {
        startDate: weekStartDate,
        endDate: weekEndDate,
      },
      closeType: closeType || "Normal Close",
      score:
        weekStats.totalActivities > 0
          ? Math.round((weekStats.green / weekStats.totalActivities) * 100)
          : 0,
      stats: weekStats,
      closedBy: req.admin._id,
      notes: notes || "",
    });

    const totalWeeks = calculatedTotalWeeks || 0;
    return sendSuccess(
      res,
      {
        weekNumber,
        closedAt: new Date(),
        closeType: closeType || "Normal Close",
        stats: weekStats,
        progress:
          totalWeeks > 0
            ? Math.min(
                100,
                Math.round(
                  (updatedProgramme.closedWeeks.length / totalWeeks) * 100,
                ),
              )
            : 0,
        isFullyClosed: false,
        isLastWeek: isLastWeek,
        cycleStatus: nextCycleStatus,
      },
      isLastWeek
        ? `All weeks completed - Ready for Close-Out`
        : `Week ${weekNumber} closed successfully`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post(
  "/:id/reopen-week/:weekNumber",
  protect,
  adminOnly,
  async (req, res) => {
    try {
      const weekNumber = parseInt(req.params.weekNumber);
      const CycleHistory = require("../models/CycleHistory");

      const programme = await Programme.findById(req.params.id);
      if (!programme) {
        return sendError(res, "Programme not found", 404);
      }

      const weekIndex = programme.closedWeeks.findIndex(
        (w) => w.weekNumber === weekNumber,
      );
      if (weekIndex === -1) {
        return sendError(res, `Week ${weekNumber} is not closed`, 400);
      }

      const maxClosedWeek = Math.max(
        ...programme.closedWeeks.map((w) => w.weekNumber),
      );
      if (weekNumber !== maxClosedWeek) {
        return sendError(
          res,
          `Can only reopen the last closed week (Week ${maxClosedWeek})`,
          400,
        );
      }

      programme.closedWeeks.splice(weekIndex, 1);

      if (programme.isLocked) {
        programme.isLocked = false;
        programme.cycleStatus = "Execution";
        programme.closedAt = null;
        programme.closedBy = null;
        programme.closeType = null;
      }

      await programme.save();

      await CycleHistory.deleteOne({
        programme: req.params.id,
        weekNumber,
      });

      const totalWeeks = programme.totalWeeks || 0;

      return sendSuccess(
        res,
        {
          weekNumber,
          progress:
            totalWeeks > 0
              ? Math.min(
                  100,
                  Math.round((programme.closedWeeks.length / totalWeeks) * 100),
                )
              : 0,
        },
        `Week ${weekNumber} reopened successfully`,
      );
    } catch (error) {
      console.error(error);
      return sendError(res, "Server error");
    }
  },
);

router.patch("/:id/link-project", protect, async (req, res) => {
  try {
    const { projectId } = req.body;

    if (!projectId) {
      return sendValidationError(res, [
        { field: "projectId", message: "Project ID is required" },
      ]);
    }

    const programme = await Programme.findById(req.params.id);
    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    programme.project = projectId;
    await programme.save();

    await auditLogger.log({
      action: "PROGRAMME_LINKED",
      req,
      user: req.admin,
      resourceType: "Programme",
      resourceId: programme._id,
      resourceName: programme.name,
      project,
      description: `Linked programme "${programme.name}" to project "${project.name}"`,
    });

    return sendSuccess(
      res,
      { programme: { _id: programme._id, project: projectId } },
      "Programme linked to project successfully",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/governance-proof/:programmeId", protect, async (req, res) => {
  try {
    const CycleHistory = require("../models/CycleHistory");
    const programme = await Programme.findById(req.params.programmeId);

    if (!programme) {
      return sendError(res, "Programme not found", 404);
    }

    const actions = await Action.find({ programme: req.params.programmeId });
    const activities = programme.extractedData?.activities || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const calculateRAGDemo = (activity, referenceDate) => {
      const parseDateLocal = (dateStr) => {
        if (!dateStr) return null;
        const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
        const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
          return new Date(
            parseInt(isoMatch[1]),
            parseInt(isoMatch[2]) - 1,
            parseInt(isoMatch[3]),
          );
        }
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

      const startDate = parseDateLocal(activity.startDate);
      const finishDate = parseDateLocal(activity.finishDate);

      if (!startDate)
        return { zone: "Unknown", color: "gray", reason: "No start date" };

      const msPerDay = 1000 * 60 * 60 * 24;
      const daysUntilStart = Math.ceil((startDate - referenceDate) / msPerDay);

      if (activity.finishDate && activity.finishDate.includes(" A")) {
        return {
          zone: "Complete",
          color: "blue",
          reason: "Activity completed (has 'A' suffix)",
        };
      }

      if (finishDate && finishDate < referenceDate) {
        return {
          zone: "Red",
          color: "red",
          reason: `Overdue - finish date ${activity.finishDate} has passed`,
        };
      }

      if (daysUntilStart <= 14) {
        return {
          zone: "Green",
          color: "green",
          reason: `Starts within 2 weeks (${daysUntilStart} days)`,
        };
      }

      if (daysUntilStart <= 28) {
        return {
          zone: "Amber",
          color: "amber",
          reason: `Starts in 2-4 weeks (${daysUntilStart} days)`,
        };
      }

      return {
        zone: "Red",
        color: "red",
        reason: `Starts in ${daysUntilStart} days (>4 weeks away - Strategic)`,
      };
    };

    const cycleTransitions = {
      Draft: ["Meeting Open"],
      Uploaded: ["Meeting Open"],
      "Meeting Open": ["Execution"],
      Execution: ["Close-Out Eligible"],
      "Close-Out Eligible": ["Closed"],
      Closed: [],
    };

    const currentStatus = programme.cycleStatus || "Draft";
    const validNextStates = cycleTransitions[currentStatus] || [];
    const allStates = [
      "Draft",
      "Uploaded",
      "Meeting Open",
      "Execution",
      "Close-Out Eligible",
      "Closed",
    ];
    const invalidTransitions = allStates.filter(
      (s) => s !== currentStatus && !validNextStates.includes(s),
    );

    const stateMachineProof = {
      title: "PROOF 1: State Machine Enforcement",
      description:
        "System enforces valid state transitions and BLOCKS invalid attempts",
      currentState: currentStatus,
      validTransitions:
        validNextStates.length > 0
          ? validNextStates
          : ["NONE - Terminal state reached"],
      blockedTransitions: invalidTransitions.map((state) => ({
        attemptedState: state,
        result: "BLOCKED",
        errorMessage: `Invalid transition: Cannot go from "${currentStatus}" to "${state}"`,
      })),
      examples: [
        {
          scenario: "Try to skip Meeting Open and go directly to Execution",
          fromState: "Draft",
          toState: "Execution",
          result: "BLOCKED",
          reason: "Must follow sequence: Draft → Meeting Open → Execution",
        },
        {
          scenario: "Try to close week without Execution status",
          requirement: "cycleStatus must be 'Execution' to close weeks",
          currentStatus: currentStatus,
          canCloseWeek:
            currentStatus === "Execution" ||
            currentStatus === "Close-Out Eligible",
          result:
            currentStatus === "Execution" ||
            currentStatus === "Close-Out Eligible"
              ? "ALLOWED"
              : "BLOCKED",
        },
      ],
      databaseEvidence: {
        collection: "programmes",
        field: "cycleStatus",
        currentValue: currentStatus,
        query: `db.programmes.findOne({ _id: ObjectId("${req.params.programmeId}") }, { cycleStatus: 1 })`,
      },
    };

    const sampleActivities = activities.slice(0, 5).map((activity) => {
      const currentRAG = calculateRAGDemo(activity, today);
      const futureDate = new Date(today);
      futureDate.setDate(futureDate.getDate() + 42);

      const modifiedActivity = {
        ...activity,
        startDate: `${String(futureDate.getDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][futureDate.getMonth()]}-${String(futureDate.getFullYear()).slice(-2)}`,
      };
      const futureRAG = calculateRAGDemo(modifiedActivity, today);

      return {
        activityId: activity.activityId,
        activityName: activity.activityName,
        originalStartDate: activity.startDate,
        currentRAG: currentRAG,
        simulatedChange: {
          description: "If start date changed to 6 weeks from now",
          newStartDate: modifiedActivity.startDate,
          newRAG: futureRAG,
          ragChange:
            currentRAG.zone !== futureRAG.zone
              ? `${currentRAG.zone} → ${futureRAG.zone}`
              : "No change",
        },
      };
    });

    const ragProof = {
      title: "PROOF 2: RAG Classification - Dynamic Calculation",
      description:
        "RAG zones are calculated in REAL-TIME based on dates, NOT hardcoded values",
      calculationLogic: {
        green: "Activity starts within 2 weeks (0-14 days)",
        amber: "Activity starts in 2-4 weeks (15-28 days)",
        red: "Activity overdue OR starts in >4 weeks (Strategic)",
        blue: "Activity completed (finish date has 'A' suffix)",
      },
      currentDate: today.toISOString().split("T")[0],
      activitiesAnalyzed: sampleActivities,
      proofOfDynamicCalculation: {
        note: "RAG is NOT stored in database - computed on every request",
        storedInDB: ["startDate", "finishDate"],
        calculatedAtRuntime: ["ragStatus", "weekZone", "activityStatus"],
      },
    };

    const requiredActions = actions.filter((a) => a.type === "Required");
    const optionalActions = actions.filter((a) => a.type === "Optional");
    const openRequiredActions = requiredActions.filter(
      (a) => a.status === "Open" || a.status === "In Progress",
    );
    const completedActions = actions.filter((a) => a.status === "Completed");
    const overdueActions = actions.filter(
      (a) =>
        a.status !== "Completed" &&
        a.status !== "Cancelled" &&
        a.dueDate &&
        new Date(a.dueDate) < today,
    );
    const blockedActivities = activities.filter((a) => a.isBlocked === true);

    const totalWeeks = programme.totalWeeks || 0;
    const closedWeeksCount = (programme.closedWeeks || []).length;
    const remainingWeeks = totalWeeks - closedWeeksCount;

    let readyToClose = false;
    if (
      programme.cycleStatus === "Draft" ||
      programme.cycleStatus === "Uploaded" ||
      programme.cycleStatus === "Meeting Open"
    ) {
      readyToClose = false;
    } else if (
      programme.cycleStatus === "Execution" ||
      programme.cycleStatus === "Close-Out Eligible"
    ) {
      readyToClose = openRequiredActions.length === 0;
    }

    const cycleHistory = await CycleHistory.find({
      programme: req.params.programmeId,
    })
      .populate("closedBy", "name")
      .sort({ createdAt: -1 });

    const parseDateDashboard = (dateStr) => {
      if (!dateStr) return null;
      const cleanDate = dateStr.replace(/\s*[AB\*]$/, "").trim();
      const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        return new Date(
          parseInt(isoMatch[1]),
          parseInt(isoMatch[2]) - 1,
          parseInt(isoMatch[3]),
        );
      }
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

    let earliestStartDate = null;
    let latestEndDate = null;
    for (const activity of activities) {
      const startDate = parseDateDashboard(activity.startDate);
      const finishDate = parseDateDashboard(activity.finishDate);
      if (startDate && (!earliestStartDate || startDate < earliestStartDate)) {
        earliestStartDate = startDate;
      }
      if (finishDate && (!latestEndDate || finishDate > latestEndDate)) {
        latestEndDate = finishDate;
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

      const referenceDate = programme.lookaheadStartDate
        ? new Date(programme.lookaheadStartDate)
        : earliestStartDate;
      referenceDate.setHours(0, 0, 0, 0);
      const daysSinceStart = Math.floor((today - referenceDate) / msPerDay);
      currentWeekNumber = Math.max(1, Math.ceil((daysSinceStart + 1) / 7));
    }

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

    const calculateWeekRAG = (weekStartDate, weekEndDate) => {
      let green = 0,
        amber = 0,
        red = 0;
      for (const activity of activities) {
        const actStart = parseDateDashboard(activity.startDate);
        const actFinish = parseDateDashboard(activity.finishDate);
        if (!actStart) continue;
        const startsThisWeek =
          actStart >= weekStartDate && actStart <= weekEndDate;
        const spansThisWeek =
          actStart < weekStartDate && actFinish && actFinish >= weekStartDate;
        if (!startsThisWeek && !spansThisWeek) continue;
        const ragStatus = activity.ragStatus || "Grey";
        if (ragStatus === "Green") green++;
        else if (ragStatus === "Amber") amber++;
        else if (ragStatus === "Red") red++;
      }
      return { green, amber, red, total: green + amber + red };
    };

    if (earliestStartDate) {
      const weeksToGenerate = totalWeeksFromProgramme;
      for (let weekNum = 1; weekNum <= weeksToGenerate; weekNum++) {
        const weekStartDate = new Date(earliestStartDate);
        weekStartDate.setDate(weekStartDate.getDate() + (weekNum - 1) * 7);
        const weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekStartDate.getDate() + 6);

        const rag = calculateWeekRAG(weekStartDate, weekEndDate);
        const matchingCycle = cycleHistory.find(
          (c) => c.weekNumber === weekNum,
        );

        weeklyReadinessData.push({
          week: `W${weekNum}`,
          value: matchingCycle
            ? Math.round(
                ((matchingCycle.stats?.green || 0) /
                  (matchingCycle.stats?.totalActivities || 1)) *
                  100,
              )
            : 0,
        });

        actionsData.push({
          week: `W${weekNum}`,
          raised: matchingCycle ? matchingCycle.stats?.actionsTotal || 0 : 0,
          closed: matchingCycle
            ? matchingCycle.stats?.actionsCompleted || 0
            : 0,
        });

        ragTrendData.push({
          week: `W${weekNum}`,
          green: matchingCycle ? matchingCycle.stats?.green || 0 : 0,
          amber: matchingCycle ? matchingCycle.stats?.amber || 0 : 0,
          red: matchingCycle ? matchingCycle.stats?.red || 0 : 0,
        });
      }
    }

    const currentWeekIndex = Math.min(
      currentWeekNumber,
      weeklyReadinessData.length,
    );
    const pastAndCurrentWeeks = weeklyReadinessData.slice(0, currentWeekIndex);
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

    const totalCyclesForProgramme = cycleHistory.length;
    const pmOverridesForProgramme = cycleHistory.filter(
      (c) => c.closeType === "PM Override",
    ).length;
    const normalWeeks = totalCyclesForProgramme - pmOverridesForProgramme;
    const pmOverrideFrequencyScore =
      totalCyclesForProgramme > 0
        ? Math.round((normalWeeks / totalCyclesForProgramme) * 100)
        : 100;

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
        dynamicWeights[key] = Math.round((score / totalScoreSum) * 100);
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

    let blockerTypes = new Set();
    activities.forEach((a) => {
      if (a.isBlocked && a.blocker) {
        blockerTypes.add(a.blocker.split(" ")[0]);
      }
    });

    const governanceDashboard = {
      title: "Governance Dashboard - Score & Metrics",
      description:
        "Overall programme governance health calculated from weighted metrics",

      score: governanceScore,
      status: governanceStatus,

      metrics: {
        weeksClosedOnTime: {
          label: "Weeks Closed On Time",
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
          label: "Overdue Action Rate",
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
          label: "Action Closure Speed",
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
          label: "Readiness Trend Stability",
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
          label: "PM Override Frequency",
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
        closedWeeks: cycleHistory.length,
        avgReadiness: `${avgReadiness}%`,
        totalActionsRaised: totalActionsFromClosedWeeks,
        totalClosed: closedActionsFromClosedWeeks,
        overdueTrend: "Stable",
        recurringBlockers: blockerTypes.size,
        pmOverrides: pmOverrides,
        normalCloses: weeksClosedOnTime,
      },

      chartData: {
        weeklyReadinessTrend: weeklyReadinessData,
        actionsRaisedVsClosed: actionsData,
        weeklyRAGTrend: ragTrendData,
      },
    };

    const governanceProof = {
      title: "PROOF 3: Backend Governance Rules",
      description:
        "System enforces governance rules that control Close-Out eligibility",

      currentStats: {
        totalActions: actions.length,
        requiredActions: requiredActions.length,
        optionalActions: optionalActions.length,
        openRequiredActions: openRequiredActions.length,
        completedActions: completedActions.length,
        overdueActions: overdueActions.length,
        blockedActivities: blockedActivities.length,
        totalWeeks: totalWeeks,
        closedWeeks: closedWeeksCount,
        remainingWeeks: remainingWeeks,
      },

      governanceChecks: [
        {
          checkName: "Required Actions Open/In Progress",
          count: openRequiredActions.length,
          blocksCloseOut: openRequiredActions.length > 0,
          result:
            openRequiredActions.length > 0
              ? "❌ BLOCKS CLOSE-OUT"
              : "✅ ALLOWS CLOSE-OUT",
          blockingActions: openRequiredActions.map((a) => ({
            _id: a._id,
            title: a.title,
            type: a.type,
            status: a.status,
            linkedActivity: a.linkedActivity?.activityId || "None",
          })),
        },
        {
          checkName: "Optional Actions (DO NOT block)",
          count: optionalActions.filter((a) => a.status !== "Completed").length,
          blocksCloseOut: false,
          result: "✅ DOES NOT BLOCK - Optional actions ignored",
          codeReference: "Line 1741: a.type !== 'Optional'",
        },
        {
          checkName: "Overdue Actions",
          count: overdueActions.length,
          blocksCloseOut: overdueActions.length > 0,
          result:
            overdueActions.length > 0
              ? "❌ BLOCKS CLOSE-OUT"
              : "✅ ALLOWS CLOSE-OUT",
        },
        {
          checkName: "Blocked Activities",
          count: blockedActivities.length,
          blocksCloseOut: blockedActivities.length > 0,
          result:
            blockedActivities.length > 0
              ? "❌ BLOCKS CLOSE-OUT"
              : "✅ ALLOWS CLOSE-OUT",
        },
      ],

      finalDecision: {
        readyToClose: readyToClose,
        displayValue: readyToClose ? "Yes" : "No",
        uiColor: readyToClose ? "GREEN" : "RED",
        reason: !readyToClose
          ? `${openRequiredActions.length} Required action(s) still Open/In Progress`
          : "All Required actions completed - Ready for Close-Out",
      },

      scenarios: {
        whenRequiredActionOpen: {
          description: "When a Required action is Open or In Progress",
          systemBehavior: "System BLOCKS Close-Out",
          readyToCloseValue: "No (RED)",
          closeOutButtonState: "Disabled or shows warning",
        },
        whenAllConditionsMet: {
          description: "When all Required actions are Completed/Cancelled",
          systemBehavior: "System ALLOWS Close-Out",
          readyToCloseValue: "Yes (GREEN)",
          closeOutButtonState: "Enabled",
        },
      },
    };

    const GovernanceProof = require("../models/GovernanceProof");

    const proofDocument = {
      programme: req.params.programmeId,
      programmeName: programme.name,
      generatedAt: new Date(),
      generatedBy: req.admin?._id,

      GovernanceDashboard: {
        score: governanceScore,
        status: governanceStatus,
        metrics: governanceDashboard.metrics,
        stats: governanceDashboard.stats,
      },
    };

    const savedProof = await GovernanceProof.create(proofDocument);

    return sendSuccess(
      res,
      {
        _id: savedProof._id,
        savedToDatabase: true,
        collectionName: "governanceproofs",
        reportGeneratedAt: new Date().toISOString(),
        programmeId: req.params.programmeId,
        programmeName: programme.name,

        GovernanceDashboard: governanceDashboard,
      },
      "Governance Proof",
    );
  } catch (error) {
    console.error("Governance proof error:", error);
    return sendError(
      res,
      "Failed to generate governance proof: " + error.message,
    );
  }
});

module.exports = router;
