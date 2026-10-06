/*
 * Builds each account's per-project memberships from what it already holds.
 *
 * Until now an account carried one role and a flat list of projects, so the
 * role applied everywhere. Memberships record the role per project, which is
 * how the client's teams actually work — a PM on one programme who only
 * watches another. Existing accounts get the same role on every project they
 * already reach, so nothing changes for them on the day this runs.
 *
 * A Super Admin reaches every project through the flag and needs no rows.
 * Accounts that already have memberships are left alone, so the script is
 * safe to run twice.
 *
 *   node scripts/backfillMemberships.js            # report only
 *   node scripts/backfillMemberships.js --apply    # write them
 */
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const mongoose = require("mongoose");

const run = async () => {
  const apply = process.argv.includes("--apply");

  await mongoose.connect(process.env.MONGO_URI);
  /* populate needs the referenced model registered, and a script loads only
     what it asks for — unlike the server, which pulls every model in through
     the routes. */
  require("../models/Project");
  const Admin = require("../models/Admin");

  const accounts = await Admin.find().populate("projects", "name");

  const planned = [];
  const skipped = [];

  for (const account of accounts) {
    if (account.memberships?.length > 0) {
      skipped.push({ account, why: "already has memberships" });
      continue;
    }
    if (account.isSuperAdmin) {
      skipped.push({ account, why: "Super Admin — reaches every project" });
      continue;
    }
    if (!account.projects || account.projects.length === 0) {
      skipped.push({ account, why: "no projects to carry over" });
      continue;
    }

    planned.push({
      account,
      rows: account.projects.map((p) => ({
        project: p._id,
        name: p.name,
        role: account.role,
      })),
    });
  }

  if (planned.length === 0) {
    console.log("Nothing to backfill.");
  } else {
    console.log(`\n${planned.length} account(s) to backfill:\n`);
    planned.forEach(({ account, rows }) => {
      console.log(`  ${account.email}`);
      rows.forEach((r) => console.log(`      ${r.role.padEnd(8)} ${r.name}`));
    });
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.length} account(s) left alone:`);
    skipped.forEach((s) => console.log(`  ${s.account.email} — ${s.why}`));
  }

  if (!apply) {
    if (planned.length > 0) {
      console.log("\nNothing written. Re-run with --apply to save these.");
    }
    await mongoose.disconnect();
    return;
  }

  for (const { account, rows } of planned) {
    account.memberships = rows.map((r) => ({ project: r.project, role: r.role }));
    await account.save();
  }

  console.log(`\nBackfilled ${planned.length} account(s).`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
