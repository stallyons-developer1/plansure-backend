/**
 * Debug script to analyze PDF structure and text positions
 * Run with: node scripts/debugPdfParsing.js /path/to/your/pdf.pdf
 */

const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const pdfPath = process.argv[2];

if (!pdfPath) {
  console.error("Usage: node scripts/debugPdfParsing.js /path/to/your/pdf.pdf");
  process.exit(1);
}

if (!fs.existsSync(pdfPath)) {
  console.error(`File not found: ${pdfPath}`);
  process.exit(1);
}

async function analyzePdf() {
  console.log(`\n📄 Analyzing PDF: ${pdfPath}\n`);
  console.log("=".repeat(80));

  const pdfBuffer = fs.readFileSync(pdfPath);
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

  console.log(`\n📊 Total Pages: ${pdfDoc.numPages}\n`);

  // Only analyze first 2 pages for debugging
  const pagesToAnalyze = Math.min(2, pdfDoc.numPages);

  for (let pageNum = 1; pageNum <= pagesToAnalyze; pageNum++) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📄 PAGE ${pageNum}`);
    console.log("=".repeat(80));

    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Group items by Y position
    const rows = {};
    textContent.items.forEach((item) => {
      if (!item.str.trim()) return;
      const y = Math.round(item.transform[5] / 3) * 3;
      const x = Math.round(item.transform[4]);

      if (!rows[y]) rows[y] = [];
      rows[y].push({ text: item.str.trim(), x, rawX: item.transform[4] });
    });

    // Sort rows by Y (descending = top to bottom)
    const sortedYPositions = Object.keys(rows)
      .map(Number)
      .sort((a, b) => b - a);

    // Activity ID pattern
    const activityIdPattern = /^([A-Z]{1,4}[-_]?[A-Z]{0,3}[-_]?\d+[\.\d]*|[A-Z]{2,}[-_][A-Z]{0,3}[-_]?\d+|VI_+[A-Z0-9]+)/;
    const datePattern = /\d{2}-[A-Za-z]{3}-\d{2}/;

    console.log("\n📍 X Position Analysis (first 30 rows with potential activity IDs):\n");
    console.log("Format: [X position] text content");
    console.log("-".repeat(80));

    let rowsWithActivityIds = 0;
    let rowsAnalyzed = 0;

    for (const y of sortedYPositions) {
      if (rowsAnalyzed > 50) break;
      rowsAnalyzed++;

      const row = rows[y];
      row.sort((a, b) => a.x - b.x);

      // Check if any item looks like an Activity ID
      const hasActivityId = row.some((item) => activityIdPattern.test(item.text));
      const hasDate = row.some((item) => datePattern.test(item.text));

      if (hasActivityId || hasDate) {
        rowsWithActivityIds++;
        if (rowsWithActivityIds <= 30) {
          console.log(`\n📌 Row Y=${y}:`);
          row.forEach((item) => {
            const marker = activityIdPattern.test(item.text)
              ? "🆔"
              : datePattern.test(item.text)
              ? "📅"
              : /^\d+$/.test(item.text)
              ? "⏱️"
              : "  ";
            console.log(`   ${marker} [X: ${item.x.toString().padStart(4)}] "${item.text}"`);
          });
        }
      }
    }

    // Analyze column positions
    console.log("\n\n📊 COLUMN POSITION STATISTICS:\n");
    console.log("-".repeat(80));

    const activityIdPositions = [];
    const datePositions = [];
    const durationPositions = [];
    const textPositions = [];

    sortedYPositions.forEach((y) => {
      const row = rows[y];
      row.forEach((item) => {
        if (activityIdPattern.test(item.text)) {
          activityIdPositions.push(item.x);
        } else if (datePattern.test(item.text)) {
          datePositions.push(item.x);
        } else if (/^\d+$/.test(item.text) && parseInt(item.text) < 2000) {
          durationPositions.push(item.x);
        } else if (item.text.length > 5) {
          textPositions.push(item.x);
        }
      });
    });

    const analyzePositions = (positions, name) => {
      if (positions.length === 0) {
        console.log(`\n${name}: No items found!`);
        return;
      }
      positions.sort((a, b) => a - b);
      const min = Math.min(...positions);
      const max = Math.max(...positions);
      const avg = Math.round(positions.reduce((a, b) => a + b, 0) / positions.length);
      const median = positions[Math.floor(positions.length / 2)];

      console.log(`\n${name}:`);
      console.log(`   Count: ${positions.length}`);
      console.log(`   Min X: ${min}`);
      console.log(`   Max X: ${max}`);
      console.log(`   Avg X: ${avg}`);
      console.log(`   Median X: ${median}`);
      console.log(`   Sample positions: ${positions.slice(0, 10).join(", ")}`);
    };

    analyzePositions(activityIdPositions, "🆔 Activity IDs");
    analyzePositions(datePositions, "📅 Dates");
    analyzePositions(durationPositions, "⏱️ Durations (numbers < 2000)");
    analyzePositions(textPositions, "📝 Text items (>5 chars)");
  }

  // Summary recommendations
  console.log("\n\n" + "=".repeat(80));
  console.log("📋 CURRENT CODE THRESHOLDS vs DETECTED POSITIONS:");
  console.log("=".repeat(80));
  console.log("\nCurrent code expects:");
  console.log("  Activity ID:    x >= 38  && x < 145");
  console.log("  Activity Name:  x >= 145 && x < 550");
  console.log("  Duration:       x >= 500 && x < 620");
  console.log("  Finish Column:  x >= 603");
  console.log("\n⚠️  If detected positions above don't match these ranges,");
  console.log("    the parsing will fail to extract activities!");
  console.log("=".repeat(80));
}

analyzePdf().catch((err) => {
  console.error("Error analyzing PDF:", err);
  process.exit(1);
});
