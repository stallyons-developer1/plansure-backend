const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate test PDF with blocked activities that are currently in progress
// Today is June 3, 2026
// Blocked + In Progress = start date < today < finish date, with " B" suffix
const generateTestPDF = () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const outputPath = '/Users/apple/Desktop/Plansure PDF/test_programme_june_2026.pdf';

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
    // No suffix for overdue/at-risk - they just have past dates without " A"
    return `${day}-${month}-${year}${suffix}`;
  };

  // Activities starting May 18, 2026
  // Today is June 3, 2026
  // BLOCKED + IN PROGRESS = start < June 3 < finish, with " B" suffix
  const activities = [
    { id: 'JUN-PROG', name: 'May-June Construction Programme', duration: 45, start: new Date(2026, 4, 18), finish: new Date(2026, 5, 30), isHeader: true },

    // Week 1-2 (May 18 - May 31) - COMPLETED activities
    { id: 'JUN-001', name: 'Site Survey & Planning', duration: 3, start: new Date(2026, 4, 18), finish: new Date(2026, 4, 20), status: 'completed' },
    { id: 'JUN-002', name: 'Permit Acquisition', duration: 2, start: new Date(2026, 4, 19), finish: new Date(2026, 4, 20), status: 'completed' },

    // AT RISK (OVERDUE) activities - finish date passed but NOT completed (no " A")
    { id: 'JUN-003', name: 'Ground Preparation', duration: 4, start: new Date(2026, 4, 21), finish: new Date(2026, 4, 24), status: null }, // Overdue
    { id: 'JUN-004', name: 'Foundation Marking', duration: 3, start: new Date(2026, 4, 25), finish: new Date(2026, 4, 27), status: null }, // Overdue

    // BLOCKED + IN PROGRESS activities (5 activities)
    // These are blocked but currently in progress (start < June 3 < finish)
    // When unblocked, they should become "Ready"
    { id: 'JUN-005', name: 'Excavation Phase 1', duration: 10, start: new Date(2026, 4, 28), finish: new Date(2026, 5, 7), status: 'blocked' },      // Started May 28, ends June 7
    { id: 'JUN-006', name: 'Concrete Foundation', duration: 8, start: new Date(2026, 4, 30), finish: new Date(2026, 5, 8), status: 'blocked' },      // Started May 30, ends June 8
    { id: 'JUN-007', name: 'Steel Framework', duration: 7, start: new Date(2026, 5, 1), finish: new Date(2026, 5, 8), status: 'blocked' },           // Started June 1, ends June 8
    { id: 'JUN-008', name: 'Electrical Rough-In', duration: 6, start: new Date(2026, 5, 2), finish: new Date(2026, 5, 9), status: 'blocked' },       // Started June 2, ends June 9
    { id: 'JUN-009', name: 'Plumbing Installation', duration: 5, start: new Date(2026, 5, 2), finish: new Date(2026, 5, 7), status: 'blocked' },     // Started June 2, ends June 7

    // Future activities (not started yet)
    { id: 'JUN-010', name: 'Wall Framing', duration: 4, start: new Date(2026, 5, 10), finish: new Date(2026, 5, 13), status: null },
    { id: 'JUN-011', name: 'Roofing Work', duration: 4, start: new Date(2026, 5, 14), finish: new Date(2026, 5, 17), status: null },
    { id: 'JUN-012', name: 'Window Installation', duration: 3, start: new Date(2026, 5, 18), finish: new Date(2026, 5, 20), status: null },
    { id: 'JUN-013', name: 'External Finishing', duration: 4, start: new Date(2026, 5, 21), finish: new Date(2026, 5, 24), status: null },
    { id: 'JUN-014', name: 'Final Inspection', duration: 3, start: new Date(2026, 5, 25), finish: new Date(2026, 5, 27), status: null },
  ];

  const projectStart = new Date(2026, 4, 18);
  const projectEnd = new Date(2026, 5, 30);

  console.log(`Generating PDF with ${activities.length} activities`);
  console.log(`Date range: ${formatDate(projectStart)} to ${formatDate(projectEnd)}`);
  console.log(`\nToday: June 3, 2026`);
  console.log(`\nActivity breakdown:`);
  console.log(`- Completed (with " A"): JUN-001, JUN-002`);
  console.log(`- At Risk/Overdue (past finish date, no " A"): JUN-003, JUN-004`);
  console.log(`- BLOCKED + IN PROGRESS (with " B", start < today < finish): JUN-005, JUN-006, JUN-007, JUN-008, JUN-009`);
  console.log(`  These should become "Ready" when unblocked`);
  console.log(`- Future (not started): JUN-010 to JUN-014`);

  // Title
  doc.fontSize(14).font('Helvetica-Bold').text('June Construction Project / 2026', 50, 30);
  doc.fontSize(10).font('Helvetica').text('03/06/2026', 700, 30);

  // Table setup
  const tableTop = 60;
  const colWidths = [70, 200, 60, 80, 80];
  const headers = ['Activity ID', 'Activity Name', 'Duration', 'Start', 'Finish'];
  const rowHeight = 22;

  // Draw header background
  doc.fillColor('#666666').rect(50, tableTop, 490, rowHeight).fill();

  // Header text
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x + 5, tableTop + 6, { width: colWidths[i] - 10 });
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
      doc.text(cell, x + 5, y + 7, { width: colWidths[i] - 10 });
      x += colWidths[i];
    });

    y += rowHeight;

    // New page if needed
    if (y > 500) {
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
