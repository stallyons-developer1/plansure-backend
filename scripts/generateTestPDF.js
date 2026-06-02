const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate test PDF with May-June dates so Week 1-2 can be closed on June 2
const generateTestPDF = () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const outputPath = '/Users/apple/Desktop/Plansure PDF/test_programme_may_june_2026.pdf';

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
    return `${day}-${month}-${year}${suffix}`;
  };

  // Activities starting May 18, 2026
  // Week 1-2: May 18 - May 31 (2-week end date = May 31, closable on June 2)
  // Week 3-4: June 1 - June 14
  const activities = [
    { id: 'MAY-PROG', name: 'May-June Construction Programme', duration: 45, start: new Date(2026, 4, 18), finish: new Date(2026, 5, 30), isHeader: true },
    // Week 1-2 (May 18 - May 31)
    { id: 'MAY-001', name: 'Site Survey & Planning', duration: 3, start: new Date(2026, 4, 18), finish: new Date(2026, 4, 20), status: 'completed' },
    { id: 'MAY-002', name: 'Permit Acquisition', duration: 2, start: new Date(2026, 4, 19), finish: new Date(2026, 4, 20), status: 'completed' },
    { id: 'MAY-003', name: 'Ground Preparation', duration: 4, start: new Date(2026, 4, 21), finish: new Date(2026, 4, 24), status: 'completed' },
    { id: 'MAY-004', name: 'Foundation Marking', duration: 3, start: new Date(2026, 4, 25), finish: new Date(2026, 4, 27), status: 'completed' },
    { id: 'MAY-005', name: 'Excavation Phase 1', duration: 4, start: new Date(2026, 4, 28), finish: new Date(2026, 4, 31), status: null },
    // Week 3-4 (June 1 - June 14)
    { id: 'MAY-006', name: 'Concrete Foundation', duration: 4, start: new Date(2026, 5, 1), finish: new Date(2026, 5, 4), status: null },
    { id: 'MAY-007', name: 'Steel Framework', duration: 4, start: new Date(2026, 5, 5), finish: new Date(2026, 5, 8), status: null },
    { id: 'MAY-008', name: 'Electrical Rough-In', duration: 3, start: new Date(2026, 5, 9), finish: new Date(2026, 5, 11), status: null },
    { id: 'MAY-009', name: 'Plumbing Installation', duration: 3, start: new Date(2026, 5, 12), finish: new Date(2026, 5, 14), status: null },
    // Week 5-6 (June 15 - June 28)
    { id: 'MAY-010', name: 'Wall Framing', duration: 4, start: new Date(2026, 5, 15), finish: new Date(2026, 5, 18), status: null },
    { id: 'MAY-011', name: 'Roofing Work', duration: 4, start: new Date(2026, 5, 19), finish: new Date(2026, 5, 22), status: null },
    { id: 'MAY-012', name: 'Window Installation', duration: 3, start: new Date(2026, 5, 23), finish: new Date(2026, 5, 25), status: null },
    { id: 'MAY-013', name: 'External Finishing', duration: 3, start: new Date(2026, 5, 26), finish: new Date(2026, 5, 28), status: null },
    { id: 'MAY-014', name: 'Final Inspection', duration: 2, start: new Date(2026, 5, 29), finish: new Date(2026, 5, 30), status: null },
  ];

  const projectStart = new Date(2026, 4, 18);
  const projectEnd = new Date(2026, 5, 30);

  console.log(`Generating PDF with ${activities.length} activities`);
  console.log(`Date range: ${formatDate(projectStart)} to ${formatDate(projectEnd)}`);
  console.log(`Week 1-2: May 18 - May 31 (closable since 2-week end date has passed)`);

  // Title
  doc.fontSize(14).font('Helvetica-Bold').text('May-June Construction Project / 2026', 50, 30);
  doc.fontSize(10).font('Helvetica').text('02/06/2026', 700, 30);

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
    console.log(`PDF generated successfully at: ${outputPath}`);
  });
};

generateTestPDF();
