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

const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/\s*[A\*]$/, "").trim();
  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
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
  const pdfBuffer = fs.readFileSync(pdfPath);
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

  const pageCount = pdfDoc.numPages;
  const activities = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();

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

    const activityIdPattern =
      /^([A-Z]{1,6}[-_][A-Z0-9]{1,6}[-_]?\d*[\.\d]*|[A-Z]{1,4}\d+[\.\d]*|[A-Z]{2,}[-_][A-Z0-9]+-?\d*|VI_+[A-Z0-9]+|[A-Z]+-\d+|STAGE-\d+)/;
    const datePattern = /\d{2}-[A-Za-z]{3}-\d{2}/;

    const idXPositions = [];
    const dateXPositions = [];
    const textXPositions = [];

    sortedYPositions.slice(0, 50).forEach((y) => {
      const row = rows[y];
      row.sort((a, b) => a.x - b.x);

      row.forEach((item, idx) => {
        if (activityIdPattern.test(item.text) && item.x < 200 && idx === 0) {
          idXPositions.push(item.x);
        }
        if (datePattern.test(item.text)) {
          dateXPositions.push(item.x);
        }
        if (
          item.text.length > 5 &&
          !datePattern.test(item.text) &&
          !/^\d+$/.test(item.text) &&
          !activityIdPattern.test(item.text)
        ) {
          textXPositions.push(item.x);
        }
      });
    });

    const uniqueIdX = [...new Set(idXPositions)].sort((a, b) => a - b);
    const idColumnX = uniqueIdX.length > 0 ? uniqueIdX[0] : 30;
    const idColumnMaxX =
      uniqueIdX.length > 0 ? Math.max(...uniqueIdX) + 80 : 145;

    const uniqueTextX = [...new Set(textXPositions)].sort((a, b) => a - b);
    const nameColumnMinX =
      uniqueTextX.length > 0
        ? Math.min(...uniqueTextX.filter((x) => x > idColumnX)) - 10
        : 100;

    const sortedDateX = [...new Set(dateXPositions)].sort((a, b) => a - b);
    let finishColumnThreshold = 603;
    if (sortedDateX.length >= 4) {
      const dateGaps = [];
      for (let j = 1; j < sortedDateX.length; j++) {
        if (sortedDateX[j] - sortedDateX[j - 1] > 20) {
          dateGaps.push({
            gap: sortedDateX[j] - sortedDateX[j - 1],
            midpoint: (sortedDateX[j] + sortedDateX[j - 1]) / 2,
          });
        }
      }
      if (dateGaps.length > 0) {
        finishColumnThreshold = dateGaps[0].midpoint;
      }
    } else if (sortedDateX.length >= 2) {
      finishColumnThreshold =
        (sortedDateX[0] + sortedDateX[sortedDateX.length - 1]) / 2;
    }

    sortedYPositions.forEach((y) => {
      const row = rows[y];
      row.sort((a, b) => a.x - b.x);

      const idItem = row.find(
        (item) =>
          item.x >= 0 &&
          item.x < idColumnMaxX &&
          activityIdPattern.test(item.text),
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

        const dateItems = row
          .filter((item) => item.x < 780 && datePattern.test(item.text))
          .sort((a, b) => a.x - b.x);

        const minDateX =
          dateItems.length > 0 ? Math.min(...dateItems.map((d) => d.x)) : 780;
        const nameColumnMaxX = Math.min(minDateX - 20, 550);

        row.forEach((item) => {
          if (
            item.x >= 0 &&
            item.x < idColumnMaxX &&
            activityIdPattern.test(item.text)
          ) {
            activity.activityId = item.text;
          } else if (
            item.x >= nameColumnMinX &&
            item.x < nameColumnMaxX &&
            item.text.length > 2 &&
            !datePattern.test(item.text) &&
            !/^\d+$/.test(item.text)
          ) {
            if (activity.activityName) {
              activity.activityName += " " + item.text;
            } else {
              activity.activityName = item.text;
            }
          } else if (
            /^\d+$/.test(item.text) &&
            parseInt(item.text) < 2000 &&
            item.x < minDateX
          ) {
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
        } else if (
          activity.startDate.includes(" A") &&
          !activity.finishDate.includes(" A")
        ) {
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

  if (activities.length === 0) {
  } else {
    activities.slice(0, 20).forEach((a, idx) => {});

    if (activities.length > 20) {
    }
  }
}

testParsing().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
