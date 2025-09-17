const express = require("express");
const router = express.Router();
const fs = require("fs-extra");
const path = require("path");
const PDFDocument = require("pdfkit");
const Employee = require("../models/Employees");
const Salaries = require("../models/Salaries");
const { decrypt } = require("../utils/encryption");
const EmployeeDoc = require("../models/EmployeeDoc");

const UPLOAD_DIR = path.join(__dirname, "../Uploads");
fs.ensureDirSync(UPLOAD_DIR);

const FONT_DIR = path.join(__dirname, "../assets/fonts");
const LATO_REG = path.join(FONT_DIR, "Lato-Regular.ttf");
const LATO_BOLD = path.join(FONT_DIR, "Lato-Bold.ttf");
const LATO_ITAL = path.join(FONT_DIR, "Lato-Italic.ttf");

const SIZES = { h1: 19, h2: 15, body: 11.7, meta: 11 };
const HEADER_GAP_LINES = 8;
const META_BOTTOM_GAP = 2;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const DEFAULT_MARGINS = { top: 70, bottom: 70, left: 50, right: 50 };

function setupFonts(doc) {
  const fonts = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" };
  try {
    if (fs.existsSync(LATO_REG)) {
      doc.registerFont("Lato-Regular", LATO_REG);
      fonts.regular = "Lato-Regular";
    }
    if (fs.existsSync(LATO_BOLD)) {
      doc.registerFont("Lato-Bold", LATO_BOLD);
      fonts.bold = "Lato-Bold";
    }
    if (fs.existsSync(LATO_ITAL)) {
      doc.registerFont("Lato-Italic", LATO_ITAL);
      fonts.italic = "Lato-Italic";
    }
  } catch {}
  return fonts;
}

function printMetaLeft(doc, fonts, dateString, docNumber, metaSize = SIZES.meta) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const half = contentWidth / 2;
  const xLeft = doc.page.margins.left;
  const xRight = doc.page.margins.left + half;
  const y0 = doc.y;
  const leftText = `Date: ${dateString}`;
  const rightText = `Doc No: ${docNumber}`;
  doc.font(fonts.regular).fontSize(metaSize).text(leftText, xLeft, y0, { width: half, align: "left" });
  doc.font(fonts.regular).fontSize(metaSize).text(rightText, xRight, y0, { width: half, align: "right" });
  const leftH = doc.heightOfString(leftText, { width: half, align: "left" });
  const rightH = doc.heightOfString(rightText, { width: half, align: "right" });
  doc.y = y0 + Math.max(leftH, rightH);
  doc.moveDown(META_BOTTOM_GAP);
}

async function waitForFileWrite(filepath, timeout = 3000) {
  const started = Date.now();
  while (!fs.existsSync(filepath)) {
    await new Promise((r) => setTimeout(r, 100));
    if (Date.now() - started > timeout) break;
  }
  return fs.existsSync(filepath);
}

async function loadDocData(employeeId, type) {
  const doc = await EmployeeDoc.findOne({ employee: employeeId, type }).lean();
  return doc?.data || {};
}

