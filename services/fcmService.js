const { getMessaging } = require("../config/firebase");
const Admin = require("../models/Admin");

/**
 * Send push notification to a single user
 */
const sendToUser = async (userId, notification) => {
  try {
    const user = await Admin.findById(userId);

    if (user?.fcmTokens?.length > 0) {
    }

    if (!user || !user.pushNotificationsEnabled || !user.fcmTokens?.length) {
      return { success: false, reason: "No valid FCM tokens or push disabled" };
    }

    /*
     * One token is one browser. Addressing the same token twice makes that
     * browser raise two OS notifications, so collapse repeats before the
     * multicast regardless of how the rows got there.
     */
    const tokens = [...new Set(user.fcmTokens.map((t) => t.token))];
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
  const messaging = getMessaging();

  if (!messaging) {
    return { success: false, reason: "Firebase not configured" };
  }

  if (!tokens.length) {
    return { success: false, reason: "No tokens provided" };
  }

  const message = {
    data: {
      title: notification.title || "New Notification",
      body: notification.body || "You have a new notification",
      clickUrl: notification.data?.clickUrl || process.env.FRONTEND_URL || "/",
      type: notification.data?.type || "general",
      actionId: notification.data?.actionId || "",
      projectId: notification.data?.projectId || "",
      notificationId:
        notification.data?.notificationId || Date.now().toString(),
    },
    webpush: {
      headers: {
        Urgency: "high",
      },
    },
  };

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      ...message,
    });

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
      } else {
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
      }
    }

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
    planner_todo_generated: {
      title: "Planner To-Do Issued",
      body:
        data.message ||
        "A new Planner To-Do list is ready for you to action.",
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
    /* `title` is passed through as well as under actionTitle: the "general"
       entry in the content map titles itself from data.title, so without it
       every general push arrived headed "Notification". */
    const pushContent = getNotificationContent(type, {
      title,
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
