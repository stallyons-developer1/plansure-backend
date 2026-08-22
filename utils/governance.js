const CYCLE_LENGTH_DAYS = 42;
const getCycleEndDate = (programme) => {
  const activities = programme?.extractedData?.activities;
  if (!Array.isArray(activities) || activities.length === 0) return null;
  let latest = null;
  for (const a of activities) {
    const f = parseActivityDate(a.finishDate);
    if (f && (!latest || f > latest)) latest = f;
  }
  if (latest) latest.setHours(23, 59, 59, 999);
  return latest;
};

// A PM Override force-closes a single action, so it is terminal like
// Completed/Cancelled — otherwise an overridden action would keep blocking.
const CLOSED_ACTION_STATUSES = [
  "Completed",
  "Complete",
  "Cancelled",
  "PM Override",
];

const isActionOpen = (action) =>
  !!action && !CLOSED_ACTION_STATUSES.includes(action.status);

const AUTO_OVERRIDE_REASON =
  "Automatically force-closed by the system: the governance week ended without completion.";

/* End of the governance week (anchor + 7n .. +6 days) that a date falls into. */
const weekEndFor = (date, anchor) => {
  const msPerDay = 24 * 60 * 60 * 1000;
  const index = Math.floor((date - anchor) / (7 * msPerDay));
  const end = new Date(anchor);
  end.setDate(anchor.getDate() + index * 7 + 6);
  end.setHours(23, 59, 59, 999);
  return end;
};

/*
 * Force-closes any still-open action whose GOVERNANCE WEEK has ended.
 *
 * The trigger is the week window closing, not the action slipping: an action
 * due 18 Aug in the 18–24 Aug week stays open and simply overdue until 24 Aug
 * passes, then it is force-closed.
 *
 * NOTE: unlike a PM Override raised by a person, this has no human
 * justification and no accountable actor, so `overriddenBy` is deliberately
 * left unset and the audit entry is tagged `automatic: true`. That keeps the
 * two kinds of override distinguishable in the record.
 *
 * Returns the actions it closed, so callers can report on them.
 */
