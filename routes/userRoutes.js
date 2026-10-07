const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const Admin = require("../models/Admin");
const Project = require("../models/Project");
const { protect } = require("../middleware/authMiddleware");

/* A PM has the same reach as the Super Admin in User Management — they see and
 * manage every account. Two things stay out of their hands:
 *
 *   - the Super Admin account. Anything else and a PM could edit or delete the
 *     owner and take the system with it.
 *   - their own project grants. Project access is scoped everywhere else, and
 *     editing your own record would be a way around that scoping.
 */
/* A PM manages everyone except the owner. Reaching the Super Admin account
 * would let any PM edit or delete it and take the system with it. */
const canManageAccount = (actor, target) =>
  actor.isSuperAdmin || !target.isSuperAdmin;

/* Invitation hierarchy. An account may create another at its own level or
   below, never above: a Planner can bring in Planners and Users, a User can
   bring in Users. Super Admin sits above PM because it is unscoped and owns
   the other admin accounts. */
const LEVELS = { user: 1, planner: 2, admin: 3 };
const levelOf = (role, isSuperAdmin) =>
  role === "admin" && isSuperAdmin ? 4 : LEVELS[role] || 0;
const levelOfActor = (actor) => levelOf(actor.role, actor.isSuperAdmin);

/* Who may act on an account. An admin manages everyone; below that you manage
   only the accounts you invited. The same test the list sends out as
   canManage, so a control the screen offers is one the server will accept. */
const mayManage = (actor, target) =>
  canManageAccount(actor, target) &&
  (actor.role === "admin" ||
    String(target.invitedBy?._id || target.invitedBy || "") ===
      String(actor._id));

/* Turns what the form sends into membership rows, and refuses anything the
   person sending it could not grant: a role above their own, or a project they
   do not hold themselves. Accepts the older shape — one role with a list of
   projects — so existing callers keep working. */
const buildMemberships = (actor, body, existing = []) => {
  const rows = Array.isArray(body.memberships)
    ? body.memberships
        .filter((m) => m && m.project && m.role)
        .map((m) => ({ project: String(m.project), role: m.role }))
    : (Array.isArray(body.projectIds)
        ? body.projectIds
        : body.projectId
          ? [body.projectId]
          : []
      )
        .filter(Boolean)
        .map((id) => ({ project: String(id), role: body.role })),
    seen = new Map();

  for (const row of rows) {
    if (!LEVELS[row.role]) {
      return { error: `Unknown role "${row.role}".` };
    }
    if (levelOf(row.role, false) > levelOfActor(actor)) {
      return { error: "You can only grant a role at your own level or below." };
    }
    seen.set(row.project, row.role);
  }

  /* An admin grants any project. Below that you can only pass on what you
     already hold, so nobody widens anyone's reach beyond their own. */
  if (actor.role !== "admin" && seen.size > 0) {
    const own = (actor.projects || []).map((id) => String(id));
    const beyond = [...seen.keys()].filter((id) => !own.includes(id));
    if (beyond.length > 0) {
      return { error: "You can only grant projects you have access to yourself." };
    }
  }

  /* A place already taken up keeps its state and its link. A new project, or
     a different role on one already held, is a fresh offer and has to be
     invited for again. */
  const held = new Map(
    (existing || []).map((m) => [
      `${String(m.project?._id || m.project)}:${m.role}`,
      m,
    ]),
  );

  return {
    memberships: [...seen.entries()].map(([project, role]) => {
      const previous = held.get(`${project}:${role}`);
      return previous
        ? {
            project,
            role,
            status: previous.status,
            inviteToken: previous.inviteToken,
            inviteTokenExpiry: previous.inviteTokenExpiry,
          }
        : { project, role, status: "pending" };
    }),
  };
};

/* Each project with the role held on it, named, for the invitation email. */
/*
 * One invitation per role, not a single message listing them all. Somebody who
 * plans one project and only watches another gets two emails, each naming only
 * the projects that role covers, so neither has to be read past the part that
 * applies. Both carry the same accept link — there is one account behind them,
 * and accepting either activates the lot.
 */
/*
 * One invitation per role, each with its own link and its own state.
 *
 * Somebody who plans one project and only watches another gets two emails.
 * Opening one takes up the projects it names and leaves the other outstanding,
 * so the View modal can say where each project's invitation got to. Every
 * project held at the same role shares a link, because they arrive together in
 * one message.
 *
 * `roles` narrows it to a single role, which is what Resend sends.
 */
