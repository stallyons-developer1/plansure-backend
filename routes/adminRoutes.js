const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const Token = require("../models/Token");
const { protect } = require("../middleware/authMiddleware");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
  validateEmail,
} = require("../utils/errorResponse");
const auditLogger = require("../utils/auditLogger");
const crypto = require("crypto");
const { sendPasswordResetEmail } = require("../utils/email");

/* Trailing slashes would otherwise produce "…app//reset-password/x". */
const frontendBase = () =>
  (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

const hashResetToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

/* This form answers honestly about whether an address has an account, which
   does let someone test emails against the system. That is a deliberate call:
   POST /login already says "No account found with this email", so hiding it
   here would protect nothing while leaving people guessing why no mail
   arrived. Both routes should stay in step if that is ever revisited. */

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const errors = validateRequired({ email, password });

    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findOne({ email });

    if (!user) {
      await auditLogger.loginFailed(req, email, "No account found");
      return sendValidationError(
        res,
        [{ field: "email", message: "No account found with this email" }],
        401,
      );
    }

    if (user.status === "blocked") {
      await auditLogger.loginFailed(req, email, "Account blocked");
      return sendValidationError(
        res,
        [
          {
            field: "email",
            message: "Your account has been blocked. Contact admin.",
          },
        ],
        403,
      );
    }

    if (user.status === "pending") {
      await auditLogger.loginFailed(req, email, "Account pending invitation");
      return sendValidationError(
        res,
        [{ field: "email", message: "Please accept your invitation first" }],
        403,
      );
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      await auditLogger.loginFailed(req, email, "Incorrect password");
      return sendValidationError(
        res,
        [{ field: "password", message: "Incorrect password" }],
        401,
      );
    }

    user.lastLogin = new Date();
    await user.save();

    const token = await Token.generateToken(user._id);

    await auditLogger.loginSuccess(req, user);

    return sendSuccess(
      res,
      {
        token: token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
      "Login successful",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

/* Password reset, in three parts: request a link, check the link is still
   good, then use it. The token is single-use and short-lived — see
   generatePasswordResetToken on the Admin model. */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const errors = validateRequired({ email });
    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      return sendValidationError(
        res,
        [{ field: "email", message: "No account found with this email" }],
        404,
      );
    }

    /* Wording matches POST /login so the same account state does not get two
       different explanations depending on which form you are standing in. */
    if (user.status === "blocked") {
      return sendValidationError(
        res,
        [
          {
            field: "email",
            message: "Your account has been blocked. Contact admin.",
          },
        ],
        403,
      );
    }

    /* Nothing to reset: an unaccepted invitation has never had a password.
       The invite link is the way in, not this form. */
    if (user.status !== "active") {
      return sendValidationError(
        res,
        [{ field: "email", message: "Please accept your invitation first" }],
        403,
      );
    }

    const resetToken = user.generatePasswordResetToken();
    await user.save();

    const resetUrl = `${frontendBase()}/reset-password/${resetToken}`;

    try {
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        resetUrl,
      });
    } catch (emailError) {
      /* The link is useless if it never arrives, so clear it rather than
         leaving a live token nobody can see. */
      console.error("Failed to send password reset email:", emailError);
      user.resetPasswordToken = undefined;
      user.resetPasswordTokenExpiry = undefined;
      await user.save();
      return sendError(
        res,
        "Could not send the reset email. Please try again shortly.",
        502,
      );
    }

    await auditLogger.log({
      action: "PASSWORD_RESET_REQUESTED",
      req,
      user,
      resourceType: "User",
      resourceId: user._id,
      resourceName: user.name,
      description: `${user.name} requested a password reset`,
    });

    return sendSuccess(res, {}, "A reset link has been sent to your email.");
  } catch (error) {
    console.error("Forgot password error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/reset-password/:token/verify", async (req, res) => {
  try {
    const user = await Admin.findOne({
      resetPasswordToken: hashResetToken(req.params.token),
      resetPasswordTokenExpiry: { $gt: Date.now() },
      status: "active",
    });

    if (!user) {
      return sendValidationError(
        res,
        [
          {
            field: "token",
            message: "This reset link is invalid or has expired",
          },
        ],
        400,
      );
    }

    return sendSuccess(res, {
      valid: true,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Reset token verify error:", error);
    return sendError(res, "Server error");
  }
});

router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;

    const errors = [];
    if (!password) {
      errors.push({ field: "password", message: "New password is required" });
    } else if (password.length < 6) {
      errors.push({
        field: "password",
        message: "Password must be at least 6 characters",
      });
    }
    if (!confirmPassword) {
      errors.push({
        field: "confirmPassword",
        message: "Please confirm your new password",
      });
    } else if (password !== confirmPassword) {
      errors.push({
        field: "confirmPassword",
        message: "Passwords do not match",
      });
    }
    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findOne({
      resetPasswordToken: hashResetToken(req.params.token),
      resetPasswordTokenExpiry: { $gt: Date.now() },
      status: "active",
    });

    if (!user) {
      return sendValidationError(
        res,
        [
          {
            field: "token",
            message: "This reset link is invalid or has expired",
          },
        ],
        400,
      );
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordTokenExpiry = undefined;
    await user.save();

    /* Whoever asked for this may be locked out because someone else is signed
       in as them, so every existing session goes with the old password. */
    await Token.deleteMany({ user: user._id });

    await auditLogger.log({
      action: "PASSWORD_CHANGED",
      req,
      user,
      resourceType: "User",
      resourceId: user._id,
      resourceName: user.name,
      description: `${user.name} reset their password using an emailed link`,
    });

    return sendSuccess(
      res,
      {},
      "Password reset. You can now sign in with your new password.",
    );
  } catch (error) {
    console.error("Reset password error:", error);
    return sendError(res, "Server error");
  }
});

router.get("/profile", protect, async (req, res) => {
  res.json({
    _id: req.admin._id,
    name: req.admin.name,
    email: req.admin.email,
    role: req.admin.role,
  });
});

router.put("/profile", protect, async (req, res) => {
  try {
    const { name, email } = req.body;

    /* Email is optional here. The settings form states that email cannot be
       changed and therefore sends only the name — requiring email made every
       save fail with "Email is required". It is still validated when a client
       does send one. */
    const errors = [];
    if (!name || name.trim() === "") {
      errors.push({ field: "name", message: "Name is required" });
    }
    if (email !== undefined && email.trim() !== "") {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    if (email && email !== req.admin.email) {
      const existingUser = await Admin.findOne({
        email,
        _id: { $ne: req.admin._id },
      });
      if (existingUser) {
        return sendValidationError(res, [
          { field: "email", message: "Email is already in use" },
        ]);
      }
    }

    const update = { name: name.trim() };
    if (email && email.trim()) update.email = email.trim().toLowerCase();

    const updatedUser = await Admin.findByIdAndUpdate(req.admin._id, update, {
      new: true,
    }).select("-password");

    return sendSuccess(
      res,
      {
        user: {
          id: updatedUser._id,
          name: updatedUser.name,
          email: updatedUser.email,
          role: updatedUser.role,
        },
      },
      "Profile updated successfully",
    );
  } catch (error) {
    console.error("Profile update error:", error);
    return sendError(res, "Server error");
  }
});

router.put("/password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    const errors = [];
    if (!currentPassword) {
      errors.push({
        field: "currentPassword",
        message: "Current password is required",
      });
    }
    if (!newPassword) {
      errors.push({
        field: "newPassword",
        message: "New password is required",
      });
    } else if (newPassword.length < 6) {
      errors.push({
        field: "newPassword",
        message: "Password must be at least 6 characters",
      });
    }
    if (!confirmPassword) {
      errors.push({
        field: "confirmPassword",
        message: "Please confirm your new password",
      });
    } else if (newPassword !== confirmPassword) {
      errors.push({
        field: "confirmPassword",
        message: "Passwords do not match",
      });
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findById(req.admin._id);

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return sendValidationError(
        res,
        [
          {
            field: "currentPassword",
            message: "Current password is incorrect",
          },
        ],
        401,
      );
    }

    user.password = newPassword;
    await user.save();

    await auditLogger.log({
      action: "PASSWORD_CHANGED",
      req,
      user: req.admin,
      resourceType: "User",
      resourceId: req.admin._id,
      resourceName: req.admin.name,
      description: `${req.admin.name} changed their password`,
    });

    return sendSuccess(res, {}, "Password changed successfully");
  } catch (error) {
    console.error("Password change error:", error);
    return sendError(res, "Server error");
  }
});

router.post("/logout", protect, async (req, res) => {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const [tokenId, tokenValue] = token.split("|");

    await Token.findOneAndDelete({
      tokenId: parseInt(tokenId),
      token: tokenValue,
    });

    await auditLogger.logout(req, req.admin);

    res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.post("/logout-all", protect, async (req, res) => {
  try {
    await Token.deleteMany({ user: req.admin._id });

    res.json({ message: "Logged out from all devices successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

module.exports = router;