async function writeNda(doc, emp) {
  const fonts = setupFonts(doc);
  if (!emp || !emp.name || !emp.cnic) throw new Error("Employee name or CNIC missing for NDA");
  const data = await loadDocData(emp._id, "nda");
  const companyName = data.companyName || "Mavens Advisor Pvt. Ltd.";
  const signatoryName = data.signatoryName || "Mr. Adeel Shaikh";
  const signatoryTitle = data.signatoryTitle || "HR MANAGER";
  const phone = data.contactPhone || "+1 (615) 988-0800";
  const name = String(emp.name || "").trim() || "Unknown Employee";
  const cnic = String(emp.cnic || "").trim() || "N/A";
  doc.moveDown(HEADER_GAP_LINES);
  const now = new Date();
  const dateString = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const docNumber = `NDA-${now.getTime().toString(36).toUpperCase()}`;
  printMetaLeft(doc, fonts, dateString, docNumber);
  doc.font(fonts.bold).fontSize(SIZES.h1).text("CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT", { align: "center", underline: true });
  doc.moveDown(1.3);
  const lineOpts = (indent = 0) => ({ width: doc.page.width - doc.page.margins.left - doc.page.margins.right - indent, align: "left", lineGap: 3, paragraphGap: 0, indent });
  const blocks = [
    { t: `THIS AGREEMENT made as of the ${dateString},`, b: false, i: 0 },
    { t: "BETWEEN", b: true, i: 0 },
    { t: `(${companyName})`, b: true, i: 0 },
    { t: "- And -", b: true, i: 0 },
    { t: `(${name}, bearing CNIC: ${cnic})`, b: true, i: 0 },
    { t: "WHEREAS the parties to this Agreement wish to exchange certain confidential and proprietary information for the purpose of entering into discussions regarding a potential business relationship.", b: false, i: 0 },
    { t: "1. For the purposes of this Agreement:", b: true, i: 0 },
    { t: `"Confidential Information" includes, but is not limited to, any information, "know-how" data, patent, copyright, trade secret, process, technique, program, design, formula, marketing, advertising, financial, commercial, sales or programming data, written materials, compositions, drawings, diagrams, computer or software programs, studies, work in progress, visual demonstrations, business plans, budgets, forecasts, customer data, ideas, concepts, characters, story outlines and other data, in oral, written, graphic, electronic, or any other form or medium whatsoever, which may be exchanged between the parties in pursuance of the Purpose or otherwise.`, b: false, i: 10 },
    { t: '"Owner" means the party hereto which possesses the intellectual property rights or other proprietary rights in and to an item of Confidential Information, as the context requires, and includes, without limitation, an owner, possessor, developer and licensee of such Confidential Information.', b: false, i: 10 },
    { t: '"Recipient" means the party hereto who receives or is otherwise privy to, or comes into possession of, an item of Confidential Information of which it is not the Owner.', b: false, i: 10 },
    { t: "2. All Confidential Information constitutes the sole and exclusive property and the Confidential Information of the Owner, which the Owner is entitled to protect. Recipient shall only use the Confidential Information strictly for the Purpose. Recipient shall hold and maintain all Confidential Information of the Owner in trust and confidence for the Owner and shall use commercially reasonable efforts to protect the Confidential Information from any harm, tampering, unauthorized access, sabotage, access, exploitation, manipulation, modification, interference, misuse, misappropriation, copying or disclosure.", b: false, i: 0 },
    { t: "3. Recipient shall not, without the prior written consent of the Owner, disclose any Confidential Information to any person or entity other than:", b: false, i: 0 },
    { t: "a) To such of its employees, officers, directors, contractors, agents and professional advisors, as applicable, and in such event only to the extent necessary for the Purpose and provided that Recipient shall, prior to disclosing the Confidential Information to such employees, officers, directors, contractors, agents and professional advisors, issue appropriate instructions to them to satisfy its obligations herein and obtain their agreement to receive and use the Confidential Information on a confidential basis on the same conditions as contained in this Agreement:", b: false, i: 10 },
    { t: "b) As required pursuant to any law, court order or other legal compulsion, provided that, prior to such disclosure, Recipient shall first notify Owner in writing of such disclosure requirement and assist the Owner in protecting such Confidential Information from disclosure.", b: false, i: 10 },
    { t: "c) The Recipient shall be fully responsible to ensure that each of its employees, officers, directors, contractors, agents and professional advisors that receive the Confidential Information from the Recipient, handles the Confidential Information as required by this Agreement, and Recipient shall be liable for any loss or damage resulting from any failure to do so. The Recipient shall notify the Owner promptly of any unauthorized use, disclosure or possession of the Confidential Information that comes to the Recipient's attention.", b: false, i: 10 },
    { t: "4. The Confidential Information shall not be copied, reproduced in any form or stored in a retrieval system or data base by the Recipient without prior written consent of the Owner, except for such copies and storage as may reasonably be required internally by Recipient for the Purpose.", b: false, i: 0 },
    { t: "5. Upon request of the Owner, Recipient shall immediately return to the Owner all Confidential Information, including all records, summaries, analyses, notes or other documents and all copies thereof, in any form whatsoever, under the power or control of the Recipient and destroy the Confidential Information from all retrieval systems and databases. The return of such documents to the Owner shall in no event relieve the Recipient of its obligations of confidentiality set out in this Agreement with respect to such returned Confidential Information.", b: false, i: 0 },
    { t: "6. In the event that the business relationship contemplated by this Agreement does not occur, neither party will use or permit the use of any of the Confidential Information of which it is the Recipient for its own benefit, nor for the benefit of any third party or for any other purpose that the Purpose defined herein. Regardless of whether the business relationship contemplated by this Agreement occurs, the rights and obligations set out in this agreement shall survive from the date of this Agreement and continue for a period of TEN years.", b: false, i: 0 },
    { t: "7. Neither this Agreement nor the disclosure of any Confidential Information to Recipient shall be construed as granting to Recipient any rights in, to or in respect of the Confidential Information.", b: false, i: 0 },
    { t: "8. The provisions hereof are necessary to protect the trade, commercial and financial interests of the parties. The parties acknowledge and agree that any breach whatsoever of the covenants, provisions and restrictions herein contained by either party shall constitute a breach of that party's obligations to the other party which may cause serious damage and injury to the non-breaching party which cannot be fully or adequately compensated by monetary damages. The parties accordingly agree that in addition to claiming damages, either party not in breach of this Agreement may seek interim and permanent equitable relief, including without limitation interim, interlocutory and permanent injunctive relief, in the event of any breach of this Agreement. All such rights and remedies shall be cumulative and in addition to any and all other rights and remedies whatsoever to which either party may be entitled.", b: false, i: 0 },
    { t: "9. The parties agree that the execution of this Agreement does not in any way constitute a partnership or joint venture or binding commitment on the part of either party to enter into or complete negotiations or any transaction with the other party.", b: false, i: 0 },
    { t: "10. This Agreement constitutes the entire agreement between the parties hereto with respect to the subject matter hereof and supersedes and overrides any prior or other agreements, representations, warranties, understandings and explanations between the parties hereto with respect to the subject matter of this Agreement.", b: false, i: 0 },
    { t: "11. This Agreement shall be binding upon the trustees, receiver, heirs, executors, administrators, successors and assigns of the parties.", b: false, i: 0 },
    { t: "12. This Agreement shall be exclusively governed by, and construed in accordance, with the laws of the province of Sindh and the laws of Pakistan applicable therein. The parties hereby submit to the exclusive jurisdiction of the courts of the province of Sindh.", b: false, i: 0 },
    { t: "13. The invalidity or unenforceability of any provision or part thereof of this Agreement shall not affect the validity or enforceability of any other provision and such invalid or unenforceable provision shall be deemed severed from the remaining provisions herein and such remaining provisions shall continue in full force and effect.", b: false, i: 0 },
    { t: "14. No waiver of any breach of any provision of this Agreement will be effective or binding unless in writing and signed by party purporting to give the same and will be limited to the specific breach waived unless otherwise provided in the written waiver.", b: false, i: 0 },
    { t: "15. The Receiving Party affirms that the individual(s) executing this Agreement has the authority to bind the Receiving Party to the terms hereof.", b: false, i: 0 },
    { t: "16. The Parties acknowledge and agree that each and every term of this Agreement is of the essence. If any one or more of the provisions contained in this Agreement should be declared invalid, illegal or unenforceable in any respect, the validity, legality and enforceability of the remaining provisions contained in this Agreement shall not in any way be affected or impaired thereby so long as the commercial, economic and legal substance of the transaction contemplated hereby are not affected in any manner materially adverse to any Party. Upon such a declaration, the Parties shall modify this Agreement so as to carry out the original intent of the Parties as closely as possible in an acceptable manner so that the purposes contemplated hereby are consummated as originally contemplated to the fullest extent possible.", b: false, i: 0 },
    { t: "17. This Agreement will be effective as of the Effective Date, but will apply to any Confidential Information disclosed to the Receiving Party by Company prior to such date.", b: false, i: 0 },
    { t: "(a) as to subsequent disclosures of Confidential Information, on the later of five (5) years from and after the Effective Date or five (5) years from the expiry or termination of any other agreement between the Parties related to the supply of goods and/or services in relation to the Permitted Purpose.", b: false, i: 10 },
    { t: "(b) as to any Confidential Information disclosed prior to the date of any termination under subsection (a) above, for a further period of five (5) years from and after such date; provided that this Agreement shall continue in full force and effect with respect to any Trade Secret for such additional period as such information remains a Trade Secret.", b: false, i: 10 },
    { t: "18. An electronic copy or facsimile of a party's signature shall be binding upon the signatory with the same force and effect as an original signature.", b: false, i: 0 },
  ];
  blocks.forEach(({ t, b, i }) => {
    doc.font(b ? fonts.bold : fonts.regular).fontSize(SIZES.body).text(t, doc.page.margins.left + (i || 0), undefined, lineOpts(i || 0));
    doc.moveDown(0.6);
  });
  doc.moveDown(1.8);
  const y0 = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const col = width * 0.45;
  const gap = width * 0.1;
  doc.font(fonts.regular).fontSize(SIZES.meta).text("Signature:", doc.page.margins.left, y0);
  doc.moveDown(2);
  doc.text("_____________________________", doc.page.margins.left);
  doc.moveDown(0.6);
  doc.font(fonts.bold).text(name, doc.page.margins.left);
  doc.font(fonts.regular).text(`CNIC# ${cnic}`, doc.page.margins.left);
  doc.font(fonts.regular).fontSize(SIZES.meta).text("Signature:", doc.page.margins.left + col + gap, y0);
  doc.moveDown(2);
  doc.text("_____________________________", doc.page.margins.left + col + gap);
  doc.moveDown(0.6);
  doc.font(fonts.bold).text(`On behalf of ${companyName}`, doc.page.margins.left + col + gap);
  doc.font(fonts.regular).text(signatoryName, doc.page.margins.left + col + gap);
  doc.moveDown(2);
  doc.font(fonts.bold).fontSize(SIZES.body).text("Best regards,", { align: "left" });
  doc.moveDown(0.3);
  doc.font(fonts.bold).text(signatoryTitle);
  doc.text(phone);
}

