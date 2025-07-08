const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const SalarySlip = require("../models/SalarySlip");
const CompanyProfile = require("../models/CompanyProfile");
/** Helper: PDF Buffer from writerFn */
function pdfBufferFrom(writerFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    writerFn(doc);
    doc.end();
  });
}

/** NDA Content Writer */
function writeNda(doc, emp) {
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString("default", { month: "long" });
  const year = now.getFullYear();

  const ndaText = `
CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT

THIS AGREEMENT made as of the ${day} ${month} ${year},

BETWEEN

“Mavens Advisor Pvt. Ltd.”

- And –

“${emp.name}, bearing CNIC: ${emp.cnic}”

WHEREAS the parties to this Agreement wish to exchange certain confidential and proprietary information for the purpose of entering into discussions regarding a potential business relationship.

For the purposes of this Agreement:

“Confidential Information” includes, but is not limited to, any information, “know-how” data, patent, copyright, trade secret, process, technique, program, design, formula, marketing, advertising, financial, commercial, sales or programming data, written materials, compositions, drawings, diagrams, computer or software programs, studies, work in progress, visual demonstrations, business plans, budgets, forecasts, customer data, ideas, concepts, characters, story outlines and other data, in oral, written, graphic, electronic, or any other form or medium whatsoever, which may be exchanged between the parties in pursuance of the Purpose or otherwise.

"Owner" means the party hereto which possesses the intellectual property rights or other proprietary rights in and to an item of Confidential Information, as the context requires, and includes, without limitation, an owner, possessor, developer and licensee of such Confidential Information.

"Recipient" means the party hereto who receives or is otherwise privy to, or comes into possession of, an item of Confidential Information of which it is not the Owner.

All Confidential Information constitutes the sole and exclusive property and the Confidential Information of the Owner, which the Owner is entitled to protect. Recipient shall only use the Confidential Information strictly for the Purpose. Recipient shall hold and maintain all Confidential Information of the Owner in trust and confidence for the Owner and shall use commercially reasonable efforts to protect the Confidential Information from any harm, tampering, unauthorized access, sabotage, exploitation, manipulation, modification, interference, misuse, misappropriation, copying or disclosure.

Recipient shall not, without the prior written consent of the Owner, disclose any Confidential Information to any person or entity other than:

1. To such of its employees, officers, directors, contractors, agents and professional advisors, as applicable, and in such event only to the extent necessary for the Purpose and provided that Recipient shall, prior to disclosing the Confidential Information to such persons, issue appropriate instructions to them to satisfy its obligations herein and obtain their agreement to receive and use the Confidential Information on a confidential basis on the same conditions as contained in this Agreement;
2. As required pursuant to any law, court order or other legal compulsion, provided that, prior to such disclosure, Recipient shall first notify Owner in writing of such disclosure requirement and assist the Owner in protecting such Confidential Information from disclosure.

The Recipient shall be fully responsible to ensure that each of its employees, officers, directors, contractors, agents and professional advisors that receive the Confidential Information from the Recipient, handles the Confidential Information as required by this Agreement, and Recipient shall be liable for any loss or damage resulting from any failure to do so. The Recipient shall notify the Owner promptly of any unauthorized use, disclosure or possession of the Confidential Information that comes to the Recipient’s attention.

The Confidential Information shall not be copied, reproduced in any form or stored in a retrieval system or database by the Recipient without prior written consent of the Owner, except for such copies and storage as may reasonably be required internally by Recipient for the Purpose.

Upon request of the Owner, Recipient shall immediately return to the Owner all Confidential Information, including all records, summaries, analyses, notes or other documents and all copies thereof, in any form whatsoever, under the power or control of the Recipient and destroy the Confidential Information from all retrieval systems and databases. The return of such documents to the Owner shall in no event relieve the Recipient of its obligations of confidentiality set out in this Agreement with respect to such returned Confidential Information.

In the event that the business relationship contemplated by this Agreement does not occur, neither party will use or permit the use of any of the Confidential Information of which it is the Recipient for its own benefit, nor for the benefit of any third party or for any other purpose than the Purpose defined herein. Regardless of whether the business relationship contemplated by this Agreement occurs, the rights and obligations set out in this agreement shall survive from the date of this Agreement and continue for a period of TEN years.

Neither this Agreement nor the disclosure of any Confidential Information to Recipient shall be construed as granting to Recipient any rights in, to or in respect of the Confidential Information.

The provisions hereof are necessary to protect the trade, commercial and financial interests of the parties. The parties acknowledge and agree that any breach whatsoever of the covenants, provisions and restrictions herein contained by either party shall constitute a breach of that party's obligations to the other party which may cause serious damage and injury to the non-breaching party which cannot be fully or adequately compensated by monetary damages. The parties accordingly agree that in addition to claiming damages, either party not in breach of this Agreement may seek interim and permanent equitable relief, including without limitation interim, interlocutory and permanent injunctive relief, in the event of any breach of this Agreement. All such rights and remedies shall be cumulative and in addition to any and all other rights and remedies whatsoever to which either party may be entitled.

The parties agree that the execution of this Agreement does not in any way constitute a partnership or joint venture or binding commitment on the part of either party to enter into or complete negotiations or any transaction with the other party.

This Agreement constitutes the entire agreement between the parties hereto with respect to the subject matter hereof and supersedes and overrides any prior or other agreements, representations, warranties, understandings and explanations between the parties hereto with respect to the subject matter of this Agreement.

This Agreement shall be binding upon the trustees, receiver, heirs, executors, administrators, successors and assigns of the parties.

This Agreement shall be exclusively governed by, and construed in accordance with, the laws of the province of Sindh and the laws of Pakistan applicable therein. The parties hereby submit to the exclusive jurisdiction of the courts of the province of Sindh.

The invalidity or unenforceability of any provision or part thereof of this Agreement shall not affect the validity or enforceability of any other provision and such invalid or unenforceable provision shall be deemed severed from the remaining provisions herein and such remaining provisions shall continue in full force and effect.

No waiver of any breach of any provision of this Agreement will be effective or binding unless in writing and signed by the party purporting to give the same and will be limited to the specific breach waived unless otherwise provided in the written waiver.

The Receiving Party affirms that the individual(s) executing this Agreement has the authority to bind the Receiving Party to the terms hereof.

The Parties acknowledge and agree that each and every term of this Agreement is of the essence. If any one or more of the provisions contained in this Agreement should be declared invalid, illegal or unenforceable in any respect, the validity, legality and enforceability of the remaining provisions contained in this Agreement shall not in any way be affected or impaired thereby so long as the commercial, economic and legal substance of the transaction contemplated hereby are not affected in any manner materially adverse to any party. Upon such a declaration, the parties shall modify this Agreement so as to carry out the original intent of the parties as closely as possible in an acceptable manner so that the purposes contemplated hereby are consummated as originally contemplated to the fullest extent possible.

This Agreement will be effective as of the Effective Date, but will apply to any Confidential Information disclosed to the Receiving Party by Company prior to such date.

As to subsequent disclosures of Confidential Information, on the later of five (5) years from and after the Effective Date or five (5) years from the expiry or termination of any other agreement between the parties related to the supply of goods and/or services in relation to the Permitted Purpose;

As to any Confidential Information disclosed prior to the date of any termination under subsection (a) above, for a further period of five (5) years from and after such date; provided that this Agreement shall continue in full force and effect with respect to any Trade Secret for such additional period as such information remains a Trade Secret.

An electronic copy or facsimile of a party’s signature shall be binding upon the signatory with the same force and effect as an original signature.

SIGNED:

______________________________          ______________________________
${emp.name}                                     On behalf of Mavens Advisor Pvt. Ltd.
CNIC: ${emp.cnic}                                          Authorized Representative
`;
  doc.font("Times-Roman").fontSize(12).text(ndaText, { lineGap: 4 });
}