const sendRoleInvites = async ({ user, invitedByName, roles }) => {
  const rows = user.memberships || [];
  const backendUrl = backendBase();

  /* One link for the whole account: the shape invitations had before they were
     split per project. */
  const sendAccountInvite = async () => {
    const token = user.generateInviteToken();
    await user.save();
    await sendInviteEmail({
      email: user.email,
      name: user.name,
      role: user.role,
      projectName: "All Projects",
      invitedByName,
      acceptUrl: `${backendUrl}/api/users/invite/accept/${token}`,
      rejectUrl: `${backendUrl}/api/users/invite/reject/${token}`,
    });
    return 1;
  };

  if (rows.length === 0) return sendAccountInvite();

  const wanted =
    Array.isArray(roles) && roles.length > 0 ? new Set(roles) : null;

  const byRole = new Map();
  rows.forEach((m) => {
    if (m.status !== "pending") return;
    if (wanted && !wanted.has(m.role)) return;
    if (!byRole.has(m.role)) byRole.set(m.role, []);
    byRole.get(m.role).push(m);
  });

  if (byRole.size === 0) {
    /* An account invited before the split carries no per-project state, so
       nothing reads as pending however long its invitation has been sitting
       there. While it has still never been signed into, the account-level link
       is its invitation — otherwise Resend would report success and send
       nothing. */
    return user.status === "pending" ? sendAccountInvite() : 0;
  }

  const ids = [...byRole.values()]
    .flat()
    .map((m) => String(m.project?._id || m.project));
  const named = await Project.find({ _id: { $in: ids } }).select("name");
  const nameById = new Map(named.map((pr) => [String(pr._id), pr.name]));

  /* Stamped first and saved once, so a failure part-way through the sending
     does not leave half the links unsaved and therefore dead. */
  const tokens = new Map();
  for (const role of byRole.keys()) {
    tokens.set(role, user.generateMembershipInviteToken(role));
  }
  await user.save();

  /* Highest role first, so the most capable invitation lands at the top of the
     inbox rather than under the one that grants least. */
  const ordered = [...byRole.keys()].sort(
    (a, b) => (LEVELS[b] || 0) - (LEVELS[a] || 0),
  );

  /* Which roles this round is actually offering, so a missing invitation can
     be told apart from one that was refused. */
  console.log(
    `[INVITE] ${user.email}: ${ordered.length} invitation(s) —`,
    ordered.map((r) => `${r}=${tokens.get(r) ? "link" : "NO LINK"}`).join(", "),
  );

  let sent = 0;
  const failed = [];

  for (const role of ordered) {
    const token = tokens.get(role);
    if (!token) continue;

    const named = byRole.get(role).map((m) => ({
      projectName:
        nameById.get(String(m.project?._id || m.project)) || "Project",
      role,
    }));

    /* Caught per message. One refusal used to abort the loop and swallow the
       reason, so only the first role — always the highest, because of the sort
       above — ever arrived, and every invitation looked like a PM one. The
       links are already saved, so a failure here costs nothing but the send,
       and Resend can carry it. */
    try {
      await sendInviteEmail({
        email: user.email,
        name: user.name,
        role,
        memberships: named,
        projectName: named.map((r) => r.projectName).join(", "),
        invitedByName,
        acceptUrl: `${backendUrl}/api/users/invite/accept/${token}`,
        rejectUrl: `${backendUrl}/api/users/invite/reject/${token}`,
      });
      sent += 1;
    } catch (error) {
      failed.push(role);
      console.error(
        `[INVITE] ${user.email} — the ${role} invitation was not sent:`,
        error?.message || error,
      );
    }
  }

  if (failed.length > 0 && sent === 0) {
    throw new Error(
      `No invitation could be sent (${failed.join(", ")}).`,
    );
  }

  return sent;
};

const namedMembershipsFor = async (user) => {
  const rows = user.memberships || [];
  if (rows.length === 0) return [];
  const ids = rows.map((m) => String(m.project?._id || m.project));
  const named = await Project.find({ _id: { $in: ids } }).select("name");
  const nameById = new Map(named.map((p) => [String(p._id), p.name]));
  return rows.map((m) => ({
    projectName:
      nameById.get(String(m.project?._id || m.project)) || "Project",
    role: m.role,
  }));
};

const NOT_YOURS =
  "You can only change the accounts you invited.";

/* There may be several owners now, but never none: losing the last one leaves
   nobody who can create another, and the account cannot be restored from
   inside the app. */
