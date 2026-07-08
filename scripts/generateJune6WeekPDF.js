const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// Test programme: 6 weeks starting 1 June 2026 (01-Jun-26 -> 12-Jul-26).
// Today is 8 July 2026, so this yields a realistic RAG mix:
//   " A" suffix  = Actual/Completed  -> Blue/Completed
//   " B" suffix  = Baseline/Blocked  -> Red/Blocked (past finish)
//   no suffix, finish < today        -> Red/Blocked (overdue, untriaged)
//   no suffix, finish >= today       -> Grey/Unassigned (upcoming)
const generatePDF = () => {
  const doc = new PDFDocument({ size: "A4", layout: "landscape" });
  const outputPath =
    "/Users/apple/Desktop/Plansure PDF/test_programme_june_6week_2026.pdf";

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  const formatDate = (date, status = null) => {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const day = String(date.getDate()).padStart(2, "0");
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    let suffix = "";
    if (status === "completed") suffix = " A";
    else if (status === "blocked") suffix = " B";
    return `${day}-${month}-${year}${suffix}`;
  };

  // Month indices are 0-based: May=4, Jun=5, Jul=6.
  const activities = [
    { id: "JUN6-PROG", name: "June 6-Week Construction Programme", duration: 42, start: new Date(2026, 5, 1), finish: new Date(2026, 6, 12), isHeader: true },

    // Week 1 (Jun 1-7) - completed
    { id: "JUN6-001", name: "Site Setup & Mobilisation", duration: 3, start: new Date(2026, 5, 1), finish: new Date(2026, 5, 3), status: "completed" },
    { id: "JUN6-002", name: "Topographic Survey", duration: 3, start: new Date(2026, 5, 2), finish: new Date(2026, 5, 4), status: "completed" },

    // Week 2 (Jun 8-14) - completed + overdue
    { id: "JUN6-003", name: "Bulk Excavation", duration: 4, start: new Date(2026, 5, 8), finish: new Date(2026, 5, 11), status: "completed" },
    { id: "JUN6-004", name: "Foundation Layout", duration: 4, start: new Date(2026, 5, 10), finish: new Date(2026, 5, 13), status: null }, // overdue

    // Week 3 (Jun 15-21) - overdue
    { id: "JUN6-005", name: "Concrete Pour - Phase 1", duration: 4, start: new Date(2026, 5, 15), finish: new Date(2026, 5, 18), status: null }, // overdue
    { id: "JUN6-006", name: "Steel Erection", duration: 5, start: new Date(2026, 5, 17), finish: new Date(2026, 5, 21), status: null }, // overdue

    // Week 4 (Jun 22-28) - overdue + blocked
    { id: "JUN6-007", name: "Structural Framing", duration: 5, start: new Date(2026, 5, 22), finish: new Date(2026, 5, 26), status: null }, // overdue
    { id: "JUN6-008", name: "Roof Structure", duration: 5, start: new Date(2026, 5, 24), finish: new Date(2026, 5, 28), status: "blocked" }, // blocked

    // Week 5 (Jun 29 - Jul 5) - overdue + blocked
    { id: "JUN6-009", name: "Electrical Rough-In", duration: 5, start: new Date(2026, 5, 29), finish: new Date(2026, 6, 3), status: null }, // overdue
    { id: "JUN6-010", name: "Plumbing First Fix", duration: 5, start: new Date(2026, 6, 1), finish: new Date(2026, 6, 5), status: "blocked" }, // blocked

    // Week 6 (Jul 6-12) - upcoming (finish on/after today, 8 Jul)
    { id: "JUN6-011", name: "Wall Framing", duration: 4, start: new Date(2026, 6, 6), finish: new Date(2026, 6, 9), status: null }, // upcoming
    { id: "JUN6-012", name: "Window Installation", duration: 3, start: new Date(2026, 6, 9), finish: new Date(2026, 6, 11), status: null }, // upcoming
    { id: "JUN6-013", name: "Final Inspection Prep", duration: 3, start: new Date(2026, 6, 10), finish: new Date(2026, 6, 12), status: null }, // upcoming
  ];

  doc.fontSize(14).font("Helvetica-Bold").text("June Construction Project / 2026 (6-Week Cycle)", 50, 30);
  doc.fontSize(10).font("Helvetica").text("01/06/2026", 700, 30);

  const tableTop = 60;
  const colWidths = [80, 210, 60, 80, 80];
  const headers = ["Activity ID", "Activity Name", "Duration", "Start", "Finish"];
  const rowHeight = 22;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  doc.fillColor("#666666").rect(50, tableTop, tableWidth, rowHeight).fill();
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x + 5, tableTop + 6, { width: colWidths[i] - 10 });
    x += colWidths[i];
  });

  let y = tableTop + rowHeight;
  activities.forEach((activity, index) => {
    const isHeader = activity.isHeader;
    if (isHeader) {
      doc.fillColor("#D35400").rect(50, y, tableWidth, rowHeight).fill();
      doc.fillColor("#ffffff");
    } else {
      doc.fillColor(index % 2 === 0 ? "#f5f5f5" : "#ffffff").rect(50, y, tableWidth, rowHeight).fill();
      doc.fillColor("#333333");
    }
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    x = 50;
    const cells = [
      activity.id,
      activity.name,
      `${activity.duration}d`,
      formatDate(activity.start, activity.status),
      formatDate(activity.finish, activity.status),
    ];
    cells.forEach((cell, i) => {
      doc.text(cell, x + 5, y + 7, { width: colWidths[i] - 10 });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  doc.strokeColor("#cccccc").lineWidth(0.5);
  const tableBottom = tableTop + rowHeight * (activities.length + 1);
  x = 50;
  [...colWidths, 0].forEach((width) => {
    doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
    x += width;
  });
  for (let i = 0; i <= activities.length + 1; i++) {
    const lineY = tableTop + i * rowHeight;
    doc.moveTo(50, lineY).lineTo(50 + tableWidth, lineY).stroke();
  }

  doc.fontSize(8).fillColor("#888888").font("Helvetica")
    .text("Generated by PlanSure | Test Programme (6-week cycle from 01-Jun-2026)", 50, tableBottom + 15);

  doc.end();
  writeStream.on("finish", () => {
    console.log(`PDF generated at: ${outputPath}`);
    console.log(`${activities.length} rows (1 header + ${activities.length - 1} activities), 01-Jun-26 -> 12-Jul-26`);
  });
};

generatePDF();