async function writeContract(doc, emp, slip, key = null) {
  const fonts = setupFonts(doc);
  if (!emp || !emp.name || !emp.cnic) throw new Error("Employee name or CNIC missing for Contract");
  const data = await loadDocData(emp._id, "contract");
  const companyName = data.companyName || "Mavens Advisor Pvt. Ltd.";
  const probationMonths = Number.isFinite(+data.probationMonths) ? +data.probationMonths : (emp.probationMonths ?? 3);
  const noticeDays = Number.isFinite(+data.noticeDays) ? +data.noticeDays : 30;
  const officeStart = data.officeStart || "03:00 pm";
  const officeEnd = data.officeEnd || "12:00 am";
  const workDays = data.workDays || "Monday to Saturday";
  const phone = data.contactPhone || "+1 (615) 988-0800";
  const name = String(emp.name || "").trim() || "Unknown Employee";
  const cnic = String(emp.cnic || "").trim() || "N/A";
  const now = new Date();
  const dateString = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const docNumber = `CON-${now.getTime().toString(36).toUpperCase()}`;
  let gross = "0";
  let conveyance = "0";
  if (key && slip) {
    try {
      gross = slip.grossSalary ? await decrypt(slip.grossSalary, key) : "0";
      conveyance = slip.conveyanceAllowance ? await decrypt(slip.conveyanceAllowance, key) : "0";
    } catch {
      gross = "0";
      conveyance = "0";
    }
  }
  doc.moveDown(HEADER_GAP_LINES);
  printMetaLeft(doc, fonts, dateString, docNumber);
  doc.font(fonts.bold).fontSize(SIZES.h1).text("EMPLOYMENT CONTRACT: PRIVATE AND CONFIDENTIAL", { align: "center" });
  doc.moveDown(1.2);
  doc.font(fonts.regular).fontSize(SIZES.body).text("(1) Your monthly salary and allowances payable monthly in arrear will be:", { align: "left", lineGap: 3 });
  doc.moveDown(0.6);
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const col1 = tableWidth * 0.6;
  const col2 = tableWidth * 0.4;
  const rowH = 18;
  const x0 = doc.page.margins.left;
  const y0 = doc.y;
  doc.rect(x0, y0, tableWidth, rowH * 2).stroke();
  doc.moveTo(x0 + col1, y0).lineTo(x0 + col1, y0 + rowH * 2).stroke();
  doc.moveTo(x0, y0 + rowH).lineTo(x0 + tableWidth, y0 + rowH).stroke();
  doc.text("Basic Compensation", x0 + 6, y0 + 3, { width: col1 - 12, align: "left" });
  doc.text(`Rs. ${Number(gross || 0).toLocaleString()}`, x0 + col1 + 6, y0 + 3, { width: col2 - 12, align: "left" });
  doc.text("Conveyance Allowance", x0 + 6, y0 + rowH + 3, { width: col1 - 12, align: "left" });
  doc.text(`Rs. ${Number(conveyance || 0).toLocaleString()}`, x0 + col1 + 6, y0 + rowH + 3, { width: col2 - 12, align: "left" });
  doc.moveDown(2);
  const p = (t, bold = false, indent = 0) => {
    doc.font(bold ? fonts.bold : fonts.regular).fontSize(SIZES.body).text(t, x0 + indent, undefined, { width: tableWidth - indent, align: "left", lineGap: 3 });
    doc.moveDown(0.6);
  };
  p(`${name}, bearing CNIC number ${cnic}.`);
  p(`(2) After your probation period of ${probationMonths} months your performance will be evaluated on the basis of your monthly targets and Key Performance Indicators and the continuity of your employment with us dependent on those evaluations.`);
  p(`(3) You hereby authorize the Company to deduct from your salary or any other sum due to you, any sums which you may owe the Company including, without limitation, any overpayments or loans made to you by the Company. This is without prejudice to any other remedies that the Company may have against you in respect of such sums.`);
  p(`(4) Your employment may be terminated, without assigning any reason, either by you giving the Company ${noticeDays} days notice in writing or by the Company giving you ${noticeDays} days notice in writing or on payment by either side one month's salary in lieu of notice. Provided, however, that in the event the termination of your services is due to misconduct, of which the Company shall be the sole judge, no notice by the Company will be required to be given and no salary in lieu of notice will be payable.`);
  p(`(5) The Company reserves the right to pay you in lieu of part or all of your notice period, or require that during the notice period you do not attend the Company's premises or/and carry out your day-to-day duties (and remain at home on 'garden leave'). During any garden leave period you shall be entitled to your salary and benefits in the usual manner.`);
  p(`(6) Your continuing employment is subject to the satisfactory completion of an initial probationary period of three months, during which the Company will have the opportunity to assess your work performance. If the Company considers that your performance has not been satisfactory, it may either terminate your employment immediately without notice or extend your probationary period by up to a further three months. At the end of the probation period, we will either confirm your employment or otherwise.`);
  p(`(7) Your employment with the Company is at all times conditional upon your promptly producing references to the satisfaction of the Company and the Company determining that the outcome of any background checks which the Company may conduct, are to its satisfaction.`);
  p(`(8) You agree to be bound by the Company's rules, regulations and policies as amended, modified or adopted from time to time.`);
  p(`(9) Working Hours:`, true);
  p(`(a) Working days in the Company will be 6 days a week (${workDays}) i.e. from Monday to Saturday. Office hours will be from ${officeStart} to ${officeEnd} without any break for lunch. However, these working days/timings may be varied for different staff members with mutual agreement based upon his/her types of responsibilities.`, false, 10);
  p(`(b) Sunday is normally a full holiday, however as per the workload, the management of Mavens Advisor may call you on holidays.`, false, 10);
  p(`(10) During your employment you will not be employed, engaged, interested or concerned in any activity, office or outside business interests (whether paid or unpaid) without the written consent of the CEO. You will disclose in writing to the Company any such activities, offices or outside business interests you may currently have and in the event that the Company requires you to cease the same, you will do so forthwith. For the avoidance of doubt consent will not be given in relation to any activities, offices or business interests which in the view of the Company, are similar to, or compete directly or indirectly with the business of the Company or which could in the view of the Company, give rise to a conflict of interest or interfere with the efficient performance of your duties.`);
  p(`(11) Confidentiality:`, true);
  p(`(a) Except in the proper performance of your duties or as required in law, you may not (and undertake that you will not), during or after your employment, disclose or otherwise make use of (and shall use your best endeavors to prevent the publication or disclosure of) any trade secrets or other confidential information of or relating to the Company or any of its subsidiaries or affiliates, or any other person or entity, including any organization or business with which the Company is involved in any kind of business venture or partnership or any information concerning the business of the Company or any Associated Entity or in respect of which the Company owes an obligation of confidence to any third party.`, false, 10);
  p(`(b) You must not at any time remove from the Company's premises any documents or items which belong to the Company or which contain any Confidential Information without proper advance authorization from the administrator.`, false, 10);
  p(`(c) You must return to the Company upon request and, in any event, upon the termination of your employment, all documents, records and other papers (including copies and extracts), items and other property of whatsoever nature which belong to the Company or which contain or refer to any confidential information and which are in your possession or under your control.`, false, 10);
  p(`(12) You acknowledge that all Intellectual Property Rights, inventions and all materials embodying them shall automatically belong to the Company to the fullest extent permitted by law.`);
  p(`(13) This letter of employment shall be governed by the laws of Pakistan.`);
  p(`(14) You are not allowed to be involved in any business activity, whether it is as a buyer, supplier or employee/employer with a company that is in the same business as for the duration of your employment.`);
  p(`(15) By signing this agreement, you are endorsing the fact that you will work for the Company for at least ONE year in the current capacity and will not resign from the current or seek any other kind of employment opportunity during this period.`);
  p(`AS WITNESS the hands of the parties hereto or their duly authorized representatives.`, true);
  p(`SIGNED by _____________________________; On behalf of ${companyName}`);
  p(`I, the undersigned, confirm my agreement to and acceptance of the above terms and conditions.`);
  p(`SIGNED by`);
  p(`${name}`);
  doc.moveDown(1.5);
  doc.font(fonts.bold).fontSize(SIZES.body).text("Best regards,", { align: "left" });
  doc.moveDown(0.3);
  doc.font(fonts.bold).text("HR MANAGER");
  doc.text(phone);
}

