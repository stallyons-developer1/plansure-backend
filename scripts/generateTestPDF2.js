const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const generateTestPDF = () => {
  const doc = new PDFDocument({ size: "A4", layout: "landscape" });
  const outputPath = "/Users/apple/Downloads/test_programme_june_2026_v2.pdf";

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
      id: "JUN-PROG",
      name: "May-June Construction Programme",
      duration: 52,
      start: new Date(2026, 4, 18),
      finish: new Date(2026, 6, 8),
      isHeader: true,
    },

    {
      id: "JUN-001",
      name: "Site Survey & Planning",
      duration: 3,
      start: new Date(2026, 4, 18),
      finish: new Date(2026, 4, 20),
      status: "completed",
    },
    {
      id: "JUN-002",
      name: "Permit Acquisition",
      duration: 2,
      start: new Date(2026, 4, 19),
      finish: new Date(2026, 4, 20),
      status: "completed",
    },
    {
      id: "JUN-003",
      name: "Ground Preparation",
      duration: 4,
      start: new Date(2026, 4, 21),
      finish: new Date(2026, 4, 24),
      status: "completed",
    },

    {
      id: "JUN-004",
      name: "Foundation Marking",
      duration: 3,
      start: new Date(2026, 4, 25),
      finish: new Date(2026, 4, 27),
      status: null,
    },
    {
      id: "JUN-005",
      name: "Excavation Phase 1",
      duration: 4,
      start: new Date(2026, 4, 28),
      finish: new Date(2026, 4, 31),
      status: null,
    },

    {
      id: "JUN-006",
      name: "Concrete Foundation",
      duration: 3,
      start: new Date(2026, 5, 1),
      finish: new Date(2026, 5, 3),
      status: null,
    },
    {
      id: "JUN-007",
      name: "Steel Framework",
      duration: 4,
      start: new Date(2026, 5, 3),
      finish: new Date(2026, 5, 6),
      status: "blocked",
    },

    {
      id: "JUN-008",
      name: "Foundation Curing",
      duration: 3,
      start: new Date(2026, 5, 8),
      finish: new Date(2026, 5, 10),
      status: null,
    },
    {
      id: "JUN-009",
      name: "Plumbing Installation",
      duration: 3,
      start: new Date(2026, 5, 10),
      finish: new Date(2026, 5, 12),
      status: null,
    },
    {
      id: "JUN-010",
      name: "HVAC Ductwork",
      duration: 3,
      start: new Date(2026, 5, 12),
      finish: new Date(2026, 5, 14),
      status: null,
    },

    {
      id: "JUN-011",
      name: "Final Inspection",
      duration: 5,
      start: new Date(2026, 5, 15),
      finish: new Date(2026, 5, 20),
      status: null,
    },
    {
      id: "JUN-012",
      name: "Wall Framing",
      duration: 4,
      start: new Date(2026, 5, 16),
      finish: new Date(2026, 5, 19),
      status: null,
    },
    {
      id: "JUN-013",
      name: "Insulation Work",
      duration: 3,
      start: new Date(2026, 5, 20),
      finish: new Date(2026, 5, 22),
      status: null,
    },

    {
      id: "JUN-014",
      name: "Roofing Work",
      duration: 4,
      start: new Date(2026, 5, 22),
      finish: new Date(2026, 5, 25),
      status: null,
    },
    {
      id: "JUN-015",
      name: "Window Installation",
      duration: 3,
      start: new Date(2026, 5, 24),
      finish: new Date(2026, 5, 26),
      status: null,
    },

    {
      id: "JUN-016",
      name: "Drywall Installation",
      duration: 3,
      start: new Date(2026, 5, 27),
      finish: new Date(2026, 5, 29),
      status: null,
    },
    {
      id: "JUN-017",
      name: "External Finishing",
      duration: 4,
      start: new Date(2026, 5, 29),
      finish: new Date(2026, 6, 2),
      status: null,
    },
    {
      id: "JUN-018",
      name: "Interior Painting",
      duration: 3,
      start: new Date(2026, 6, 3),
      finish: new Date(2026, 6, 5),
      status: null,
    },
    {
      id: "JUN-019",
      name: "Electrical Rough-In",
      duration: 3,
      start: new Date(2026, 6, 6),
      finish: new Date(2026, 6, 8),
      status: null,
    },
  ];

  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .text("June Construction Project / 2026", 50, 30);
  doc.fontSize(10).font("Helvetica").text("04/06/2026", 700, 30);

  const tableTop = 60;
  const colWidths = [70, 200, 60, 80, 80];
  const headers = [
    "Activity ID",
    "Activity Name",
    "Duration",
    "Start",
    "Finish",
  ];
  const rowHeight = 20;

  doc.fillColor("#666666").rect(50, tableTop, 490, rowHeight).fill();

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x + 5, tableTop + 5, { width: colWidths[i] - 10 });
    x += colWidths[i];
  });

  let y = tableTop + rowHeight;

  activities.forEach((activity, index) => {
    const isHeader = activity.isHeader;

    if (isHeader) {
      doc.fillColor("#D35400").rect(50, y, 490, rowHeight).fill();
      doc.fillColor("#ffffff");
    } else {
      doc
        .fillColor(index % 2 === 0 ? "#f5f5f5" : "#ffffff")
        .rect(50, y, 490, rowHeight)
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
      doc.text(cell, x + 5, y + 5, { width: colWidths[i] - 10 });
      x += colWidths[i];
    });

    y += rowHeight;

    if (y > 520) {
      doc.addPage();
      y = 50;
    }
  });

  doc.strokeColor("#cccccc").lineWidth(0.5);
  let tableBottom = tableTop + rowHeight * (activities.length + 1);
  doc.rect(50, tableTop, 490, tableBottom - tableTop).stroke();

  x = 50;
  colWidths.forEach((width) => {
    doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
    x += width;
  });
  doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();

  for (let i = 0; i <= activities.length; i++) {
    const lineY = tableTop + (i + 1) * rowHeight;
    doc.moveTo(50, lineY).lineTo(540, lineY).stroke();
  }

  doc.end();

  writeStream.on("finish", () => {});
};

generateTestPDF();