const autoOverrideOverdueActions = async (ActionModel, programmeId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const Programme = require("../models/Programme");
  const programme = await Programme.findById(programmeId).select(
    "lookaheadStartDate extractedData.activities project",
  );
  if (!programme) return [];

  // Week windows are measured from the same anchor the lookahead uses.
  let anchor = programme.lookaheadStartDate
    ? new Date(programme.lookaheadStartDate)
    : null;
  if (!anchor) {
    for (const activity of programme.extractedData?.activities || []) {
      const start = parseActivityDate(activity.startDate);
      if (start && (!anchor || start < anchor)) anchor = start;
    }
  }
  if (!anchor) return [];
  anchor.setHours(0, 0, 0, 0);

  const candidates = await ActionModel.find({
    programme: programmeId,
    status: { $in: ["Open", "In Progress"] },
    dueDate: { $ne: null },
    // Never undo a person's deliberate decision to reopen an action.
    autoOverrideExempt: { $ne: true },
  });

  const overdue = candidates.filter(
    (action) => weekEndFor(new Date(action.dueDate), anchor) < startOfToday,
  );

  if (overdue.length === 0) return [];

  const auditLogger = require("./auditLogger");

  for (const action of overdue) {
    const previousStatus = action.status;
    action.status = "PM Override";
    action.overrideReason = AUTO_OVERRIDE_REASON;
    action.overriddenAt = new Date();
    action.overriddenBy = undefined;
    await action.save();

    try {
      await auditLogger.log({
        action: "ACTION_PM_OVERRIDE",
        category: "ACTION",
        resourceType: "Action",
        resourceId: action._id,
        resourceName: action.title,
        description: `System auto-override: action "${action.title}" was still open when its governance week ended.`,
        changes: {
          before: { status: previousStatus },
          after: { status: "PM Override" },
        },
        metadata: {
          overrideReason: AUTO_OVERRIDE_REASON,
          automatic: true,
          dueDate: action.dueDate,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed (auto override):", auditError);
    }

    /* Nobody triggered this, so there is no actor to name — the email says the
       status changed automatically. Isolated per action so one bad address
       cannot stop the rest of the sweep. */
    try {
      const { sendActionStatusChangedEmail } = require("./email");
      const Project = require("../models/Project");
      const populated = await ActionModel.findById(action._id)
        .populate("assignee", "name email")
        .populate("createdBy", "name email");
      const project = programme.project
        ? await Project.findById(programme.project).select("name")
        : null;

      const seen = new Set();
      for (const person of [populated?.assignee, populated?.createdBy]) {
        if (!person?.email) continue;
        const id = String(person._id);
        if (seen.has(id)) continue;
        seen.add(id);
        await sendActionStatusChangedEmail({
          email: person.email,
          name: person.name,
          actionTitle: action.title,
          previousStatus,
          newStatus: "PM Override",
          reason: AUTO_OVERRIDE_REASON,
          projectName: project?.name,
          linkedActivity: action.linkedActivity?.activityName,
          dueDate: action.dueDate,
        });
      }
    } catch (emailError) {
      console.error("Auto-override email failed:", emailError);
    }
  }

  // The sweep can be what closes the last open action, so it announces too.
  try {
    const {
      notifyPlannersIfAllActionsClosed,
    } = require("./plannerNotifications");
    await notifyPlannersIfAllActionsClosed({ programmeId });
  } catch (notifyError) {
    console.error("All-actions-closed notification failed:", notifyError);
  }

  return overdue;
};

const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const parseActivityDate = (dateStr) => {
  if (!dateStr || typeof dateStr !== "string") return null;
  const clean = dateStr.replace(/\s*[AB*]$/, "").trim();
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const m = clean.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
  if (!m || MONTHS[m[2]] === undefined) return null;
  const year = +m[3] < 50 ? 2000 + +m[3] : 1900 + +m[3];
  return new Date(year, MONTHS[m[2]], +m[1]);
};

const hasActualMarker = (dateStr) =>
  typeof dateStr === "string" && /A\s*$/.test(dateStr.trim());

const computeGovernanceStatus = (
  activity,
  linkedActions,
  cycleEndDate,
  now,
) => {
  const state = activity.assignmentState || "Unassigned";
  const reference = now ? new Date(now) : new Date();
  const refDay = new Date(reference);
  refDay.setHours(0, 0, 0, 0);
  const cycleComplete = cycleEndDate && refDay > new Date(cycleEndDate);

  const hasActionData = Array.isArray(linkedActions);
  const allActionsDone =
    hasActionData &&
    linkedActions.length > 0 &&
    linkedActions.filter(isActionOpen).length === 0;
  const isComplete =
    allActionsDone ||
    activity.ragStatus === "Blue" ||
    activity.activityStatus === "Completed" ||
    activity.activityStatus === "Complete" ||
    hasActualMarker(activity.finishDate);

  if (isComplete) {
    return { ragStatus: "Blue", activityStatus: "Completed" };
  }

  if (state === "Unassigned") {
    if (cycleComplete) {
      return activity.overdueAcknowledged
        ? { ragStatus: "Amber", activityStatus: "At Risk" }
        : { ragStatus: "Red", activityStatus: "Blocked" };
    }
    return { ragStatus: "Grey", activityStatus: "Unassigned" };
  }
  if (state === "NoAction") {
    return { ragStatus: "Green", activityStatus: "Ready" };
  }

  if (cycleComplete) {
    return { ragStatus: "Red", activityStatus: "Blocked" };
  }
  return { ragStatus: "Amber", activityStatus: "At Risk" };
};

const groupActionsByActivity = (actions) => {
  const byActivity = {};
  for (const action of actions || []) {
    const actId = action.linkedActivity?.activityId;
    if (!actId) continue;
    (byActivity[actId] = byActivity[actId] || []).push(action);
  }
  return byActivity;
};

const refreshProgrammeGovernance = (
  programme,
  actionsByActivity = {},
  now = new Date(),
) => {
  const activities = programme?.extractedData?.activities;
  if (!Array.isArray(activities) || activities.length === 0) return false;

  const cycleEndDate = getCycleEndDate(programme);
  let changed = false;

  for (const activity of activities) {
    const linkedActions = actionsByActivity[activity.activityId] || [];
    const derived = computeGovernanceStatus(
      activity,
      linkedActions,
      cycleEndDate,
      now,
    );
    if (
      activity.ragStatus !== derived.ragStatus ||
      activity.activityStatus !== derived.activityStatus
    ) {
      activity.ragStatus = derived.ragStatus;
      activity.activityStatus = derived.activityStatus;
      changed = true;
    }
  }

  if (changed) programme.markModified("extractedData.activities");
  return changed;
};

const syncProgrammeGovernance = async (
  programme,
  ActionModel,
  now = new Date(),
) => {
  if (!programme?.extractedData?.activities?.length) return false;
  const actions = await ActionModel.find({ programme: programme._id }).lean();
  const changed = refreshProgrammeGovernance(
    programme,
    groupActionsByActivity(actions),
    now,
  );
  if (changed) await programme.save();
  return changed;
};

const syncProgrammesGovernance = async (
  programmes,
  ActionModel,
  now = new Date(),
) => {
  if (!Array.isArray(programmes) || programmes.length === 0) return;
  const ids = programmes.map((p) => p._id);
  const actions = await ActionModel.find({ programme: { $in: ids } }).lean();

  const byProgramme = {};
  for (const action of actions) {
    const pid = String(action.programme);
    (byProgramme[pid] = byProgramme[pid] || []).push(action);
  }

  for (const programme of programmes) {
    const grouped = groupActionsByActivity(
      byProgramme[String(programme._id)] || [],
    );
    const changed = refreshProgrammeGovernance(programme, grouped, now);
    if (changed) await programme.save();
  }
};

module.exports = {
  CYCLE_LENGTH_DAYS,
  CLOSED_ACTION_STATUSES,
  AUTO_OVERRIDE_REASON,
  autoOverrideOverdueActions,
  getCycleEndDate,
  isActionOpen,
  computeGovernanceStatus,
  groupActionsByActivity,
  refreshProgrammeGovernance,
  syncProgrammeGovernance,
  syncProgrammesGovernance,
};
