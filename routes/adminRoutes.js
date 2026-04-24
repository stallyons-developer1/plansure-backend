const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const Token = require("../models/Token");
const { protect } = require("../middleware/authMiddleware");

// @route   POST /api/auth/login
// @desc    Login for all roles (admin, user, planner)
// @access  Public
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Please provide email and password" });
    }

    const user = await Admin.findOne({ email });

    if (user && (await user.matchPassword(password))) {
      // Generate Sanctum-style token
      const token = await Token.generateToken(user._id);

      res.json({
        message: "Login successful.",
        token: token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
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

module.exports = router;
