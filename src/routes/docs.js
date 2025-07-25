const express = require("express");
const router = express.Router();
const fs = require("fs-extra");
const path = require("path");
const PDFDocument = require("pdfkit");
const Employee = require("../models/Employees");
const Salaries = require("../models/Salaries");
const { decrypt } = require("../utils/encryption");

const UPLOAD_DIR = path.join(__dirname, "../Uploads");
fs.ensureDirSync(UPLOAD_DIR);

/* ------------------------------------------------------------------ */
/* 1. DOCUMENT WRITERS                                               */
/* ------------------------------------------------------------------ */
function writeNda(doc, emp) {
  console.log("writeNda: Input employee data:", emp);
  if (!emp || !emp.name || !emp.cnic) {
    console.error("writeNda: Invalid employee data - name or CNIC missing", { emp });
    throw new Error("Employee name or CNIC missing for NDA");
  }

  const name = typeof emp.name === "string" && emp.name.trim() ? emp.name.trim() : "Unknown Employee";
  const cnic = typeof emp.cnic === "string" && emp.cnic.trim() ? emp.cnic.trim() : "N/A";
  console.log("writeNda: Using name:", name, "CNIC:", cnic);

  // Generate document number and date
  const now = new Date();
  const dateString = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const docNumber = `NDA-${emp._id}-${Date.now()}`;

  // Header: 0.5-inch empty space (36 points), matching contract
  doc.moveDown(6);

  // Document info: Date on left, Document Number on right
  doc.font("Helvetica").fontSize(10);
  doc.text(`Date: ${dateString}`, doc.page.margins.left, doc.y, { align: "left" });
  doc.text(`Document No: ${docNumber}`, doc.page.margins.right, doc.y, { align: "right" });
  doc.moveDown(2);

  // Main Heading
  doc.font("Helvetica-Bold").fontSize(12).text("CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT", { 
    align: "center",
    underline: true
  });
  doc.moveDown(2);

  // Document content (font size 10)
  const ndaText = [
    { text: `THIS AGREEMENT made as of the ${dateString},`, bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "BETWEEN", bold: true, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "(Mavens Advisor Pvt. Ltd.)", bold: true, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "- And -", bold: true, indent: 0, align: "center" },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: `(${name}, bearing CNIC: ${cnic})`, bold: true, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "WHEREAS the parties to this Agreement wish to exchange certain confidential and proprietary information for the purpose of entering into discussions regarding a potential business relationship.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "1. For the purposes of this Agreement:", bold: true, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "\"Confidential Information\" includes, but is not limited to, any information, \"know-how\" data, patent, copyright, trade secret, process, technique, program, design, formula, marketing, advertising, financial, commercial, sales or programming data, written materials, compositions, drawings, diagrams, computer or software programs, studies, work in progress, visual demonstrations, business plans, budgets, forecasts, customer data, ideas, concepts, characters, story outlines and other data, in oral, written, graphic, electronic, or any other form or medium whatsoever, which may be exchanged between the parties in pursuance of the Purpose or otherwise.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "\"Owner\" means the party hereto which possesses the intellectual property rights or other proprietary rights in and to an item of Confidential Information, as the context requires, and includes, without limitation, an owner, possessor, developer and licensee of such Confidential Information.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "\"Recipient\" means the party hereto who receives or is otherwise privy to, or comes into possession of, an item of Confidential Information of which it is not the Owner.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "2. All Confidential Information constitutes the sole and exclusive property and the Confidential Information of the Owner, which the Owner is entitled to protect. Recipient shall only use the Confidential Information strictly for the Purpose. Recipient shall hold and maintain all Confidential Information of the Owner in trust and confidence for the Owner and shall use commercially reasonable efforts to protect the Confidential Information from any harm, tampering, unauthorized access, sabotage, access, exploitation, manipulation, modification, interference, misuse, misappropriation, copying or disclosure.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "3. Recipient shall not, without the prior written consent of the Owner, disclose any Confidential Information to any person or entity other than:", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "a) To such of its employees, officers, directors, contractors, agents and professional advisors, as applicable, and in such event only to the extent necessary for the Purpose and provided that Recipient shall, prior to disclosing the Confidential Information to such employees, officers, directors, contractors, agents and professional advisors, issue appropriate instructions to them to satisfy its obligations herein and obtain their agreement to receive and use the Confidential Information on a confidential basis on the same conditions as contained in this Agreement:", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "b) As required pursuant to any law, court order or other legal compulsion, provided that, prior to such disclosure, Recipient shall first notify Owner in writing of such disclosure requirement and assist the Owner in protecting such Confidential Information from disclosure.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "c) The Recipient shall be fully responsible to ensure that each of its employees, officers, directors, contractors, agents and professional advisors that receive the Confidential Information from the Recipient, handles the Confidential Information as required by this Agreement, and Recipient shall be liable for any loss or damage resulting from any failure to do so. The Recipient shall notify the Owner promptly of any unauthorized use, disclosure or possession of the Confidential Information that comes to the Recipient's attention.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "4. The Confidential Information shall not be copied, reproduced in any form or stored in a retrieval system or data base by the Recipient without prior written consent of the Owner, except for such copies and storage as may reasonably be required internally by Recipient for the Purpose.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "5. Upon request of the Owner, Recipient shall immediately return to the Owner all Confidential Information, including all records, summaries, analyses, notes or other documents and all copies thereof, in any form whatsoever, under the power or control of the Recipient and destroy the Confidential Information from all retrieval systems and databases. The return of such documents to the Owner shall in no event relieve the Recipient of its obligations of confidentiality set out in this Agreement with respect to such returned Confidential Information.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "6. In the event that the business relationship contemplated by this Agreement does not occur, neither party will use or permit the use of any of the Confidential Information of which it is the Recipient for its own benefit, nor for the benefit of any third party or for any other purpose that the Purpose defined herein. Regardless of whether the business relationship contemplated by this Agreement occurs, the rights and obligations set out in this agreement shall survive from the date of this Agreement and continue for a period of TEN years.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "7. Neither this Agreement nor the disclosure of any Confidential Information to Recipient shall be construed as granting to Recipient any rights in, to or in respect of the Confidential Information.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "8. The provisions hereof are necessary to protect the trade, commercial and financial interests of the parties. The parties acknowledge and agree that any breach whatsoever of the covenants, provisions and restrictions herein contained by either party shall constitute a breach of that party's obligations to the other party which may cause serious damage and injury to the non-breaching party which cannot be fully or adequately compensated by monetary damages. The parties accordingly agree that in addition to claiming damages, either party not in breach of this Agreement may seek interim and permanent equitable relief, including without limitation interim, interlocutory and permanent injunctive relief, in the event of any breach of this Agreement. All such rights and remedies shall be cumulative and in addition to any and all other rights and remedies whatsoever to which either party may be entitled.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "9. The parties agree that the execution of this Agreement does not in any way constitute a partnership or joint venture or binding commitment on the part of either party to enter into or complete negotiations or any transaction with the other party.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "10. This Agreement constitutes the entire agreement between the parties hereto with respect to the subject matter hereof and supersedes and overrides any prior or other agreements, representations, warranties, understandings and explanations between the parties hereto with respect to the subject matter of this Agreement.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "11. This Agreement shall be binding upon the trustees, receiver, heirs, executors, administrators, successors and assigns of the parties.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "12. This Agreement shall be exclusively governed by, and construed in accordance with, the laws of the province of Sindh and the laws of Pakistan applicable therein. The parties hereby submit to the exclusive jurisdiction of the courts of the province of Sindh.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "13. The invalidity or unenforceability of any provision or part thereof of this Agreement shall not affect the validity or enforceability of any other provision and such invalid or unenforceable provision shall be deemed severed from the remaining provisions herein and such remaining provisions shall continue in full force and effect.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "14. No waiver of any breach of any provision of this Agreement will be effective or binding unless in writing and signed by party purporting to give the same and will be limited to the specific breach waived unless otherwise provided in the written waiver.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "15. The Receiving Party affirms that the individual(s) executing this Agreement has the authority to bind the Receiving Party to the terms hereof.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "16. The Parties acknowledge and agree that each and every term of this Agreement is of the essence. If any one or more of the provisions contained in this Agreement should be declared invalid, illegal or unenforceable in any respect, the validity, legality and enforceability of the remaining provisions contained in this Agreement shall not in any way be affected or impaired thereby so long as the commercial, economic and legal substance of the transaction contemplated hereby are not affected in any manner materially adverse to any Party. Upon such a declaration, the Parties shall modify this Agreement so as to carry out the original intent of the Parties as closely as possible in an acceptable manner so that the purposes contemplated hereby are consummated as originally contemplated to the fullest extent possible.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "17. This Agreement will be effective as of the Effective Date, but will apply to any Confidential Information disclosed to the Receiving Party by Company prior to such date.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "(a) as to subsequent disclosures of Confidential Information, on the later of five (5) years from and after the Effective Date or five (5) years from the expiry or termination of any other agreement between the Parties related to the supply of goods and/or services in relation to the Permitted Purpose.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "(b) as to any Confidential Information disclosed prior to the date of any termination under subsection (a) above, for a further period of five (5) years from and after such date; provided that this Agreement shall continue in full force and effect with respect to any Trade Secret for such additional period as such information remains a Trade Secret.", bold: false, indent: 10 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 }, // Extra line break
    { text: "18. An electronic copy or facsimile of a party's signature shall be binding upon the signatory with the same force and effect as an original signature.", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 },
    { text: "", bold: false, indent: 0 } // Extra line break
  ];

  // Write all text segments (except signatures)
  const signatureIndex = ndaText.findIndex(segment => segment.text === "Signature:");
  const contentText = ndaText.slice(0, signatureIndex);
  contentText.forEach(segment => {
    doc.font(segment.bold ? "Helvetica-Bold" : "Helvetica")
       .fontSize(10)
       .text(segment.text, doc.page.margins.left + segment.indent, undefined, {
         width: doc.page.width - doc.page.margins.left - doc.page.margins.right - segment.indent,
         align: segment.align || "left",
         lineGap: 4,
         paragraphGap: 0,
         indent: segment.indent
       });
  });

  // Signatures in same row
  doc.moveDown(2);
  const signatureY = doc.y;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftColumnWidth = pageWidth * 0.45;
  const rightColumnWidth = pageWidth * 0.45;
  const gapWidth = pageWidth * 0.10;

  // Employee signature (left column)
  doc.font("Helvetica").fontSize(10);
  doc.text("Signature:", doc.page.margins.left, signatureY, { align: "left" });
  doc.text("_____________________________", doc.page.margins.left, undefined, { align: "left" });
  doc.font("Helvetica-Bold").text(name, doc.page.margins.left, undefined, { align: "left" });
  doc.text(`CNIC# ${cnic}`, doc.page.margins.left, undefined, { align: "left" });

  // Company signature (right column)
  doc.font("Helvetica").fontSize(10);
  doc.text("Signature:", doc.page.margins.left + leftColumnWidth + gapWidth, signatureY, { align: "left" });
  doc.text("_____________________________", doc.page.margins.left + leftColumnWidth + gapWidth, undefined, { align: "left" });
  doc.font("Helvetica-Bold").text("On behalf of Mavens Advisor Pvt. Ltd.", doc.page.margins.left + leftColumnWidth + gapWidth, undefined, { align: "left" });
  doc.text("Mr. Adeel Shaikh", doc.page.margins.left + leftColumnWidth + gapWidth, undefined, { align: "left" });

  // Footer: 0.5-inch empty space (36 points), matching contract
  doc.moveDown(6);
  doc.font("Helvetica-Bold").text("Best regards,", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text("ABDUL REHMAN ABID", doc.page.margins.left, undefined, { align: "left" });
  doc.font("Helvetica").text("HR MANAGER", doc.page.margins.left, undefined, { align: "left" });
  doc.text("+1 (615) 988-0800", doc.page.margins.left, undefined, { align: "left" });
  doc.text("Gulshan e Maymar, Karachi", doc.page.margins.left, undefined, { align: "left" });
  doc.text("HR@mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.text("www.mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(6);
}

async function writeContract(doc, emp, slip, key = null) {
  console.log("writeContract: Input employee data:", emp);
  if (!emp || !emp.name || !emp.cnic) {
    console.error("writeContract: Invalid employee data - name or CNIC missing", { emp });
    throw new Error("Employee name or CNIC missing for Contract");
  }

  const name = typeof emp.name === "string" && emp.name.trim() ? emp.name.trim() : "Unknown Employee";
  const cnic = typeof emp.cnic === "string" && emp.cnic.trim() ? emp.cnic.trim() : "N/A";
  console.log("writeContract: Using name:", name, "CNIC:", cnic);

  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = now.toLocaleString("default", { month: "long" });
  const year = now.getFullYear();
  const position = emp.position || emp.designation || "Employee";
  const probation = emp.probationMonths ?? 3;

  let gross = "0";
  let conveyance = "0";
  if (key && slip) {
    try {
      gross = slip.grossSalary ? await decrypt(slip.grossSalary, key) : "0";
      conveyance = slip.conveyanceAllowance ? await decrypt(slip.conveyanceAllowance, key) : "0";
      console.log("writeContract: Decrypted gross:", gross, "conveyance:", conveyance);
    } catch (e) {
      console.error("writeContract: Decryption failed:", e.message);
      gross = "0";
      conveyance = "0";
    }
  }

  // Header: 0.5-inch empty space (36 points)
  doc.moveDown(6);

  // Document info: Date on left, Document Number on right
  const dateString = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const docNumber = `CONTRACT-${emp._id}-${Date.now()}`;
  doc.font("Helvetica").fontSize(10);
  doc.text(`Date: ${dateString}`, doc.page.margins.left, doc.y, { align: "left" });
  doc.text(`Document No: ${docNumber}`, doc.page.margins.right, doc.y, { align: "right" });
  doc.moveDown(2);

  // Main Heading
  doc.font("Helvetica-Bold").fontSize(12).text("EMPLOYMENT CONTRACT: PRIVATE AND CONFIDENTIAL", { align: "center" });
  doc.moveDown(2);

  // Salary Table
  const tableTop = doc.y;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const col1Width = tableWidth * 0.6;
  const col2Width = tableWidth * 0.4;
  const rowHeight = 15;

  doc.font("Helvetica").fontSize(12);
  doc.text("(1) Your monthly salary and allowances payable monthly in arrear will be:", doc.page.margins.left, tableTop, { width: tableWidth });
  doc.moveDown(1);

  // Draw table borders
  const tableX = doc.page.margins.left;
  const tableY = doc.y;

  // Outer rectangle
  doc.rect(tableX, tableY, tableWidth, rowHeight * 2).stroke();

  // Vertical line (column separator)
  doc.moveTo(tableX + col1Width, tableY)
     .lineTo(tableX + col1Width, tableY + rowHeight * 2)
     .stroke();

  // Horizontal line (row separator)
  doc.moveTo(tableX, tableY + rowHeight)
     .lineTo(tableX + tableWidth, tableY + rowHeight)
     .stroke();

  // Table content
  doc.text("Basic Compensation", tableX + 5, tableY + 3, { width: col1Width - 10 });
  doc.text(`Rs. ${parseFloat(gross).toLocaleString()}`, tableX + col1Width + 5, tableY + 3, { width: col2Width - 10 });
  doc.text("Conveyance Allowance", tableX + 5, tableY + rowHeight + 3, { width: col1Width - 10 });
  doc.text(`Rs. ${parseFloat(conveyance).toLocaleString()}`, tableX + col1Width + 5, tableY + rowHeight + 3, { width: col2Width - 10 });

  doc.moveDown(2);

  const contractText = [
    { text: `${name}, bearing CNIC number ${cnic}`, bold: false, indent: 0 },
    { text: `(2) After your probation period of ${probation} months your performance will be evaluated on the basis of your monthly targets and Key Performance Indicators and the continuity of your employment with us dependent on those evaluations.`, bold: false, indent: 0 },
    { text: "(3) You hereby authorize the Company to deduct from your salary or any other sum due to you, any sums which you may owe the Company including, without limitation, any overpayments or loans made to you by the Company. This is without prejudice to any other remedies that the Company may have against you in respect of such sums.", bold: false, indent: 0 },
    { text: "(4) Your employment may be terminated, without assigning any reason, either by you giving the Company 30 days notice in writing or by the Company giving you 30 days notice in writing or on payment by either side one month's salary in lieu of notice. Provided, however, that in the event the termination of your services is due to misconduct, of which the Company shall be the sole judge, no notice by the Company will be required to be given and no salary in lieu of notice will be payable.", bold: false, indent: 0 },
    { text: "(5) The Company reserves the right to pay you in lieu of part or all of your notice period, or require that during the notice period you do not attend the Company's premises or/and carry out your day-to-day duties (and remain at home on 'garden leave'). During any garden leave period you shall be entitled to your salary and benefits in the usual manner.", bold: false, indent: 0 },
    { text: "(6) Your continuing employment is subject to the satisfactory completion of an initial probationary period of three months, during which the Company will have the opportunity to assess your work performance. If the Company considers that your performance has not been satisfactory, it may either terminate your employment immediately without notice or extend your probationary period by up to a further three months. At the end of the probation period, we will either confirm your employment or otherwise.", bold: false, indent: 0 },
    { text: "(7) Your employment with the Company is at all times conditional upon your promptly producing references to the satisfaction of the Company and the Company determining that the outcome of any background checks which the Company may conduct, are to its satisfaction.", bold: false, indent: 0 },
    { text: "(8) You agree to be bound by the Company's rules, regulations and policies as amended, modified or adopted from time to time.", bold: false, indent: 0 },
    { text: "(9) Working Hours:", bold: true, indent: 0 },
    { text: "(a) Working days in the Company will be 6 days a week (total 54 working hours in a week) i.e. from Monday to Saturday. Office hours will be from 03:00 pm to 12:00 am without any break for lunch. However, these working days/timings may be varied for different staff members with mutual agreement based upon his/her types of responsibilities.", bold: false, indent: 10 },
    { text: "(b) Sunday is normally a full holiday, however as per the workload, the management of Mavens Advisor may call you on holidays.", bold: false, indent: 10 },
    { text: "(10) During your employment you will not be employed, engaged, interested or concerned in any activity, office or outside business interests (whether paid or unpaid) without the written consent of the CEO. You will disclose in writing to the Company any such activities, offices or outside business interests you may currently have and in the event that the Company requires you to cease the same, you will do so forthwith. For the avoidance of doubt consent will not be given in relation to any activities, offices or business interests which in the view of the Company, are similar to, or compete directly or indirectly with the business of the Company or which could in the view of the Company, give rise to a conflict of interest or interfere with the efficient performance of your duties.", bold: false, indent: 0 },
    { text: "(11) Confidentiality:", bold: true, indent: 0 },
    { text: "(a) Except in the proper performance of your duties or as required in law, you may not (and undertake that you will not), during or after your employment, disclose or otherwise make use of (and shall use your best endeavors to prevent the publication or disclosure of) any trade secrets or other confidential information of or relating to the Company or any of its subsidiaries or affiliates, or any other person or entity, including any organization or business with which the Company is involved in any kind of business venture or partnership or any information concerning the business of the Company or any Associated Entity or in respect of which the Company owes an obligation of confidence to any third party.", bold: false, indent: 10 },
    { text: "(b) You must not at any time remove from the Company's premises any documents or items which belong to the Company or which contain any Confidential Information without proper advance authorization from the administrator.", bold: false, indent: 10 },
    { text: "(c) You must return to the Company upon request and, in any event, upon the termination of your employment, all documents, records and other papers (including copies and extracts), items and other property of whatsoever nature which belong to the Company or which contain or refer to any confidential information and which are in your possession or under your control.", bold: false, indent: 10 },
    { text: "(12) You acknowledge that all Intellectual Property Rights, inventions and all materials embodying them shall automatically belong to the Company to the fullest extent permitted by law.", bold: false, indent: 0 },
    { text: "(13) This letter of employment shall be governed by the laws of Pakistan.", bold: false, indent: 0 },
    { text: "(14) You are not allowed to be involved in any business activity, whether it is as a buyer, supplier or employee/employer with a company that is in the same business as for the duration of your employment.", bold: false, indent: 0 },
    { text: "(15) By signing this agreement, you are endorsing the fact that you will work for the Company for at least ONE year in the current capacity and will not resign from the current or seek any other kind of employment opportunity during this period.", bold: false, indent: 0 },
    { text: "AS WITNESS the hands of the parties hereto or their duly authorized representatives.", bold: true, indent: 0 },
    { text: "SIGNED by _____________________________; On behalf of Mavens Advisor Pvt. Ltd.", bold: false, indent: 0 },
    { text: "I, the undersigned, confirm my agreement to and acceptance of the above terms and conditions.", bold: false, indent: 0 },
    { text: "SIGNED by", bold: false, indent: 0 },
    { text: `${name}`, bold: false, indent: 0 }
  ];

  contractText.forEach(segment => {
    doc.font(segment.bold ? "Helvetica-Bold" : "Helvetica")
       .fontSize(12)
       .text(segment.text, doc.page.margins.left + segment.indent, undefined, {
         width: doc.page.width - doc.page.margins.left - doc.page.margins.right - segment.indent,
         align: "left",
         lineGap: segment.indent === 0 ? 8 : 4,
         continued: false
       });
  });

  // Footer: 0.5-inch empty space (36 points)
  doc.moveDown(6);
  doc.font("Helvetica-Bold").text("Best regards,", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text("ABDUL REHMAN ABID", doc.page.margins.left, undefined, { align: "left" });
  doc.font("Helvetica").text("HR MANAGER", doc.page.margins.left, undefined, { align: "left" });
  doc.text("+1 (615) 988-0800", doc.page.margins.left, undefined, { align: "left" });
  doc.text("Gulshan e Maymar, Karachi", doc.page.margins.left, undefined, { align: "left" });
  doc.text("HR@mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.text("www.mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(6);
}

async function writeSalaryCertificate(doc, emp, issueDate, joinDate, monthlySalary) {
  console.log("writeSalaryCertificate: Input employee data:", emp);
  if (!emp || !emp.name || !emp.cnic) {
    console.error("writeSalaryCertificate: Invalid employee data - name or CNIC missing", { emp });
    throw new Error("Employee name or CNIC missing for Salary Certificate");
  }

  const name = typeof emp.name === "string" && emp.name.trim() ? emp.name.trim() : "Unknown Employee";
  const cnic = typeof emp.cnic === "string" && emp.cnic.trim() ? emp.cnic.trim() : "N/A";
  console.log("writeSalaryCertificate: Using name:", name, "CNIC:", cnic);

  const department = emp.department || "-";
  const designation = emp.designation || emp.position || "Employee";
  const nationality = emp.nationality || "Pakistani";
  const hrManager = emp.hrManager || "ABDUL REHMAN ABID";
  const hrManagerDesig = emp.hrManagerDesignation || "HR MANAGER";

  // Header: 0.5-inch empty space (36 points)
  doc.moveDown(6);

  // Document info: Date on left, Document Number on right
  const dateString = issueDate;
  const docNumber = `SALCERT-${emp._id}-${Date.now()}`;
  doc.font("Helvetica").fontSize(10);
  doc.text(`Date: ${dateString}`, doc.page.margins.left, doc.y, { align: "left" });
  doc.text(`Document No: ${docNumber}`, doc.page.margins.right, doc.y, { align: "right" });
  doc.moveDown(2);

  // Main Content (font size 12)
  doc.font("Helvetica-Bold").fontSize(14).text("To whom it may concern", { align: "center" });
  doc.moveDown(2);
  doc.moveDown(1); // Extra line break
  doc.font("Helvetica").fontSize(12).text(
    `Mavens Advisor Pvt. Ltd. certifies that the employee whose details are mentioned below is working with us since ${joinDate}.`,
    doc.page.margins.left, undefined, { align: "left" }
  );
  doc.moveDown(2);
  doc.moveDown(1); // Extra line break
  doc.font("Helvetica").text(
    `Name: ${name}\n` +
    `Job: ${designation}\n` +
    `National ID No: ${cnic}\n` +
    `Nationality: ${nationality}\n` +
    `Total Monthly Salary: ${monthlySalary ? monthlySalary.toLocaleString() + " PKR" : "XX,XXX PKR"}`,
    doc.page.margins.left, undefined, { align: "left" }
  );

  // Footer
  doc.moveDown(2);
  doc.moveDown(1); // Extra line break
  doc.font("Helvetica").text(
    "Please feel free to contact the Human Resource Department for any blocks, doubts and notifications.",
    doc.page.margins.left, undefined, { align: "left" }
  );
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text("Best regards,", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text(hrManager.toUpperCase(), doc.page.margins.left, undefined, { align: "left" });
  doc.font("Helvetica").text(hrManagerDesig.toUpperCase(), doc.page.margins.left, undefined, { align: "left" });
  doc.text("+1 (615) 988-0800", doc.page.margins.left, undefined, { align: "left" });
  doc.text("Gulshan e Maymar, Karachi", doc.page.margins.left, undefined, { align: "left" });
  doc.text("HR@mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.text("www.mavensadvisor.com", doc.page.margins.left, undefined, { align: "left" });
  doc.moveDown(6);
}

/* ------------------------------------------------------------------ */
/* 2. PDF GENERATORS                                                 */
/* ------------------------------------------------------------------ */
async function generateNdaPdf(employee) {
  console.log("generateNdaPdf: Input employee data:", employee);
  if (!employee || !employee.name || !employee.cnic) {
    console.error("generateNdaPdf: Invalid employee data - name or CNIC missing", { employee });
    throw new Error("Employee name or CNIC missing for NDA PDF");
  }

  const pdfPath = path.join(UPLOAD_DIR, `nda_${employee._id}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margin: { top: 70, bottom: 70, left: 50, right: 50 },
  });

  doc.pipe(fs.createWriteStream(pdfPath));
  writeNda(doc, employee);
  doc.end();
  
  await waitForFileWrite(pdfPath);
  console.log("generateNdaPdf: PDF generated at:", pdfPath);
  return pdfPath;
}

async function generateSalaryCertificatePdf(employee) {
  console.log("generateSalaryCertificatePdf: Input employee data:", employee);
  if (!employee || !employee.name || !employee.cnic) {
    console.error("generateSalaryCertificatePdf: Invalid employee data - name or CNIC missing", { employee });
    throw new Error("Employee name or CNIC missing for Salary Certificate PDF");
  }

  const slip = await Salaries.findOne({ employee: employee._id })
    .sort({ updatedAt: -1 })
    .lean();

  let monthlySalary = "0";
  if (slip?.grossSalary) {
    try {
      monthlySalary = await decrypt(slip.grossSalary);
      console.log("generateSalaryCertificatePdf: Decrypted monthlySalary:", monthlySalary);
    } catch (e) {
      console.error("generateSalaryCertificatePdf: Decryption failed:", e.message);
      monthlySalary = "0";
    }
  } else if (employee.compensation?.grossSalary) {
    try {
      monthlySalary = await decrypt(employee.compensation.grossSalary);
      console.log("generateSalaryCertificatePdf: Decrypted monthlySalary from compensation:", monthlySalary);
    } catch (e) {
      console.error("generateSalaryCertificatePdf: Decryption failed for compensation:", e.message);
      monthlySalary = "0";
    }
  }

  const now = new Date();
  const issueDate = now.toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" });
  const joinDate = employee.joiningDate
    ? new Date(employee.joiningDate).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })
    : "-";

  const pdfPath = path.join(UPLOAD_DIR, `salary_certificate_${employee._id}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margin: { top: 70, bottom: 70, left: 50, right: 50 },
  });

  doc.pipe(fs.createWriteStream(pdfPath));
  await writeSalaryCertificate(doc, employee, issueDate, joinDate, monthlySalary);
  doc.end();
  await waitForFileWrite(pdfPath);
  console.log("generateSalaryCertificatePdf: PDF generated at:", pdfPath);
  return pdfPath;
}

async function generateContractPdf(employee, key = null) {
  console.log("generateContractPdf: Input employee data:", employee);
  if (!employee || !employee.name || !employee.cnic) {
    console.error("generateContractPdf: Invalid employee data - name or CNIC missing", { employee });
    throw new Error("Employee name or CNIC missing for Contract PDF");
  }

  const slip = await Salaries.findOne({ employee: employee._id })
    .sort({ updatedAt: -1 })
    .lean();

  const pdfPath = path.join(UPLOAD_DIR, `contract_${employee._id}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margin: { top: 70, bottom: 70, left: 50, right: 50 },
  });

  doc.pipe(fs.createWriteStream(pdfPath));
  await writeContract(doc, employee, slip, key);
  doc.end();
  await waitForFileWrite(pdfPath);
  console.log("generateContractPdf: PDF generated at:", pdfPath);
  return pdfPath;
}

/* ------------------------------------------------------------------ */
/* 3. UTILITIES                                                      */
/* ------------------------------------------------------------------ */
async function waitForFileWrite(filepath, timeout = 3000) {
  const started = Date.now();
  while (!fs.existsSync(filepath)) {
    await new Promise(r => setTimeout(r, 100));
    if (Date.now() - started > timeout) break;
  }
  return fs.existsSync(filepath);
}

/* ------------------------------------------------------------------ */
/* 4. ROUTES                                                         */
/* ------------------------------------------------------------------ */
router.get("/nda/:employeeId", async (req, res) => {
  try {
    console.log("GET /nda/:employeeId: Fetching employee with ID:", req.params.employeeId);
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) {
      console.error("GET /nda/:employeeId: Employee not found for ID:", req.params.employeeId);
      return res.status(404).json({ message: "Employee not found" });
    }
    if (!emp.name || !emp.cnic) {
      console.error("GET /nda/:employeeId: Employee name or CNIC missing", { employeeId: req.params.employeeId, emp });
      return res.status(400).json({ message: "Employee name or CNIC is missing" });
    }
    if (typeof emp.name !== "string" || typeof emp.cnic !== "string") {
      console.error("GET /nda/:employeeId: Invalid data types", { name: typeof emp.name, cnic: typeof emp.cnic });
      return res.status(400).json({ message: "Employee name or CNIC has invalid data type" });
    }
    console.log("GET /nda/:employeeId: Employee data fetched:", { name: emp.name, cnic: emp.cnic });

    let ndaPath = emp.ndaPath;
    if (!ndaPath || !fs.existsSync(ndaPath)) {
      console.log("GET /nda/:employeeId: Generating new NDA PDF for employee:", emp._id);
      ndaPath = await generateNdaPdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { ndaPath } });
      console.log("GET /nda/:employeeId: NDA path saved to employee:", ndaPath);
    }
    
    if (!fs.existsSync(ndaPath)) {
      console.error("GET /nda/:employeeId: Failed to generate NDA at path:", ndaPath);
      return res.status(500).json({ message: "Failed to generate NDA" });
    }

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=NDA_${emp.name || "Unknown"}.pdf`);
    console.log("GET /nda/:employeeId: Sending NDA PDF:", ndaPath);
    res.sendFile(path.resolve(ndaPath));
  } catch (err) {
    console.error("GET /nda/:employeeId: Error generating NDA:", err.message, { employeeId: req.params.employeeId });
    res.status(500).json({ message: `Failed to generate NDA: ${err.message}` });
  }
});

router.get("/contract/:employeeId", async (req, res) => {
  try {
    console.log("GET /contract/:employeeId: Fetching employee with ID:", req.params.employeeId);
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) {
      console.error("GET /contract/:employeeId: Employee not found for ID:", req.params.employeeId);
      return res.status(404).json({ message: "Employee not found" });
    }
    if (!emp.name || !emp.cnic) {
      console.error("GET /contract/:employeeId: Employee name or CNIC missing", { employeeId: req.params.employeeId, emp });
      return res.status(400).json({ message: "Employee name or CNIC is missing" });
    }
    console.log("GET /contract/:employeeId: Employee data fetched:", { name: emp.name, cnic: emp.cnic });

    let contractPath = emp.contractPath;
    if (!contractPath || !fs.existsSync(contractPath)) {
      console.log("GET /contract/:employeeId: Generating new contract PDF for employee:", emp._id);
      contractPath = await generateContractPdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { contractPath } });
      console.log("GET /contract/:employeeId: Contract path saved to employee:", contractPath);
    }
    if (!fs.existsSync(contractPath)) {
      console.error("GET /contract/:employeeId: Failed to generate contract at path:", contractPath);
      return res.status(500).json({ message: "Failed to generate contract" });
    }

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=Contract_${emp.name || "Unknown"}.pdf`);
    console.log("GET /contract/:employeeId: Sending contract PDF:", contractPath);
    res.sendFile(path.resolve(contractPath));
  } catch (err) {
    console.error("GET /contract/:employeeId: Error generating contract:", err.message, { employeeId: req.params.employeeId });
    res.status(500).json({ message: `Failed to generate contract: ${err.message}` });
  }
});

router.post("/contract/:employeeId", async (req, res) => {
  const { key } = req.body;
  if (!key) {
    console.error("POST /contract/:employeeId: Decryption key missing");
    return res.status(400).json({ message: "Decryption key is required" });
  }

  try {
    console.log("POST /contract/:employeeId: Fetching employee with ID:", req.params.employeeId, "with key:", key);
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) {
      console.error("POST /contract/:employeeId: Employee not found for ID:", req.params.employeeId);
      return res.status(404).json({ message: "Employee not found" });
    }
    if (!emp.name || !emp.cnic) {
      console.error("POST /contract/:employeeId: Employee name or CNIC missing", { employeeId: req.params.employeeId, emp });
      return res.status(400).json({ message: "Employee name or CNIC is missing" });
    }
    console.log("POST /contract/:employeeId: Employee data fetched:", { name: emp.name, cnic: emp.cnic });

    console.log("POST /contract/:employeeId: Generating contract PDF with key for employee:", emp._id);
    const contractPath = await generateContractPdf(emp, key);
    await Employee.updateOne({ _id: req.params.employeeId }, { $set: { contractPath } });
    console.log("POST /contract/:employeeId: Contract path saved to employee:", contractPath);

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=Contract_${emp.name || "Unknown"}.pdf`);
    console.log("POST /contract/:employeeId: Sending contract PDF:", contractPath);
    res.sendFile(path.resolve(contractPath));
  } catch (err) {
    console.error("POST /contract/:employeeId: Error generating contract:", err.message, { employeeId: req.params.employeeId });
    res.status(400).json({ message: err.message || "Failed to generate contract" });
  }
});

