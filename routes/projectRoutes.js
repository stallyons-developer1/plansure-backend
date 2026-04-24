const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const { protect, adminOnly } = require("../middleware/authMiddleware");

// @route   POST /api/projects
// @desc    Create a new project
// @access  Private (Admin only)
router.post("/", protect, adminOnly, async (req, res) => {
  try {
    const { name, phase, description, startDate, endDate } = req.body;

    // Validate required fields
    if (!name || !phase || !startDate) {
      return res.status(400).json({
        message: "Please provide name, phase, and start date",
      });
    }

    // Create project
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

    res.status(201).json({
      message: "Project created successfully",
      project: populatedProject,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   GET /api/projects
// @desc    Get all projects
// @access  Private (Admin only)
router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const { status, phase } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (phase) filter.phase = phase;

    const projects = await Project.find(filter)
      .populate("createdBy", "name email")
      .populate("team.user", "name email")
      .populate("programmes", "name status")
      .sort({ createdAt: -1 });

    res.json(projects);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   GET /api/projects/:id
// @desc    Get single project by ID
// @access  Private (Admin only)
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
      return res.status(404).json({ message: "Project not found" });
    }

    res.json(project);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   PUT /api/projects/:id
// @desc    Update a project
// @access  Private (Admin only)
router.put("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, phase, description, startDate, endDate, status } = req.body;

    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Update fields
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

    res.json({
      message: "Project updated successfully",
      project: updatedProject,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   DELETE /api/projects/:id
// @desc    Delete a project
// @access  Private (Admin only)
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    await Project.findByIdAndDelete(req.params.id);

    res.json({ message: "Project deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   POST /api/projects/:id/team
// @desc    Add team member to project
// @access  Private (Admin only)
router.post("/:id/team", protect, adminOnly, async (req, res) => {
  try {
    const { userId, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({ message: "Please provide userId and role" });
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Check if user already in team
    const existingMember = project.team.find(
      (member) => member.user.toString() === userId
    );
    if (existingMember) {
      return res.status(400).json({ message: "User already in team" });
    }

    project.team.push({ user: userId, role });
    await project.save();

    const updatedProject = await Project.findById(project._id)
      .populate("team.user", "name email");

    res.json({
      message: "Team member added successfully",
      team: updatedProject.team,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   DELETE /api/projects/:id/team/:userId
// @desc    Remove team member from project
// @access  Private (Admin only)
router.delete("/:id/team/:userId", protect, adminOnly, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    project.team = project.team.filter(
      (member) => member.user.toString() !== req.params.userId
    );
    await project.save();

    res.json({ message: "Team member removed successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// @route   POST /api/projects/:id/programmes
// @desc    Link a programme to project
// @access  Private (Admin only)
router.post("/:id/programmes", protect, adminOnly, async (req, res) => {
  try {
    const { programmeId } = req.body;

    if (!programmeId) {
      return res.status(400).json({ message: "Please provide programmeId" });
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Check if programme already linked
    if (project.programmes.includes(programmeId)) {
      return res.status(400).json({ message: "Programme already linked" });
    }

    project.programmes.push(programmeId);
    await project.save();

    const updatedProject = await Project.findById(project._id)
      .populate("programmes", "name status");

    res.json({
      message: "Programme linked successfully",
      programmes: updatedProject.programmes,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
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
