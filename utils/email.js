const nodemailer = require("nodemailer");
const { Resend } = require("resend");

let resend = null;
const getResend = () => {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      throw new Error("RESEND_API_KEY environment variable is not set");
    }
    resend = new Resend(apiKey);
  }
  return resend;
};

const createTransporter = () => {
  const port = parseInt(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
};

/* Trailing slashes in FRONTEND_URL would otherwise produce "…app//login". */
const appUrl = () =>
  (process.env.FRONTEND_URL || "https://plansure-m5.netlify.app").replace(
    /\/+$/,
    "",
  );

const isSmtp = () => {
  const useSmtp = process.env.ISSMTP === "true";

  return useSmtp;
};

const sendInviteEmail = async (options) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; padding: 14px 28px; margin: 10px 5px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .accept { background: #4CAF50; color: white; }
        .reject { background: #f44336; color: white; }
        .role-badge { display: inline-block; padding: 5px 15px; border-radius: 20px; font-size: 14px; margin: 10px 0; }
        .admin { background: #ff6b6b; color: white; }
        .planner { background: #ffd93d; color: #333; }
        .user { background: #6bcb77; color: white; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to Plansure</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>You've been invited by <strong>${options.invitedByName}</strong> to join Plansure as a team member.</p>

          <p><strong>Your Role:</strong></p>
          <span class="role-badge ${options.role}">${options.role.charAt(0).toUpperCase() + options.role.slice(1)}</span>

          <p><strong>Project Assignment:</strong> ${options.projectName || "All Projects"}</p>

          <p>Click below to accept or decline this invitation:</p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${options.acceptUrl}" class="button accept">Accept Invite</a>
            <a href="${options.rejectUrl}" class="button reject">Decline</a>
          </div>

          <p style="color: #666; font-size: 14px;">This invitation will expire in 7 days.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "You've been invited to join Plansure",
        html: htmlContent,
      });
    } else {
      const result = await getResend().emails.send({
        from:
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "You've been invited to join Plansure",
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending invite email:`, error);
    throw error;
  }
};

const sendWelcomeEmail = async (options) => {
  const passwordSection = options.password
    ? `
    <div style="background: #1a1a2e; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #94a3b8;">Your temporary password:</p>
      <p style="margin: 0; font-size: 24px; color: #3b82f6; font-weight: bold;">${options.password}</p>
      <p style="margin: 10px 0 0 0; color: #94a3b8; font-size: 12px;">Please change your password after logging in.</p>
    </div>
  `
    : "";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #22c55e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to Plansure!</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>Your account has been successfully activated. You can now log in to Plansure and start collaborating with your team.</p>

          ${passwordSection}

          <div style="text-align: center; margin: 30px 0;">
            <a href="${appUrl()}/login" class="button">Login to Plansure</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "Welcome to Plansure!",
        html: htmlContent,
      });
    } else {
      const result = await getResend().emails.send({
        from:
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "Welcome to Plansure!",
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending welcome email:`, error);
    throw error;
  }
};

const sendRoleChangeEmail = async (options) => {
  const changes = [];
  if (options.oldRole !== options.newRole) {
    changes.push(
      `<li>Role changed from <strong>${options.oldRole}</strong> to <strong>${options.newRole}</strong></li>`,
    );
  }
  if (options.oldProject !== options.newProject) {
    changes.push(
      `<li>Project assignment changed from <strong>${options.oldProject}</strong> to <strong>${options.newProject}</strong></li>`,
    );
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #3b82f6; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .changes { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
        .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Account Updated</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>Your Plansure account has been updated by an administrator.</p>

          <div class="changes">
            <strong>Changes made:</strong>
            <ul>
              ${changes.join("")}
            </ul>
          </div>

          <p>If you have any questions about these changes, please contact your administrator.</p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${appUrl()}/login" class="button">Go to Plansure</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "Your Plansure Account Has Been Updated",
        html: htmlContent,
      });
    } else {
      const result = await getResend().emails.send({
        from:
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "Your Plansure Account Has Been Updated",
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending role change email:`, error);
    throw error;
  }
};

/*
 * Sent to the person an action lands on, alongside the in-app notification and
 * push. Covers both a brand-new assignment and a reassignment; `isReassignment`
 * only changes the wording.
 */
const sendActionAssignedEmail = async (options) => {
  const heading = options.isReassignment
    ? "Action Reassigned to You"
    : "New Action Assigned";
  const lead = options.isReassignment
    ? `<strong>${options.assignedByName}</strong> has reassigned an action to you.`
    : `<strong>${options.assignedByName}</strong> has assigned you a new action.`;

  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">${label}</td>
           <td style="padding: 6px 0; color: #333; font-size: 14px;"><strong>${value}</strong></td>
         </tr>`
      : "";

  const dueDate = options.dueDate
    ? new Date(options.dueDate).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
        .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${heading}</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>${lead}</p>

          <div class="card">
            <p style="margin: 0 0 12px 0; font-size: 16px;"><strong>${options.actionTitle}</strong></p>
            ${options.description ? `<p style="margin: 0 0 12px 0; color: #666; font-size: 14px;">${options.description}</p>` : ""}
            <table style="width: 100%; border-collapse: collapse;">
              ${row("Project", options.projectName)}
              ${row("Linked activity", options.linkedActivity)}
              ${row("Type", options.type)}
              ${row("Priority", options.priority)}
              ${row("Due date", dueDate)}
            </table>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${appUrl()}/login" class="button">View in Plansure</a>
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  /* The envelope address must stay on a domain the provider has verified, or
     the send is rejected outright. So the assigner's name goes in the display
     name and their address in Reply-To, rather than in From itself. Once a
     domain of theirs is verified, From can become their real address. */
  const senderFrom = (base) => {
    const match = /<([^>]+)>/.exec(base);
    const address = match ? match[1] : base;
    return options.assignedByName
      ? `${options.assignedByName} via Plansure <${address}>`
      : base;
  };

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: senderFrom("Plansure <noreply@plansure.io>"),
        replyTo: options.assignedByEmail || undefined,
        to: options.email,
        subject: `${heading}: ${options.actionTitle}`,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from: senderFrom(
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        ),
        replyTo: options.assignedByEmail || undefined,
        to: options.email,
        subject: `${heading}: ${options.actionTitle}`,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending action assigned email:`, error);
    throw error;
  }
};

const STATUS_COLOURS = {
  Open: "#3b82f6",
  "In Progress": "#f59e0b",
  Completed: "#22c55e",
  Cancelled: "#6b7280",
  "PM Override": "#ef4444",
};

/*
 * Sent when an action moves between statuses — completed, reopened, cancelled,
 * force-closed by a PM, or force-closed automatically once its governance week
 * ended. Goes to the assignee and the person who raised it, minus whoever made
 * the change. `changedByName` is omitted for the automatic sweep, which has no
 * accountable actor.
 */
const sendActionStatusChangedEmail = async (options) => {
  const colour = STATUS_COLOURS[options.newStatus] || "#3b82f6";
  const actor = options.changedByName
    ? `<strong>${options.changedByName}</strong> changed the status of an action.`
    : "The status of an action has changed automatically.";

  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">${label}</td>
           <td style="padding: 6px 0; color: #333; font-size: 14px;"><strong>${value}</strong></td>
         </tr>`
      : "";

  const dueDate = options.dueDate
    ? new Date(options.dueDate).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid ${colour}; margin: 20px 0; }
        .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: bold; }
        .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Action Status Updated</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>${actor}</p>

          <div class="card">
            <p style="margin: 0 0 12px 0; font-size: 16px;"><strong>${options.actionTitle}</strong></p>

            <p style="margin: 0 0 16px 0; font-size: 14px; color: #666;">
              <span class="badge" style="background: #e5e7eb; color: #6b7280;">${options.previousStatus}</span>
              <span style="margin: 0 8px;">&rarr;</span>
              <span class="badge" style="background: ${colour}22; color: ${colour};">${options.newStatus}</span>
            </p>

            ${options.reason ? `<p style="margin: 0 0 12px 0; color: #666; font-size: 14px;"><strong>Reason:</strong> ${options.reason}</p>` : ""}

            <table style="width: 100%; border-collapse: collapse;">
              ${row("Project", options.projectName)}
              ${row("Linked activity", options.linkedActivity)}
              ${row("Due date", dueDate)}
            </table>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${appUrl()}/login" class="button">View in Plansure</a>
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `Action ${options.newStatus}: ${options.actionTitle}`;

  const senderFrom = (base) => {
    const match = /<([^>]+)>/.exec(base);
    const address = match ? match[1] : base;
    return options.changedByName
      ? `${options.changedByName} via Plansure <${address}>`
      : base;
  };

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: senderFrom("Plansure <noreply@plansure.io>"),
        replyTo: options.changedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from: senderFrom(
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        ),
        replyTo: options.changedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending action status email:`, error);
    throw error;
  }
};

/*
 * Sent to the planners a Planner To-Do has been issued to, alongside the
 * in-app notification and push. The list itself is downloaded from the app —
 * this is the prompt to go and do that, not the file.
 */
const sendPlannerTodoEmail = async (options) => {
  const count = options.totalActions || 0;
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
        .count { font-size: 32px; font-weight: bold; color: #3b82f6; }
        .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Planner To-Do Issued</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>
            The Planner To-Do for
            <strong>Week ${options.weekNumber}</strong>
            ${options.projectName ? ` on <strong>${options.projectName}</strong>` : ""}
            has been issued${options.generatedByName ? ` by <strong>${options.generatedByName}</strong>` : ""}.
          </p>

          <div class="card">
            <p style="margin: 0; color: #666; font-size: 14px;">Outstanding items to action</p>
            <p class="count" style="margin: 4px 0 0 0;">${count}</p>
          </div>

          <p>Sign in to review the list and update the programme.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `Planner To-Do issued — Week ${options.weekNumber}${
    options.projectName ? `, ${options.projectName}` : ""
  }`;

  const senderFrom = (base) => {
    const match = /<([^>]+)>/.exec(base);
    const address = match ? match[1] : base;
    return options.generatedByName
      ? `${options.generatedByName} via Plansure <${address}>`
      : base;
  };

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: senderFrom("Plansure <noreply@plansure.io>"),
        replyTo: options.generatedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from: senderFrom(
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        ),
        replyTo: options.generatedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending planner to-do email:`, error);
    throw error;
  }
};

