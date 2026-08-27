/*
 * Creates the role-test accounts MS-05 §5 / AC10 asks for: planners and
 * standard Action Owners that can actually log in.
 *
 * Direct seed rather than the invite flow on purpose — invites land on an
 * unverified sending domain today, which is exactly why the client reported
 * test accounts as unreliable. These are created active with a known password,
 * so role testing does not wait on email.
 *
 * Idempotent: re-running resets the password and role rather than duplicating.
 *
 *   node scripts/seedTestAccounts.js            # dry run, prints the plan
 *   node scripts/seedTestAccounts.js --commit   # writes
 */
require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

/*
 * mongodb+srv:// needs an SRV lookup, and plenty of ISP resolvers either block
 * or mishandle those — the symptom is ESERVFAIL on _mongodb._tcp.<cluster>
 * even though the cluster is up and the app connects fine from its host.
 * Point Node at public resolvers so the script does not depend on whatever
 * the local network hands out.
 */
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const Admin = require("../models/Admin");

const PASSWORD = "PlanSure#2026";

const ACCOUNTS = [
  { name: "Planner One", email: "planner1@plansure.com", role: "planner" },
  { name: "Planner Two", email: "planner2@plansure.com", role: "planner" },
  { name: "User One", email: "user1@plansure.com", role: "user" },
  { name: "User Two", email: "user2@plansure.com", role: "user" },
  { name: "User Three", email: "user3@plansure.com", role: "user" },
];

(async () => {
  const commit = process.argv.includes("--commit");
  const uri = process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log("db:", mongoose.connection.host, "/", mongoose.connection.name);
  console.log(commit ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  /* No projects granted up front. Access should appear because someone gave
     them work, not because a seed script pre-wired it — GET /api/users already
     derives a user's project access from the actions assigned to them, so a
     project surfaces against the user the moment an Admin or Planner assigns
     one. Starting empty is also the honest state for a role test. */
  console.log("projects granted: none (assigned work will surface them)\n");

  for (const a of ACCOUNTS) {
    const existing = await Admin.findOne({ email: a.email });
    const verb = existing ? "update" : "create";
    console.log(`  ${verb.padEnd(6)} ${a.role.padEnd(8)} ${a.email}`);
    if (!commit) continue;

    if (existing) {
      existing.name = a.name;
      existing.role = a.role;
      existing.status = "active";
      /* Reset, not preserve: this is a seed, and the accounts are meant to
         start with no project access. Note a re-run therefore clears any
         project an Admin granted during testing — derived access from
         assigned actions is unaffected, since that is computed on read. */
      existing.projects = [];
      existing.password = PASSWORD; // pre-save hook hashes it
      await existing.save();
    } else {
      await Admin.create({
        name: a.name,
        email: a.email,
        role: a.role,
        status: "active",
        projects: [],
        password: PASSWORD,
      });
    }
  }

  console.log(commit ? "\ndone." : "\nnothing written.");
  await mongoose.disconnect();
})().then(() => process.exit(0)).catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
