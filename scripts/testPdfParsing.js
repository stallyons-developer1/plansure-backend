/**
 * Test script to verify PDF parsing extracts activities correctly
 * Run with: node scripts/testPdfParsing.js /path/to/your/pdf.pdf
 */

const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const pdfPath = process.argv[2];

if (!pdfPath) {
  console.error("Usage: node scripts/testPdfParsing.js /path/to/your/pdf.pdf");
  process.exit(1);
}

if (!fs.existsSync(pdfPath)) {
  console.error(`File not found: ${pdfPath}`);
  process.exit(1);
}

// Helper function to parse date strings
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const match = cleanDate.match(/(\d{2})-([A-Za-z]{3})-(\d{2,4})/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const month = months[match[2]];
  let year = parseInt(match[3]);
  if (year < 100) {
    year = year < 50 ? 2000 + year : 1900 + year;
  }
  return new Date(year, month, day);
};

async function testParsing() {
  console.log(`\n📄 Testing PDF parsing: ${pdfPath}\n`);
  console.log("=".repeat(80));

  const pdfBuffer = fs.readFileSync(pdfPath);
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

  const pageCount = pdfDoc.numPages;
  const activities = [];

  console.log(`\n📊 Total Pages: ${pageCount}\n`);

  // Extract structured data from each page
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();

    // Group items by Y position (row)
    const rows = {};
    textContent.items.forEach((item) => {
      if (!item.str.trim()) return;
      const y = Math.round(item.transform[5] / 3) * 3;
      const x = Math.round(item.transform[4]);

      if (x > 780) return;

      if (!rows[y]) rows[y] = [];
      rows[y].push({ text: item.str.trim(), x });
    });

    const sortedYPositions = Object.keys(rows)
      .map(Number)
      .sort((a, b) => b - a);

    // Activity ID patterns - must contain digits OR be a specific format with separators
    // Examples: MS-AD-007, A26410, CST_A17090, CE-121, VI____PP40, TP_2024, CW-001, MEP-001, TC-001, STAGE-1
    const activityIdPattern = /^([A-Z]{1,6}[-_][A-Z0-9]{1,6}[-_]?\d*[\.\d]*|[A-Z]{1,4}\d+[\.\d]*|[A-Z]{2,}[-_][A-Z0-9]+-?\d*|VI_+[A-Z0-9]+|[A-Z]+-\d+|STAGE-\d+)/;
    const datePattern = /\d{2}-[A-Za-z]{3}-\d{2}/;

    // Auto-detect column positions by analyzing X positions of different text types
    const idXPositions = [];
    const dateXPositions = [];
    const textXPositions = [];

    sortedYPositions.slice(0, 50).forEach((y) => {
      const row = rows[y];
      row.sort((a, b) => a.x - b.x);

      row.forEach((item, idx) => {
        // Activity IDs are typically in the first column (leftmost items that match pattern)
        if (activityIdPattern.test(item.text) && item.x < 200 && idx === 0) {
          idXPositions.push(item.x);
        }
        if (datePattern.test(item.text)) {
          dateXPositions.push(item.x);
        }
        // Text items that are not IDs, dates, or numbers are likely activity names
        if (item.text.length > 5 && !datePattern.test(item.text) && !/^\d+$/.test(item.text) && !activityIdPattern.test(item.text)) {
          textXPositions.push(item.x);
        }
      });
    });

    // Calculate adaptive thresholds
    const uniqueIdX = [...new Set(idXPositions)].sort((a, b) => a - b);
    const idColumnX = uniqueIdX.length > 0 ? uniqueIdX[0] : 30;
    const idColumnMaxX = uniqueIdX.length > 0 ? Math.max(...uniqueIdX) + 80 : 145;

    const uniqueTextX = [...new Set(textXPositions)].sort((a, b) => a - b);
    const nameColumnMinX = uniqueTextX.length > 0 ? Math.min(...uniqueTextX.filter(x => x > idColumnX)) - 10 : 100;

    const sortedDateX = [...new Set(dateXPositions)].sort((a, b) => a - b);
    let finishColumnThreshold = 603;
    if (sortedDateX.length >= 4) {
      const dateGaps = [];
      for (let j = 1; j < sortedDateX.length; j++) {
        if (sortedDateX[j] - sortedDateX[j-1] > 20) {
          dateGaps.push({ gap: sortedDateX[j] - sortedDateX[j-1], midpoint: (sortedDateX[j] + sortedDateX[j-1]) / 2 });
        }
      }
      if (dateGaps.length > 0) {
        finishColumnThreshold = dateGaps[0].midpoint;
      }
    } else if (sortedDateX.length >= 2) {
      finishColumnThreshold = (sortedDateX[0] + sortedDateX[sortedDateX.length - 1]) / 2;
    }

    console.log(`Page ${i} - Auto-detected thresholds:`);
    console.log(`  ID Column Max X: ${idColumnMaxX}`);
    console.log(`  Name Column Min X: ${nameColumnMinX}`);
    console.log(`  Finish Column Threshold: ${finishColumnThreshold}`);
    console.log("");

    // Parse each row
    sortedYPositions.forEach((y) => {
      const row = rows[y];
      row.sort((a, b) => a.x - b.x);

      const idItem = row.find((item) =>
        item.x >= 0 && item.x < idColumnMaxX && activityIdPattern.test(item.text)
      );

      if (idItem) {
        const activity = {
          activityId: "",
          activityName: "",
          duration: "",
          durationDays: 0,
          startDate: "",
          finishDate: "",
          status: "Not Started",
        };

        const dateItems = row.filter((item) =>
          item.x < 780 && datePattern.test(item.text)
        ).sort((a, b) => a.x - b.x);

        const minDateX = dateItems.length > 0 ? Math.min(...dateItems.map(d => d.x)) : 780;
        const nameColumnMaxX = Math.min(minDateX - 20, 550);

        row.forEach((item) => {
          if (item.x >= 0 && item.x < idColumnMaxX && activityIdPattern.test(item.text)) {
            activity.activityId = item.text;
          }
          else if (item.x >= nameColumnMinX && item.x < nameColumnMaxX && item.text.length > 2 && !datePattern.test(item.text) && !/^\d+$/.test(item.text)) {
            if (activity.activityName) {
              activity.activityName += " " + item.text;
            } else {
              activity.activityName = item.text;
            }
          }
          else if (/^\d+$/.test(item.text) && parseInt(item.text) < 2000 && item.x < minDateX) {
            activity.duration = item.text;
            activity.durationDays = parseInt(item.text) || 0;
          }
        });

        if (dateItems.length >= 2) {
          activity.startDate = dateItems[0].text;
          activity.finishDate = dateItems[1].text;
        } else if (dateItems.length === 1) {
          if (dateItems[0].x >= finishColumnThreshold) {
            activity.finishDate = dateItems[0].text;
          } else {
            activity.startDate = dateItems[0].text;
          }
        }

        if (activity.finishDate.includes(" A")) {
          activity.status = "Completed";
        } else if (activity.startDate.includes(" A") && !activity.finishDate.includes(" A")) {
          activity.status = "In Progress";
        } else {
          activity.status = "Planned";
        }

        if (activity.activityName) {
          activities.push(activity);
        }
      }
    });
  }

  // Print results
  console.log("\n" + "=".repeat(80));
  console.log(`✅ EXTRACTED ${activities.length} ACTIVITIES`);
  console.log("=".repeat(80));

  if (activities.length === 0) {
    console.log("\n❌ No activities extracted! Check the column detection logic.");
  } else {
    console.log("\nFirst 20 activities:\n");
    activities.slice(0, 20).forEach((a, idx) => {
      console.log(`${(idx + 1).toString().padStart(2)}. ${a.activityId.padEnd(15)} | ${a.activityName.substring(0, 45).padEnd(45)} | ${a.startDate.padEnd(12)} | ${a.finishDate.padEnd(12)} | ${a.status}`);
    });

    if (activities.length > 20) {
      console.log(`\n... and ${activities.length - 20} more activities`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("📊 SUMMARY:");
  console.log("=".repeat(80));
  console.log(`Total activities: ${activities.length}`);
  console.log(`Completed: ${activities.filter(a => a.status === "Completed").length}`);
  console.log(`In Progress: ${activities.filter(a => a.status === "In Progress").length}`);
  console.log(`Planned: ${activities.filter(a => a.status === "Planned").length}`);
  console.log(`With start date: ${activities.filter(a => a.startDate).length}`);
  console.log(`With finish date: ${activities.filter(a => a.finishDate).length}`);
  console.log(`With duration: ${activities.filter(a => a.duration).length}`);
}

testParsing().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
