const { PdfReader } = require("pdfreader");
const Programme = require("../models/programmeModel");

const uploadProgramme = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No PDF file uploaded" });
    }

    // Step 1: Collect all text items with position
    const pages = {};
    const reader = new PdfReader();

    await new Promise((resolve, reject) => {
      reader.parseBuffer(req.file.buffer, (err, item) => {
        if (err) return reject(err);
        if (!item) return resolve();
        if (item.page) {
          pages[item.page] = {};
        }
        if (item.text && item.page) {
          const row = Math.round(item.y * 10) / 10;
          const page = item.page;
          if (!pages[page]) pages[page] = {};
          if (!pages[page][row]) pages[page][row] = [];
          pages[page][row].push({ x: item.x, text: item.text.trim() });
        }
      });
    });

    // Step 2: Parse activities per page, then deduplicate
    const activityMap = new Map(); // activityId -> activity object

    // Known column X positions (approximate from Primavera P6 PDF layout)
    // Activity ID ~ x:0-8, Activity Name ~ x:8-35, Duration ~ x:35-42, Start ~ x:42-50, Finish ~ x:50-58

    for (const page of Object.values(pages)) {
      for (const rowKey of Object.keys(page).sort(
        (a, b) => parseFloat(a) - parseFloat(b),
      )) {
        const cells = page[rowKey].sort((a, b) => a.x - b.x);

        if (cells.length < 2) continue;

        // Extract fields by X position
        let activityId = "";
        let activityName = "";
        let duration = "";
        let startDate = "";
        let finishDate = "";

        for (const cell of cells) {
          const x = cell.x;
          const txt = cell.text;

          if (x < 9 && !activityId) {
            // First column = Activity ID
            if (/^[A-Z0-9][A-Z0-9_\-\.]+$/.test(txt) && txt.length >= 3) {
              activityId = txt;
            }
          } else if (x >= 9 && x < 38 && activityId) {
            // Second column = Activity Name (may span multiple tokens)
            activityName += (activityName ? " " : "") + txt;
          } else if (x >= 38 && x < 44 && activityId) {
            // Duration column
            if (/^\d+$/.test(txt)) duration = txt;
          } else if (x >= 44 && x < 52 && activityId) {
            // Start date column
            if (/\d{2}-[A-Za-z]{3}-\d{2,4}/.test(txt)) {
              startDate = txt.replace(" A", "").replace("*", "").trim();
            }
          } else if (x >= 52 && activityId) {
            // Finish date column
            if (/\d{2}-[A-Za-z]{3}-\d{2,4}/.test(txt)) {
              finishDate = txt.replace(" A", "").replace("*", "").trim();
            }
          }
        }

        // Clean up activity name - remove duplicated text patterns
        if (activityName) {
          // Split by repeated content (Primavera repeats names)
          const parts = activityName.split(/\s{3,}/);
          activityName = parts[0].trim();

          // Also handle if same phrase repeated with space
          const words = activityName.split(" ");
          const half = Math.floor(words.length / 2);
          const firstHalf = words.slice(0, half).join(" ");
          const secondHalf = words.slice(half).join(" ");
          if (firstHalf === secondHalf && half > 2) {
            activityName = firstHalf;
          }
        }

        // Only save valid rows that have an Activity ID and name
        if (
          activityId &&
          activityName &&
          activityId.length >= 3 &&
          !activityId.includes("Activity") &&
          !activityName.includes("Activity ID") &&
          !activityName.includes("TASK filter")
        ) {
          // Deduplicate: first occurrence wins
          if (!activityMap.has(activityId)) {
            activityMap.set(activityId, {
              activityId,
              activityName: activityName.trim(),
              originalDuration: duration ? parseInt(duration) : 0,
              startDate: startDate || "",
              finishDate: finishDate || "",
              isMilestone: duration === "0" || duration === "",
              ragStatus: "Green",
              status: "Ready",
              owner: "",
            });
          }
        }
      }
    }

    const activities = Array.from(activityMap.values());

    // Save to MongoDB
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

const debugPDF = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file" });
    }

    const { PdfReader } = require("pdfreader");
    const reader = new PdfReader();
    const items = [];

    await new Promise((resolve, reject) => {
      reader.parseBuffer(req.file.buffer, (err, item) => {
        if (err) return reject(err);
        if (!item) return resolve();
        if (item.text && item.page === 1) {
          // Only page 1 to keep it small
          items.push({
            page: item.page,
            x: Math.round(item.x * 100) / 100,
            y: Math.round(item.y * 100) / 100,
            text: item.text.trim(),
          });
        }
      });
    });

    res.status(200).json({ total: items.length, items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { uploadProgramme, getProgramme, debugPDF };
