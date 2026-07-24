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
  cycleEnd.setDate(cycleEnd.getDate() + 42);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
