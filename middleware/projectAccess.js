/*
 * Role checks that know which project they are about.
 *
 * The plain adminOnly / adminOrPlanner / plannerOnly guards sit at the door of
 * a route and cannot see past it, so they judge an account by the one role it
 * carries everywhere. That stopped being true once an account could be the PM
 * of one programme and only a User on the next: the question is never "is this
 * a PM" but "is this a PM *here*".
 *
 * Each factory below resolves the project the request is about — from the URL,
 * from a programme, or from the action being touched — and then asks the
 * account what it holds there. A Super Admin reaches every project, which the
 * model's roleOn already answers.
 */
const Programme = require("../models/Programme");
const Action = require("../models/Action");

const LABEL = { admin: "PM", planner: "Planner", user: "User" };

const describe = (roles) =>
  roles.map((r) => LABEL[r] || r).join(" or ");

/*
 * source says where the project id comes from:
 *   "project"        req.params.id is the project
 *   "programme"      req.params.id is a programme
 *   "bodyProgramme"  req.body.programmeId is a programme
 *   "action"         req.params.id is an action
 */
const resolveProjectId = async (req, source) => {
  if (source === "project") return req.params.id;

  if (source === "programme" || source === "bodyProgramme") {
    const id =
      source === "programme" ? req.params.id : req.body?.programmeId;
    if (!id) return null;
    const programme = await Programme.findById(id).select("project");
    return programme?.project || null;
  }

  if (source === "action") {
    const action = await Action.findById(req.params.id).select("programme");
    if (!action?.programme) return null;
    const programme = await Programme.findById(action.programme).select(
      "project",
    );
    return programme?.project || null;
  }

  return null;
};

const requireProjectRole = (roles, source) => async (req, res, next) => {
  try {
    const projectId = await resolveProjectId(req, source);

    /* Nothing to judge against — the record is gone, or the request never
       named one. Let the handler answer with its own 404 rather than
       inventing a permission error for a thing that does not exist. */
    if (!projectId) return next();

    const held = req.admin?.roleOn?.(projectId) ?? null;

    if (!held) {
      return res
        .status(403)
        .json({ message: "You do not have access to this project." });
    }

    if (!roles.includes(held)) {
      return res.status(403).json({
        message: `Access denied. ${describe(roles)} only on this project.`,
      });
    }

    return next();
  } catch (error) {
    console.error("Project role check failed:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  projectAdmin: (source) => requireProjectRole(["admin"], source),
  projectAdminOrPlanner: (source) =>
    requireProjectRole(["admin", "planner"], source),
  projectPlanner: (source) => requireProjectRole(["planner"], source),
};
