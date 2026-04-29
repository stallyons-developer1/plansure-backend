const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const connectDB = require("./config/db");

dotenv.config();

console.log("[BOOT]", {
  hasResendKey: !!process.env.RESEND_API_KEY,
  resendKeyLen: (process.env.RESEND_API_KEY || "").length,
  resendKeyPrefix: (process.env.RESEND_API_KEY || "").slice(0, 3),
  issmtp: process.env.ISSMTP,
});

connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.send("Plansure API is running...");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/test-email", async (req, res) => {
  const nodemailer = require("nodemailer");

  console.log("SMTP Settings:", {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS ? "****" : "NOT SET",
  });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.verify();
    console.log("SMTP connection verified!");

    await transporter.sendMail({
      from: "Plansure <noreply@plansure.io>",
      to: "test@example.com",
      subject: "Test Email from Plansure",
      text: "If you receive this, Mailtrap is working!",
    });

    res.json({
      success: true,
      message: "Test email sent! Check Mailtrap inbox.",
    });
  } catch (error) {
    console.error("Email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use("/api/auth", require("./routes/adminRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/projects", require("./routes/projectRoutes"));
app.use("/api/programmes", require("./routes/programmeUploadRoutes"));
app.use("/api/actions", require("./routes/actionRoutes"));

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Environment check:", {
    ISSMTP: process.env.ISSMTP || "NOT SET",
    RESEND_API_KEY: process.env.RESEND_API_KEY ? "SET" : "NOT SET",
    SMTP_HOST: process.env.SMTP_HOST || "NOT SET",
    SMTP_PORT: process.env.SMTP_PORT || "NOT SET",
    SMTP_USER: process.env.SMTP_USER ? "SET" : "NOT SET",
    SMTP_PASS: process.env.SMTP_PASS ? "SET" : "NOT SET",
  });
});
