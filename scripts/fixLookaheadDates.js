const mongoose = require("mongoose");
require("dotenv").config();

const Programme = require("../models/Programme");

const fixLookaheadDates = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const programmes = await Programme.find({});

    let updated = 0;
    for (const programme of programmes) {
      if (programme.createdAt) {
        programme.lookaheadStartDate = programme.createdAt;
        await programme.save();
        updated++;
      }
    }

    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
};

fixLookaheadDates();
