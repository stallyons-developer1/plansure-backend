const nodemailer = require("nodemailer");
const { Resend } = require("resend");

// Lazy initialize Resend
let resend = null;
const getResend = () => {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
};

// SMTP Transporter for Mailtrap (local development)
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
      rejectUnauthorized: false
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
};

// Check if using SMTP or Resend
const isSmtp = () => {
  const useSmtp = process.env.ISSMTP === "true";
  console.log(`[EMAIL] ISSMTP=${process.env.ISSMTP}, Using: ${useSmtp ? 'SMTP (Mailtrap)' : 'Resend API'}`);
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
    console.log(`[EMAIL] Sending invite email to: ${options.email}`);

    if (isSmtp()) {
      // Use SMTP (Mailtrap) for local development
      console.log(`[EMAIL] Using SMTP - Host: ${process.env.SMTP_HOST}, Port: ${process.env.SMTP_PORT}`);
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "You've been invited to join Plansure",
        html: htmlContent,
      });
      console.log(`[EMAIL] SMTP send success:`, result.messageId);
    } else {
      // Use Resend for production (Railway)
      console.log(`[EMAIL] Using Resend API - Key exists: ${!!process.env.RESEND_API_KEY}`);
      const result = await getResend().emails.send({
        from: "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "You've been invited to join Plansure",
        html: htmlContent,
      });
      console.log(`[EMAIL] Resend send success:`, result);
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
            <a href="${process.env.FRONTEND_URL}/login" class="button">Login to Plansure</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    console.log(`[EMAIL] Sending welcome email to: ${options.email}`);

    if (isSmtp()) {
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "Welcome to Plansure!",
        html: htmlContent,
      });
      console.log(`[EMAIL] SMTP welcome email success:`, result.messageId);
    } else {
      const result = await getResend().emails.send({
        from: "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "Welcome to Plansure!",
        html: htmlContent,
      });
      console.log(`[EMAIL] Resend welcome email success:`, result);
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
            <a href="${process.env.FRONTEND_URL}/login" class="button">Go to Plansure</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    console.log(`[EMAIL] Sending role change email to: ${options.email}`);

    if (isSmtp()) {
      const transporter = createTransporter();
      const result = await transporter.sendMail({
        from: "Plansure <noreply@plansure.io>",
        to: options.email,
        subject: "Your Plansure Account Has Been Updated",
        html: htmlContent,
      });
      console.log(`[EMAIL] SMTP role change email success:`, result.messageId);
    } else {
      const result = await getResend().emails.send({
        from: "Plansure <onboarding@resend.dev>",
        to: options.email,
        subject: "Your Plansure Account Has Been Updated",
        html: htmlContent,
      });
      console.log(`[EMAIL] Resend role change email success:`, result);
    }
  } catch (error) {
    console.error(`[EMAIL] Error sending role change email:`, error);
    throw error;
  }
};

module.exports = { sendInviteEmail, sendWelcomeEmail, sendRoleChangeEmail };
