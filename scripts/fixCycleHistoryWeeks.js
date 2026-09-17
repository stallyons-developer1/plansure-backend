/*
 * Repairs the week numbers on closed-week history.
 *
 * A governance week gets its own programme, and close-week used to record the
 * week as that programme counted it — which is 1 for every week of a project.
 * So Week 2 and Week 3 were both stored as "Week 1", and the Historical Week
 * Explorer showed them collapsed together.
 *
 * Programme.weekNumber has always held the project-level count, so the true
 * number can be recovered from it. Closures written after this was fixed
 * already carry the right value and are left alone.
 *
 *   node scripts/fixCycleHistoryWeeks.js            # report only
 *   node scripts/fixCycleHistoryWeeks.js --apply    # write the corrections
 */
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
const mongoose = require("mongoose");

const run = async () => {
  const apply = process.argv.includes("--apply");

  await mongoose.connect(process.env.MONGO_URI);
  const Programme = require("./../models/Programme");
  const CycleHistory = require("./../models/CycleHistory");

  const cycles = await CycleHistory.find().sort({ createdAt: 1 });
  if (cycles.length === 0) {
    console.log("No closed-week history to check.");
    await mongoose.disconnect();
    return;
  }

  const programmeIds = [...new Set(cycles.map((c) => String(c.programme)))];
  const programmes = await Programme.find({ _id: { $in: programmeIds } }).select(
    "weekNumber name project",
  );
  const byId = new Map(programmes.map((p) => [String(p._id), p]));

  const corrections = [];
  const skipped = [];

  for (const cycle of cycles) {
    const programme = byId.get(String(cycle.programme));

    if (!programme) {
      skipped.push({ cycle, why: "programme no longer exists" });
      continue;
    }
    if (!programme.weekNumber) {
      skipped.push({ cycle, why: "programme has no weekNumber" });
      continue;
    }
    if (cycle.weekNumber === programme.weekNumber) continue;

    corrections.push({
      cycle,
      from: cycle.weekNumber,
      to: programme.weekNumber,
      programmeName: programme.name,
    });
  }

  if (corrections.length === 0) {
    console.log(`Checked ${cycles.length} closures — all week numbers correct.`);
  } else {
    console.log(`\n${corrections.length} closure(s) to correct:\n`);
    corrections.forEach((c) => {
      console.log(
        `  ${String(c.programmeName).padEnd(28)} Week ${c.from} -> Week ${c.to}`,
      );
    });
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.length} closure(s) left alone:`);
    skipped.forEach((s) =>
      console.log(`  ${String(s.cycle._id)} — ${s.why}`),
    );
  }

  if (!apply) {
    if (corrections.length > 0) {
      console.log("\nNothing written. Re-run with --apply to make the changes.");
    }
    await mongoose.disconnect();
    return;
  }

  for (const c of corrections) {
    c.cycle.weekNumber = c.to;
    if (c.cycle.weekLabel) c.cycle.weekLabel = `Week ${c.to}`;
    await c.cycle.save();
  }

  console.log(`\nCorrected ${corrections.length} closure(s).`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
