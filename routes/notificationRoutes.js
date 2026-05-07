const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/errorResponse");

router.get("/", protect, async (req, res) => {
  try {
    const { limit = 20, unreadOnly = false } = req.query;

    let filter = { recipient: req.admin._id };
    if (unreadOnly === "true") {
      filter.isRead = false;
    }

    const notifications = await Notification.find(filter)
      .populate("sender", "name email")
      .populate("action", "title")
      .populate("project", "name")
      .populate({
        path: "programme",
        select: "name project",
        populate: { path: "project", select: "name _id" },
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    const unreadCount = await Notification.countDocuments({
      recipient: req.admin._id,
      isRead: false,
    });

    return sendSuccess(res, { notifications, unreadCount });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/unread-count", protect, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.admin._id,
      isRead: false,
    });

    return sendSuccess(res, { count });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/:id/read", protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.admin._id },
      { isRead: true, readAt: new Date() },
      { new: true },
    );

    if (!notification) {
      return sendError(res, "Notification not found", 404);
    }

    return sendSuccess(res, { notification }, "Notification marked as read");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/read-all", protect, async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.admin._id, isRead: false },
      { isRead: true, readAt: new Date() },
    );

    return sendSuccess(res, {}, "All notifications marked as read");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      recipient: req.admin._id,
    });

    if (!notification) {
      return sendError(res, "Notification not found", 404);
    }

    return sendSuccess(res, {}, "Notification deleted");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