async function writeSalaryCertificate(doc, emp, issueDate, joinDate, monthlySalary) {
  const fonts = setupFonts(doc);
  if (!emp || !emp.name || !emp.cnic) throw new Error("Employee name or CNIC missing for Salary Certificate");
  const data = await loadDocData(emp._id, "salary_certificate");
  const name = String(emp.name || "").trim() || "Unknown Employee";
  const hrManager = data.hrManager || "ABDUL REHMAN ABID";
  const hrManagerDesig = data.hrManagerDesignation || "HR MANAGER";
  const phone = data.contactPhone || "+1 (615) 988-0800";
  const overrideSalary = data.overrideMonthlySalary;
  const totalSalary = overrideSalary && String(overrideSalary).trim() !== "" ? overrideSalary : monthlySalary;
  doc.moveDown(HEADER_GAP_LINES);
  const docNumber = `SAL-${Date.now().toString(36).toUpperCase()}`;
  printMetaLeft(doc, fonts, issueDate, docNumber);
  doc.font(fonts.bold).fontSize(SIZES.h1).text("To whom it may concern", { align: "center" });
  doc.moveDown(1.2);
  doc.font(fonts.regular).fontSize(SIZES.body).text(`Mavens Advisor Pvt. Ltd. certifies that the employee whose details are mentioned below is working with us since ${joinDate}.`, { align: "left", lineGap: 3 });
  doc.moveDown(0.8);
  const details =
    `Name: ${name}\n` +
    `Job: ${emp.designation || emp.position || "Employee"}\n` +
    `National ID No: ${String(emp.cnic || "").trim()}\n` +
    `Nationality: ${emp.nationality || "Pakistani"}\n` +
    `Total Monthly Salary: ${totalSalary ? Number(totalSalary).toLocaleString() + " PKR" : "XX,XXX PKR"}`;
  doc.font(fonts.regular).fontSize(SIZES.body).text(details, { align: "left", lineGap: 3 });
  doc.moveDown(1.2);
  doc.font(fonts.regular).fontSize(SIZES.body).text("Please feel free to contact the Human Resource Department for any blocks, doubts and notifications.", { align: "left", lineGap: 3 });
  doc.moveDown(0.8);
  doc.font(fonts.bold).text("Best regards,", { align: "left" });
  doc.moveDown(0.3);
  doc.font(fonts.bold).text(hrManager.toUpperCase());
  doc.font(fonts.regular).text(hrManagerDesig.toUpperCase());
  doc.text(phone);
}

