// ---------------------------------------------------------------------------
// Assignment / action-driven governance status engine (NOT date-driven).
//
//   Unassigned      -> Grey  (activity untouched after upload)
//                    -> Red   (Blocked) once the 6-week cycle window has passed
//                             while still untriaged (a governance miss)
//   NoAction        -> Green ("No Action" chosen; Ready)
//   ActionAssigned  -> Amber (At Risk) while any linked action is open
//                    -> Blue  (Completed) once all linked actions are done
//                    -> Red   (Blocked) if an action is still open past the
//                             6-week cycle end date
//
// This is the single source of truth shared by programmeUploadRoutes,
// actionRoutes recompute paths and the dashboard read endpoints.
// ---------------------------------------------------------------------------

const CYCLE_LENGTH_DAYS = 42; // 6 weeks

// The 6-week cycle is "completed" once the programme itself has ended — i.e.
// once today is past the LATEST activity finish date. Activities can only turn
// Blocked after this point (see computeGovernanceStatus). Returns null when
// there are no parseable finish dates (treated as "cycle not yet complete").
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

const isActionOpen = (action) =>
  action &&
  action.status !== "Completed" &&
  action.status !== "Complete" &&
  action.status !== "Cancelled";

// Parse an activity date string ("DD-MMM-YY" or "YYYY-MM-DD"), tolerating a
// trailing Actual/Baseline marker (A/B/*). Returns a Date at local midnight or
// null. Mirrors the parser used across the upload/dashboard routes.
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
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

// A trailing "A" marks an Actual (already-happened) date => the activity is
// genuinely complete, so a past Actual finish is NOT overdue.
const hasActualMarker = (dateStr) =>
  typeof dateStr === "string" && /A\s*$/.test(dateStr.trim());

// Single source of truth for an activity's governance status.
// linkedActions may be undefined when a caller has no action data — in that
// case we trust the persisted ragStatus for already-resolved states.
const computeGovernanceStatus = (activity, linkedActions, cycleEndDate, now) => {
  const state = activity.assignmentState || "Unassigned";
  const reference = now ? new Date(now) : new Date();
  const refDay = new Date(reference);
  refDay.setHours(0, 0, 0, 0);
  // The 6-week cycle is "completed" once we're past the programme's end date
  // (its latest activity finish, supplied as cycleEndDate). Activities can only
  // become Blocked once the cycle is complete — not when their own date slips.
  const cycleComplete = cycleEndDate && refDay > new Date(cycleEndDate);

  // --- Completion takes precedence -----------------------------------------
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

  // Genuinely complete (all actions done, a resolved Blue, or an Actual "A"
  // finish date) => Completed/Blue, regardless of assignment state.
  if (isComplete) {
    return { ragStatus: "Blue", activityStatus: "Completed" };
  }

  if (state === "Unassigned") {
    if (cycleComplete) {
      // Cycle finished with the activity never triaged -> Blocked, unless the
      // planner "unblocked" (acknowledged) it, after which it drops to At Risk
      // so it stays in the blocked/risk list and can be assigned an action.
      return activity.overdueAcknowledged
        ? { ragStatus: "Amber", activityStatus: "At Risk" }
        : { ragStatus: "Red", activityStatus: "Blocked" };
    }
    // During the cycle an untriaged activity is simply awaiting triage (Grey).
    return { ragStatus: "Grey", activityStatus: "Unassigned" };
  }
  if (state === "NoAction") {
    return { ragStatus: "Green", activityStatus: "Ready" };
  }

  // state === "ActionAssigned": being handled (At Risk) during the cycle;
  // Blocked only once the cycle has completed with the action still open.
  if (cycleComplete) {
    return { ragStatus: "Red", activityStatus: "Blocked" };
  }
  return { ragStatus: "Amber", activityStatus: "At Risk" };
};

// Group a flat list of Action docs by their linked activityId.
const groupActionsByActivity = (actions) => {
  const byActivity = {};
  for (const action of actions || []) {
    const actId = action.linkedActivity?.activityId;
    if (!actId) continue;
    (byActivity[actId] = byActivity[actId] || []).push(action);
  }
  return byActivity;
};

// Recompute every activity's ragStatus/activityStatus in-place from the current
// assignment state + linked actions + cycle window. Marks the nested array
// modified when anything changed. Does NOT save — the caller owns persistence.
// Returns true if any activity changed.
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

// Convenience: refresh a single programme, loading its actions and saving if
// anything changed. Safe to call at the top of a read endpoint ("auto on load").
const syncProgrammeGovernance = async (programme, ActionModel, now = new Date()) => {
  if (!programme?.extractedData?.activities?.length) return false;
  const actions = await ActionModel.find({ programme: programme._id });
  const changed = refreshProgrammeGovernance(
    programme,
    groupActionsByActivity(actions),
    now,
  );
  if (changed) await programme.save();
  return changed;
};

// Convenience: refresh many programmes in one batched action query. Used by the
// dashboard endpoints so their counts reflect the current cycle state on load.
const syncProgrammesGovernance = async (programmes, ActionModel, now = new Date()) => {
  if (!Array.isArray(programmes) || programmes.length === 0) return;
  const ids = programmes.map((p) => p._id);
  const actions = await ActionModel.find({ programme: { $in: ids } });

  const byProgramme = {};
  for (const action of actions) {
    const pid = String(action.programme);
    (byProgramme[pid] = byProgramme[pid] || []).push(action);
  }

  for (const programme of programmes) {
    const grouped = groupActionsByActivity(byProgramme[String(programme._id)] || []);
    const changed = refreshProgrammeGovernance(programme, grouped, now);
    if (changed) await programme.save();
  }
};

module.exports = {
  CYCLE_LENGTH_DAYS,
  getCycleEndDate,
  isActionOpen,
  computeGovernanceStatus,
  groupActionsByActivity,
  refreshProgrammeGovernance,
  syncProgrammeGovernance,
  syncProgrammesGovernance,
};