const wouldRemoveLastSuperAdmin = async (target) => {
  if (!target.isSuperAdmin) return false;
  const remaining = await Admin.countDocuments({
    isSuperAdmin: true,
    _id: { $ne: target._id },
  });
  return remaining === 0;
};

/* A PM may grant any project to anyone else — User Management is unscoped for
   them. Their own record is the exception: raising their own grants would hand
   them the projects, dashboards, logs and exports that are scoped everywhere
   else in the app. */
const canSetProjects = (actor, target) =>
  actor.isSuperAdmin || String(target._id) !== String(actor._id);

const {
  sendInviteEmail,
  sendWelcomeEmail,
  sendRoleChangeEmail,
} = require("../utils/email");
const {
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
  validateEmail,
  validatePassword,
} = require("../utils/errorResponse");

/* A trailing slash on BACKEND_URL/FRONTEND_URL would produce "…app//api/…",
   which Express does not match — the invite link 404s. Strip it once here so
   the env var can be set either way. */
const trimSlash = (url) => (url || "").replace(/\/+$/, "");

const backendBase = () =>
  trimSlash(process.env.BACKEND_URL) ||
  `http://localhost:${process.env.PORT || 4000}`;

const frontendBase = () =>
  trimSlash(process.env.FRONTEND_URL) || "http://localhost:5173";