router.get("/salary-certificate/:employeeId", async (req, res) => {
  try {
    console.log("GET /salary-certificate/:employeeId: Fetching employee with ID:", req.params.employeeId);
    const emp = await Employee.findById(req.params.employeeId).lean();
    if (!emp) {
      console.error("GET /salary-certificate/:employeeId: Employee not found for ID:", req.params.employeeId);
      return res.status(404).json({ message: "Employee not found" });
    }
    if (!emp.name || !emp.cnic) {
      console.error("GET /salary-certificate/:employeeId: Employee name or CNIC missing", { employeeId: req.params.employeeId, emp });
      return res.status(400).json({ message: "Employee name or CNIC is missing" });
    }
    console.log("GET /salary-certificate/:employeeId: Employee data fetched:", { name: emp.name, cnic: emp.cnic });

    let certPath = emp.salaryCertificatePath;
    if (!certPath || !fs.existsSync(certPath)) {
      console.log("GET /salary-certificate/:employeeId: Generating new salary certificate PDF for employee:", emp._id);
      certPath = await generateSalaryCertificatePdf(emp);
      await Employee.updateOne({ _id: req.params.employeeId }, { $set: { salaryCertificatePath: certPath } });
      console.log("GET /salary-certificate/:employeeId: Salary certificate path saved to employee:", certPath);
    }
    if (!fs.existsSync(certPath)) {
      console.error("GET /salary-certificate/:employeeId: Failed to generate salary certificate at path:", certPath);
      return res.status(500).json({ message: "Failed to generate salary certificate" });
    }

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename=SalaryCertificate_${emp.name || "Unknown"}.pdf`);
    console.log("GET /salary-certificate/:employeeId: Sending salary certificate PDF:", certPath);
    res.sendFile(path.resolve(certPath));
  } catch (err) {
    console.error("GET /salary-certificate/:employeeId: Error generating salary certificate:", err.message, { employeeId: req.params.employeeId });
    res.status(500).json({ message: `Failed to generate salary certificate: ${err.message}` });
  }
});

module.exports = router;