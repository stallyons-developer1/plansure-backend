const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const { protect } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/errorResponse");

router.post("/register-token", protect, async (req, res) => {
  try {
    const { token, deviceInfo } = req.body;
    console.log(
      "[FCM Route] Register token for user:",
      req.admin._id,
      req.admin.email,
    );
    console.log("[FCM Route] Token preview:", token?.substring(0, 30) + "...");

    if (!token) {
      return sendError(res, "FCM token is required", 400);
    }

    const user = await Admin.findById(req.admin._id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!user.fcmTokens) {
      user.fcmTokens = [];
    }

    const existingTokenIndex = user.fcmTokens.findIndex(
      (t) => t.token === token,
    );

    if (existingTokenIndex !== -1) {
      user.fcmTokens[existingTokenIndex].lastUsed = new Date();
      await user.save();
      console.log("[FCM Route] Token already exists, updated lastUsed");
      return sendSuccess(res, {}, "Token already registered, updated lastUsed");
    }

    user.fcmTokens.push({
      token,
      deviceInfo: deviceInfo || "Unknown device",
      createdAt: new Date(),
      lastUsed: new Date(),
    });

    await user.save();
    console.log(
      "[FCM Route] NEW token registered, total tokens:",
      user.fcmTokens.length,
    );
    return sendSuccess(res, {}, "FCM token registered successfully");
  } catch (error) {
    console.error("FCM token registration error:", error);
    return sendError(res, "Server error", 500);
  }
});

router.delete("/unregister-token", protect, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return sendError(res, "FCM token is required", 400);
    }

    await Admin.findByIdAndUpdate(req.admin._id, {
      $pull: { fcmTokens: { token } },
    });

    return sendSuccess(res, {}, "FCM token removed successfully");
  } catch (error) {
    console.error("FCM token removal error:", error);
    return sendError(res, "Server error", 500);
  }
});

router.patch("/toggle-push", protect, async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== "boolean") {
      return sendError(res, "enabled must be a boolean", 400);
    }

    const user = await Admin.findByIdAndUpdate(
      req.admin._id,
      { pushNotificationsEnabled: enabled },
      { new: true },
    );

    return sendSuccess(
      res,
      { pushNotificationsEnabled: user.pushNotificationsEnabled },
      `Push notifications ${enabled ? "enabled" : "disabled"}`,
    );
  } catch (error) {
    console.error("Toggle push error:", error);
    return sendError(res, "Server error", 500);
  }
});

router.get("/status", protect, async (req, res) => {
  try {
    const user = await Admin.findById(req.admin._id).select(
      "fcmTokens pushNotificationsEnabled",
    );

    return sendSuccess(res, {
      pushNotificationsEnabled: user.pushNotificationsEnabled ?? true,
      registeredDevices: user.fcmTokens?.length || 0,
      devices:
        user.fcmTokens?.map((t) => ({
          deviceInfo: t.deviceInfo,
          lastUsed: t.lastUsed,
          createdAt: t.createdAt,
        })) || [],
    });
  } catch (error) {
    console.error("FCM status error:", error);
    return sendError(res, "Server error", 500);
  }
});

module.exports = router;
