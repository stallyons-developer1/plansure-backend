const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Admin = require("./models/Admin");

dotenv.config();

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: "admin@plansure.com" });

    if (existingAdmin) {
      // Ensure admin is active (use updateOne to avoid pre-save hook)
      if (existingAdmin.status !== "active") {
        await Admin.updateOne(
          { _id: existingAdmin._id },
          { status: "active" }
        );
        console.log("Admin status updated to active");
      }
      console.log("Admin already exists:");
      console.log("Email: admin@plansure.com");
      console.log("Password: password");
    } else {
      // Create admin with active status
      const admin = await Admin.create({
        name: "Admin",
        email: "admin@plansure.com",
        password: "password",
        role: "admin",
        status: "active",
      });

      console.log("Admin created successfully:");
      console.log("Email: admin@plansure.com");
      console.log("Password: password");
    }

    process.exit(0);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
};

seedAdmin();
