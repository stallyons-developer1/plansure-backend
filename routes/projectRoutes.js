const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
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

router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const { status, phase } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (phase) filter.phase = phase;

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

router.get("/:id", protect, adminOnly, async (req, res) => {
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

// @route   DELETE /api/projects/:id
// @desc    Delete a project
// @access  Private (Admin only)
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

// @route   POST /api/projects/:id/team
// @desc    Add team member to project
// @access  Private (Admin only)
router.post("/:id/team", protect, adminOnly, async (req, res) => {
  try {
    const { userId, role } = req.body;

    // Validate required fields
    const errors = validateRequired({ userId, role });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    // Check if user already in team
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

// @route   DELETE /api/projects/:id/team/:userId
// @desc    Remove team member from project
// @access  Private (Admin only)
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

// @route   POST /api/projects/:id/programmes
// @desc    Link a programme to project
// @access  Private (Admin only)
router.post("/:id/programmes", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId } = req.body;

    // Validate required fields
    const errors = validateRequired({ programmeId });
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return sendError(res, "Project not found", 404);
    }

    // Check if programme already linked
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

// @route   GET /api/projects/phases
// @desc    Get all available phases
// @access  Private
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
