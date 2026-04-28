const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const Admin = require("../models/Admin");
const Project = require("../models/Project");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  sendInviteEmail,
  sendWelcomeEmail,
  sendRoleChangeEmail,
} = require("../utils/email");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
  validateEmail,
  validatePassword,
} = require("../utils/errorResponse");

router.post("/invite", protect, adminOnly, async (req, res) => {
  try {
    const { name, email, role, projectId } = req.body;

    const errors = validateRequired({ name, email, role });

    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const existingUser = await Admin.findOne({ email });
    if (existingUser) {
      return sendValidationError(res, [
        { field: "email", message: "User with this email already exists" },
      ]);
    }

    let projectName = "All Projects";
    if (projectId) {
      const project = await Project.findById(projectId);
      if (project) {
        projectName = project.name;
      }
    }

    const user = new Admin({
      name,
      email,
      role,
      status: "pending",
      projects: projectId ? [projectId] : [],
      invitedBy: req.admin._id,
    });

    const inviteToken = user.generateInviteToken();
    await user.save();

    const backendUrl =
      process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
    const acceptUrl = `${backendUrl}/api/users/invite/accept/${inviteToken}`;
    const rejectUrl = `${backendUrl}/api/users/invite/reject/${inviteToken}`;

    let emailSent = true;
    try {
      await sendInviteEmail({
        email: user.email,
        name: user.name,
        role: user.role,
        projectName,
        invitedByName: req.admin.name,
        acceptUrl,
        rejectUrl,
      });
    } catch (emailError) {
      console.error("Failed to send invite email:", emailError);
      emailSent = false;
    }

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
        emailSent,
      },
      emailSent ? "Invitation sent successfully" : "User invited but email could not be sent. Please configure SMTP settings.",
      201,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

const renderResponsePage = (title, message, type = "success") => {
  const colors = {
    success: { bg: "#22c55e", icon: "✓" },
    error: { bg: "#ef4444", icon: "✕" },
    warning: { bg: "#f59e0b", icon: "!" },
  };
  const color = colors[type] || colors.success;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title} - Plansure</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0f172a;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .card {
          background: #1e293b;
          border-radius: 16px;
          padding: 40px;
          text-align: center;
          max-width: 420px;
          width: 100%;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        .icon {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: ${color.bg};
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 24px;
          font-size: 40px;
          color: white;
        }
        h1 {
          color: #f1f5f9;
          font-size: 24px;
          margin-bottom: 12px;
        }
        p {
          color: #94a3b8;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 32px;
        }
        .btn {
          background: #3b82f6;
          color: white;
          border: none;
          padding: 14px 32px;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }
        .btn:hover { background: #2563eb; }
        .logo {
          color: #64748b;
          font-size: 14px;
          margin-top: 32px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">${color.icon}</div>
        <h1>${title}</h1>
        <p>${message}</p>
        <button class="btn" onclick="window.close(); setTimeout(() => { if(!window.closed) window.location.href='about:blank'; }, 100);">
          Close Window
        </button>
        <div class="logo">Plansure</div>
      </div>
    </body>
    </html>
  `;
};

router.get("/invite/accept/:token", async (req, res) => {
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
      return res.send(
        renderResponsePage(
          "Invalid or Expired",
          "This invitation link is invalid or has already been used. Please contact your administrator for a new invitation.",
          "error",
        ),
      );
    }

    const generatedPassword = crypto.randomBytes(4).toString("hex") + "A1!";

    user.password = generatedPassword;
    user.status = "active";
    user.inviteToken = undefined;
    user.inviteTokenExpiry = undefined;
    await user.save();

    try {
      await sendWelcomeEmail({
        email: user.email,
        name: user.name,
        password: generatedPassword,
      });
    } catch (emailError) {
      console.error("Failed to send welcome email:", emailError);
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Welcome to Plansure</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .card {
            background: #1e293b;
            border-radius: 16px;
            padding: 40px;
            text-align: center;
            max-width: 420px;
            width: 100%;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          .icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: #22c55e;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            font-size: 40px;
            color: white;
          }
          h1 { color: #f1f5f9; font-size: 24px; margin-bottom: 12px; }
          p { color: #94a3b8; font-size: 16px; line-height: 1.6; margin-bottom: 20px; }
          .password-box {
            background: #0f172a;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .password-label { color: #64748b; font-size: 14px; margin-bottom: 8px; }
          .password {
            color: #3b82f6;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 2px;
          }
          .btn {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 14px 32px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: background 0.2s;
          }
          .btn:hover { background: #2563eb; }
          .note { color: #64748b; font-size: 13px; margin-top: 16px; }
          .logo { color: #64748b; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h1>Welcome to Plansure!</h1>
          <p>Your account has been activated successfully.</p>
          <div class="password-box">
            <div class="password-label">Your temporary password</div>
            <div class="password">${generatedPassword}</div>
          </div>
          <a href="${frontendUrl}/login" class="btn">Go to Login</a>
          <div class="note">Please change your password after logging in.</div>
          <div class="logo">Plansure</div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    return res.send(
      renderResponsePage(
        "Something Went Wrong",
        "An error occurred while processing your invitation. Please try again or contact your administrator.",
        "error",
      ),
    );
  }
});

router.get("/invite/reject/:token", async (req, res) => {
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
      return res.send(
        renderResponsePage(
          "Invalid or Expired",
          "This invitation link is invalid or has already been used.",
          "error",
        ),
      );
    }

    await Admin.findByIdAndDelete(user._id);

    return res.send(
      renderResponsePage(
        "Invitation Declined",
        "You have declined the invitation to join Plansure. You can close this window.",
        "warning",
      ),
    );
  } catch (error) {
    console.error(error);
    return res.send(
      renderResponsePage(
        "Something Went Wrong",
        "An error occurred while processing your request. Please try again.",
        "error",
      ),
    );
  }
});

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

router.get("/", protect, adminOnly, async (req, res) => {
  try {
    const { status, role, search } = req.query;

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

    const formattedUsers = users.map((user) => ({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      projectAccess:
        user.projects && user.projects.length > 0
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

router.put("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, role, projects, status } = req.body;

    const user = await Admin.findById(req.params.id).populate(
      "projects",
      "name",
    );
    if (!user) {
      return sendError(res, "User not found", 404);
    }

    const wasPending = user.status === "pending";
    const oldProjects = user.projects
      .map((p) => p._id.toString())
      .sort()
      .join(",");
    const oldRole = user.role;

    if (name) user.name = name;
    if (role) user.role = role;
    if (projects !== undefined) user.projects = projects;
    if (status) user.status = status;

    const newProjects = (projects || []).sort().join(",");
    const shouldResendInvite =
      wasPending && (oldProjects !== newProjects || oldRole !== role);

    if (shouldResendInvite) {
      const inviteToken = user.generateInviteToken();
      await user.save();

      const Project = require("../models/Project");
      let projectName = "All Projects";
      if (projects && projects.length > 0) {
        const projectDocs = await Project.find({ _id: { $in: projects } });
        projectName = projectDocs.map((p) => p.name).join(", ");
      }

      const backendUrl =
        process.env.BACKEND_URL ||
        `http://localhost:${process.env.PORT || 4000}`;
      const acceptUrl = `${backendUrl}/api/users/invite/accept/${inviteToken}`;
      const rejectUrl = `${backendUrl}/api/users/invite/reject/${inviteToken}`;

      try {
        await sendInviteEmail({
          email: user.email,
          name: user.name,
          role: user.role,
          projectName,
          invitedByName: req.admin.name,
          acceptUrl,
          rejectUrl,
        });
      } catch (emailError) {
        console.error("Failed to send invite email:", emailError);
      }

      const updatedUser = await Admin.findById(user._id)
        .select("-password -inviteToken -inviteTokenExpiry")
        .populate("projects", "name");

      return sendSuccess(
        res,
        { user: updatedUser },
        "User updated and new invitation sent",
      );
    }

    const wasActive = !wasPending && user.status === "active";
    const shouldNotifyActiveUser =
      wasActive && (oldProjects !== newProjects || oldRole !== role);

    await user.save();

    if (shouldNotifyActiveUser) {
      const Project = require("../models/Project");

      let oldProjectName = "All Projects";
      if (oldProjects) {
        const oldProjectIds = oldProjects.split(",").filter((id) => id);
        if (oldProjectIds.length > 0) {
          const oldProjectDocs = await Project.find({
            _id: { $in: oldProjectIds },
          });
          oldProjectName =
            oldProjectDocs.map((p) => p.name).join(", ") || "All Projects";
        }
      }

      let newProjectName = "All Projects";
      if (projects && projects.length > 0) {
        const newProjectDocs = await Project.find({ _id: { $in: projects } });
        newProjectName =
          newProjectDocs.map((p) => p.name).join(", ") || "All Projects";
      }

      try {
        await sendRoleChangeEmail({
          email: user.email,
          name: user.name,
          oldRole: oldRole.charAt(0).toUpperCase() + oldRole.slice(1),
          newRole:
            (role || oldRole).charAt(0).toUpperCase() +
            (role || oldRole).slice(1),
          oldProject: oldProjectName,
          newProject: newProjectName,
        });
      } catch (emailError) {
        console.error("Failed to send role change email:", emailError);
      }
    }

    const updatedUser = await Admin.findById(user._id)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name");

    return sendSuccess(res, { user: updatedUser }, "User updated successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/:id/block", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (user._id.toString() === req.admin._id.toString()) {
      return sendValidationError(res, [
        { field: "user", message: "You cannot block yourself" },
      ]);
    }

    if (user.status === "blocked") {
      user.status = "active";
    } else {
      user.status = "blocked";
    }

    await user.save();

    return sendSuccess(
      res,
      { status: user.status },
      `User ${user.status === "blocked" ? "blocked" : "unblocked"} successfully`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

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

router.post("/:id/resend-invite", protect, adminOnly, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id).populate(
      "projects",
      "name",
    );

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (user.status !== "pending") {
      return sendValidationError(res, [
        {
          field: "status",
          message: "User has already accepted the invitation",
        },
      ]);
    }

    const inviteToken = user.generateInviteToken();
    await user.save();

    const backendUrl =
      process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
    const acceptUrl = `${backendUrl}/api/users/invite/accept/${inviteToken}`;
    const rejectUrl = `${backendUrl}/api/users/invite/reject/${inviteToken}`;

    const projectName =
      user.projects && user.projects.length > 0
        ? user.projects.map((p) => p.name).join(", ")
        : "All Projects";

    let emailSent = true;
    try {
      await sendInviteEmail({
        email: user.email,
        name: user.name,
        role: user.role,
        projectName,
        invitedByName: req.admin.name,
        acceptUrl,
        rejectUrl,
      });
    } catch (emailError) {
      console.error("Failed to resend invite email:", emailError);
      emailSent = false;
    }

    return sendSuccess(
      res,
      { emailSent },
      emailSent ? "Invitation resent successfully" : "Invitation token refreshed but email could not be sent. Please configure SMTP settings."
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
