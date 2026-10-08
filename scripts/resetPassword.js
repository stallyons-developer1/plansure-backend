/*
 * Sets an account's password from the command line.
 *
 * There is deliberately no endpoint for this. The reset link in the app is
 * emailed to the account's own address, which is no use when nobody can reach
 * that inbox — admin@plansure.com is not a domain this project owns — and that
 * is the one case where an owner can lock themselves out entirely.
 *
 * With no --password it generates one and prints it once, so nothing a
 * password manager would want ends up in the shell history.
 *
 *   node scripts/resetPassword.js admin@plansure.com                 # report only
 *   node scripts/resetPassword.js admin@plansure.com --apply         # generated
 *   node scripts/resetPassword.js admin@plansure.com --apply --password 'chosen'
 */
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const mongoose = require("mongoose");
const crypto = require("crypto");

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};

const generate = () =>
  `${crypto.randomBytes(6).toString("base64url")}A1!`;

const run = async () => {
  const email = (process.argv[2] || "").toLowerCase().trim();
  const apply = process.argv.includes("--apply");
  const chosen = argValue("--password");

  if (!email || email.startsWith("--")) {
    console.error("Usage: node scripts/resetPassword.js <email> [--apply] [--password <value>]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const Admin = require("../models/Admin");

  const user = await Admin.findOne({ email });
  if (!user) {
    console.error(`No account found for ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nAccount : ${user.email}`);
  console.log(`Name    : ${user.name}`);
  console.log(`Role    : ${user.role}${user.isSuperAdmin ? " (Super Admin)" : ""}`);
  console.log(`Status  : ${user.status}`);
  console.log(`Password: ${user.password ? "set" : "NONE — this account cannot sign in"}`);

  if (!apply) {
    console.log("\nNothing changed. Re-run with --apply to set a new password.");
    await mongoose.disconnect();
    return;
  }

  const password = chosen || generate();

  /* The app refuses anything shorter when a password is set through it, and an
     account that cannot be changed from inside the app afterwards is worse
     than one that is locked out now. */
  if (password.length < 6) {
    console.error("\nPassword must be at least 6 characters — the app refuses shorter ones.");
    await mongoose.disconnect();
    process.exit(1);
  }

  /* Assigned, not hashed here: the model's pre-save hook does the hashing, and
     doing it twice would store a hash of a hash. */
  user.password = password;

  /* A blocked or half-invited account still could not sign in afterwards. */
  if (user.status !== "active") {
    console.log(`\nStatus was "${user.status}" — setting it active so the account can sign in.`);
    user.status = "active";
  }

  await user.save();

  console.log("\nPassword set.");
  if (!chosen) {
    console.log(`\n    ${password}\n`);
    console.log("Shown once. Change it from Settings after signing in.");
  }

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
