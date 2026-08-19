const { CLOSED_ACTION_STATUSES } = require("./governance");

/*
 * Notifies planners once a programme has no open actions left — every action
 * is either Completed or force-closed by PM Override.
 *
 * Called after any change that closes an action. It only fires on the
 * transition to zero, because the caller has just closed one: if the count is
 * now zero, that closure was the last one. Re-opening and re-closing an action
 * legitimately notifies again.
 */
const notifyPlannersIfAllActionsClosed = async ({ programmeId, sender }) => {
  const Action = require("../models/Action");
  const Programme = require("../models/Programme");
  const Project = require("../models/Project");
  const Admin = require("../models/Admin");
  const Notification = require("../models/Notification");
  const { sendPushForNotification } = require("../services/fcmService");

  const [total, stillOpen] = await Promise.all([
    Action.countDocuments({ programme: programmeId }),
    Action.countDocuments({
      programme: programmeId,
      status: { $nin: CLOSED_ACTION_STATUSES },
    }),
  ]);

  // Nothing to report on a programme with no actions, and nothing to announce
  // while work is still outstanding.
  if (total === 0 || stillOpen > 0) return [];

  const programme = await Programme.findById(programmeId).select("name project");
  if (!programme) return [];

  const [completed, overridden] = await Promise.all([
    Action.countDocuments({ programme: programmeId, status: "Completed" }),
    Action.countDocuments({ programme: programmeId, status: "PM Override" }),
  ]);

  const project = programme.project
    ? await Project.findById(programme.project).select("team name")
    : null;

  const planners = await Admin.find({
    role: "planner",
    status: "active",
  }).select("_id");

  const teamPlanners = (project?.team || [])
    .filter((member) => member.role === "Planner" && member.user)
    .map((member) => member.user);

  const recipients = [
    ...new Set(
      [...planners.map((p) => p._id), ...teamPlanners]
        .filter(Boolean)
        .map(String),
    ),
  ].filter((id) => id !== String(sender?._id));

  if (recipients.length === 0) return [];

  const title = "All Actions Closed";
  const overriddenNote = overridden
    ? ` (${overridden} via PM Override)`
    : "";
  const message = `All ${total} action${total === 1 ? "" : "s"} on "${
    project?.name || programme.name
  }" are now closed — ${completed} completed${overriddenNote}. The programme is ready for your update.`;

  for (const recipient of recipients) {
    await Notification.create({
      recipient,
      sender: sender?._id,
      type: "planner_todo_generated",
      title,
      message,
      programme: programme._id,
      project: programme.project,
    });

    sendPushForNotification(recipient, "planner_todo_generated", {
      title,
      message,
      programmeId: programme._id,
      projectId: programme.project,
    });
  }

  return recipients;
};

module.exports = { notifyPlannersIfAllActionsClosed };