router.post("/invite", protect, async (req, res) => {
  try {
    const { name, email, role, projectId, projectIds } = req.body;

    const errors = validateRequired({ name, email, role });

    if (email && !errors.find((e) => e.field === "email")) {
      const emailError = validateEmail(email);
      if (emailError) errors.push(emailError);
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const asSuperAdmin = role === "admin" && Boolean(req.body.isSuperAdmin);
    const inviteeLevel = levelOf(role, asSuperAdmin);

    if (!inviteeLevel) {
      return sendValidationError(res, [
        { field: "role", message: "Unknown role" },
      ]);
    }

    if (inviteeLevel > levelOfActor(req.admin)) {
      return sendError(
        res,
        "You can only invite someone at your own level or below.",
        403,
      );
    }

    const existingUser = await Admin.findOne({ email });
    if (existingUser) {
      return sendValidationError(res, [
        { field: "email", message: "User with this email already exists" },
      ]);
    }

    /* A user can be granted several projects at invite time. projectId is
       still accepted so older callers keep working. */
    const built = buildMemberships(req.admin, req.body);
    if (built.error) {
      return sendError(res, built.error, 403);
    }

    const memberships = built.memberships;
    const grantedProjects = memberships.map((m) => m.project);

    const user = new Admin({
      name,
      email,
      /* role and projects are a summary of the memberships; the model keeps
         them in step on save. They are set here too so an invitation with no
         project at all still has a role to show. */
      role,
      isSuperAdmin: asSuperAdmin,
      status: "pending",
      memberships,
      projects: grantedProjects,
      invitedBy: req.admin._id,
    });

    await user.save();

    let emailSent = true;
    let emailError = null;
    const debugInfo = {
      ISSMTP: process.env.ISSMTP,
      RESEND_KEY_EXISTS: !!process.env.RESEND_API_KEY,
      RESEND_KEY_LENGTH: process.env.RESEND_API_KEY
        ? process.env.RESEND_API_KEY.length
        : 0,
    };
    try {
      await sendRoleInvites({ user, invitedByName: req.admin.name });
    } catch (err) {
      emailSent = false;
      emailError = err.message || String(err);
    }

    return sendSuccess(
      res,
      {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
        },
        emailSent,
        emailError,
        debugInfo,
      },
      emailSent
        ? "Invitation sent successfully"
        : `Email failed: ${emailError}`,
      201,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

const renderResponsePage = (title, message, type = "success") => {
  const colors = {
    success: { bg: "#22c55e", icon: "✓" },
    error: { bg: "#ef4444", icon: "✕" },
    warning: { bg: "#f59e0b", icon: "!" },
  };
  const color = colors[type] || colors.success;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title} - Plansure</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0f172a;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .card {
          background: #1e293b;
          border-radius: 16px;
          padding: 40px;
          text-align: center;
          max-width: 420px;
          width: 100%;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        .icon {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: ${color.bg};
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 24px;
          font-size: 40px;
          color: white;
        }
        h1 {
          color: #f1f5f9;
          font-size: 24px;
          margin-bottom: 12px;
        }
        p {
          color: #94a3b8;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 32px;
        }
        .btn {
          background: #3b82f6;
          color: white;
          border: none;
          padding: 14px 32px;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }
        .btn:hover { background: #2563eb; }
        .logo {
          color: #64748b;
          font-size: 14px;
          margin-top: 32px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">${color.icon}</div>
        <h1>${title}</h1>
        <p>${message}</p>
        <button class="btn" onclick="window.close(); setTimeout(() => { if(!window.closed) window.location.href='about:blank'; }, 100);">
          Close Window
        </button>
        <div class="logo">Plansure</div>
      </div>
    </body>
    </html>
  `;
};

router.get("/invite/accept/:token", async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    /* A per-project invitation first. Accounts invited before invitations were
       split still carry a single account-level link, so that is the fallback
       rather than a second code path. */
    let user = await Admin.findOne({
      memberships: {
        $elemMatch: {
          inviteToken: hashedToken,
          inviteTokenExpiry: { $gt: new Date() },
          status: "pending",
        },
      },
    });

    let takenUp = [];
    if (user) {
      takenUp = (user.memberships || []).filter(
        (m) => m.inviteToken === hashedToken && m.status === "pending",
      );
      takenUp.forEach((m) => {
        m.status = "active";
        m.inviteToken = undefined;
        m.inviteTokenExpiry = undefined;
      });
      user.markModified("memberships");
    } else {
      user = await Admin.findOne({
        inviteToken: hashedToken,
        inviteTokenExpiry: { $gt: Date.now() },
        status: "pending",
      });
      if (user) {
        user.inviteToken = undefined;
        user.inviteTokenExpiry = undefined;
      }
    }

    if (!user) {
      return res.send(
        renderResponsePage(
          "Invalid or Expired",
          "This invitation link is invalid or has already been used. Please contact your administrator for a new invitation.",
          "error",
        ),
      );
    }

    /* The password is issued once. Taking up a second role later opens those
       projects to an account that already has credentials, so reissuing would
       break the ones in use. */
    const firstTimeIn = user.status === "pending";
    let generatedPassword = null;

    if (firstTimeIn) {
      generatedPassword = crypto.randomBytes(4).toString("hex") + "A1!";
      user.password = generatedPassword;
      user.status = "active";
    }

    await user.save();

    if (generatedPassword) {
      try {
        await sendWelcomeEmail({
          email: user.email,
          name: user.name,
          password: generatedPassword,
        });
      } catch (emailError) {
        console.error("Failed to send welcome email:", emailError);
      }
    }

    if (!firstTimeIn) {
      const Project = require("../models/Project");
      const opened = await Project.find({
        _id: { $in: takenUp.map((m) => m.project) },
      }).select("name");
      const names = opened.map((pr) => pr.name).join(", ");
      return res.send(
        renderResponsePage(
          "Invitation Accepted",
          names
            ? `${names} is now open to you. Sign in with the password you already use for Plansure.`
            : "This invitation has been accepted. Sign in with the password you already use for Plansure.",
          "success",
        ),
      );
    }

    const frontendUrl = frontendBase();
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Welcome to Plansure</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .card {
            background: #1e293b;
            border-radius: 16px;
            padding: 40px;
            text-align: center;
            max-width: 420px;
            width: 100%;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          .icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: #22c55e;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            font-size: 40px;
            color: white;
          }
          h1 { color: #f1f5f9; font-size: 24px; margin-bottom: 12px; }
          p { color: #94a3b8; font-size: 16px; line-height: 1.6; margin-bottom: 20px; }
          .password-box {
            background: #0f172a;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .password-label { color: #64748b; font-size: 14px; margin-bottom: 8px; }
          .password {
            color: #3b82f6;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 2px;
          }
          .btn {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 14px 32px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: background 0.2s;
          }
          .btn:hover { background: #2563eb; }
          .note { color: #64748b; font-size: 13px; margin-top: 16px; }
          .logo { color: #64748b; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h1>Welcome to Plansure!</h1>
          <p>Your account has been activated successfully.</p>
          <div class="password-box">
            <div class="password-label">Your temporary password</div>
            <div class="password">${generatedPassword}</div>
          </div>
          <a href="${frontendUrl}/login" class="btn">Go to Login</a>
          <div class="note">Please change your password after logging in.</div>
          <div class="logo">Plansure</div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    return res.send(
      renderResponsePage(
        "Something Went Wrong",
        "An error occurred while processing your invitation. Please try again or contact your administrator.",
        "error",
      ),
    );
  }
});

router.get("/invite/reject/:token", async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await Admin.findOne({
      $or: [
        { inviteToken: hashedToken, status: "pending" },
        {
          memberships: {
            $elemMatch: { inviteToken: hashedToken, status: "pending" },
          },
        },
      ],
    });

    if (!user) {
      return res.send(
        renderResponsePage(
          "Invalid or Expired",
          "This invitation link is invalid or has already been used.",
          "error",
        ),
      );
    }

    /* Declining one role drops only the projects that offer named. The account
       goes only when nothing is left of it and it was never signed into — an
       active account keeps the places it has already taken up. */
    const declined = (user.memberships || []).filter(
      (m) => m.inviteToken === hashedToken && m.status === "pending",
    );

    if (declined.length > 0) {
      user.memberships = (user.memberships || []).filter(
        (m) => !(m.inviteToken === hashedToken && m.status === "pending"),
      );
      user.markModified("memberships");

      if (user.memberships.length === 0 && user.status === "pending") {
        await Admin.findByIdAndDelete(user._id);
      } else {
        await user.save();
      }
    } else {
      await Admin.findByIdAndDelete(user._id);
    }

    return res.send(
      renderResponsePage(
        "Invitation Declined",
        "You have declined the invitation to join Plansure. You can close this window.",
        "warning",
      ),
    );
  } catch (error) {
    console.error(error);
    return res.send(
      renderResponsePage(
        "Something Went Wrong",
        "An error occurred while processing your request. Please try again.",
        "error",
      ),
    );
  }
});

router.get("/invite/verify/:token", async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await Admin.findOne({
      inviteToken: hashedToken,
      inviteTokenExpiry: { $gt: Date.now() },
      status: "pending",
    });

    if (!user) {
      return sendValidationError(res, [
        { field: "token", message: "Invalid or expired invitation token" },
      ]);
    }

    return sendSuccess(res, {
      valid: true,
      user: {
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const { status, role, search, managedOnly } = req.query;
    const Action = require("../models/Action");
    const Programme = require("../models/Programme");

    const filter = {};
    if (status) filter.status = status;
    if (role) filter.role = role;

    /* Everyone but an owner. The list has to agree with canManageAccount, or
       a PM sees a row they cannot act on. */
    if (!req.admin.isSuperAdmin) {
      filter.isSuperAdmin = { $ne: true };
    }

    /* managedOnly is what the User Management screen asks for. It is opt-in
       because the same endpoint feeds the assignee dropdowns, which need the
       whole active list.

       An account is visible to you when you share a project with it. An
       account with no project yet belongs to nobody's project, so it would
       otherwise vanish the moment it is created — those stay visible to every
       admin, and to whoever sent the invitation, so the person who created it
       can still find it and grant the project. The Super Admin sees all. */
    const visibility = [];
    if (managedOnly === "true" && !req.admin.isSuperAdmin) {
      const myProjects = (req.admin.projects || []).map((id) => String(id));

      if (myProjects.length > 0) {
        visibility.push({ projects: { $in: myProjects } });
      }

      if (req.admin.role === "admin") {
        visibility.push({ projects: { $size: 0 } });
        visibility.push({ projects: { $exists: false } });
      }

      // Whoever sent the invitation keeps sight of it, and everyone sees
      // their own row.
      visibility.push({ invitedBy: req.admin._id });
      visibility.push({ _id: req.admin._id });
    }

    const searchClause = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : null;

    /* Two $or clauses cannot sit side by side on one object, so they are
       combined rather than one quietly replacing the other. */
    const clauses = [];
    if (visibility.length > 0) clauses.push({ $or: visibility });
    if (searchClause) clauses.push(searchClause);
    if (clauses.length === 1) {
      Object.assign(filter, clauses[0]);
    } else if (clauses.length > 1) {
      filter.$and = clauses;
    }

    const users = await Admin.find(filter)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name")
      .populate("memberships.project", "name")
      .populate("invitedBy", "name")
      .sort({ createdAt: -1 });

    const allProjects = await Project.find().select("_id name");
    const projectMap = {};
    allProjects.forEach((p) => {
      projectMap[p._id.toString()] = p.name;
    });

    const formattedUsers = await Promise.all(
      users.map(async (user) => {
        let projectNames = [];

        /* Who may act on this row. An admin manages everyone; a Planner or a
           User only the accounts they brought in themselves, so the controls
           are greyed out on anyone else's. The Super Admin's row stays out of
           a PM's reach, as elsewhere. */
        const canManage =
          canManageAccount(req.admin, user) &&
          (req.admin.role === "admin" ||
            String(user.invitedBy?._id || user.invitedBy || "") ===
              String(req.admin._id));

        if (user.role === "admin" && user.isSuperAdmin) {
          return {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isSuperAdmin: !!user.isSuperAdmin,
            status: user.status,
            canManage,
            /* Empty for an owner: the flag reaches every project, so there is
               nothing per-project to list. */
            memberships: [],
            projectAccess: "All Projects",
            // Admins are not scoped to projects, so they match any project filter.
            allProjects: true,
            projectIds: [],
            grantedProjectIds: [],
            lastLogin: user.lastLogin,
            createdAt: user.createdAt,
            initials: user.name
              .split(" ")
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2),
          };
        }

        const validProjects = (user.projects || []).filter(
          (p) => p && p._id && p.name,
        );
        const assignedProjectIds = new Set(
          validProjects.map((p) => p._id.toString()),
        );
        projectNames = validProjects.map((p) => p.name);

        const userActions = await Action.find({
          $or: [{ assignee: user._id }, { "previousAssignees.user": user._id }],
        }).select("programme");

        const programmeIds = [
          ...new Set(
            userActions.map((a) => a.programme?.toString()).filter(Boolean),
          ),
        ];

        if (programmeIds.length > 0) {
          const programmes = await Programme.find({
            _id: { $in: programmeIds },
          }).select("project");

          programmes.forEach((prog) => {
            const projId = prog.project?.toString();
            if (
              projId &&
              !assignedProjectIds.has(projId) &&
              projectMap[projId]
            ) {
              assignedProjectIds.add(projId);
              projectNames.push(projectMap[projId]);
            }
          });
        }

        return {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isSuperAdmin: !!user.isSuperAdmin,
          status: user.status,
          canManage,
          /* What the account holds, project by project — what the edit form
             shows and sends back. */
          memberships: (user.memberships || [])
            .filter((m) => m.project)
            .map((m) => ({
              project: String(m.project._id || m.project),
              projectName: m.project.name || "",
              role: m.role,
              /* Each project is invited for on its own, so each reports its own
                 state. The token behind it never leaves the server. */
              status: m.status === "pending" ? "pending" : "active",
            })),
          projectAccess:
            projectNames.length > 0 ? projectNames.join(", ") : "No Projects",
          allProjects: false,
          // The same set that produced projectAccess above: direct assignments
          // plus projects reached through the user's actions.
          projectIds: [...assignedProjectIds],
          /* Only what an admin granted directly. The edit form needs this
             separately: pre-selecting action-derived access would turn it into
             a permanent grant the moment the form is saved. */
          grantedProjectIds: validProjects.map((p) => p._id.toString()),
          lastLogin: user.lastLogin,
          createdAt: user.createdAt,
          initials: user.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
            .slice(0, 2),
        };
      }),
    );

    return sendSuccess(res, { users: formattedUsers });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name")
      .populate("invitedBy", "name email");

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!mayManage(req.admin, user)) {
      return sendError(
        res,
        canManageAccount(req.admin, user)
          ? NOT_YOURS
          : "The Super Admin account cannot be changed from here.",
        403,
      );
    }

    return sendSuccess(res, { user });
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.put("/:id", protect, async (req, res) => {
  try {
    const { name, email, role, projects, status } = req.body;

    const user = await Admin.findById(req.params.id).populate(
      "projects",
      "name",
    );
    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!mayManage(req.admin, user)) {
      return sendError(
        res,
        canManageAccount(req.admin, user)
          ? NOT_YOURS
          : "The Super Admin account cannot be changed from here.",
        403,
      );
    }

    /* Moving the last owner off the admin role would leave the system with
       nobody who can promote another. Same reasoning as deletion. */
    if (
      role &&
      role !== "admin" &&
      (await wouldRemoveLastSuperAdmin(user))
    ) {
      return sendError(
        res,
        "This is the last Super Admin. Promote another account before changing this one's role.",
        409,
      );
    }

    /* The same ceiling the invitation obeys: nobody may hand out a role above
       their own, so a Planner cannot promote their invitee past themselves. */
    if (role && levelOf(role, false) > levelOfActor(req.admin)) {
      return sendError(
        res,
        "You can only set a role at your own level or below.",
        403,
      );
    }

    /* And nobody below an admin may widen access past their own. */
    if (
      projects !== undefined &&
      req.admin.role !== "admin" &&
      Array.isArray(projects)
    ) {
      const own = (req.admin.projects || []).map((id) => String(id));
      const beyond = projects.filter((id) => !own.includes(String(id)));
      if (beyond.length > 0) {
        return sendError(
          res,
          "You can only grant projects you have access to yourself.",
          403,
        );
      }
    }

    /* The form offers the address as an editable, required field, so it has to
       be accepted here — it was being shown, typed into, and silently dropped.
       Changing it moves the account, so the address has to stay unique. */
    const oldEmail = user.email;
    const emailChanged =
      typeof email === "string" &&
      email.trim() !== "" &&
      email.trim().toLowerCase() !== oldEmail.toLowerCase();

    if (emailChanged) {
      const emailError = validateEmail(email);
      if (emailError) {
        return sendValidationError(res, [emailError]);
      }
      const taken = await Admin.findOne({
        email: email.trim().toLowerCase(),
        _id: { $ne: user._id },
      });
      if (taken) {
        return sendValidationError(res, [
          { field: "email", message: "Another user already has this email" },
        ]);
      }
      user.email = email.trim().toLowerCase();
    }

    const wasPending = user.status === "pending";
    const oldProjects = user.projects
      .map((p) => p._id.toString())
      .sort()
      .join(",");
    const oldRole = user.role;

    if (name) user.name = name;

    /* Memberships are the real record now. When the form sends them, they
       replace what was there; `role` and `projects` follow from them on save.
       The older shape — one role with a list of projects — still works, so
       anything still sending that keeps going. */
    const sendsMemberships = Array.isArray(req.body.memberships);
    if (sendsMemberships || projects !== undefined) {
      if (!canSetProjects(req.admin, user)) {
        return sendError(
          res,
          "You cannot change your own project access.",
          403,
        );
      }
      const built = buildMemberships(req.admin, req.body, user.memberships);
      if (built.error) {
        return sendError(res, built.error, 403);
      }
      user.memberships = built.memberships;
      /* The save hook derives `role` and `projects` from the memberships, but
         the notice below has to compare before and after, so bring them up to
         date here. Running it twice costs nothing. */
      user.syncFromMemberships();
      if (built.memberships.length === 0 && role) user.role = role;
    } else if (role) {
      user.role = role;
    }

    if (status) user.status = status;

    const newProjectIds = (user.projects || []).map((p) => String(p._id || p));
    const newProjects = [...newProjectIds].sort().join(",");
    /* The account as it now stands, not what the form happened to send. The
       form sends `memberships`, so `role` and `projects` arrive undefined —
       comparing against them reported a change on every edit, and named the
       new access "All Projects" however little had moved. */
    const newRole = user.role;
    /* A pending invite is tied to the account, not the address, so moving the
       address would leave the link sitting in the old inbox. Reissue it. */
    const shouldResendInvite =
      wasPending &&
      (oldProjects !== newProjects || oldRole !== newRole || emailChanged);

    if (shouldResendInvite) {
      await user.save();

      try {
        await sendRoleInvites({ user, invitedByName: req.admin.name });
      } catch (emailError) {
        console.error("Failed to send invite email:", emailError);
      }

      const updatedUser = await Admin.findById(user._id)
        .select("-password -inviteToken -inviteTokenExpiry")
        .populate("projects", "name");

      return sendSuccess(
        res,
        { user: updatedUser },
        "User updated and new invitation sent",
      );
    }

    const wasActive = !wasPending && user.status === "active";
    const shouldNotifyActiveUser =
      wasActive && (oldProjects !== newProjects || oldRole !== newRole);

    await user.save();

    /*
     * A place that has been granted but never offered.
     *
     * The reissue above only covers accounts that are pending as a whole, and
     * the notice below compares the projects actually taken up — so adding a
     * project to somebody who has already signed in left it sitting pending
     * with no link ever sent, and nobody knew there was anything to accept.
     * Having no token is what marks it as never offered; a resend would have
     * left one.
     */
    const neverOffered = [
      ...new Set(
        (user.memberships || [])
          .filter((m) => m.status === "pending" && !m.inviteToken)
          .map((m) => m.role),
      ),
    ];

    if (neverOffered.length > 0) {
      try {
        await sendRoleInvites({
          user,
          invitedByName: req.admin.name,
          roles: neverOffered,
        });
      } catch (inviteError) {
        console.error(
          "Failed to send the invitation for newly granted access:",
          inviteError,
        );
      }
    }

    if (shouldNotifyActiveUser) {
      const Project = require("../models/Project");

      let oldProjectName = "All Projects";
      if (oldProjects) {
        const oldProjectIds = oldProjects.split(",").filter((id) => id);
        if (oldProjectIds.length > 0) {
          const oldProjectDocs = await Project.find({
            _id: { $in: oldProjectIds },
          });
          oldProjectName =
            oldProjectDocs.map((p) => p.name).join(", ") || "All Projects";
        }
      }

      let newProjectName = "All Projects";
      if (newProjectIds.length > 0) {
        const newProjectDocs = await Project.find({
          _id: { $in: newProjectIds },
        });
        newProjectName =
          newProjectDocs.map((p) => p.name).join(", ") || "All Projects";
      }

      try {
        await sendRoleChangeEmail({
          email: user.email,
          name: user.name,
          oldRole: oldRole.charAt(0).toUpperCase() + oldRole.slice(1),
          newRole: newRole.charAt(0).toUpperCase() + newRole.slice(1),
          oldProject: oldProjectName,
          newProject: newProjectName,
        });
      } catch (emailError) {
        console.error("Failed to send role change email:", emailError);
      }
    }

    const updatedUser = await Admin.findById(user._id)
      .select("-password -inviteToken -inviteTokenExpiry")
      .populate("projects", "name");

    return sendSuccess(res, { user: updatedUser }, "User updated successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.patch("/:id/block", protect, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!mayManage(req.admin, user)) {
      return sendError(
        res,
        canManageAccount(req.admin, user)
          ? NOT_YOURS
          : "The Super Admin account cannot be changed from here.",
        403,
      );
    }

    if (user._id.toString() === req.admin._id.toString()) {
      return sendValidationError(res, [
        { field: "user", message: "You cannot block yourself" },
      ]);
    }

    if (user.status === "blocked") {
      user.status = "active";
    } else {
      user.status = "blocked";
    }

    await user.save();

    return sendSuccess(
      res,
      { status: user.status },
      `User ${user.status === "blocked" ? "blocked" : "unblocked"} successfully`,
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id);

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!mayManage(req.admin, user)) {
      return sendError(
        res,
        canManageAccount(req.admin, user)
          ? NOT_YOURS
          : "The Super Admin account cannot be changed from here.",
        403,
      );
    }

    if (user._id.toString() === req.admin._id.toString()) {
      return sendValidationError(res, [
        { field: "user", message: "You cannot delete yourself" },
      ]);
    }

    if (await wouldRemoveLastSuperAdmin(user)) {
      return sendError(
        res,
        "This is the last Super Admin. Promote another account before removing this one.",
        409,
      );
    }

    await Admin.findByIdAndDelete(req.params.id);

    return sendSuccess(res, {}, "User deleted successfully");
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

router.post("/:id/resend-invite", protect, async (req, res) => {
  try {
    const user = await Admin.findById(req.params.id).populate(
      "projects",
      "name",
    );

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!mayManage(req.admin, user)) {
      return sendError(
        res,
        canManageAccount(req.admin, user)
          ? NOT_YOURS
          : "The Super Admin account cannot be changed from here.",
        403,
      );
    }

    /* Since each project is invited for separately, somebody already signed in
       can still be waiting on another role — so this asks whether anything is
       outstanding, not whether the account is pending. */
    const outstanding = (user.memberships || []).some(
      (m) => m.status === "pending",
    );
    if (!outstanding && user.status !== "pending") {
      return sendValidationError(res, [
        {
          field: "status",
          message: "There is no invitation outstanding for this user",
        },
      ]);
    }

    /* The modal resends one project's invitation, which is the invitation for
       the role that project is held at. Without a role it resends every
       outstanding one. */
    const roles = req.body?.role ? [req.body.role] : undefined;

    let emailSent = true;
    try {
      await sendRoleInvites({ user, invitedByName: req.admin.name, roles });
    } catch (emailError) {
      console.error("Failed to resend invite email:", emailError);
      emailSent = false;
    }

    return sendSuccess(
      res,
      { emailSent },
      emailSent
        ? "Invitation resent successfully"
        : "Invitation token refreshed but email could not be sent. Please configure SMTP settings.",
    );
  } catch (error) {
    console.error(error);
    return sendError(res, "Server error");
  }
});

module.exports = router;
