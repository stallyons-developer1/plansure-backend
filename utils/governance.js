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
  getCycleEndDate,
  isActionOpen,
  computeGovernanceStatus,
  groupActionsByActivity,
  refreshProgrammeGovernance,
  syncProgrammeGovernance,
  syncProgrammesGovernance,
};