/*
 * Sent once when a programme first satisfies every close-out condition — no
 * open Required actions, nothing overdue, no blocked activities — which is the
 * moment the "Mark Close-Out Eligible" control becomes available.
 */
const sendCloseOutEligibleEmail = async (options) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #16a34a; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid #22c55e; margin: 20px 0; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Ready for Close-Out</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>
            <strong>Week ${options.weekNumber}</strong>
            ${options.projectName ? ` on <strong>${options.projectName}</strong>` : ""}
            has met every close-out condition and can now be marked Close-Out Eligible.
          </p>

          <div class="card">
            <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">All conditions met</p>
            <p style="margin: 0; font-size: 14px;">
              No required actions left open &middot; nothing overdue &middot; no blocked activities
            </p>
          </div>

          <p>Sign in to review the week and take it through close-out.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `Ready for close-out — Week ${options.weekNumber}${
    options.projectName ? `, ${options.projectName}` : ""
  }`;

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from:
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending close-out eligible email:`, error);
    throw error;
  }
};

/*
 * Sent when a governance week is closed, to the people who carry the week but
 * did not close it — most importantly the Planner, who may not have been the
 * one to do it. Closing locks the week read-only, so anyone who still owed an
 * update needs telling promptly.
 */
const sendWeekClosedEmail = async (options) => {
  const isOverride = options.closeType === "PM Override";
  const accent = isOverride ? "#ef4444" : "#3b82f6";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid ${accent}; margin: 20px 0; }
        .notice { background: #fff7ed; border: 1px solid #fed7aa; padding: 14px 16px; border-radius: 8px; margin: 20px 0; font-size: 14px; color: #9a3412; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Week ${options.weekNumber} Closed</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>
            <strong>Week ${options.weekNumber}</strong>
            ${options.projectName ? ` on <strong>${options.projectName}</strong>` : ""}
            has been closed${options.closedByName ? ` by <strong>${options.closedByName}</strong>` : ""}.
          </p>

          <div class="card">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">Closed by</td>
                <td style="padding: 6px 0; color: #333; font-size: 14px;"><strong>${options.closedByName || "System"}</strong></td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #666; font-size: 14px;">Close type</td>
                <td style="padding: 6px 0; font-size: 14px;"><strong style="color: ${accent};">${options.closeType || "Normal Close"}</strong></td>
              </tr>
              ${
                options.notes
                  ? `<tr>
                       <td style="padding: 6px 0; color: #666; font-size: 14px;">${isOverride ? "Reason" : "Notes"}</td>
                       <td style="padding: 6px 0; color: #333; font-size: 14px;">${options.notes}</td>
                     </tr>`
                  : ""
              }
            </table>
          </div>

          <div class="notice">
            This week is now locked and read-only. If you still had a programme
            update to make against it, raise it with
            ${options.closedByName || "whoever closed the week"}.
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `Week ${options.weekNumber} closed${
    options.projectName ? ` — ${options.projectName}` : ""
  }${isOverride ? " (PM Override)" : ""}`;

  const senderFrom = (base) => {
    const match = /<([^>]+)>/.exec(base);
    const address = match ? match[1] : base;
    return options.closedByName
      ? `${options.closedByName} via Plansure <${address}>`
      : base;
  };

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: senderFrom("Plansure <noreply@plansure.io>"),
        replyTo: options.closedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from: senderFrom(
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        ),
        replyTo: options.closedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending week closed email:`, error);
    throw error;
  }
};