async function writeExperienceLetter(doc, emp, issueDate, joinDate, endDate, roles, sizes, bodyLineGap = 2.4, headerGapLines = HEADER_GAP_LINES, linesBetweenParas = 2.0, headingGapLines = 3, signGapAfterRegards = 7, gapBeforeHeadingLines = 1.0, extraAfterHeadingLines = 0.8) {
  const fonts = setupFonts(doc);
  if (!emp || !emp.name) throw new Error("Employee name missing for Experience Letter");
  const data = await loadDocData(emp._id, "experience_letter");
  const signName = (data.signName || "ADEEL SHAIKH").toUpperCase();
  const signTitle = (data.signTitle || "CHIEF OF OPERATIONS").toUpperCase();
  const qualitiesLine = data.qualitiesLine || `…hardworking, punctual, precise, and honest.`;
  const name = String(emp.name || "").trim();
  const docNumber = `EXP-${Date.now().toString(36).toUpperCase()}`;
  sizes = sizes || { heading: 16, body: 12.5, meta: 11 };
  doc.moveDown(headerGapLines);
  printMetaLeft(doc, fonts, issueDate, docNumber, sizes.meta);
  doc.font(fonts.regular).fontSize(sizes.body);
  doc.moveDown(gapBeforeHeadingLines);
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font(fonts.bold).fontSize(sizes.heading).text("To whom it may concern", doc.page.margins.left, undefined, { width: contentWidth, align: "center", underline: true });
  doc.moveDown(headingGapLines + extraAfterHeadingLines);
  const bodyOpts = { width: contentWidth, align: "left", lineGap: bodyLineGap, paragraphGap: 0 };
  const para = (t) => { doc.font(fonts.regular).fontSize(sizes.body).text(t, doc.page.margins.left, undefined, bodyOpts); doc.moveDown(linesBetweenParas); };
  para(`We hereby certify that ${name} was working at Mavens Advisor from ${joinDate} to ${endDate}.`);
  let wroteTimeline = false;
  if (Array.isArray(roles) && roles.length >= 2) {
    const monthsBetween = (a, b) => { const d1 = new Date(a), d2 = new Date(b); if (isNaN(d1) || isNaN(d2)) return null; let m = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()); if (d2.getDate() < d1.getDate()) m -= 1; if (m < 0) m = 0; return m <= 1 ? `${m || 1} month` : `${m} months`; };
    const [r1, r2] = roles;
    const title1 = (r1?.title ? String(r1.title) : "").trim() || "—";
    const title2 = (r2?.title ? String(r2.title) : "").trim() || "—";
    const dur1 = r1?.from && r1?.to ? monthsBetween(r1.from, r1.to) : null;
    const dur2 = r2?.from && r2?.to ? monthsBetween(r2.from, r2.to) : null;
    const part1 = dur1 ? `started as a ${title1} for ${dur1}` : `started as a ${title1}`;
    const part2 = dur2 ? `then served as a ${title2} for ${dur2}` : `then served as a ${title2}`;
    para(`${name} ${part1}, ${part2}.`);
    wroteTimeline = true;
  }
  if (!wroteTimeline && (emp.designation || emp.position)) para(`${name} served as ${emp.designation || emp.position}.`);
  para(`We are also pleased to inform you that ${name} ${qualitiesLine}`);
  para("Please feel free to contact the Human Resource Department for any further details.");
  doc.font(fonts.regular).fontSize(sizes.body).text("Best regards,", { align: "left" });
  doc.moveDown(signGapAfterRegards);
  doc.font(fonts.bold).fontSize(sizes.body).text(signName);
  doc.font(fonts.bold).fontSize(sizes.body).text(signTitle);
}

