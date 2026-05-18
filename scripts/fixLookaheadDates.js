const mongoose = require("mongoose");
require("dotenv").config();

const Programme = require("../models/Programme");

const fixLookaheadDates = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    const programmes = await Programme.find({});
    console.log(`Found ${programmes.length} programmes to fix`);

    let updated = 0;
    for (const programme of programmes) {
      if (programme.createdAt) {
        programme.lookaheadStartDate = programme.createdAt;
        await programme.save();
        updated++;
        console.log(`Fixed: ${programme.name} - lookaheadStartDate set to ${programme.createdAt}`);
      }
    }

    console.log(`\nDone! Updated ${updated} programmes.`);
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
};

fixLookaheadDates();
