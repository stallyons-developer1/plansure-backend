const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// Generates a test programme for the NEW assignment-driven flow.
// Every activity starts Grey/Unassigned (status is no longer date-driven), and
// start dates are spread across the next 6 weeks so they populate
// Weeks 1-2 (Committed), 3-4 (Readiness) and 5-6 (Strategic) in the lookahead.
const generateAssignFlowPDF = () => {
  const doc = new PDFDocument({ size: "A4", layout: "landscape" });
  const outputPath = path.join(
    __dirname,
    "..",
    "..",
    "plansure",
    "test-6week-assign-flow.pdf",
  );

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, "0");
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`; // no A/B suffix -> stays Grey on upload
  };

  // Base everything on "today" so activities always fall inside the 6-week
  // lookahead regardless of when the script is run.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const addDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d;
  };

  // offset = days from today -> determines the week pair it lands in:
  //   0-13  Weeks 1-2 (Committed), 14-27 Weeks 3-4 (Readiness),
  //   28-41 Weeks 5-6 (Strategic)
  const rows = [
    // Weeks 1-2 (Committed)
    { id: "ACT-001", name: "Site Setup & Mobilisation", dur: 3, off: 1 },
    { id: "ACT-002", name: "Ground Investigation", dur: 4, off: 4 },
    { id: "ACT-003", name: "Temporary Works Design", dur: 5, off: 8 },
    { id: "ACT-004", name: "Utilities Diversion", dur: 4, off: 11 },
    // Weeks 3-4 (Readiness)
    { id: "ACT-005", name: "Bulk Excavation", dur: 6, off: 15 },
    { id: "ACT-006", name: "Piling Works", dur: 7, off: 18 },
    { id: "ACT-007", name: "Pile Caps & Ground Beams", dur: 5, off: 22 },
    { id: "ACT-008", name: "Drainage Installation", dur: 4, off: 25 },
    // Weeks 5-6 (Strategic)
    { id: "ACT-009", name: "Ground Floor Slab", dur: 6, off: 29 },
    { id: "ACT-010", name: "Steel Frame Erection", dur: 8, off: 32 },
    { id: "ACT-011", name: "Cladding Procurement", dur: 5, off: 36 },
    { id: "ACT-012", name: "MEP First Fix", dur: 6, off: 39 },
    // A milestone (0 duration) for good measure
    { id: "MS-001", name: "Structural Completion Milestone", dur: 0, off: 41 },
  ];

  const activities = rows.map((r) => {
    const start = addDays(r.off);
    const finish = addDays(r.off + r.dur);
    return { ...r, start, finish };
  });

  const projectStart = activities[0].start;
  const projectEnd = activities[activities.length - 1].finish;

  console.log(`Generating ${activities.length} activities (all start Grey).`);
  console.log(
    `Today: ${formatDate(today)}  Range: ${formatDate(projectStart)} -> ${formatDate(projectEnd)}`,
  );

  // Title
  doc.fontSize(14).font("Helvetica-Bold").text("6-Week Assign-Flow Test Programme", 50, 30);
  doc.fontSize(10).font("Helvetica").text(formatDate(today), 700, 30);

  // Table setup
  const tableTop = 60;
  const colWidths = [70, 220, 60, 80, 80];
  const headers = ["Activity ID", "Activity Name", "Duration", "Start", "Finish"];
  const rowHeight = 22;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  // Header background
  doc.fillColor("#666666").rect(50, tableTop, tableWidth, rowHeight).fill();
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x + 5, tableTop + 6, { width: colWidths[i] - 10 });
    x += colWidths[i];
  });

  // Rows
  let y = tableTop + rowHeight;
  activities.forEach((activity, index) => {
    doc.fillColor(index % 2 === 0 ? "#f5f5f5" : "#ffffff").rect(50, y, tableWidth, rowHeight).fill();
    doc.fillColor("#333333").font("Helvetica").fontSize(8);
    x = 50;
    const cells = [
      activity.id,
      activity.name,
      `${activity.dur}d`,
      formatDate(activity.start),
      formatDate(activity.finish),
    ];
    cells.forEach((cell, i) => {
      doc.text(cell, x + 5, y + 7, { width: colWidths[i] - 10 });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  // Borders
  doc.strokeColor("#cccccc").lineWidth(0.5);
  const tableBottom = tableTop + rowHeight * (activities.length + 1);
  doc.rect(50, tableTop, tableWidth, tableBottom - tableTop).stroke();
  x = 50;
  colWidths.forEach((width) => {
    doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
    x += width;
  });
  doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
  for (let i = 0; i <= activities.length; i++) {
    const lineY = tableTop + (i + 1) * rowHeight;
    doc.moveTo(50, lineY).lineTo(50 + tableWidth, lineY).stroke();
  }

  doc.end();
  writeStream.on("finish", () => {
    console.log(`\nPDF generated at: ${outputPath}`);
  });
};

generateAssignFlowPDF();
