// One-off backfill: give every company its system groups.
//
//   company group    — one per org, holding every ACTIVE employee.
//   department group — one per department that has at least one active
//                      employee, holding that department's active employees.
//
// Owner/admins of each group = the org's active `isAdmin` employees. From here
// on the groups keep themselves up to date: the Employee model syncs an
// employee into them whenever they become active or change department
// (src/services/systemGroupService.js), so this script is only needed for
// companies that were already running before the feature existed.
//
// Additive only — an existing group just gains the members it is missing, so
// the script is safe to re-run.
//
// Run from backend/:  node backfill-system-groups.js
//        preview it:  node backfill-system-groups.js --dry
const mongoose = require("mongoose");
require("dotenv").config();

const Employee = require("./src/models/Employees");
// Register schemas referenced by name in populate() calls.
require("./src/models/Users");
const CompanyProfile = require("./src/models/CompanyProfile");
const Department = require("./src/models/Departments");
const { Space } = require("./src/models/Chat");
const {
  syncSystemGroupsForOwner,
  departmentKey,
  COMPANY_KEY,
} = require("./src/services/systemGroupService");

const DRY = process.argv.includes("--dry");

/** Report what a real run would create/join, touching nothing. */
async function preview(ownerId) {
  const employees = await Employee.find({ owner: ownerId, status: "active" })
    .select("_id department")
    .lean();
  const profile = await CompanyProfile.findOne({ owner: ownerId })
    .select("name")
    .lean();
  const admins = await Employee.find({
    owner: ownerId,
    status: "active",
    isAdmin: true,
  })
    .select("_id name")
    .lean();

  // Same set the real run builds: every Department record, plus any name typed
  // straight onto an employee.
  const records = await Department.find({ owner: ownerId }).select("name").lean();
  const byDepartment = new Map();
  const remember = (rawName, counts) => {
    const name = String(rawName || "").trim();
    if (!name) return;
    const key = departmentKey(name);
    if (!byDepartment.has(key)) byDepartment.set(key, { name, count: 0 });
    if (counts) byDepartment.get(key).count++;
  };
  records.forEach((record) => remember(record.name, false));
  employees.forEach((employee) => remember(employee.department, true));

  const existing = await Space.find({ "systemGroup.owner": ownerId })
    .select("name systemGroup.role systemGroup.key members")
    .lean();
  const existingKeys = new Set(
    existing.map((s) => `${s.systemGroup?.role}:${s.systemGroup?.key}`)
  );

  console.log(`\n${ownerId} — ${profile?.name || "(no company profile)"}`);
  console.log(`  active employees: ${employees.length}`);
  console.log(
    `  group owner/admins: ${
      admins.map((a) => a.name).join(", ") || "(none — falls back to an employee)"
    }`
  );
  console.log(
    `  company group "${profile?.name || "Company"}" (${employees.length} member(s)) — ${
      existingKeys.has(`company:${COMPANY_KEY}`) ? "exists, tops up" : "WOULD CREATE"
    }`
  );
  byDepartment.forEach(({ name, count }, key) => {
    console.log(
      `  department group "${name}" (${count} member(s)) — ${
        existingKeys.has(`department:${key}`) ? "exists, tops up" : "WOULD CREATE"
      }`
    );
  });
  const noDepartment = employees.filter((e) => !String(e.department || "").trim());
  if (noDepartment.length > 0) {
    console.log(
      `  ${noDepartment.length} active employee(s) have no department — company group only`
    );
  }
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log(`Connected to MongoDB${DRY ? " (dry run — nothing is written)" : ""}`);

  const owners = await Employee.distinct("owner", { status: "active" });
  console.log(`Found ${owners.length} company/companies with active staff`);

  if (DRY) {
    for (const ownerId of owners) await preview(ownerId);
    await mongoose.disconnect();
    console.log("\nDry run complete — re-run without --dry to apply.");
    return;
  }

  let companyGroups = 0;
  let departmentGroups = 0;
  let failed = 0;

  for (const ownerId of owners) {
    try {
      const { company, departments } = await syncSystemGroupsForOwner({
        ownerId,
      });
      if (company) companyGroups++;
      departmentGroups += departments.length;
      console.log(
        `✔ ${ownerId}: company group ${
          company ? `"${company.name}" (${company.members.length} member(s))` : "—"
        }, ${departments.length} department group(s): ` +
          departments.map((d) => `${d.name}[${d.members.length}]`).join(", ")
      );
    } catch (error) {
      failed++;
      console.error(`✖ ${ownerId}:`, error.message);
    }
  }

  console.log(
    `\nDone. Company groups: ${companyGroups}, department groups: ${departmentGroups}, failed: ${failed}`
  );
  await mongoose.disconnect();
  console.log("Disconnected");
}

run().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
