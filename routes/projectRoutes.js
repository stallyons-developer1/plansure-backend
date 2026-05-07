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

    return sendSuccess(res, { projects });
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

    project.team = project.team.filter(
      (member) => member.user.toString() !== req.params.userId,
    );
    await project.save();

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
