const { CLOSED_ACTION_STATUSES } = require("./governance");

/*
 * Who counts as "the planners" for a programme.
 *
 * Every active planner is included, not only those assigned to the project:
 * planners are not reliably linked to projects in this data, so scoping by
 * assignment silently reached nobody. Project team members carrying the
 * Planner role are included too, since that is recorded separately. The person
 * who triggered the event is excluded — they do not need telling.
 */
const resolvePlannerRecipients = async ({ project, sender }) => {
  const Admin = require("../models/Admin");

  const planners = await Admin.find({
    role: "planner",
    status: "active",
  }).select("_id");

  const teamPlanners = (project?.team || [])
    .filter((member) => member.role === "Planner" && member.user)
    .map((member) => member.user);

  return [
    ...new Set(
      [...planners.map((p) => p._id), ...teamPlanners]
        .filter(Boolean)
        .map(String),
    ),
  ].filter((id) => id !== String(sender?._id));
};

/* Creates the in-app notification and fires the matching push. */
const dispatch = async ({ recipients, sender, title, message, programme }) => {
  const Notification = require("../models/Notification");
  const { sendPushForNotification } = require("../services/fcmService");

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

/*
 * Notifies planners that a Planner To-Do has been issued for them to work
 * through. Fires when the list is generated.
 */
const notifyPlannersOfTodoGenerated = async ({
  programme,
  weekNumber,
  totalActions,
  sender,
}) => {
  if (!programme) return [];

  const Project = require("../models/Project");
  const project = programme.project
    ? await Project.findById(programme.project).select("team name")
    : null;

  const recipients = await resolvePlannerRecipients({ project, sender });
  if (recipients.length === 0) return [];

  const title = "Planner To-Do Issued";
  const message = `The Planner To-Do for Week ${weekNumber} on "${
    project?.name || programme.name
  }" is ready — ${totalActions} item${
    totalActions === 1 ? "" : "s"
  } to action.`;

  const notified = await dispatch({
    recipients,
    sender,
    title,
    message,
    programme,
  });

  /* Email the same planners the in-app notification went to. Isolated per
     recipient so one bad address does not stop the rest, and isolated as a
     whole so a mail outage cannot fail the export. */
  try {
    const Admin = require("../models/Admin");
    const { sendPlannerTodoEmail } = require("./email");
    const people = await Admin.find({ _id: { $in: notified } }).select(
      "name email",
    );

    for (const person of people) {
      if (!person.email) continue;
      try {
        await sendPlannerTodoEmail({
          email: person.email,
          name: person.name,
          projectName: project?.name || programme.name,
          weekNumber,
          totalActions,
          generatedByName: sender?.name,
          generatedByEmail: sender?.email,
        });
      } catch (emailError) {
        console.error("Planner To-Do email failed:", emailError);
      }
    }
  } catch (lookupError) {
    console.error("Planner To-Do email lookup failed:", lookupError);
  }

  return notified;
};

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

  const recipients = await resolvePlannerRecipients({ project, sender });
  if (recipients.length === 0) return [];

  const title = "All Actions Closed";
  const overriddenNote = overridden ? ` (${overridden} via PM Override)` : "";
  const message = `All ${total} action${total === 1 ? "" : "s"} on "${
    project?.name || programme.name
  }" are now closed — ${completed} completed${overriddenNote}. The programme is ready for your update.`;

  return dispatch({ recipients, sender, title, message, programme });
};

module.exports = {
  notifyPlannersOfTodoGenerated,
  notifyPlannersIfAllActionsClosed,
};
