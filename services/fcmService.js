const { getMessaging } = require("../config/firebase");
const Admin = require("../models/Admin");

/**
 * Send push notification to a single user
 */
const sendToUser = async (userId, notification) => {
  console.log("[Push] ========================================");
  console.log("[Push] sendToUser called for userId:", userId);
  console.log("[Push] Notification:", JSON.stringify(notification, null, 2));
  try {
    const user = await Admin.findById(userId);
    console.log("[Push] User lookup result:");
    console.log("[Push]   - Found:", !!user);
    console.log("[Push]   - Email:", user?.email);
    console.log("[Push]   - Push enabled:", user?.pushNotificationsEnabled);
    console.log("[Push]   - FCM tokens:", user?.fcmTokens?.length || 0);
    if (user?.fcmTokens?.length > 0) {
      console.log(
        "[Push]   - Token preview:",
        user.fcmTokens[0].token.substring(0, 30) + "...",
      );
    }

    if (!user || !user.pushNotificationsEnabled || !user.fcmTokens?.length) {
      console.log("[Push] BLOCKED - no tokens or push disabled");
      return { success: false, reason: "No valid FCM tokens or push disabled" };
    }

    const tokens = user.fcmTokens.map((t) => t.token);
    console.log("[Push] Sending to", tokens.length, "token(s)...");
    return await sendToTokens(tokens, notification, userId);
  } catch (error) {
    console.error("[Push] sendToUser ERROR:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Send push notification to multiple tokens
 */
const sendToTokens = async (tokens, notification, userId = null) => {
  console.log("[Push] sendToTokens with", tokens.length, "token(s)");
  const messaging = getMessaging();

  if (!messaging) {
    console.log("[Push] ERROR: Firebase messaging not initialized!");
    return { success: false, reason: "Firebase not configured" };
  }

  if (!tokens.length) {
    console.log("[Push] ERROR: No tokens provided");
    return { success: false, reason: "No tokens provided" };
  }

  // Use data-only message to ensure it goes through service worker
  const message = {
    data: {
      title: notification.title || "New Notification",
      body: notification.body || "You have a new notification",
      clickUrl: notification.data?.clickUrl || process.env.FRONTEND_URL || "/",
      type: notification.data?.type || "general",
      actionId: notification.data?.actionId || "",
      projectId: notification.data?.projectId || "",
      notificationId: notification.data?.notificationId || Date.now().toString(),
    },
    webpush: {
      headers: {
        Urgency: "high",
      },
    },
  };

  console.log("[Push] FCM Message payload:", JSON.stringify(message, null, 2));

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      ...message,
    });

    console.log(
      "[Push] FCM Response:",
      JSON.stringify({
        successCount: response.successCount,
        failureCount: response.failureCount,
      }),
    );

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.log(
          "[Push] Token",
          idx,
          "FAILED:",
          resp.error?.code,
          resp.error?.message,
        );
      } else {
        console.log("[Push] Token", idx, "SUCCESS, messageId:", resp.messageId);
      }
    });

    if (response.failureCount > 0 && userId) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (
            errorCode === "messaging/invalid-registration-token" ||
            errorCode === "messaging/registration-token-not-registered"
          ) {
            invalidTokens.push(tokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await removeInvalidTokens(userId, invalidTokens);
        console.log("[Push] Removed", invalidTokens.length, "invalid token(s)");
      }
    }

    console.log("[Push] ========================================");

    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (error) {
    console.error("[Push] sendToTokens EXCEPTION:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Remove invalid tokens from user's fcmTokens array
 */
const removeInvalidTokens = async (userId, invalidTokens) => {
  try {
    await Admin.findByIdAndUpdate(userId, {
      $pull: { fcmTokens: { token: { $in: invalidTokens } } },
    });
  } catch (error) {
    console.error("[FCM] removeInvalidTokens error:", error);
  }
};

/**
 * Map notification type to push notification content
 */
const getNotificationContent = (type, data) => {
  const contentMap = {
    action_assigned: {
      title: "New Action Assigned",
      body:
        data.message ||
        `You have been assigned a new action: "${data.actionTitle}"`,
    },
    action_reassigned: {
      title: "Action Reassigned",
      body:
        data.message ||
        `An action has been reassigned to you: "${data.actionTitle}"`,
    },
    action_completed: {
      title: "Action Completed",
      body:
        data.message || `An action has been completed: "${data.actionTitle}"`,
    },
    project_assigned: {
      title: "New Project Assignment",
      body:
        data.message ||
        `You have been assigned to project: "${data.projectName}"`,
    },
    general: {
      title: data.title || "Notification",
      body: data.message || "You have a new notification",
    },
  };

  return contentMap[type] || contentMap.general;
};

/**
 * Send push notification when creating an in-app notification
 */
const sendPushForNotification = async (
  recipientId,
  type,
  { title, message, actionId, programmeId, projectId },
) => {
  try {
    const pushContent = getNotificationContent(type, {
      message,
      actionTitle: title,
    });

    const clickUrl = projectId
      ? `${process.env.FRONTEND_URL || ""}/planner/projects/${projectId}?tab=actions`
      : process.env.FRONTEND_URL || "/";

    const result = await sendToUser(recipientId, {
      ...pushContent,
      data: {
        type,
        actionId: actionId?.toString() || "",
        programmeId: programmeId?.toString() || "",
        projectId: projectId?.toString() || "",
        clickUrl,
      },
    });

    if (result.success) {
      console.log("[Push] Notification sent:", {
        type,
        title,
        recipientId: recipientId.toString(),
      });
    }
  } catch (error) {}
};

module.exports = {
  sendToUser,
  sendToTokens,
  removeInvalidTokens,
  getNotificationContent,
  sendPushForNotification,
};
