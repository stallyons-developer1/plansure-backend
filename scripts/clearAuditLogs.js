/*
 * Deletes audit log entries.
 *
 * There is deliberately no endpoint or button for this — the trail is
 * append-only, and MS-05 point 8 asks that action details, closure narratives,
 * override reasons, people and timestamps stay in it permanently. Clearing it
 * is a one-off housekeeping act, so it lives here and has to be run by hand.
 *
 * Nothing is deleted without --apply. There is no backup and no undo.
 *
 *   node scripts/clearAuditLogs.js                      # report only
 *   node scripts/clearAuditLogs.js --apply              # delete everything
 *   node scripts/clearAuditLogs.js --before 2026-09-01  # older than a date
 *   node scripts/clearAuditLogs.js --project <id>       # one project only
 */
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const mongoose = require("mongoose");

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};

const run = async () => {
  const apply = process.argv.includes("--apply");
  const before = argValue("--before");
  const projectId = argValue("--project");

  const query = {};

  if (before) {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) {
      console.error(`--before "${before}" is not a date. Use YYYY-MM-DD.`);
      process.exit(1);
    }
    query.createdAt = { $lt: cutoff };
  }

  if (projectId) {
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      console.error(`--project "${projectId}" is not a valid id.`);
      process.exit(1);
    }
    query.project = projectId;
  }

  await mongoose.connect(process.env.MONGO_URI);
  const AuditLog = require("./../models/AuditLog");

  const total = await AuditLog.countDocuments();
  const matched = await AuditLog.countDocuments(query);

  console.log(`\nAudit entries in total : ${total}`);
  console.log(`Matching this run      : ${matched}`);
  if (before) console.log(`  older than           : ${before}`);
  if (projectId) console.log(`  project              : ${projectId}`);

  if (matched === 0) {
    console.log("\nNothing to delete.");
    await mongoose.disconnect();
    return;
  }

  /* Show what is going, so an unintended scope is obvious before it runs. */
  const byAction = await AuditLog.aggregate([
    { $match: query },
    { $group: { _id: "$action", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
  ]);

  console.log("\nBy action:");
  byAction.forEach((row) => {
    console.log(`  ${String(row._id).padEnd(32)} ${row.count}`);
  });

  const oldest = await AuditLog.findOne(query).sort({ createdAt: 1 });
  const newest = await AuditLog.findOne(query).sort({ createdAt: -1 });
  if (oldest && newest) {
    console.log(
      `\nRange: ${oldest.createdAt.toISOString()} → ${newest.createdAt.toISOString()}`,
    );
  }

  if (!apply) {
    console.log(
      `\nNothing deleted. Re-run with --apply to remove these ${matched} entries.`,
    );
    console.log("This cannot be undone — there is no backup of the trail.");
    await mongoose.disconnect();
    return;
  }

  const result = await AuditLog.deleteMany(query);
  const remaining = await AuditLog.countDocuments();

  console.log(`\nDeleted ${result.deletedCount} entries. ${remaining} remain.`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
