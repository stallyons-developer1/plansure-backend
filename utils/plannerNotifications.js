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
const dispatch = async ({
  recipients,
  sender,
  title,
  message,
  programme,
  type = "planner_todo_generated",
}) => {
  const Notification = require("../models/Notification");
  const { sendPushForNotification } = require("../services/fcmService");

  for (const recipient of recipients) {
    await Notification.create({
      recipient,
      sender: sender?._id,
      type,
      title,
      message,
      programme: programme._id,
      project: programme.project,
    });

    sendPushForNotification(recipient, type, {
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

  const programme =
    await Programme.findById(programmeId).select("name project");
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

/*
 * Announces that a programme now satisfies every close-out condition. Nobody
 * triggers this — it is detected while evaluating eligibility — so there is no
 * sender to exclude and every planner is told.
 */
const emailPlannersCloseOutEligible = async ({ programme }) => {
  if (!programme) return [];

  const Project = require("../models/Project");
  const { sendCloseOutEligibleEmail } = require("./email");

  const project = programme.project
    ? await Project.findById(programme.project).select("team name")
    : null;

  /* Same audience as the other week-level events — planners, the uploader and
     the admins. Nobody triggers this one, so no actor is excluded. */
  const people = await resolveWeekStakeholders({
    programme,
    project,
    actor: null,
  });
  if (people.length === 0) return [];

  const weekNumber = programme.weekNumber || 1;
  const projectName = project?.name || programme.name;

  for (const person of people) {
    try {
      await sendCloseOutEligibleEmail({
        email: person.email,
        name: person.name,
        projectName,
        weekNumber,
      });
    } catch (emailError) {
      console.error("Close-out eligible email failed:", emailError);
    }
  }

  const recipients = people.map((p) => String(p._id));

  try {
    await dispatch({
      recipients,
      sender: null,
      type: "general",
      title: "Ready for Close-Out",
      message: `Week ${weekNumber} on "${projectName}" has met every close-out condition and can now be marked Close-Out Eligible.`,
      programme,
    });
  } catch (notifyError) {
    console.error("Close-out ready notification failed:", notifyError);
  }

  return recipients;
};

/*
 * The people who carry a governance week: the project's planners, whoever
 * uploaded the programme (who owns it even when not a planner), and the
 * admins, who oversee the cycle and need to know when a Planner moves it on.
 * The actor is excluded — they performed the action and do not need telling.
 */
const resolveWeekStakeholders = async ({ programme, project, actor }) => {
  const Admin = require("../models/Admin");

  const planners = await resolvePlannerRecipients({ project, sender: actor });
  const uploader = programme.uploadedBy ? String(programme.uploadedBy) : null;

  const admins = await Admin.find({ role: "admin", status: "active" }).select(
    "_id",
  );

  const ids = [
    ...new Set(
      [...planners, uploader, ...admins.map((a) => String(a._id))].filter(
        (id) => id && id !== String(actor?._id),
      ),
    ),
  ];
  if (ids.length === 0) return [];

  const people = await Admin.find({ _id: { $in: ids } }).select("name email");
  return people.filter((p) => p.email);
};

/*
 * Announces that a week has been marked Close-Out Eligible. Distinct from the
 * "ready for close-out" announcement: that one says the conditions are met and
 * somebody should mark it, this one says somebody has.
 */
const emailStakeholdersMarkedCloseOutEligible = async ({
  programme,
  markedBy,
}) => {
  if (!programme) return [];

  const Project = require("../models/Project");
  const { sendMarkedCloseOutEligibleEmail } = require("./email");

  const project = programme.project
    ? await Project.findById(programme.project).select("team name")
    : null;

  const people = await resolveWeekStakeholders({
    programme,
    project,
    actor: markedBy,
  });

  for (const person of people) {
    try {
      await sendMarkedCloseOutEligibleEmail({
        email: person.email,
        name: person.name,
        weekNumber: programme.weekNumber || 1,
        projectName: project?.name || programme.name,
        markedByName: markedBy?.name,
        markedByEmail: markedBy?.email,
        markedByRole: markedBy?.role,
      });
    } catch (emailError) {
      console.error("Marked close-out eligible email failed:", emailError);
    }
  }

  const recipients = people.map((p) => String(p._id));

  /* Same audience gets the bell and the push. Isolated: the transition is
     already persisted and must not fail on a notification error. */
  try {
    const actor = markedBy?.name || "Someone";
    const role = markedBy?.role
      ? ` (${markedBy.role.charAt(0).toUpperCase()}${markedBy.role.slice(1)})`
      : "";
    await dispatch({
      recipients,
      sender: markedBy,
      type: "general",
      title: "Week Marked Close-Out Eligible",
      message: `${actor}${role} marked Week ${
        programme.weekNumber || 1
      } on "${project?.name || programme.name}" as Close-Out Eligible.`,
      programme,
    });
  } catch (notifyError) {
    console.error(
      "Marked close-out eligible notification failed:",
      notifyError,
    );
  }

  if (markedBy?._id) {
    try {
      await dispatch({
        recipients: [String(markedBy._id)],
        sender: markedBy,
        type: "general",
        title: "Week Marked Close-Out Eligible",
        message: `You marked Week ${
          programme.weekNumber || 1
        } on "${project?.name || programme.name}" as Close-Out Eligible.`,
        programme,
      });
    } catch (notifyError) {
      console.error("Marked eligible self-notification failed:", notifyError);
    }
  }

  return recipients;
};

/*
 * Tells the people who carry a week that it has been closed — the project's
 * planners plus whoever uploaded the programme, minus whoever did the closing.
 *
 * QA's scenario is a stakeholder other than the Planner closing the week, but
 * this fires on every close and names the closer: a Planner closing their own
 * week is still worth telling the rest of the team, and the record is more
 * useful than a conditional.
 *
 * Note this is a notification, not the MS-05 B1/B3 gate. It reports a close
 * after the fact; it does not stop a week closing without the Planner.
 */
const emailStakeholdersWeekClosed = async ({
  programme,
  weekNumber,
  closeType,
  notes,
  closedBy,
}) => {
  if (!programme) return [];

  const Admin = require("../models/Admin");
  const Project = require("../models/Project");
  const { sendWeekClosedEmail } = require("./email");

  const project = programme.project
    ? await Project.findById(programme.project).select("team name")
    : null;

  const people = await resolveWeekStakeholders({
    programme,
    project,
    actor: closedBy,
  });
  if (people.length === 0) return [];
  const recipients = people.map((p) => String(p._id));

  for (const person of people) {
    if (!person.email) continue;
    try {
      await sendWeekClosedEmail({
        email: person.email,
        name: person.name,
        weekNumber,
        projectName: project?.name || programme.name,
        closeType: closeType || "Normal Close",
        notes,
        closedByName: closedBy?.name,
        closedByEmail: closedBy?.email,
      });
    } catch (emailError) {
      console.error("Week closed email failed:", emailError);
    }
  }

  try {
    const actor = closedBy?.name || "The system";
    const via = closeType === "PM Override" ? " via PM Override" : "";
    await dispatch({
      recipients,
      sender: closedBy,
      type: "general",
      title: "Week Closed",
      message: `${actor} closed Week ${weekNumber} on "${
        project?.name || programme.name
      }"${via}. The week is now locked and read-only.`,
      programme,
    });
  } catch (notifyError) {
    console.error("Week closed notification failed:", notifyError);
  }

  /* The read-only users on the project are told separately: bell and push,
     no email. Isolated so a failure here cannot lose the stakeholder run. */
  try {
    await notifyUsersOfWeekClosed({
      programme,
      weekNumber,
      closeType,
      closedBy,
    });
  } catch (notifyError) {
    console.error("Week closed user notification failed:", notifyError);
  }

  /* And confirm back to whoever did it. The action-assign flow already works
     this way — the actor gets a "You assigned…" of their own — and without it
     the person driving the close sees nothing at all. */
  if (closedBy?._id) {
    try {
      await dispatch({
        recipients: [String(closedBy._id)],
        sender: closedBy,
        type: "general",
        title: "Week Closed",
        message: `You closed Week ${weekNumber} on "${
          project?.name || programme.name
        }"${
          closeType === "PM Override" ? " via PM Override" : ""
        }. The week is now locked and read-only.`,
        programme,
      });
    } catch (notifyError) {
      console.error("Week closed self-notification failed:", notifyError);
    }
  }

  return recipients;
};

/*
 * The view-only users attached to a project: those granted it directly and
 * those sitting on its team. The actor is skipped — they did the thing.
 *
 * Returns { recipients, project, granted, team } so callers can log what they
 * resolved; a silent zero-recipient result is otherwise indistinguishable from
 * the notifier never having run.
 */
const resolveProjectUsers = async ({ programme, actor }) => {
  const Admin = require("../models/Admin");
  const Project = require("../models/Project");

  const projectId = programme.project.toString();

  const granted = await Admin.find({
    role: "user",
    status: "active",
    projects: programme.project,
  }).select("_id");

  const project = await Project.findById(projectId).select("team name");
  const teamUserIds = (project?.team || [])
    .filter((member) => member.user)
    .map((member) => member.user.toString());

  const teamUsers = teamUserIds.length
    ? await Admin.find({
        _id: { $in: teamUserIds },
        role: "user",
        status: "active",
      }).select("_id")
    : [];

  const recipients = [
    ...new Set([...granted, ...teamUsers].map((u) => u._id.toString())),
  ].filter((id) => id !== String(actor?._id));

  return {
    recipients,
    project,
    projectId,
    grantedCount: granted.length,
    teamCount: teamUsers.length,
  };
};

/*
 * Tells the view-only users on a project that a formal output has been issued
 * for it — the Weekly Plan or the Planner To-Do.
 *
 * Bell and push only, no email: these users cannot generate exports (SRS §10.2
 * grants them "View exports (read-only)"), so this is simply how they learn a
 * new one is available.
 */
const notifyUsersOfExport = async ({
  programme,
  exportType,
  weekNumber,
  sender,
}) => {
  if (!programme?.project) return [];

  const { recipients, project, projectId, grantedCount, teamCount } =
    await resolveProjectUsers({ programme, actor: sender });

  console.log(
    `[export-notify] ${exportType} | project ${projectId} | granted ${grantedCount} | team ${teamCount} | sending to ${recipients.length}`,
  );

  if (recipients.length === 0) return [];

  return dispatch({
    recipients,
    sender,
    type: "general",
    title: `New ${exportType} Available`,
    message: `A new ${exportType} for Week ${weekNumber} on "${
      project?.name || programme.name
    }" has been issued. Open Exports to view it.`,
    programme,
  });
};

/*
 * Tells the view-only users on a project that a governance week has closed.
 *
 * Bell and push only, like the export notice and for the same reason: these
 * users take no part in the close (SRS §10.2 gives them read access), so this
 * tells them the week they were watching is now locked. The stakeholders'
 * email is unchanged — users are not added to it.
 */
const notifyUsersOfWeekClosed = async ({
  programme,
  weekNumber,
  closeType,
  closedBy,
}) => {
  if (!programme?.project) return [];

  const { recipients, project, projectId, grantedCount, teamCount } =
    await resolveProjectUsers({ programme, actor: closedBy });

  console.log(
    `[week-closed-notify] week ${weekNumber} | project ${projectId} | granted ${grantedCount} | team ${teamCount} | sending to ${recipients.length}`,
  );

  if (recipients.length === 0) return [];

  const actor = closedBy?.name || "The system";
  const via = closeType === "PM Override" ? " via PM Override" : "";

  return dispatch({
    recipients,
    sender: closedBy,
    type: "general",
    title: "Week Closed",
    message: `${actor} closed Week ${weekNumber} on "${
      project?.name || programme.name
    }"${via}. The week is now locked and read-only.`,
    programme,
  });
};

module.exports = {
  notifyUsersOfExport,
  notifyUsersOfWeekClosed,
  emailStakeholdersWeekClosed,
  emailStakeholdersMarkedCloseOutEligible,
  notifyPlannersOfTodoGenerated,
  notifyPlannersIfAllActionsClosed,
  emailPlannersCloseOutEligible,
};