async function generateNdaPdf(employee) {
  if (!employee || !employee.name || !employee.cnic) throw new Error("Employee name or CNIC missing for NDA PDF");
  const pdfPath = path.join(UPLOAD_DIR, `nda_${employee._id}.pdf`);
  const doc = new PDFDocument({ size: "A4", margin: DEFAULT_MARGINS });
  doc.pipe(fs.createWriteStream(pdfPath));
  await writeNda(doc, employee);
  doc.end();
  await waitForFileWrite(pdfPath);
  return pdfPath;
}

async function generateContractPdf(employee, key = null) {
  if (!employee || !employee.name || !employee.cnic) throw new Error("Employee name or CNIC missing for Contract PDF");
  const slip = await Salaries.findOne({ employee: employee._id }).sort({ updatedAt: -1 }).lean();
  const pdfPath = path.join(UPLOAD_DIR, `contract_${employee._id}.pdf`);
  const doc = new PDFDocument({ size: "A4", margin: DEFAULT_MARGINS });
  doc.pipe(fs.createWriteStream(pdfPath));
  await writeContract(doc, employee, slip, key);
  doc.end();
  await waitForFileWrite(pdfPath);
  return pdfPath;
}

async function generateSalaryCertificatePdf(employee) {
  if (!employee || !employee.name || !employee.cnic) throw new Error("Employee name or CNIC missing for Salary Certificate PDF");
  const slip = await Salaries.findOne({ employee: employee._id }).sort({ updatedAt: -1 }).lean();
  let monthlySalary = "0";
  try {
    if (slip?.grossSalary) monthlySalary = await decrypt(slip.grossSalary);
    else if (employee.compensation?.grossSalary) monthlySalary = await decrypt(employee.compensation.grossSalary);
  } catch { monthlySalary = "0"; }
  const now = new Date();
  const issueDate = now.toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" });
  const joinDate = employee.joiningDate ? new Date(employee.joiningDate).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" }) : "-";
  const pdfPath = path.join(UPLOAD_DIR, `salary_certificate_${employee._id}.pdf`);
  const doc = new PDFDocument({ size: "A4", margin: DEFAULT_MARGINS });
  doc.pipe(fs.createWriteStream(pdfPath));
  await writeSalaryCertificate(doc, employee, issueDate, joinDate, monthlySalary);
  doc.end();
  await waitForFileWrite(pdfPath);
  return pdfPath;
}

