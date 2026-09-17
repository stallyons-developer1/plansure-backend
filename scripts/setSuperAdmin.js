/*
 * Marks one admin account as the Super Admin.
 *
 * The flag cannot be granted through the app — inviting someone always creates
 * a plain account — so the first owner has to be set here. Run it again to
 * hand ownership to a different account; it clears the flag from everyone else
 * so there is only ever one.
 *
 *   node scripts/setSuperAdmin.js admin@plansure.com
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

  // Only one owner: clear the flag everywhere else first.
  await Admin.updateMany(
    { _id: { $ne: target._id } },
    { $set: { isSuperAdmin: false } },
  );
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