/** Contract Content Writer */
function writeContract(doc, emp, slip) {
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString("default", { month: "long" });
  const year = now.getFullYear();

  // fetch values from slip or fallback
  const gross = slip?.grossSalary ?? 0;
  const conveyance = slip?.conveyanceAllowance ?? 0;
  const probation = emp.probationMonths ?? 3;

 const contractText = `
EMPLOYMENT CONTRACT: PRIVATE AND CONFIDENTIAL

Date: ${day} ${month} ${year}

Dear ${emp.name},

We are pleased to offer you employment with Mavens Advisor Pvt. Ltd. (hereon referred to as the "Company") in the position of “${emp.position}” on the following terms and conditions:

Your monthly salary and allowances payable monthly in arrear will be:
Basic Compensation
Rs. ${gross.toLocaleString()}
Conveyance Allowance
Rs. ${conveyance.toLocaleString()}

${emp.name}, bearing CNIC number ${emp.cnic}

After your probation period of ${emp.probationMonths || 3} months your performance will be evaluated on the basis of your monthly targets and Key Performance Indicators and the continuity of your employment with us dependent on those evaluations.

You hereby authorize the Company to deduct from your salary or any other sum due to you, any sums which you may owe the Company including, without limitation, any overpayments or loans made to you by the Company. This is without prejudice to any other remedies that the Company may have against you in respect of such sums.

Your employment may be terminated, without assigning any reason, either by you giving the Company 30 days notice in writing or by the Company giving you 30 days notice in writing or on payment by either side one month's salary in lieu of notice. Provided, however, that in the event the termination of your services is due to misconduct, of which the Company shall be the sole judge, no notice by the Company will be required to be given and no salary in lieu of notice will be payable.

The Company reserves the right to pay you in lieu of part or all of your notice period, or require that during the notice period you do not attend the Company's premises or/and carry out your day-to-day duties (and remain at home on "garden leave"). During any garden leave period you shall be entitled to your salary and benefits in the usual manner.

Your continuing employment is subject to the satisfactory completion of an initial probationary period of three months, during which the Company will have the opportunity to assess your work performance. If the Company considers that your performance has not been satisfactory, it may either terminate your employment immediately without notice or extend your probationary period by up to a further three months. At the end of the probation period, we will either confirm your employment or otherwise.

Your employment with the Company is at all times conditional upon your promptly producing references to the satisfaction of the Company and the Company determining that the outcome of any background checks which the Company may conduct, are to its satisfaction.

You agree to be bound by the Company's rules, regulations and policies as amended, modified or adopted from time to time.

Working Hours:
Working days in the Company will be 6 days a week (total 54 working hours in a week) i.e. from Monday to Saturday. Office hours will be from 03:00 pm to 12:00 am without any break for lunch. However, these working days/ timings may be varied for different staff members with mutual agreement based upon his/her types of responsibilities.
Sunday is normally a full holiday, however as per the workload, the management of Mavens Advisor may call you on holidays.

During your employment you will not be employed, engaged, interested or concerned in any activity, office or outside business interests (whether paid or unpaid) without the written consent of the CEO. You will disclose in writing to the Company any such activities, offices or outside business interests you may currently have and in the event that the Company requires you to cease the same, you will do so forthwith. For the avoidance of doubt consent will not be given in relation to any activities, offices or business interests which in the view of the Company, are similar to, or compete directly or indirectly with the business of the Company or which could in the view of the Company, give rise to a conflict of interest or interfere with the efficient performance of your duties.

Confidentiality:
Except in the proper performance of your duties or as required in law, you may not (and undertake that you will not), during or after your employment, disclose or otherwise make use of (and shall use your best endeavors to prevent the publication or disclosure of) any trade secrets or other confidential information of or relating to the Company or any Associated Entities or any user of the Company's services or any company, organization or business with which the Company is involved in any kind of business venture or partnership or any information concerning the business of the Company or any Associated Entity or in respect of which the Company owes an obligation of confidence to any third party.
You must not at any time remove from the Company's premises any documents or items which belong to the Company or which contain any Confidential Information without proper advance authorization from the administrator.
You must return to the Company upon request and, in any event, upon the termination of your employment, all documents, records and other papers (including copies and extracts), items and other property of whatsoever nature which belong to the Company or which contain or refer to any confidential information and which are in your possession or under your control.

You acknowledge that all Intellectual Property Rights, inventions and all materials embodying them shall automatically belong to the Company to the fullest extent permitted by law.

This letter of employment shall be governed by the laws of Pakistan.

You are not allowed to be involved in any business activity, whether it is as a buyer, supplier or employee/employer with a company that is in the same business as for the duration of your employment.

By signing this agreement, you are endorsing the fact that you will work for the Company for at least ONE year in the current capacity and will not resign from the current or seek any other kind of employment opportunity during this period.

AS WITNESS the hands of the parties hereto or their duly authorized representatives.

SIGNED by _____________________________; On behalf of Mavens Advisor Pvt. Ltd.

I, the undersigned, confirm my agreement to and acceptance of the above terms and conditions.

SIGNED by:

________________________
${emp.name}
`;
  doc.font("Times-Roman").fontSize(12).text(contractText, { lineGap: 4 });
}
function writeSalaryCertificate(doc, emp, slip, company) {
  const now = new Date();
  const issueDay = now.getDate();
  const issueMonth = now.toLocaleString("default", { month: "long" });
  const issueYear = now.getFullYear();

  // Format joining date
  const start = emp.startDate ? new Date(emp.startDate) : null;
  let joinStr = "____";
  if (start) {
    const day = String(start.getDate()).padStart(2, "0");
    const month = start.toLocaleString("default", { month: "long" });
    const year = start.getFullYear();
    joinStr = `${month} ${day}, ${year}`;
  }

  const salary = slip?.grossSalary ?? 0;

  const certText = `
To whom it may concern

${company?.name || "Mavens Advisor Pvt. Ltd."} certifies that the employee whose details are mentioned below is working with us since ${joinStr}.

Name: ${emp.name}
Job: ${emp.position || emp.designation || ""}
National ID No: ${emp.cnic}
Nationality: Pakistani
Total of Monthly Salary: ${salary.toLocaleString()} PKR

Please feel free to contact the Human Resource Department for any further details, doubts and notifications.

Best regards,
${company?.hrManager || "HR MANAGER"}
${company?.name || "Mavens Advisor Pvt. Ltd."}
${issueMonth} ${issueDay}, ${issueYear}
  `;
  doc.font("Times-Roman").fontSize(12).text(certText, { lineGap: 4 });
}