async function generateExperienceLetterPdf(employee) {
  if (!employee || !employee.name || !employee.cnic) throw new Error("Employee name or CNIC missing for Experience Letter PDF");
  const now = new Date();
  const issueDate = now.toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" });
  const startIso = employee.joiningDate || employee.startDate || employee.hireDate || null;
  const endIso = employee.leavingDate || employee.resignationDate || employee.endDate || employee.terminationDate || employee.lastWorkingDay || null;
  const joinDate = startIso ? new Date(startIso).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" }) : "—";
  const endDate = endIso ? new Date(endIso).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" }) : "Present";
  const roles = employee.rolesHistory || employee.experience || employee.positions || employee.designationHistory || [];
  const pdfPath = path.join(UPLOAD_DIR, `experience_${employee._id}.pdf`);
  const doc = new PDFDocument({ size: "A4", margin: DEFAULT_MARGINS });
  doc.pipe(fs.createWriteStream(pdfPath));
  await writeExperienceLetter(doc, employee, issueDate, joinDate, endDate, roles);
  doc.end();
  await waitForFileWrite(pdfPath);
  return pdfPath;
}

router.get("/nda/:employeeId", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.name || !emp.cnic) return res.status(400).json({ message: "Employee name or CNIC is missing" });
    let ndaPath = emp.ndaPath;
    if (!ndaPath || !fs.existsSync(ndaPath)) {
      ndaPath = await generateNdaPdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { ndaPath } });
    }
    if (!fs.existsSync(ndaPath)) return res.status(500).json({ message: "Failed to generate NDA" });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=NDA_${emp.name || "Unknown"}.pdf`);
    res.sendFile(path.resolve(ndaPath));
  } catch (err) {
    res.status(500).json({ message: `Failed to generate NDA: ${err.message}` });
  }
});

router.get("/contract/:employeeId", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.name || !emp.cnic) return res.status(400).json({ message: "Employee name or CNIC is missing" });
    let contractPath = emp.contractPath;
    if (!contractPath || !fs.existsSync(contractPath)) {
      contractPath = await generateContractPdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { contractPath } });
    }
    if (!fs.existsSync(contractPath)) return res.status(500).json({ message: "Failed to generate contract" });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=Contract_${emp.name || "Unknown"}.pdf`);
    res.sendFile(path.resolve(contractPath));
  } catch (err) {
    res.status(500).json({ message: `Failed to generate contract: ${err.message}` });
  }
});

