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
      console.log("Admin already exists:");
      console.log("Email: admin@plansure.com");
      console.log("Password: admin123");
    } else {
      // Create admin
      const admin = await Admin.create({
        name: "Admin",
        email: "admin@plansure.com",
        password: "admin123",
        role: "admin",
      });

      console.log("Admin created successfully:");
      console.log("Email: admin@plansure.com");
      console.log("Password: admin123");
    }

    process.exit(0);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
};

seedAdmin();
