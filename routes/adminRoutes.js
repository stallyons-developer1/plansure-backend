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

// @route   POST /api/auth/login
// @desc    Login for all roles (admin, user, planner)
// @access  Public
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    const errors = validateRequired({ email, password });

    // Validate email format if provided
    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const user = await Admin.findOne({ email });

    // Check if user exists
    if (!user) {
      return sendValidationError(res, [
        { field: "email", message: "No account found with this email" },
      ], 401);
    }

    // Check if user is blocked
    if (user.status === "blocked") {
      return sendValidationError(res, [
        { field: "email", message: "Your account has been blocked. Contact admin." },
      ], 403);
    }

    // Check if user is pending (hasn't accepted invite)
    if (user.status === "pending") {
      return sendValidationError(res, [
        { field: "email", message: "Please accept your invitation first" },
      ], 403);
    }

    // Verify password
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return sendValidationError(res, [
        { field: "password", message: "Incorrect password" },
      ], 401);
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate Sanctum-style token
    const token = await Token.generateToken(user._id);

    return sendSuccess(res, {
      token: token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    }, "Login successful");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

// @route   GET /api/auth/profile
// @desc    Get logged in user profile
// @access  Private
router.get("/profile", protect, async (req, res) => {
  res.json({
    _id: req.admin._id,
    name: req.admin.name,
    email: req.admin.email,
    role: req.admin.role,
  });
});

// @route   POST /api/auth/logout
// @desc    Logout user (delete current token)
// @access  Private
router.post("/logout", protect, async (req, res) => {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const [tokenId, tokenValue] = token.split("|");

    // Delete the token from database
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

// @route   POST /api/auth/logout-all
// @desc    Logout from all devices (delete all tokens for user)
// @access  Private
router.post("/logout-all", protect, async (req, res) => {
  try {
    // Delete all tokens for this user
    await Token.deleteMany({ user: req.admin._id });

    res.json({ message: "Logged out from all devices successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

module.exports = router;
