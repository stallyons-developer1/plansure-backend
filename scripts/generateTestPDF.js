const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate test PDF with activities from Jan 1, 2026 to May 20, 2026
const generateTestPDF = () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const outputPath = path.join(__dirname, '..', 'uploads', 'programmes', 'test_programme_jan_may_2026.pdf');

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  // Helper to format date as DD-Mon-YY
  const formatDate = (date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  };

  // Generate activities spread across Jan 1 - May 20, 2026
  const activities = [];
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 4, 21);  // May 21, 2026

  // Calculate total weeks (~20 weeks)
  const msPerDay = 1000 * 60 * 60 * 24;
  const totalDays = Math.ceil((endDate - startDate) / msPerDay);
  const totalWeeks = Math.ceil(totalDays / 7);

  console.log(`Generating PDF with activities spanning ${totalWeeks} weeks`);
  console.log(`Date range: ${formatDate(startDate)} to ${formatDate(endDate)}`);

  // Create activities - 2-3 per week
  let activityId = 1000;
  for (let week = 0; week < totalWeeks; week++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + week * 7);

    // 2-3 activities per week
    const activitiesThisWeek = 2 + (week % 2); // alternates between 2 and 3

    for (let i = 0; i < activitiesThisWeek; i++) {
      const actStart = new Date(weekStart);
      actStart.setDate(weekStart.getDate() + i * 2);

      const actEnd = new Date(actStart);
      actEnd.setDate(actStart.getDate() + 3 + (i % 3)); // 3-5 day duration

      // Don't go past end date
      if (actStart > endDate) break;
      if (actEnd > endDate) actEnd.setTime(endDate.getTime());

      activities.push({
        id: `A${activityId++}`,
        name: `Activity ${activityId - 1000} - Week ${week + 1}`,
        start: formatDate(actStart),
        finish: formatDate(actEnd),
      });
    }
  }

  console.log(`Total activities: ${activities.length}`);

  // Title
  doc.fontSize(16).font('Helvetica-Bold').text('Test Programme - Jan to May 2026', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  doc.moveDown(2);

  // Table header
  const tableTop = doc.y;
  const colWidths = [80, 250, 100, 100];
  const headers = ['Activity ID', 'Activity Name', 'Start', 'Finish'];

  doc.font('Helvetica-Bold').fontSize(10);
  let x = 50;
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop, { width: colWidths[i] });
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(750, tableTop + 15).stroke();

  // Table rows
  doc.font('Helvetica').fontSize(9);
  let y = tableTop + 20;

  activities.forEach((activity, index) => {
    // New page if needed
    if (y > 500) {
      doc.addPage();
      y = 50;

      // Repeat header on new page
      doc.font('Helvetica-Bold').fontSize(10);
      x = 50;
      headers.forEach((header, i) => {
        doc.text(header, x, y, { width: colWidths[i] });
        x += colWidths[i];
      });
      doc.moveTo(50, y + 15).lineTo(750, y + 15).stroke();
      y += 20;
      doc.font('Helvetica').fontSize(9);
    }

    x = 50;
    doc.text(activity.id, x, y, { width: colWidths[0] });
    x += colWidths[0];
    doc.text(activity.name, x, y, { width: colWidths[1] });
    x += colWidths[1];
    doc.text(activity.start, x, y, { width: colWidths[2] });
    x += colWidths[2];
    doc.text(activity.finish, x, y, { width: colWidths[3] });

    y += 15;
  });

  // Summary at the end
  doc.addPage();
  doc.fontSize(14).font('Helvetica-Bold').text('Summary', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).font('Helvetica');
  doc.text(`Total Activities: ${activities.length}`);
  doc.text(`Date Range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
  doc.text(`Total Weeks: ${totalWeeks}`);
  doc.text(`First Activity: ${activities[0].name} (${activities[0].start})`);
  doc.text(`Last Activity: ${activities[activities.length - 1].name} (${activities[activities.length - 1].finish})`);

  doc.end();

  writeStream.on('finish', () => {
    console.log(`\nPDF created successfully!`);
    console.log(`Location: ${outputPath}`);
    console.log(`\nYou can now upload this PDF to test the Close-Out Eligible flow.`);
  });
};

generateTestPDF();
