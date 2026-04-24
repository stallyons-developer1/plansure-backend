const nodemailer = require("nodemailer");

// Create transporter for Mailtrap
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

// Send invite email
const sendInviteEmail = async (options) => {
  const transporter = createTransporter();

  const mailOptions = {
    from: "Plansure <noreply@plansure.io>",
    to: options.email,
    subject: "You've been invited to join Plansure",
    html: `
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
    `,
  };

  await transporter.sendMail(mailOptions);
};

// Send welcome email after accepting invite
const sendWelcomeEmail = async (options) => {
  const transporter = createTransporter();

  const mailOptions = {
    from: "Plansure <noreply@plansure.io>",
    to: options.email,
    subject: "Welcome to Plansure!",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4CAF50; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; padding: 14px 28px; background: #1a1a2e; color: white; border-radius: 6px; text-decoration: none; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome Aboard!</h1>
          </div>
          <div class="content">
            <h2>Hello ${options.name},</h2>
            <p>Your account has been successfully activated. You can now log in to Plansure and start collaborating with your team.</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/login" class="button">Login to Plansure</a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendInviteEmail, sendWelcomeEmail };