/** Generate and Save NDA for Employee */
async function generateAndSaveNda(emp) {
  if (!emp.name || !emp.cnic) return null;
  const ndaDir = path.join(__dirname, "../ndas");
  if (!fs.existsSync(ndaDir)) fs.mkdirSync(ndaDir);
  const ndaPath = path.join(ndaDir, `${emp._id}.pdf`);
  if (!fs.existsSync(ndaPath)) {
    const buffer = await pdfBufferFrom((doc) => writeNda(doc, emp));
    fs.writeFileSync(ndaPath, buffer);
  }
  return ndaPath;
}

/** Generate and Save Contract for Employee */
async function generateAndSaveContract(emp) {
  if (!emp.name || !emp.cnic) return null;
  const contractDir = path.join(__dirname, "../contracts");
  if (!fs.existsSync(contractDir)) fs.mkdirSync(contractDir);
  const contractPath = path.join(contractDir, `${emp._id}.pdf`);
  if (!fs.existsSync(contractPath)) {
    const slip = await SalarySlip.findOne({ employee: emp._id }).sort({ updatedAt: -1 }).lean();
    const buffer = await pdfBufferFrom((doc) => writeContract(doc, emp, slip));
    fs.writeFileSync(contractPath, buffer);
  }
  return contractPath;
}
async function generateAndSaveSalaryCertificate(emp) {
  if (!emp.name || !emp.cnic) return null;
  const certDir = path.join(__dirname, "../salary_certificates");
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);
  const certPath = path.join(certDir, `${emp._id}.pdf`);
  if (!fs.existsSync(certPath)) {
    // Fetch the latest SalarySlip and CompanyProfile (using owner from employee or slip)
    const slip = await SalarySlip.findOne({ employee: emp._id }).sort({ updatedAt: -1 }).lean();
    // Try to get the owner from the employee (recommended, ensure employee has 'owner' field)
    let ownerId = emp.owner || (slip ? slip.owner : null);
    if (!ownerId) throw new Error("Owner not found for employee or slip");
    const company = await CompanyProfile.findOne({ owner: ownerId }).lean();
    const buffer = await pdfBufferFrom((doc) => writeSalaryCertificate(doc, emp, slip, company));
    fs.writeFileSync(certPath, buffer);
  }
  return certPath;
}


/** Fetch NDA (return buffer) */
function fetchNdaPdf(employeeId) {
  const ndaPath = path.join(__dirname, "../ndas", `${employeeId}.pdf`);
  if (!fs.existsSync(ndaPath)) return null;
  return fs.readFileSync(ndaPath);
}

/** Fetch Contract (return buffer) */
function fetchContractPdf(employeeId) {
  const contractPath = path.join(__dirname, "../contracts", `${employeeId}.pdf`);
  if (!fs.existsSync(contractPath)) return null;
  return fs.readFileSync(contractPath);
}
function fetchSalaryCertificatePdf(employeeId) {
  const certPath = path.join(__dirname, "../salary_certificates", `${employeeId}.pdf`);
  if (!fs.existsSync(certPath)) return null;
  return fs.readFileSync(certPath);
}
module.exports = {
  generateAndSaveNda,
  generateAndSaveContract,
  generateAndSaveSalaryCertificate,
  fetchNdaPdf,
  fetchContractPdf,
  fetchSalaryCertificatePdf,
};