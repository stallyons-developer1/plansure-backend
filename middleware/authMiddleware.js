const Token = require("../models/Token");

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      const user = await Token.verifyToken(token);

      if (!user) {
        return res
          .status(401)
          .json({ message: "Not authorized, token invalid or expired" });
      }

      req.admin = user;
      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  } else {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

const adminOnly = (req, res, next) => {
  if (req.admin && req.admin.role === "admin") {
    next();
  } else {
    res.status(403).json({ message: "Access denied. Admin only." });
  }
};

/*
 * Both roles that run delivery, as opposed to adminOnly for the account and
 * audit surfaces. Planners own the programme day to day, so they need the
 * project they will upload against. `user` stays view-only.
 */
const adminOrPlanner = (req, res, next) => {
  if (req.admin && ["admin", "planner"].includes(req.admin.role)) {
    next();
  } else {
    res.status(403).json({ message: "Access denied. Admin or Planner only." });
  }
};

/*
 * The closure authority. SRS §10.2 puts "PM override close", "Close week
 * (standard)" and "Trigger state transitions" at Planner: Yes, Admin: No —
 * there is no separate PM role in this system, the Planner holds it. Admin is
 * deliberately excluded: its remit is projects, users and audit, not running
 * the week.
 */
const plannerOnly = (req, res, next) => {
  if (req.admin && req.admin.role === "planner") {
    next();
  } else {
    res.status(403).json({
      message:
        "Access denied. Only the Planner can perform this governance action.",
    });
  }
};

module.exports = { protect, adminOnly, adminOrPlanner, plannerOnly };
