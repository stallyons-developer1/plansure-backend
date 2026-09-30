/*
 * Marks one admin account as the Super Admin.
 *
 * The first owner has to be set here, because there is nobody to invite them.
 * After that a Super Admin can invite another from inside the app.
 *
 *   node scripts/setSuperAdmin.js admin@plansure.com          # add an owner
 *   node scripts/setSuperAdmin.js admin@plansure.com --only   # make it the only one
 *   node scripts/setSuperAdmin.js --show
 */
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const mongoose = require("mongoose");

const run = async () => {
  const arg = process.argv[2];

  await mongoose.connect(process.env.MONGO_URI);
  const Admin = require("../models/Admin");

  const listAdmins = async () => {
    const admins = await Admin.find({ role: "admin" })
      .select("email name status isSuperAdmin")
      .sort({ createdAt: 1 });
    if (admins.length === 0) {
      console.log("No admin accounts exist.");
      return;
    }
    console.log("\nAdmin accounts:");
    admins.forEach((a) => {
      const mark = a.isSuperAdmin ? "SUPER ADMIN" : "PM";
      console.log(`  ${a.email.padEnd(34)} ${a.status.padEnd(9)} ${mark}`);
    });
    console.log("");
  };

  if (!arg || arg === "--show") {
    await listAdmins();
    if (!arg) {
      console.log("Usage: node scripts/setSuperAdmin.js <email>");
    }
    await mongoose.disconnect();
    return;
  }

  const email = arg.toLowerCase().trim();
  const target = await Admin.findOne({ email });

  if (!target) {
    console.error(`No account found for ${email}`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (target.role !== "admin") {
    console.error(
      `${email} has role "${target.role}". The Super Admin must be an admin account.`,
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  /* There can be several owners, so this adds one rather than handing over.
     Pass --only to clear the flag from everyone else and make this the sole
     owner, which is how the first one was set. */
  if (process.argv.includes("--only")) {
    await Admin.updateMany(
      { _id: { $ne: target._id } },
      { $set: { isSuperAdmin: false } },
    );
  }
  target.isSuperAdmin = true;
  await target.save();

  console.log(`\n${email} is now the Super Admin.`);
  await listAdmins();
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
