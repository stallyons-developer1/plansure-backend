const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate updated test PDF with:
// 1. 5 more activities added
// 2. Electrical Rough-In moved to Week 5-6 (June 15-20)
// Today is June 4, 2026
const generateTestPDF = () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const outputPath = '/Users/apple/Downloads/test_programme_june_2026_v2.pdf';

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  // Helper to format date as DD-Mon-YY with status indicator
  const formatDate = (date, status = null) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    let suffix = '';
    if (status === 'completed') suffix = ' A';
    else if (status === 'blocked') suffix = ' B';
    return `${day}-${month}-${year}${suffix}`;
  };

  // Week calculation from May 18, 2026:
  // Week 1: May 18-24
  // Week 2: May 25-31
  // Week 3: June 1-7
  // Week 4: June 8-14
  // Week 5: June 15-21
  // Week 6: June 22-28
  // Week 7: June 29 - July 5

  const activities = [
    { id: 'JUN-PROG', name: 'May-June Construction Programme', duration: 52, start: new Date(2026, 4, 18), finish: new Date(2026, 6, 8), isHeader: true },

    // Week 1-2 (May 18 - May 31) - COMPLETED activities
    { id: 'JUN-001', name: 'Site Survey & Planning', duration: 3, start: new Date(2026, 4, 18), finish: new Date(2026, 4, 20), status: 'completed' },
    { id: 'JUN-002', name: 'Permit Acquisition', duration: 2, start: new Date(2026, 4, 19), finish: new Date(2026, 4, 20), status: 'completed' },
    { id: 'JUN-003', name: 'Ground Preparation', duration: 4, start: new Date(2026, 4, 21), finish: new Date(2026, 4, 24), status: 'completed' },

    // Week 2 continued
    { id: 'JUN-004', name: 'Foundation Marking', duration: 3, start: new Date(2026, 4, 25), finish: new Date(2026, 4, 27), status: null },
    { id: 'JUN-005', name: 'Excavation Phase 1', duration: 4, start: new Date(2026, 4, 28), finish: new Date(2026, 4, 31), status: null },

    // Week 3 (June 1-7)
    { id: 'JUN-006', name: 'Concrete Foundation', duration: 3, start: new Date(2026, 5, 1), finish: new Date(2026, 5, 3), status: null },
    { id: 'JUN-007', name: 'Steel Framework', duration: 4, start: new Date(2026, 5, 3), finish: new Date(2026, 5, 6), status: 'blocked' },

    // Week 4 (June 8-14) - NEW ACTIVITIES
    { id: 'JUN-008', name: 'Foundation Curing', duration: 3, start: new Date(2026, 5, 8), finish: new Date(2026, 5, 10), status: null },
    { id: 'JUN-009', name: 'Plumbing Installation', duration: 3, start: new Date(2026, 5, 10), finish: new Date(2026, 5, 12), status: null },
    { id: 'JUN-010', name: 'HVAC Ductwork', duration: 3, start: new Date(2026, 5, 12), finish: new Date(2026, 5, 14), status: null },

    // Week 5-6 (June 15-28) - FINAL INSPECTION MOVED HERE
    { id: 'JUN-011', name: 'Final Inspection', duration: 5, start: new Date(2026, 5, 15), finish: new Date(2026, 5, 20), status: null },
    { id: 'JUN-012', name: 'Wall Framing', duration: 4, start: new Date(2026, 5, 16), finish: new Date(2026, 5, 19), status: null },
    { id: 'JUN-013', name: 'Insulation Work', duration: 3, start: new Date(2026, 5, 20), finish: new Date(2026, 5, 22), status: null },

    // Week 6 continued
    { id: 'JUN-014', name: 'Roofing Work', duration: 4, start: new Date(2026, 5, 22), finish: new Date(2026, 5, 25), status: null },
    { id: 'JUN-015', name: 'Window Installation', duration: 3, start: new Date(2026, 5, 24), finish: new Date(2026, 5, 26), status: null },

    // Week 7 (June 29 - July 5) - NEW ACTIVITIES
    { id: 'JUN-016', name: 'Drywall Installation', duration: 3, start: new Date(2026, 5, 27), finish: new Date(2026, 5, 29), status: null },
    { id: 'JUN-017', name: 'External Finishing', duration: 4, start: new Date(2026, 5, 29), finish: new Date(2026, 6, 2), status: null },
    { id: 'JUN-018', name: 'Interior Painting', duration: 3, start: new Date(2026, 6, 3), finish: new Date(2026, 6, 5), status: null },
    { id: 'JUN-019', name: 'Electrical Rough-In', duration: 3, start: new Date(2026, 6, 6), finish: new Date(2026, 6, 8), status: null },
  ];

  console.log(`Generating PDF with ${activities.length} activities (5 more than original)`);
  console.log(`\nSwapped positions:`);
  console.log(`- Final Inspection moved to Week 5-6: June 15-20, 2026`);
  console.log(`- Electrical Rough-In moved to Week 7: July 6-8, 2026`);
  console.log(`\nNew activities added:`);
  console.log(`- JUN-008: Foundation Curing`);
  console.log(`- JUN-010: HVAC Ductwork`);
  console.log(`- JUN-013: Insulation Work`);
  console.log(`- JUN-016: Drywall Installation`);
  console.log(`- JUN-018: Interior Painting`);

  // Title
  doc.fontSize(14).font('Helvetica-Bold').text('June Construction Project / 2026', 50, 30);
  doc.fontSize(10).font('Helvetica').text('04/06/2026', 700, 30);

  // Table setup
  const tableTop = 60;
  const colWidths = [70, 200, 60, 80, 80];
  const headers = ['Activity ID', 'Activity Name', 'Duration', 'Start', 'Finish'];
  const rowHeight = 20;

  // Draw header background
  doc.fillColor('#666666').rect(50, tableTop, 490, rowHeight).fill();

  // Header text
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x + 5, tableTop + 5, { width: colWidths[i] - 10 });
    x += colWidths[i];
  });

  // Table rows
  let y = tableTop + rowHeight;

  activities.forEach((activity, index) => {
    const isHeader = activity.isHeader;

    // Row background
    if (isHeader) {
      doc.fillColor('#D35400').rect(50, y, 490, rowHeight).fill();
      doc.fillColor('#ffffff');
    } else {
      doc.fillColor(index % 2 === 0 ? '#f5f5f5' : '#ffffff').rect(50, y, 490, rowHeight).fill();
      doc.fillColor('#333333');
    }

    // Row text
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    x = 50;

    const cells = [
      activity.id,
      activity.name,
      `${activity.duration}d`,
      formatDate(activity.start, activity.status),
      formatDate(activity.finish, activity.status)
    ];

    cells.forEach((cell, i) => {
      doc.text(cell, x + 5, y + 5, { width: colWidths[i] - 10 });
      x += colWidths[i];
    });

    y += rowHeight;

    // New page if needed
    if (y > 520) {
      doc.addPage();
      y = 50;
    }
  });

  // Draw table borders
  doc.strokeColor('#cccccc').lineWidth(0.5);
  let tableBottom = tableTop + rowHeight * (activities.length + 1);
  doc.rect(50, tableTop, 490, tableBottom - tableTop).stroke();

  // Vertical lines
  x = 50;
  colWidths.forEach((width) => {
    doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
    x += width;
  });
  doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();

  // Horizontal lines
  for (let i = 0; i <= activities.length; i++) {
    const lineY = tableTop + (i + 1) * rowHeight;
    doc.moveTo(50, lineY).lineTo(540, lineY).stroke();
  }

  doc.end();

  writeStream.on('finish', () => {
    console.log(`\nPDF generated successfully at: ${outputPath}`);
  });
};

generateTestPDF();
