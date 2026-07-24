const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const generatePDF = () => {
  const doc = new PDFDocument({ size: "A4", layout: "landscape" });
  const outputPath =
    "/Users/apple/Desktop/Plansure PDF/test_programme_june20_6week_2026.pdf";

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  const formatDate = (date, status = null) => {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const day = String(date.getDate()).padStart(2, "0");
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    let suffix = "";
    if (status === "completed") suffix = " A";
    else if (status === "blocked") suffix = " B";
    return `${day}-${month}-${year}${suffix}`;
  };

  const activities = [
    {
      id: "J20-PROG",
      name: "June-July 6-Week Construction Programme",
      duration: 42,
      start: new Date(2026, 5, 20),
      finish: new Date(2026, 6, 31),
      isHeader: true,
    },

    {
      id: "J20-001",
      name: "Site Mobilisation",
      duration: 3,
      start: new Date(2026, 5, 20),
      finish: new Date(2026, 5, 22),
      status: "completed",
    },
    {
      id: "J20-002",
      name: "Survey & Setting Out",
      duration: 3,
      start: new Date(2026, 5, 21),
      finish: new Date(2026, 5, 23),
      status: "completed",
    },
    {
      id: "J20-003",
      name: "Site Clearance",
      duration: 3,
      start: new Date(2026, 5, 24),
      finish: new Date(2026, 5, 26),
      status: null,
    },

    {
      id: "J20-004",
      name: "Bulk Excavation",
      duration: 4,
      start: new Date(2026, 5, 27),
      finish: new Date(2026, 5, 30),
      status: null,
    },
    {
      id: "J20-005",
      name: "Foundation Preparation",
      duration: 4,
      start: new Date(2026, 5, 29),
      finish: new Date(2026, 6, 2),
      status: "blocked",
    },
    {
      id: "J20-006",
      name: "Rebar Fixing",
      duration: 3,
      start: new Date(2026, 6, 1),
      finish: new Date(2026, 6, 3),
      status: null,
    },

    {
      id: "J20-007",
      name: "Concrete Pour - Foundations",
      duration: 4,
      start: new Date(2026, 6, 4),
      finish: new Date(2026, 6, 7),
      status: null,
    },
    {
      id: "J20-008",
      name: "Curing & Formwork Strip",
      duration: 4,
      start: new Date(2026, 6, 6),
      finish: new Date(2026, 6, 9),
      status: null,
    },
    {
      id: "J20-009",
      name: "Ground Floor Slab",
      duration: 3,
      start: new Date(2026, 6, 8),
      finish: new Date(2026, 6, 10),
      status: null,
    },

    {
      id: "J20-010",
      name: "Steel Erection",
      duration: 5,
      start: new Date(2026, 6, 11),
      finish: new Date(2026, 6, 15),
      status: null,
    },
    {
      id: "J20-011",
      name: "Metal Decking",
      duration: 5,
      start: new Date(2026, 6, 13),
      finish: new Date(2026, 6, 17),
      status: null,
    },

    {
      id: "J20-012",
      name: "MEP Rough-In",
      duration: 5,
      start: new Date(2026, 6, 18),
      finish: new Date(2026, 6, 22),
      status: null,
    },

    {
      id: "J20-013",
      name: "Facade Installation",
      duration: 5,
      start: new Date(2026, 6, 25),
      finish: new Date(2026, 6, 29),
      status: null,
    },
    {
      id: "J20-014",
      name: "Final Inspection",
      duration: 3,
      start: new Date(2026, 6, 29),
      finish: new Date(2026, 6, 31),
      status: null,
    },
  ];

  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .text("June-July Construction Project / 2026 (6-Week Cycle)", 50, 30);
  doc.fontSize(10).font("Helvetica").text("20/06/2026", 700, 30);

  const tableTop = 60;
  const colWidths = [80, 220, 60, 80, 80];
  const headers = [
    "Activity ID",
    "Activity Name",
    "Duration",
    "Start",
    "Finish",
  ];
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
      doc
        .fillColor(index % 2 === 0 ? "#f5f5f5" : "#ffffff")
        .rect(50, y, tableWidth, rowHeight)
        .fill();
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
    doc
      .moveTo(50, lineY)
      .lineTo(50 + tableWidth, lineY)
      .stroke();
  }

  doc
    .fontSize(8)
    .fillColor("#888888")
    .font("Helvetica")
    .text(
      "Generated by PlanSure | Test Programme (6-week cycle from 20-Jun-2026)",
      50,
      tableBottom + 15,
    );

  doc.end();
  writeStream.on("finish", () => {});
};

generatePDF();
