const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const Admin = require("../models/Admin");
const Project = require("../models/Project");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { sendInviteEmail, sendWelcomeEmail } = require("../utils/email");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
  validateEmail,
  validatePassword,
} = require("../utils/errorResponse");

// @route   POST /api/users/invite
// @desc    Invite a new user
// @access  Private (Admin only)
router.post("/invite", protect, adminOnly, async (req, res) => {
  try {
    const { name, email, role, projectId } = req.body;

    // Validate required fields
    const errors = validateRequired({ name, email, role });

    // Validate email format if provided
    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    // Check if user already exists
    const existingUser = await Admin.findOne({ email });
    if (existingUser) {
      return sendValidationError(res, [
        { field: "email", message: "User with this email already exists" },
      ]);
    }

    // Get project name if projectId provided
    let projectName = "All Projects";
    if (projectId) {
      const project = await Project.findById(projectId);
      if (project) {
        projectName = project.name;
      }
    }

    // Create user with pending status
    const user = new Admin({
      name,
      email,
      role,
      status: "pending",
      projects: projectId ? [projectId] : [],
      invitedBy: req.admin._id,
    });

    // Generate invite token
    const inviteToken = user.generateInviteToken();
    await user.save();

    // Send invite email
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const acceptUrl = `${frontendUrl}/invite/accept/${inviteToken}`;
    const rejectUrl = `${frontendUrl}/invite/reject/${inviteToken}`;

    await sendInviteEmail({
      email: user.email,
      name: user.name,
      role: user.role,
      projectName,
      invitedByName: req.admin.name,
      acceptUrl,
      rejectUrl,
    });

    return sendSuccess(
      res,
      {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
        },
      },
      "Invitation sent successfully",
      201
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   POST /api/users/invite/accept/:token
// @desc    Accept invitation and set password
// @access  Public
router.post("/invite/accept/:token", async (req, res) => {
  try {
    const { password } = req.body;

    // Validate password
    const errors = validateRequired({ password });
    if (errors.length === 0) {
      const passwordError = validatePassword(password, 6);
      if (passwordError) errors.push(passwordError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    // Hash the token to compare with stored hash
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    // Find user with valid token
    const user = await Admin.findOne({
      inviteToken: hashedToken,
      inviteTokenExpiry: { $gt: Date.now() },
      status: "pending",
    });

    if (!user) {
      return sendValidationError(res, [
        { field: "token", message: "Invalid or expired invitation token" },
      ]);
    }

    // Set password and activate user
    user.password = password;
    user.status = "active";
    user.inviteToken = undefined;
    user.inviteTokenExpiry = undefined;
    await user.save();

    // Send welcome email
    await sendWelcomeEmail({
      email: user.email,
      name: user.name,
    });

    return sendSuccess(res, {}, "Account activated successfully. You can now login.");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   POST /api/users/invite/reject/:token
// @desc    Reject invitation
// @access  Public
router.post("/invite/reject/:token", async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await Admin.findOne({
      inviteToken: hashedToken,
      status: "pending",
    });

    if (!user) {
      return sendValidationError(res, [
        { field: "token", message: "Invalid invitation token" },
      ]);
    }

    // Delete the user
    await Admin.findByIdAndDelete(user._id);

    return sendSuccess(res, {}, "Invitation declined");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/users/invite/verify/:token
// @desc    Verify if invitation token is valid
// @access  Public
router.get("/invite/verify/:token", async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await Admin.findOne({
      inviteToken: hashedToken,
      inviteTokenExpiry: { $gt: Date.now() },
      status: "pending",
    });

    if (!user) {
      return sendValidationError(res, [
        { field: "token", message: "Invalid or expired invitation token" },
      ]);
    }

    return sendSuccess(res, {
      valid: true,
      user: {
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/users
// @desc    Get all users
// @access  Private (Admin only)
router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const { status, role, search } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const users = await Admin.find(filter)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name")
      .populate("invitedBy", "name")
      .sort({ createdAt: -1 });

    // Format response
    const formattedUsers = users.map((user) => ({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      projectAccess: user.projects && user.projects.length > 0
        ? user.projects.map((p) => p.name).join(", ")
        : "All Projects",
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      initials: user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2),
    }));

    return sendSuccess(res, { users: formattedUsers });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private (Admin only)
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name")
      .populate("invitedBy", "name email");

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    return sendSuccess(res, { user });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private (Admin only)
router.put("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, role, projects, status } = req.body;

    const user = await Admin.findById(req.params.id);
    if (!user) {
      return sendError(res, "User not found", 404);
    }

    // Update fields
    if (name) user.name = name;
    if (role) user.role = role;
    if (projects !== undefined) user.projects = projects;
    if (status) user.status = status;

    await user.save();

    const updatedUser = await Admin.findById(user._id)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name");

    return sendSuccess(res, { user: updatedUser }, "User updated successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   PATCH /api/users/:id/block
// @desc    Block/Unblock user
// @access  Private (Admin only)
router.patch("/:id/block", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    // Prevent blocking yourself
    if (user._id.toString() === req.admin._id.toString()) {
      return sendValidationError(res, [
        { field: "user", message: "You cannot block yourself" },
      ]);
    }

    // Toggle block status
    if (user.status === "blocked") {
      user.status = "active";
    } else {
      user.status = "blocked";
    }

    await user.save();

    return sendSuccess(
      res,
      { status: user.status },
      `User ${user.status === "blocked" ? "blocked" : "unblocked"} successfully`
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private (Admin only)
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    // Prevent deleting yourself
    if (user._id.toString() === req.admin._id.toString()) {
      return sendValidationError(res, [
        { field: "user", message: "You cannot delete yourself" },
      ]);
    }

    await Admin.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "User deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   POST /api/users/:id/resend-invite
// @desc    Resend invitation email
// @access  Private (Admin only)
router.post("/:id/resend-invite", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id).populate("projects", "name");

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (user.status !== "pending") {
      return sendValidationError(res, [
        { field: "status", message: "User has already accepted the invitation" },
      ]);
    }

    // Generate new invite token
    const inviteToken = user.generateInviteToken();
    await user.save();

    // Send invite email
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const acceptUrl = `${frontendUrl}/invite/accept/${inviteToken}`;
    const rejectUrl = `${frontendUrl}/invite/reject/${inviteToken}`;

    const projectName = user.projects && user.projects.length > 0
      ? user.projects.map((p) => p.name).join(", ")
      : "All Projects";

    await sendInviteEmail({
      email: user.email,
      name: user.name,
      role: user.role,
      projectName,
      invitedByName: req.admin.name,
      acceptUrl,
      rejectUrl,
    });

    return sendSuccess(res, {}, "Invitation resent successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
