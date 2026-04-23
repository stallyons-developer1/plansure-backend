const { PdfReader } = require("pdfreader");
const Programme = require("../models/programmeModel");

const uploadProgramme = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No PDF file uploaded" });
    }

    const rows = {};
    const reader = new PdfReader();

    await new Promise((resolve, reject) => {
      reader.parseBuffer(req.file.buffer, (err, item) => {
        if (err) reject(err);
        else if (!item) resolve();
        else if (item.text) {
          const row = Math.round(item.y * 10);
          if (!rows[row]) rows[row] = [];
          rows[row].push({ x: item.x, text: item.text.trim() });
        }
      });
    });

    const activities = [];
    const seen = new Set();

    const activityIdRegex =
      /^([A-Z]{1,6}[-_]?[A-Z0-9]{1,10}[-_]?[A-Z0-9]*)\s+(.+?)\s+(\d+)\s+(\d{2}-[A-Za-z]{3}-\d{2,4})\s+(\d{2}-[A-Za-z]{3}-\d{2,4})/;
    const milestoneRegex =
      /^([A-Z]{1,6}[-_]?[A-Z0-9]{1,10}[-_]?[A-Z0-9]*)\s+(.+?)\s+(0)\s+(\d{2}-[A-Za-z]{3}-\d{2,4})/;

    for (const rowKey of Object.keys(rows).sort((a, b) => a - b)) {
      const cells = rows[rowKey].sort((a, b) => a.x - b.x);
      const line = cells.map((c) => c.text).join(" ");

      let match = line.match(activityIdRegex);
      if (match) {
        const key = `${match[1]}_${match[4]}`;
        if (!seen.has(key)) {
          seen.add(key);
          activities.push({
            activityId: match[1],
            activityName: match[2].trim(),
            originalDuration: parseInt(match[3]),
            startDate: match[4],
            finishDate: match[5],
            isMilestone: false,
          });
        }
        continue;
      }

      match = line.match(milestoneRegex);
      if (match) {
        const key = `${match[1]}_${match[4]}`;
        if (!seen.has(key)) {
          seen.add(key);
          activities.push({
            activityId: match[1],
            activityName: match[2].trim(),
            originalDuration: 0,
            startDate: match[4],
            finishDate: match[4],
            isMilestone: true,
          });
        }
      }
    }

    await Programme.deleteMany({});
    const saved = await Programme.create({ activities });

    res.status(201).json({
      message: "PDF parsed and saved successfully",
      totalActivities: activities.length,
      activities: saved.activities,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getProgramme = async (req, res) => {
  try {
    const programme = await Programme.findOne().sort({ createdAt: -1 });
    if (!programme) {
      return res.status(404).json({ message: "No programme uploaded yet" });
    }
    res.status(200).json({
      totalActivities: programme.activities.length,
      activities: programme.activities,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { uploadProgramme, getProgramme };
