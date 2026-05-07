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

    console.log(
      `[LOGIN] Attempt for ${email}, found user status: ${user?.status || "NOT FOUND"}`,
    );

    if (!user) {
      return sendValidationError(
        res,
        [{ field: "email", message: "No account found with this email" }],
        401,
      );
    }

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

    if (user.status === "pending") {
      console.log(
        `[LOGIN] User ${email} rejected - status is still pending. User ID: ${user._id}`,
      );
      return sendValidationError(
        res,
        [{ field: "email", message: "Please accept your invitation first" }],
        403,
      );
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return sendValidationError(
        res,
        [{ field: "password", message: "Incorrect password" }],
        401,
      );
    }

    user.lastLogin = new Date();
    await user.save();

    const token = await Token.generateToken(user._id);

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

router.get("/profile", protect, async (req, res) => {
  res.json({
    _id: req.admin._id,
    name: req.admin.name,
    email: req.admin.email,
    role: req.admin.role,
  });
});

// Update profile (name, email)
router.put("/profile", protect, async (req, res) => {
  try {
    const { name, email } = req.body;

    const errors = [];
    if (!name || name.trim() === "") {
      errors.push({ field: "name", message: "Name is required" });
    }
    if (!email || email.trim() === "") {
      errors.push({ field: "email", message: "Email is required" });
    } else {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    // Check if email is already taken by another user
    if (email !== req.admin.email) {
      const existingUser = await Admin.findOne({ email, _id: { $ne: req.admin._id } });
      if (existingUser) {
        return sendValidationError(res, [
          { field: "email", message: "Email is already in use" },
        ]);
      }
    }

    const updatedUser = await Admin.findByIdAndUpdate(
      req.admin._id,
      { name: name.trim(), email: email.trim().toLowerCase() },
      { new: true }
    ).select("-password");

    return sendSuccess(res, {
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
      },
    }, "Profile updated successfully");
  } catch (error) {
    console.error("Profile update error:", error);
    return sendError(res, "Server error");
  }
});

// Change password
router.put("/password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    const errors = [];
    if (!currentPassword) {
      errors.push({ field: "currentPassword", message: "Current password is required" });
    }
    if (!newPassword) {
      errors.push({ field: "newPassword", message: "New password is required" });
    } else if (newPassword.length < 6) {
      errors.push({ field: "newPassword", message: "Password must be at least 6 characters" });
    }
    if (!confirmPassword) {
      errors.push({ field: "confirmPassword", message: "Please confirm your new password" });
    } else if (newPassword !== confirmPassword) {
      errors.push({ field: "confirmPassword", message: "Passwords do not match" });
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findById(req.admin._id);

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return sendValidationError(res, [
        { field: "currentPassword", message: "Current password is incorrect" },
      ], 401);
    }

    user.password = newPassword;
    await user.save();

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