/*
 * Sent when someone marks a week Close-Out Eligible. Either an Admin or a
 * Planner can do it, so the email names who did and in what role — the other
 * stakeholders need to know the week has moved on without them.
 */
const sendMarkedCloseOutEligibleEmail = async (options) => {
  const actor = options.markedByName || "Someone";
  const role = options.markedByRole
    ? options.markedByRole.charAt(0).toUpperCase() +
      options.markedByRole.slice(1)
    : null;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a2e; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Marked Close-Out Eligible</h1>
        </div>
        <div class="content">
          <h2>Hello ${options.name},</h2>
          <p>
            <strong>Week ${options.weekNumber}</strong>
            ${options.projectName ? ` on <strong>${options.projectName}</strong>` : ""}
            has been marked <strong>Close-Out Eligible</strong> by
            <strong>${actor}</strong>${role ? ` (${role})` : ""}.
          </p>

          <div class="card">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">Marked by</td>
                <td style="padding: 6px 0; color: #333; font-size: 14px;"><strong>${actor}</strong>${role ? ` (${role})` : ""}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #666; font-size: 14px;">New status</td>
                <td style="padding: 6px 0; font-size: 14px;"><strong style="color: #3b82f6;">Close-Out Eligible</strong></td>
              </tr>
            </table>
          </div>

          <p>
            The week can now be closed. Sign in to review it before it is,
            since closing locks it read-only.
          </p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Plansure. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `Week ${options.weekNumber} marked Close-Out Eligible${
    options.projectName ? ` — ${options.projectName}` : ""
  }`;

  const senderFrom = (base) => {
    const match = /<([^>]+)>/.exec(base);
    const address = match ? match[1] : base;
    return options.markedByName
      ? `${options.markedByName} via Plansure <${address}>`
      : base;
  };

  try {
    if (isSmtp()) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: senderFrom("Plansure <noreply@plansure.io>"),
        replyTo: options.markedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    } else {
      await getResend().emails.send({
        from: senderFrom(
          process.env.RESEND_FROM_EMAIL || "Plansure <onboarding@resend.dev>",
        ),
        replyTo: options.markedByEmail || undefined,
        to: options.email,
        subject,
        html: htmlContent,
      });
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending marked close-out email:`, error);
    throw error;
  }
};

module.exports = {
  sendInviteEmail,
  sendWelcomeEmail,
  sendRoleChangeEmail,
  sendActionAssignedEmail,
  sendActionStatusChangedEmail,
  sendPlannerTodoEmail,
  sendCloseOutEligibleEmail,
  sendWeekClosedEmail,
  sendMarkedCloseOutEligibleEmail,
};
