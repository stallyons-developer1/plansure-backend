// Test helper: backdate a programme's cycle start so the 6-week cycle is
// already "over". Any activity that has an assigned action still open will
// then flip to Blocked (Red) on the next read / Recalculate RAG.
//
// Usage:
//   node scripts/backdateCycle.js                 # most recently updated programme
//   node scripts/backdateCycle.js "<programme name>"   # match by name
//   node scripts/backdateCycle.js --days 50       # how far back to set (default 50)
//
// To restore, re-upload or set lookaheadStartDate back to now.

require("dotenv").config();
const mongoose = require("mongoose");
const Programme = require("../models/Programme");

(async () => {
  const args = process.argv.slice(2);
  let days = 50;
  const dIdx = args.indexOf("--days");
  if (dIdx !== -1 && args[dIdx + 1]) {
    days = parseInt(args[dIdx + 1], 10);
    args.splice(dIdx, 2);
  }
  const nameArg = args[0];

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const query = nameArg ? { name: new RegExp(nameArg, "i") } : {};
  const programme = await Programme.findOne(query).sort({ updatedAt: -1 });

  if (!programme) {
    console.error("No programme found", nameArg ? `matching "${nameArg}"` : "");
    process.exit(1);
  }

  const backdated = new Date();
  backdated.setDate(backdated.getDate() - days);
  programme.lookaheadStartDate = backdated;
  await programme.save();

  const cycleEnd = new Date(backdated);
  cycleEnd.setDate(cycleEnd.getDate() + 42); // 6 weeks

  console.log(`\nProgramme:        ${programme.name} (${programme._id})`);
  console.log(`lookaheadStartDate set to: ${backdated.toDateString()}`);
  console.log(`=> 6-week cycle ended:     ${cycleEnd.toDateString()} (in the past)`);
  console.log(
    `\nNow: assign an action to an activity (leave it incomplete), then open`,
  );
  console.log(
    `the Activities & Lookahead tab (or run Recalculate RAG). Any activity`,
  );
  console.log(`with an open assigned action will show Blocked (Red).`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
