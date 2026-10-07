const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const {
  EXPENSE_CATEGORIES,
  isValidExpenseCategory,
} = require("../constants/expenseCategories");

const PAGE = {
  margin: 40,
  width: 595.28,
  height: 841.89,
};

const CARE_LOGO_CANDIDATES = [
  path.join(__dirname, "..", "..", "assets", "care-logo.jpg"),
  path.join(__dirname, "..", "..", "assets", "care-logo.png"),
];

function getCareLogoPath() {
  return CARE_LOGO_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

function contentWidth() {
  return PAGE.width - PAGE.margin * 2;
}

function formatDate(value, options = {}) {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (options.long) {
    return date.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  return [
    String(date.getDate()).padStart(2, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    date.getFullYear(),
  ].join("/");
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCurrencyLabel(value) {
  return `KSH ${formatCurrency(value)}`;
}

function dash(value) {
  const text = value == null ? "" : String(value).trim();
  return text || "—";
}

function checkboxMark(checked) {
  return checked ? "[X]" : "[ ]";
}

function ensureSpace(doc, needed = 60) {
  if (doc.y + needed > PAGE.height - PAGE.margin) {
    doc.addPage();
  }
}

function drawLine(doc, y = doc.y, color = "#333333") {
  const x = PAGE.margin;
  doc
    .save()
    .strokeColor(color)
    .lineWidth(0.8)
    .moveTo(x, y)
    .lineTo(x + contentWidth(), y)
    .stroke()
    .restore();
}

function drawBox(doc, x, y, w, h, options = {}) {
  doc
    .save()
    .lineWidth(options.lineWidth || 0.9)
    .strokeColor(options.stroke || "#222222");
  if (options.fill) {
    doc.fillColor(options.fill).rect(x, y, w, h).fillAndStroke();
  } else {
    doc.rect(x, y, w, h).stroke();
  }
  doc.restore();
}

function drawCareLogo(doc, { x, y, width = 56 } = {}) {
  const logoPath = getCareLogoPath();
  if (!logoPath) {
    return 0;
  }

  // Keep branded mark readable without crowding the form title.
  const renderedHeight = width;
  doc.image(logoPath, x, y, { width, height: renderedHeight });
  return renderedHeight;
}

function drawHeaderBand(doc, { eyebrow, title, subtitle }) {
  const x = PAGE.margin;
  let y = PAGE.margin;
  const w = contentWidth();
  const logoWidth = 58;

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#444444")
    .text(eyebrow, x, y, { width: w });

  y = doc.y + 8;
  const logoX = x + (w - logoWidth) / 2;
  const logoHeight = drawCareLogo(doc, { x: logoX, y, width: logoWidth });

  if (logoHeight) {
    y += logoHeight + 6;
  } else {
    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor("#E87722")
      .text("CARE KENYA", x, y, { width: w, align: "center" });
    y = doc.y + 4;
  }

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#333333")
    .text(subtitle, x, y, { width: w, align: "center" });

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#000000")
    .text(title, x, doc.y + 2, { width: w, align: "center" });

  doc.moveDown(0.6);
  drawLine(doc, doc.y);
  doc.moveDown(0.6);
  doc.fillColor("#000000");
}

function fieldRow(doc, pairs, options = {}) {
  const startY = doc.y;
  const gap = 10;
  const colWidth = (contentWidth() - gap * (pairs.length - 1)) / pairs.length;
  let maxY = startY;

  pairs.forEach((pair, index) => {
    const x = PAGE.margin + index * (colWidth + gap);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#333333")
      .text(pair.label, x, startY, { width: colWidth });
    const labelBottom = doc.y;
    doc
      .font("Helvetica")
      .fontSize(options.valueSize || 10)
      .fillColor("#000000")
      .text(dash(pair.value), x, labelBottom + 2, { width: colWidth });
    maxY = Math.max(maxY, doc.y);
  });

  doc.y = maxY + (options.spacingAfter ?? 8);
}

function labeledBlock(doc, label, value, options = {}) {
  ensureSpace(doc, options.minHeight || 40);
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#333333")
    .text(label, PAGE.margin, doc.y, { width: contentWidth() });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#000000")
    .text(dash(value), {
      width: contentWidth(),
      align: "left",
    });
  doc.moveDown(options.spacingAfter ?? 0.4);
}

function drawTable(doc, columns, rows, options = {}) {
  const tableWidth = contentWidth();
  const startX = PAGE.margin;
  const fontSize = options.fontSize || 8;
  const headerHeight = options.headerHeight || 28;
  const padding = 3;

  const drawHeader = () => {
    ensureSpace(doc, headerHeight + 20);
    const y = doc.y;
    let x = startX;
    columns.forEach((col) => {
      drawBox(doc, x, y, col.width, headerHeight, { fill: "#eeeeee" });
      doc
        .font("Helvetica-Bold")
        .fontSize(fontSize)
        .fillColor("#000000")
        .text(col.header, x + padding, y + padding, {
          width: col.width - padding * 2,
          height: headerHeight - padding * 2,
        });
      x += col.width;
    });
    doc.y = y + headerHeight;
  };

  drawHeader();

  rows.forEach((row) => {
    doc.font("Helvetica").fontSize(fontSize);
    const heights = columns.map((col, index) => {
      const text = dash(row[index]);
      return Math.max(
        18,
        doc.heightOfString(text, {
          width: col.width - padding * 2,
        }) +
          padding * 2
      );
    });
    const rowHeight = Math.max(...heights);

    if (doc.y + rowHeight > PAGE.height - PAGE.margin) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    let x = startX;
    columns.forEach((col, index) => {
      drawBox(doc, x, y, col.width, rowHeight);
      doc
        .font("Helvetica")
        .fontSize(fontSize)
        .fillColor("#000000")
        .text(dash(row[index]), x + padding, y + padding, {
          width: col.width - padding * 2,
          align: col.align || "left",
        });
      x += col.width;
    });
    doc.y = y + rowHeight;
  });

  doc.moveDown(0.6);
}

function drawTarGrid(doc, rows, options = {}) {
  const startX = PAGE.margin;
  const tableWidth = contentWidth();
  const padding = options.padding || 4;
  let y = doc.y;

  rows.forEach((row) => {
    const rowHeight = row.height || Math.max(
      24,
      ...row.cells.map((cell) => {
        doc.font(cell.bold ? "Helvetica-Bold" : "Helvetica").fontSize(cell.size || 8);
        return doc.heightOfString(dash(cell.value), {
          width: tableWidth * cell.width - padding * 2,
        }) + padding * 2;
      })
    );
    let x = startX;

    row.cells.forEach((cell) => {
      const width = tableWidth * cell.width;
      const rawImage = cell.image ? String(cell.image) : "";
      const isDataImage =
        rawImage.startsWith("data:image/") ||
        rawImage.startsWith("data:application/octet-stream;") ||
        rawImage.startsWith("data:application/pdf;") ||
        rawImage.startsWith("data:image/svg+xml") ||
        rawImage.startsWith("data:;base64,");
      const isFileImage = rawImage && fs.existsSync(rawImage);
      const isRemoteUrl = rawImage.startsWith("http://") || rawImage.startsWith("https://");
      const looksLikeBase64Blob =
        rawImage.length >= 500 &&
        (rawImage.length > 2000 || /^[A-Za-z0-9+/=\s]+$/.test(rawImage.slice(-200)));
      const isImageSignature =
        rawImage && (isDataImage || isFileImage || isRemoteUrl || rawImage.length > 500 || looksLikeBase64Blob);
      const imageSource = isImageSignature ? rawImage : null;
      drawBox(doc, x, y, width, rowHeight, { fill: cell.fill });
      if (imageSource) {
        if (cell.value) {
          doc
            .font(cell.bold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(cell.size || 8)
            .fillColor(cell.color || (cell.bold ? "#000000" : "#0000FF"))
            .text(dash(cell.value), x + padding, y + padding, {
              width: width - padding * 2,
              height: 12,
            });
        }
        try {
          let src = imageSource;
          if (looksLikeBase64Blob && !rawImage.startsWith("data:")) {
            src = `data:image/png;base64,${rawImage.replace(/\s+/g, "")}`;
          }
          doc.image(src, x + padding, y + padding + (cell.value ? 12 : 0), {
            fit: [width - padding * 2, rowHeight - padding * 2 - (cell.value ? 12 : 0)],
            align: "center",
            valign: "center",
          });
        } catch (imgError) {
          const signatureLabel =
            cell.signatureLabel && typeof cell.signatureLabel === "string"
              ? cell.signatureLabel
              : rawImage && rawImage.length < 120 && !rawImage.startsWith("data:")
                ? rawImage
                : "[Signature on file]";
          doc
            .font("Helvetica")
            .fontSize(7)
            .fillColor("#555555")
            .text(signatureLabel, x + padding, y + padding + (cell.value ? 12 : 0), {
              width: width - padding * 2,
              height: rowHeight - padding * 2 - (cell.value ? 12 : 0),
              align: "center",
              valign: "center",
            });
        }
      } else {
        doc
          .font(cell.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(cell.size || 8)
          .fillColor(cell.color || (cell.bold ? "#000000" : "#0000FF"))
          .text(dash(cell.value), x + padding, y + padding, {
            width: width - padding * 2,
            height: rowHeight - padding * 2,
            align: cell.align || "left",
            valign: cell.valign || "top",
          });
      }
      x += width;
    });

    y += rowHeight;
  });

  doc.y = y;
  doc.fillColor("#000000");
}

function signatureBlock(doc, columns) {
  ensureSpace(doc, 90);
  const gap = 12;
  const colWidth = (contentWidth() - gap * (columns.length - 1)) / columns.length;
  const startY = doc.y;

  columns.forEach((col, index) => {
    const x = PAGE.margin + index * (colWidth + gap);
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(col.title, x, startY, { width: colWidth });
    let y = startY + 14;
    (col.lines || []).forEach((line) => {
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(`${line.label}: ${dash(line.value)}`, x, y, { width: colWidth });
      y = doc.y + 4;
    });
    doc
      .moveTo(x, y + 18)
      .lineTo(x + colWidth - 8, y + 18)
      .strokeColor("#555555")
      .lineWidth(0.7)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#555555")
      .text("Signature", x, y + 22, { width: colWidth });
  });

  doc.y = startY + 100;
  doc.fillColor("#000000");
}

function streamPdf(res, filename, buildContent, options = {}) {
  const doc = new PDFDocument({
    margin: PAGE.margin,
    size: "A4",
    layout: options.layout || "portrait",
    autoFirstPage: true,
    info: {
      Title: filename,
      Author: "CARE Kenya TAR System",
      Creator: "CARE Kenya Travel Authority Request",
    },
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const chunks = [];
  let settled = false;

  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("error", (error) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) {
      res.status(500).json({ message: "Failed to generate PDF" });
    } else {
      res.destroy(error);
    }
  });
  doc.on("end", () => {
    if (settled) return;
    settled = true;
    const pdf = Buffer.concat(chunks);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  });

  try {
    buildContent(doc);
    doc.end();
  } catch (error) {
    doc.emit("error", error);
  }
}

function getPassengerNames(requestDocument) {
  if (!requestDocument.passengers?.length) {
    return [requestDocument.requestedBy?.name].filter(Boolean);
  }
  return requestDocument.passengers.map((p) => p.name).filter(Boolean);
}

function getPassengerNumbers(requestDocument) {
  if (!requestDocument.passengers?.length) {
    return [requestDocument.requestedBy?.employeeNumber].filter(Boolean);
  }
  return requestDocument.passengers
    .map((p) => p.employeeNumber)
    .filter(Boolean);
}

function drawTravelRequestPdfPage(doc, requestDocument) {
  const project = requestDocument.project || {};
  const itinerary = requestDocument.itinerary || {};
  const mode = requestDocument.modeOfTravel || {};
  const requester = requestDocument.requestedBy || {};
  const budgetHolder = requestDocument.selected_budget_holder_id || {};
  const budgetHolderDecision = requestDocument.budgetHolderDecision || {};
  const approver =
    requestDocument.decision?.decidedBy ||
    requestDocument.selected_approver_id ||
    {};
  const passengerNames = getPassengerNames(requestDocument);
  const passengerNumbers = getPassengerNumbers(requestDocument);

    const office = requestDocument.employeeOffice || requester.office;
    const tripDate = formatDate(requestDocument.submittedAt);
    const travelMode = [
      `${checkboxMark(Boolean(mode.careVehicle))} CARE Vehicle`,
      `${checkboxMark(Boolean(mode.publicTransport))} Public Transport`,
      `${checkboxMark(Boolean(mode.aircraft))} Aircraft`,
    ].join("     ");

    doc.font("Helvetica").fontSize(7).text("Revised Version:", PAGE.margin, PAGE.margin);
    doc.font("Helvetica-Bold").fontSize(8).text("25th January, 2023", PAGE.margin, doc.y);
    drawCareLogo(doc, { x: PAGE.margin + contentWidth() / 2 - 30, y: PAGE.margin - 2, width: 60 });
    doc.font("Helvetica-Bold").fontSize(9).text("CARE KENYA", PAGE.margin, PAGE.margin + 66, {
      width: contentWidth(), align: "center",
    });
    doc.font("Helvetica-Bold").fontSize(8).text("COUNTRY OFFICES FLEET POLICIES", PAGE.margin, PAGE.margin + 84, {
      width: contentWidth(), align: "center",
    });
    doc.font("Helvetica-Bold").fontSize(9).text("3.5.7    TRAVEL AUTHORIZATION REQUEST", PAGE.margin, PAGE.margin + 108, {
      width: contentWidth(), align: "left",
    });
    doc.y = PAGE.margin + 124;

    drawTarGrid(doc, [
      { cells: [
        { width: 0.15, value: "Employee\nName", bold: true },
        { width: 0.17, value: passengerNames.join("\n") },
        { width: 0.15, value: "Employee\nNumber", bold: true },
        { width: 0.15, value: passengerNumbers.join(", ") },
        { width: 0.15, value: "Project\nName", bold: true },
        { width: 0.23, value: project.name },
      ], height: 42 },
      { cells: [
        { width: 0.15, value: "Business Unit:", bold: true },
        { width: 0.18, value: project.businessUnit },
        { width: 0.15, value: "Fund Code:", bold: true },
        { width: 0.18, value: project.fundCode },
        { width: 0.15, value: "Budget Holder:", bold: true },
        { width: 0.19, value: budgetHolder.name || budgetHolder.email },
      ], height: 24 },
      { cells: [
        { width: 0.20, value: "Review Status:", bold: true },
        { width: 0.80, value: budgetHolderDecision.status || "Pending" },
      ], height: 24 },
      { cells: [
        { width: 0.20, value: "Budget Holder Email:", bold: true },
        { width: 0.80, value: budgetHolder.email },
      ], height: 24 },
      { cells: [
        { width: 0.20, value: "Budget Holder Review:", bold: true },
        { width: 0.30, value: `Print Name:\n${budgetHolderDecision.decidedBy?.name || budgetHolder.name || ""}` },
        { width: 0.20, value: "Signature:", bold: true },
        { width: 0.30, value: budgetHolderDecision.signature ? "" : "____________________________", image: budgetHolderDecision.signature },
      ], height: 40 },
      { cells: [
        { width: 0.15, value: "Project ID:", bold: true },
        { width: 0.18, value: project.projectId },
        { width: 0.15, value: "Department ID:", bold: true },
        { width: 0.18, value: project.departmentId },
        { width: 0.15, value: "Activity ID:", bold: true },
        { width: 0.19, value: project.activityId },
      ], height: 24 },
      { cells: [
        { width: 0.15, value: "Assigned Area\nof Operation", bold: true },
        { width: 0.35, value: requestDocument.assignedAreaOfOperation },
        { width: 0.15, value: "Employees\nOffice", bold: true },
        { width: 0.35, value: office },
      ], height: 34 },
      { cells: [
        { width: 0.15, value: "Purpose of the Trip", bold: true },
        { width: 0.85, value: requestDocument.purposeOfTrip },
      ], height: 30 },
      { cells: [
        { width: 0.15, value: "Mode of Travel", bold: true },
        { width: 0.85, value: travelMode },
      ], height: 27 },
      { cells: [
        { width: 1, value: "Travel Itinerary (must be completed prior to supervisor authorizing travel)", bold: true, align: "center" },
      ], height: 23 },
      { cells: [
        { width: 0.14, value: "Date From", bold: true, align: "center" },
        { width: 0.14, value: "Date To", bold: true, align: "center" },
        { width: 0.25, value: "Destination", bold: true, align: "center" },
        { width: 0.17, value: "Passengers", bold: true, align: "center" },
        { width: 0.30, value: "Accommodation", bold: true, align: "center" },
      ], height: 24 },
      { cells: [
        { width: 0.14, value: formatDate(itinerary.dateFrom), align: "center" },
        { width: 0.14, value: formatDate(itinerary.dateTo), align: "center" },
        { width: 0.25, value: itinerary.destination, align: "center" },
        { width: 0.17, value: String(passengerNames.length || 0), align: "center" },
        { width: 0.30, value: itinerary.accommodationNeeded ? "Yes" : "No", align: "center" },
      ], height: 28 },
      ...(requestDocument.travelSegments?.length
        ? [
            {
              cells: [
                { width: 1, value: "Additional Travel Destinations", bold: true, align: "center" },
              ],
              height: 22,
            },
            {
              cells: [
                { width: 0.18, value: "Arrival", bold: true, align: "center" },
                { width: 0.18, value: "Departure", bold: true, align: "center" },
                { width: 0.22, value: "From", bold: true, align: "center" },
                { width: 0.22, value: "To", bold: true, align: "center" },
                { width: 0.20, value: "Destination", bold: true, align: "center" },
              ],
              height: 22,
            },
          ]
        : []),
      ...(requestDocument.travelSegments || []).map((segment) => ({
        cells: [
          { width: 0.18, value: formatDate(segment.dateFrom), align: "center" },
          { width: 0.18, value: formatDate(segment.dateTo), align: "center" },
          { width: 0.22, value: segment.from, align: "center" },
          { width: 0.22, value: segment.to, align: "center" },
          { width: 0.20, value: segment.destination, align: "center" },
        ],
        height: 25,
      })),
      { cells: [
        { width: 0.20, value: "Requested by:\n\nSignature:", bold: true },
        { width: 0.50, value: requestDocument.requesterSignature ? requester.name || "" : `${requester.name || ""}\n\n________________________`, image: requestDocument.requesterSignature },
        { width: 0.30, value: `Date: ${tripDate}` },
      ], height: 54 },
      { cells: [
        { width: 0.20, value: "Travel\nAuthorized\nby:", bold: true },
        { width: 0.25, value: `Print Name:\n${approver.name || ""}` },
        { width: 0.25, value: `Position:\n${approver.position || "Supervisor / Approver"}` },
        { width: 0.20, value: requestDocument.decision?.signature ? "Signature:" : "Signature:\n\n________________", image: requestDocument.decision?.signature },
        { width: 0.10, value: `Date:\n${formatDate(requestDocument.decision?.decidedAt || requestDocument.submittedAt)}` },
      ], height: 54 },
      { cells: [
        { width: 1, value: "To be signed by supervisor once all is completed", align: "center", color: "#000000" },
      ], height: 25 },
      { cells: [
        { width: 1, value: "Note: This form must be produced in 3 or 4 copies BEFORE travel is undertaken. The signed original is to be submitted to the Finance Unit when seeking an advance or claiming reimbursement, another photocopy provided to the Security Officer and the Fleet Officer if requesting a CARE vehicle for travel, and the third copy for employee’s records/file.", size: 7, color: "#000000" },
      ], height: 52 },
    ]);

    const status = String(requestDocument.status || "").toUpperCase();
    const statusLabel = status === "APPROVED" ? "APPROVED" : status === "REJECTED" ? "DECLINED" : "PENDING APPROVAL";
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(status === "APPROVED" ? "#2e7d32" : status === "REJECTED" ? "#c62828" : "#8a5a00")
      .text(`TAR STATUS: ${statusLabel}`, PAGE.margin, doc.y + 8);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#000000")
      .text(`Request ID: ${requestDocument._id}    Approved/Reviewed by: ${approver.name || "—"}`, PAGE.margin, doc.y + 3);
    doc.font("Helvetica").fontSize(7).text("Page 1 of 1", PAGE.margin, PAGE.height - PAGE.margin - 10, { width: contentWidth(), align: "center" });
}

function buildTravelRequestPdf(res, requestDocument) {
  streamPdf(res, `travel-request-${requestDocument._id}.pdf`, (doc) => {
    drawTravelRequestPdfPage(doc, requestDocument);
  });
}

function buildTravelRequestsPdf(res, requestDocuments) {
  const date = new Date().toISOString().slice(0, 10);
  streamPdf(res, `travel-requests-${date}.pdf`, (doc) => {
    requestDocuments.forEach((requestDocument, index) => {
      if (index > 0) {
        doc.addPage();
      }
      drawTravelRequestPdfPage(doc, requestDocument);
    });
  });
}

function drawPaymentRequestPage(doc, report) {
  const travel = report.travelRequest || {};
  const project = travel.project || {};
  const submitter = report.submittedBy || {};
  const total = Number(report.totalAmountKsh || 0);
  const purpose =
    travel.purposeOfTrip ||
    report.lineItems?.[0]?.description ||
    "Travel expense reimbursement";

  drawHeaderBand(doc, {
    eyebrow: "CARE International in KENYA",
    subtitle: "Finance — Settlement of advances / reimbursement of expenses",
    title: "PAYMENT REQUEST",
  });

  fieldRow(doc, [
    { label: "Transaction / Report No.:", value: String(report._id) },
    { label: "Status:", value: String(report.status || "").toUpperCase() },
  ]);

  fieldRow(doc, [
    { label: "Name of the Payee:", value: submitter.name },
    {
      label: "Employee / Vendor No.:",
      value: report.employeeNumber || submitter.employeeNumber,
    },
  ]);

  fieldRow(doc, [
    { label: "Unit:", value: report.department || submitter.department },
    { label: "Location:", value: report.baseLocation || submitter.office },
    { label: "Position:", value: report.position || submitter.position },
  ]);

  fieldRow(doc, [
    { label: "Amount of Payment:", value: formatCurrencyLabel(total) },
    { label: "Currency of Payment:", value: "KSHS" },
  ]);

  labeledBlock(doc, "PURPOSE:", purpose, { spacingAfter: 0.35 });

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("Back-up Document Details / Account Classification");
  doc.moveDown(0.3);

  const lineItems = report.lineItems || [];
  drawTable(
    doc,
    [
      { header: "Date", width: 70 },
      { header: "Description", width: 130 },
      { header: "Amount", width: 55, align: "right" },
      { header: "Fund Code", width: 55 },
      { header: "Project ID", width: 70 },
      { header: "Activity ID", width: 55 },
      { header: "Dept ID", width: 80 },
    ],
    lineItems.length
      ? lineItems.map((item) => [
          formatDate(item.expenseDate),
          item.description || item.category,
          formatCurrency(item.amount),
          project.fundCode,
          project.projectId,
          project.activityId,
          project.departmentId,
        ])
      : [["—", "No line items", "0.00", "—", "—", "—", "—"]],
    { fontSize: 7.5, headerHeight: 32 }
  );

  fieldRow(doc, [
    { label: "Total of Expenses:", value: formatCurrencyLabel(total) },
    { label: "Advance Outstanding:", value: "KSH 0.00" },
    {
      label: "(Owed to CARE) / Owed to Employee:",
      value: formatCurrencyLabel(total),
    },
  ]);

  doc
    .font("Helvetica-Oblique")
    .fontSize(7.5)
    .fillColor("#333333")
    .text(
      "The payment requested above is reasonable and proper justification is attached to this payment request. Staff approving the settlement of the advance confirm that all CARE Kenya Policies and Procedures have been followed.",
      { width: contentWidth() }
    );
  doc.fillColor("#000000");
  doc.moveDown(0.6);

  signatureBlock(doc, [
    {
      title: "Prepared by:",
      lines: [
        { label: "Name", value: submitter.name },
        {
          label: "Designation",
          value: report.position || submitter.position,
        },
        { label: "Date", value: formatDate(report.submittedAt) },
      ],
    },
    {
      title: "Reviewed by:",
      lines: [
        {
          label: "Name",
          value: report.selected_approver_id?.name,
        },
        { label: "Designation", value: report.selected_approver_id?.position },
        { label: "Date", value: formatDate(report.decision?.decidedAt) },
      ],
    },
    {
      title: "Approved by:",
      lines: [
        { label: "Name", value: report.decision?.decidedBy?.name },
        {
          label: "Designation",
          value: report.decision?.decidedBy?.position,
        },
        { label: "Date", value: formatDate(report.decision?.decidedAt) },
      ],
    },
  ]);

  if (report.decision?.comment) {
    labeledBlock(doc, "Decision Comment:", report.decision.comment);
  }
}

function classifyExpenseDescription(description = "") {
  const text = String(description).toLowerCase();
  if (text.includes("breakfast")) return "BREAKFAST";
  if (text.includes("lunch")) return "LUNCH";
  if (text.includes("dinner")) return "DINNER";
  if (text.includes("incident")) return "INCIDENTALS";
  if (text.includes("hotel") || text.includes("accommodation") || text.includes("lodging")) {
    return "HOTEL ROOM & TAXES";
  }
  if (text.includes("airport") || text.includes("visa")) {
    return "AIRPORT TAXES & VISA FEES";
  }
  if (
    text.includes("taxi") ||
    text.includes("transport") ||
    text.includes("fare") ||
    text.includes("matatu") ||
    text.includes("boda")
  ) {
    return "TAXI/LOCAL TRANSPORTATION";
  }
  if (text.includes("fuel") || text.includes("petrol") || text.includes("diesel")) {
    return "VEHICLE FUEL";
  }
  if (text.includes("perdiem") || text.includes("per diem") || text.includes("per-diem")) {
    return "PER DIEM (M&I)";
  }
  return "OTHER EXPENSES";
}

function resolveExpenseCategory(item = {}) {
  if (isValidExpenseCategory(item.category)) {
    return String(item.category).trim();
  }

  return classifyExpenseDescription(item.description);
}

function buildTerDayBuckets(lineItems = []) {
  const byKey = new Map();

  lineItems.forEach((item) => {
    const dateValue = item.expenseDate ? new Date(item.expenseDate) : null;
    const key = dateValue
      ? dateValue.toISOString().slice(0, 10)
      : `unknown-${item.location || "x"}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        date: dateValue,
        location: item.location || "—",
        amounts: {},
      });
    }
    const bucket = byKey.get(key);
    if (item.location) {
      bucket.location = item.location;
    }
    const category = resolveExpenseCategory(item);
    bucket.amounts[category] =
      (bucket.amounts[category] || 0) + Number(item.amount || 0);
  });

  return [...byKey.values()].sort((a, b) => {
    const aTime = a.date ? a.date.getTime() : 0;
    const bTime = b.date ? b.date.getTime() : 0;
    return aTime - bTime;
  });
}

function drawTravelExpenseReportPage(doc, report) {
  const submitter = report.submittedBy || {};
  const travel = report.travelRequest || {};
  const days = buildTerDayBuckets(report.lineItems || []);
  const displayDays = days.slice(0, 5);
  const categories = EXPENSE_CATEGORIES;

  doc.addPage();
  drawHeaderBand(doc, {
    eyebrow: "APPENDIX B",
    subtitle: "CARE — Settlement support schedule",
    title: "TRAVEL EXPENSE REPORT [TER]",
  });

  fieldRow(doc, [
    { label: "NAME:", value: submitter.name },
    {
      label: "POSITION:",
      value: report.position || submitter.position,
    },
  ]);
  fieldRow(doc, [
    {
      label: "EMPLOYEE NUMBER:",
      value: report.employeeNumber || submitter.employeeNumber,
    },
    {
      label: "DEPARTMENT:",
      value: report.department || submitter.department,
    },
  ]);
  fieldRow(doc, [
    { label: "TODAY'S DATE:", value: formatDate(report.submittedAt) },
    {
      label: "FIELD / SUB OFFICE:",
      value: report.baseLocation || submitter.office,
    },
    { label: "COUNTRY:", value: "Kenya" },
  ]);

  if (!displayDays.length) {
    doc.font("Helvetica").fontSize(10).text("No expense line items to report.");
    return;
  }

  const dayColWidth = 70;
  const labelWidth = contentWidth() - dayColWidth * displayDays.length - 70;
  const totalColWidth = 70;

  const columns = [
    { header: "ITEM DESCRIPTION", width: labelWidth },
    ...displayDays.map((day) => ({
      header: `${day.date ? formatDate(day.date) : "Day"}\n${day.location}`,
      width: dayColWidth,
      align: "right",
    })),
    { header: "TOTALS\nKSH", width: totalColWidth, align: "right" },
  ];

  const rows = categories.map((category) => {
    const dayValues = displayDays.map((day) =>
      day.amounts[category] ? formatCurrency(day.amounts[category]) : ""
    );
    const total = displayDays.reduce(
      (sum, day) => sum + Number(day.amounts[category] || 0),
      0
    );
    return [category, ...dayValues, total ? formatCurrency(total) : "0.00"];
  });

  const dailyTotals = displayDays.map((day) =>
    Object.values(day.amounts).reduce((sum, value) => sum + Number(value || 0), 0)
  );
  const grandTotal = dailyTotals.reduce((sum, value) => sum + value, 0);

  rows.push([
    "TOTALS FOR EACH DAY",
    ...dailyTotals.map((value) => formatCurrency(value)),
    formatCurrency(grandTotal),
  ]);

  drawTable(doc, columns, rows, { fontSize: 7, headerHeight: 34 });

  if (days.length > displayDays.length) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor("#444444")
      .text(
        `Note: TER day columns show the first ${displayDays.length} expense days. Remaining amounts are included in the Payment Request page totals (${formatCurrencyLabel(report.totalAmountKsh)}).`,
        { width: contentWidth() }
      );
    doc.fillColor("#000000");
    doc.moveDown(0.4);
  }

  fieldRow(doc, [
    { label: "TOTAL THIS PAGE:", value: formatCurrencyLabel(grandTotal) },
    {
      label: "TOTAL ALL PAGES:",
      value: formatCurrencyLabel(report.totalAmountKsh),
    },
    {
      label: "Linked Travel Destination:",
      value: travel.itinerary?.destination,
    },
  ]);

  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#444444")
    .text(
      "NOTE: 1) Full per diem will be paid for a full day if departure is before 1300 hrs and for dinner only if departure is before 1800 hrs. 2) No per diem will be paid on the day of return if the return is before 1300 hrs. 3) Per diem for lunch will be paid if return is after 1300 hrs and dinner if return is after 1800 hrs.",
      { width: contentWidth() }
    );
  doc.fillColor("#000000");
}

function drawTerLandscapePage(doc, report, days, pageIndex, pageCount, priorTotal, pageTotal, allTotal) {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 24;
  const tableX = margin;
  const tableWidth = pageWidth - margin * 2;
  const labelWidth = 112;
  const totalWidth = 62;
  const dayWidth = (tableWidth - labelWidth - totalWidth) / 6;
  const columns = [
    { x: tableX, width: labelWidth },
    ...Array.from({ length: 6 }, (_, index) => ({
      x: tableX + labelWidth + index * dayWidth,
      width: dayWidth,
    })),
    { x: tableX + labelWidth + 6 * dayWidth, width: totalWidth },
  ];
  let y = margin;

  const cell = (x, top, width, height, text = "", options = {}) => {
    doc.save();
    doc.lineWidth(0.55).strokeColor("#222222");
    if (options.fill) doc.fillColor(options.fill).rect(x, top, width, height).fillAndStroke();
    else doc.rect(x, top, width, height).stroke();
    doc
      .font(options.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(options.size || 7)
      .fillColor(options.color || "#000000")
      .text(String(text || ""), x + 3, top + 3, {
        width: Math.max(1, width - 6),
        height: height - 5,
        align: options.align || "left",
        ellipsis: true,
      });
    doc.restore();
  };

  cell(tableX, y, 82, 30, "CARE", { bold: true, size: 17 });
  cell(tableX + 82, y, tableWidth - 164, 30, "TRAVEL EXPENSE REPORT [TER]", {
    bold: true,
    size: 13,
    align: "center",
  });
  cell(tableX + tableWidth - 82, y, 82, 30, "APPENDIX B", { bold: true, size: 8, align: "center" });
  y += 30;

  const submitter = report.submittedBy || {};
  const travel = report.travelRequest || {};
  const profileRows = [
    [
      ["NAME", submitter.name],
      ["EMPLOYEE NUMBER", report.employeeNumber || submitter.employeeNumber],
    ],
    [
      ["POSITION", report.position || submitter.position],
      ["DEPARTMENT", report.department || submitter.department],
    ],
    [
      ["TODAY'S DATE", report.submittedAt ? formatDate(report.submittedAt) : ""],
      ["FIELD / SUB OFFICE", report.baseLocation || submitter.office],
    ],
    [
      ["COUNTRY", travel.country || "Kenya"],
      ["LOCATION", travel.itinerary?.destination || ""],
    ],
  ];
  for (const row of profileRows) {
    const colWidth = tableWidth / 2;
    row.forEach(([label, value], index) => {
      const x = tableX + index * colWidth;
      cell(x, y, 105, 15, label, { bold: true, size: 6.5 });
      cell(x + 105, y, colWidth - 105, 15, value || "", { size: 7.5 });
    });
    y += 15;
  }

  const expenseRows = [
    ["PER DIEM (M&I)", "PER DIEM (M&I)"],
    ["BREAKFAST", "BREAKFAST"],
    ["LUNCH", "LUNCH"],
    ["DINNER", "DINNER"],
    ["INCIDENTALS", "INCIDENTALS"],
    ["HOTEL ROOM & TAXES", "HOTEL ROOM & TAXES"],
    ["OTHER EXPENSES", "OTHER EXPENSES"],
    ["AIRPORT TAXES & VISA FEES", "AIRPORT TAXES & VISA FEES"],
    ["TAXI/LOCAL TRANSPORTATION", "TAXI/LOCAL TRANSPORTATION"],
    ["VEHICLE FUEL", "VEHICLE FUEL"],
  ];
  const dayHeaders = ["DAY", "DATE", "LOCATION", "EX. RATE", "REF", "TIME OF DEPARTURE", "TIME OF ARRIVAL", "ITEM DESCRIPTION"];
  for (const [index, header] of dayHeaders.entries()) {
    const rowHeight = index < 5 ? 14 : 16;
    cell(columns[0].x, y, labelWidth, rowHeight, header, { bold: true, size: 6.5 });
    days.forEach((day, dayIndex) => {
      let value = "";
      if (index === 0 && day?.date) {
        value = new Date(day.date).toLocaleDateString("en-KE", { weekday: "long" });
      } else if (index === 1 && day?.date) {
        value = formatDate(day.date);
      } else if (index === 2) {
        value = day?.location || "";
      }
      cell(columns[dayIndex + 1].x, y, dayWidth, rowHeight, value, {
        bold: index < 2,
        size: 6,
        align: "center",
      });
    });
    cell(columns[7].x, y, totalWidth, rowHeight, index === 0 ? "TOTALS KSH" : "", {
      bold: true,
      size: 6,
      align: "center",
    });
    y += rowHeight;
  }

  const groupedRows = [
    { title: "PER DIEM (M&I)", categories: expenseRows.slice(0, 6).map((row) => row[1]) },
    { title: "OTHER EXPENSES", categories: expenseRows.slice(6).map((row) => row[1]) },
  ];
  for (const group of groupedRows) {
    cell(tableX, y, tableWidth, 15, group.title, { bold: true, fill: "#c8c8c8", size: 7 });
    y += 15;
    for (const category of group.categories) {
      const lineHeight = 15;
      cell(columns[0].x, y, labelWidth, lineHeight, category, { size: 6.3 });
      let rowTotal = 0;
      days.forEach((day, dayIndex) => {
        const amount = Number(day?.amounts?.[category] || 0);
        rowTotal += amount;
        cell(columns[dayIndex + 1].x, y, dayWidth, lineHeight, amount ? formatCurrency(amount) : "", {
          size: 6.5,
          align: "right",
        });
      });
      cell(columns[7].x, y, totalWidth, lineHeight, rowTotal ? formatCurrency(rowTotal) : "-", {
        size: 6.5,
        align: "right",
      });
      y += lineHeight;
    }
  }

  cell(columns[0].x, y, labelWidth, 18, "TOTALS FOR EACH DAY", { bold: true, fill: "#c8c8c8", size: 6.5 });
  days.forEach((day, dayIndex) => {
    const total = Object.values(day?.amounts || {}).reduce((sum, amount) => sum + Number(amount || 0), 0);
    cell(columns[dayIndex + 1].x, y, dayWidth, 18, total ? formatCurrency(total) : "-", {
      bold: true,
      fill: "#c8c8c8",
      size: 6.5,
      align: "right",
    });
  });
  cell(columns[7].x, y, totalWidth, 18, formatCurrency(pageTotal), {
    bold: true,
    fill: "#c8c8c8",
    size: 6.5,
    align: "right",
  });
  y += 18;

  const summaryRows = [
    ["TOTAL THIS PAGE", formatCurrency(pageTotal)],
    ["TOTAL PREVIOUS PAGES", formatCurrency(priorTotal)],
    ["TOTAL ALL PAGES", formatCurrency(allTotal)],
  ];
  for (const [label, amount] of summaryRows) {
    cell(tableX + tableWidth - 230, y, 150, 16, label, { size: 6.5 });
    cell(tableX + tableWidth - 80, y, 80, 16, amount, { bold: true, size: 6.5, align: "right" });
    y += 16;
  }

  const notesY = Math.min(y + 2, pageHeight - 46);
  cell(
    tableX,
    notesY,
    tableWidth,
    Math.min(40, pageHeight - notesY - 12),
    "NOTE: 1) Full per diem will be paid for a full day if departure is before 1300 hrs and for dinner only if departure is before 1800 hrs. 2) No per diem will be paid on the day of return if the return is before 1300 hrs. 3) Per diem for lunch will be paid if return is after 1300 hrs and dinner if return is after 1800 hrs.",
    { bold: true, size: 6.2 }
  );
  doc
    .font("Helvetica")
    .fontSize(6)
    .fillColor("#444444")
    .text(`Page ${pageIndex} of ${pageCount}`, tableX, pageHeight - 13, { width: tableWidth, align: "right" });
}

function drawTravelExpenseReportPages(doc, report) {
  const days = buildTerDayBuckets(report.lineItems || []);
  const dayPages = [];
  for (let index = 0; index < Math.max(1, days.length); index += 6) {
    dayPages.push(days.slice(index, index + 6));
  }
  const allTotal = Number(report.totalAmountKsh || 0);
  let priorTotal = 0;

  dayPages.forEach((pageDays, index) => {
    if (index > 0) doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
    else doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
    const pageTotal = pageDays.reduce(
      (sum, day) => sum + Object.values(day.amounts).reduce((daySum, amount) => daySum + Number(amount || 0), 0),
      0
    );
    drawTerLandscapePage(doc, report, pageDays, index + 1, dayPages.length, priorTotal, pageTotal, allTotal);
    priorTotal += pageTotal;
  });
}

function buildReimbursementPdf(res, report) {
  streamPdf(res, `reimbursement-${report._id}.pdf`, (doc) => {
    drawPaymentRequestPage(doc, report);
    drawTravelExpenseReportPages(doc, report);
    if (report.travelRequest) {
      doc.addPage({ size: "A4", layout: "portrait", margin: PAGE.margin });
      drawTravelRequestPdfPage(doc, report.travelRequest);
    }
  });
}

function buildEmptyTravelExpenseReportPdf(res) {
  streamPdf(
    res,
    "travel-expense-report-template.pdf",
    (doc) => {
      drawTerLandscapePage(doc, {}, Array(6).fill(null), 1, 1, 0, 0, 0);
    },
    { layout: "landscape" }
  );
}

module.exports = {
  buildTravelRequestPdf,
  buildTravelRequestsPdf,
  buildReimbursementPdf,
  buildEmptyTravelExpenseReportPdf,
};
