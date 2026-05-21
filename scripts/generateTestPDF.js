const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate test PDF similar to Alpha Construction Project format
const generateTestPDF = () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const outputPath = path.join(__dirname, '..', 'uploads', 'programmes', 'test_programme_may_2026.pdf');

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  // Helper to format date as DD-Mon-YY
  const formatDate = (date, addA = false) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    return `${day}-${month}-${year}${addA ? ' A' : ''}`;
  };

  // Define activities similar to the Alpha Construction Project
  const activities = [
    { id: 'TST-PROG', name: 'Test Construction Programme', duration: 20, start: new Date(2026, 4, 1), finish: new Date(2026, 4, 20), isHeader: true },
    { id: 'TST-001', name: 'Site Preparation', duration: 3, start: new Date(2026, 4, 1), finish: new Date(2026, 4, 3), completed: true },
    { id: 'TST-002', name: 'Foundation Layout', duration: 2, start: new Date(2026, 4, 2), finish: new Date(2026, 4, 3), completed: true },
    { id: 'TST-003', name: 'Excavation Work', duration: 3, start: new Date(2026, 4, 4), finish: new Date(2026, 4, 6), completed: true },
    { id: 'TST-004', name: 'Concrete Pouring Phase 1', duration: 2, start: new Date(2026, 4, 5), finish: new Date(2026, 4, 6), completed: true },
    { id: 'TST-005', name: 'Steel Framework Installation', duration: 4, start: new Date(2026, 4, 7), finish: new Date(2026, 4, 10), completed: false },
    { id: 'TST-006', name: 'Electrical Conduit Rough-In', duration: 3, start: new Date(2026, 4, 8), finish: new Date(2026, 4, 10), completed: false },
    { id: 'TST-007', name: 'Plumbing First Fix', duration: 3, start: new Date(2026, 4, 9), finish: new Date(2026, 4, 11), completed: false },
    { id: 'TST-008', name: 'Roof Structure Assembly', duration: 4, start: new Date(2026, 4, 11), finish: new Date(2026, 4, 14), completed: false },
    { id: 'TST-009', name: 'Wall Framing', duration: 3, start: new Date(2026, 4, 12), finish: new Date(2026, 4, 14), completed: false },
    { id: 'TST-010', name: 'Window Installation', duration: 2, start: new Date(2026, 4, 15), finish: new Date(2026, 4, 16), completed: false },
    { id: 'TST-011', name: 'External Cladding', duration: 3, start: new Date(2026, 4, 16), finish: new Date(2026, 4, 18), completed: false },
    { id: 'TST-012', name: 'Final Inspection Prep', duration: 2, start: new Date(2026, 4, 19), finish: new Date(2026, 4, 20), completed: false },
  ];

  const projectStart = new Date(2026, 4, 1);
  const projectEnd = new Date(2026, 4, 20);

  console.log(`Generating PDF with ${activities.length} activities`);
  console.log(`Date range: ${formatDate(projectStart)} to ${formatDate(projectEnd)}`);

  // Title
  doc.fontSize(14).font('Helvetica-Bold').text('Test Construction Project / May 2026', 50, 30);
  doc.fontSize(10).font('Helvetica').text('21/05/2026', 700, 30);

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
      doc.fillColor(index % 2 === 0 ? '#f9f9f9' : '#ffffff').rect(50, y, 490, rowHeight).fill();
      doc.fillColor('#333333');
    }

    // Draw cell borders
    doc.strokeColor('#dddddd').lineWidth(0.5);
    doc.rect(50, y, 490, rowHeight).stroke();

    // Row content
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    x = 50;

    // Activity ID
    doc.text(activity.id, x + 5, y + 6, { width: colWidths[0] - 10 });
    x += colWidths[0];

    // Activity Name
    doc.text(activity.name, x + 5, y + 6, { width: colWidths[1] - 10 });
    x += colWidths[1];

    // Duration
    doc.text(String(activity.duration), x + 5, y + 6, { width: colWidths[2] - 10, align: 'center' });
    x += colWidths[2];

    // Start
    doc.text(formatDate(activity.start), x + 5, y + 6, { width: colWidths[3] - 10, align: 'center' });
    x += colWidths[3];

    // Finish (with 'A' suffix if completed)
    doc.text(formatDate(activity.finish, activity.completed), x + 5, y + 6, { width: colWidths[4] - 10, align: 'center' });

    y += rowHeight;
  });

  // Footer
  doc.fillColor('#666666').fontSize(8).font('Helvetica');
  doc.text('Generated by PlanSure | Test Programme', 50, y + 20);

  doc.end();

  writeStream.on('finish', () => {
    console.log(`\nPDF created successfully!`);
    console.log(`Location: ${outputPath}`);
    console.log(`\nActivities with 'A' suffix (completed): ${activities.filter(a => a.completed).length}`);
    console.log(`Activities without 'A' suffix (in progress): ${activities.filter(a => !a.completed && !a.isHeader).length}`);
  });
};

generateTestPDF();
