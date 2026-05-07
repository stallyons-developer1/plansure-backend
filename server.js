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

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

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

app.get("/api/debug-env", (req, res) => {
  res.json({
    hasResendKey: !!process.env.RESEND_API_KEY,
    resendKeyLen: (process.env.RESEND_API_KEY || "").length,
    resendKeyPrefix: (process.env.RESEND_API_KEY || "").slice(0, 3),
    issmtp: process.env.ISSMTP,
    nodeEnv: process.env.NODE_ENV,
  });
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
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/fcm", require("./routes/fcmRoutes"));

const { protect, adminOnly } = require("./middleware/authMiddleware");
const mongoose = require("mongoose");
const fs = require("fs");

app.delete("/api/dev/clear-database", protect, adminOnly, async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();

    const results = {};

    for (const collection of collections) {
      if (collection.name === "admins") {
        const deleteResult = await db.collection(collection.name).deleteMany({
          role: { $ne: "admin" },
        });
        results[collection.name] =
          `deleted ${deleteResult.deletedCount} non-admin users (preserved admin users)`;
        continue;
      }

      const deleteResult = await db.collection(collection.name).deleteMany({});
      results[collection.name] =
        `deleted ${deleteResult.deletedCount} documents`;
    }

    const uploadsDir = "./uploads/programmes";
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        fs.unlinkSync(`${uploadsDir}/${file}`);
      }
      results["uploaded_files"] = `deleted ${files.length} PDF files`;
    }

    res.json({
      success: true,
      message: "Database cleared successfully",
      results,
    });
  } catch (error) {
    console.error("Clear database error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5000;

const { initializeFirebase } = require("./config/firebase");
initializeFirebase();

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