router.post("/contract/:employeeId", async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ message: "Decryption key is required" });
  try {
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.name || !emp.cnic) return res.status(400).json({ message: "Employee name or CNIC is missing" });
    const contractPath = await generateContractPdf(emp, key);
    await Employee.updateOne({ _id: req.params.employeeId }, { $set: { contractPath } });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=Contract_${emp.name || "Unknown"}.pdf`);
    res.sendFile(path.resolve(contractPath));
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to generate contract" });
  }
});

router.get("/salary-certificate/:employeeId", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.name || !emp.cnic) return res.status(400).json({ message: "Employee name or CNIC is missing" });
    let certPath = emp.salaryCertificatePath;
    if (!certPath || !fs.existsSync(certPath)) {
      certPath = await generateSalaryCertificatePdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { salaryCertificatePath: certPath } });
    }
    if (!fs.existsSync(certPath)) return res.status(500).json({ message: "Failed to generate salary certificate" });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=SalaryCertificate_${emp.name || "Unknown"}.pdf`);
    res.sendFile(path.resolve(certPath));
  } catch (err) {
    res.status(500).json({ message: `Failed to generate salary certificate: ${err.message}` });
  }
});

router.get("/experience-letter/:employeeId", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.name || !emp.cnic) return res.status(400).json({ message: "Employee name or CNIC is missing" });
    let expPath = emp.experienceLetterPath;
    if (!expPath || !fs.existsSync(expPath)) {
      expPath = await generateExperienceLetterPdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { experienceLetterPath: expPath } });
    }
    if (!fs.existsSync(expPath)) return res.status(500).json({ message: "Failed to generate experience letter" });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=ExperienceLetter_${emp.name || "Unknown"}.pdf`);
    res.sendFile(path.resolve(expPath));
  } catch (err) {
    res.status(500).json({ message: `Failed to generate experience letter: ${err.message}` });
  }
});

module.exports = router;
