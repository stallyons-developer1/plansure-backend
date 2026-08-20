const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const { protect } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/errorResponse");

router.post("/register-token", protect, async (req, res) => {
  try {
    const { token, deviceInfo } = req.body;

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

    /*
     * A token identifies a browser, not a person, so it must belong to exactly
     * one account — the one currently signed in. Without this, logging in as a
     * second user on the same browser leaves the token on both accounts and
     * every push to either one lands on the same device, which looks like
     * duplicate notifications.
     */
    await Admin.updateMany(
      { _id: { $ne: user._id }, "fcmTokens.token": token },
      { $pull: { fcmTokens: { token } } },
    );

    /*
     * Both steps below are conditional on the token's absence/presence inside
     * the update filter itself. Read-modify-write here (findById, scan the
     * array, push, save) loses the race when a browser registers twice at
     * once — both reads see no token, both push a row, and every later push
     * reaches that browser once per row as duplicate OS notifications.
     */
    /*
     * Every deployment URL is its own origin holding its own token, so an
     * account that has signed into several of them gets pushed to once per
     * deployment. Signing in here supersedes those: keep this origin's
     * tokens and drop the rest, which also clears legacy rows that predate
     * this field ($ne matches a missing origin). Several devices on the
     * same site keep working, since they share an origin.
     */
    const origin = req.get("origin") || null;
    if (origin) {
      await Admin.updateOne(
        { _id: user._id },
        { $pull: { fcmTokens: { origin: { $ne: origin } } } },
      );
    }

    const touched = await Admin.updateOne(
      { _id: user._id, "fcmTokens.token": token },
      {
        $set: {
          "fcmTokens.$.lastUsed": new Date(),
          "fcmTokens.$.origin": origin,
        },
      },
    );

    if (touched.matchedCount > 0) {
      return sendSuccess(res, {}, "Token already registered, updated lastUsed");
    }

    // Matches only while the token is still absent, so a concurrent insert
    // makes this a no-op rather than a second row.
    await Admin.updateOne(
      { _id: user._id, "fcmTokens.token": { $ne: token } },
      {
        $push: {
          fcmTokens: {
            token,
            deviceInfo: deviceInfo || "Unknown device",
            origin,
            createdAt: new Date(),
            lastUsed: new Date(),
          },
        },
      },
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

router.post("/test-push", protect, async (req, res) => {
  try {
    const { sendToUser } = require("../services/fcmService");

    const result = await sendToUser(req.admin._id, {
      title: "Test Push Notification",
      body: "If you see this, FCM is working!",
      data: { type: "test" },
    });

    return sendSuccess(res, { fcmResult: result }, "Test push sent");
  } catch (error) {
    console.error("Test push error:", error);
    return sendError(res, error.message, 500);
  }
});

router.delete("/clear-all-tokens", protect, async (req, res) => {
  try {
    await Admin.findByIdAndUpdate(req.admin._id, {
      $set: { fcmTokens: [] },
    });
    return sendSuccess(res, {}, "All FCM tokens cleared");
  } catch (error) {
    console.error("Clear tokens error:", error);
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
