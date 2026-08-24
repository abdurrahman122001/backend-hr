/**
 * backfill-owner-scoping.js
 *
 * Makes TaxConfig, PFSetting and AttendanceFlag company-scoped.
 *
 * Until now these three collections had no `owner` field, so every company on
 * the platform shared the same rows. The schemas now require `owner`, which
 * means THIS SCRIPT MUST RUN BEFORE (or together with) the deploy that ships
 * the new models — otherwise writes to these collections will fail validation
 * and reads will return nothing.
 *
 * What it does, per collection:
 *
 *   TaxConfig      Fans each shared config out into one copy per company. A
 *                  company's copy has autoApplyEnabled only if that company was
 *                  listed in the shared row's `autoEnabledOwners`, so current
 *                  behaviour is preserved exactly. Also drops the old global
 *                  `fiscalYear_1` unique index — removing `unique: true` from
 *                  the schema does NOT remove the index from MongoDB, and while
 *                  it exists a second company still cannot create the same
 *                  fiscal year.
 *
 *   PFSetting      Fans out the single most recent shared row to every company
 *                  (it is read "latest row wins"), then removes the originals.
 *
 *   AttendanceFlag Fans each shared flag out to every company.
 *
 * Usage:
 *   node migrations/backfill-owner-scoping.js --dry-run     # report only, no writes
 *   node migrations/backfill-owner-scoping.js --apply       # perform the migration
 *
 * Safety:
 *   - Refuses to run without an explicit --dry-run or --apply flag.
 *   - Reads MONGODB_URI from the environment. No connection string is embedded.
 *   - Take a database backup before running with --apply. This script copies and
 *     deletes documents; there is no undo.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const TaxConfig = require("../src/models/TaxConfig");
const PFSetting = require("../src/models/PFSetting");
const AttendanceFlag = require("../src/models/AttendanceFlag");
const User = require("../src/models/Users");
const Employee = require("../src/models/Employees");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const APPLY = args.includes("--apply");

if (DRY_RUN === APPLY) {
  console.error("Pass exactly one of --dry-run or --apply.");
  process.exit(1);
}

const log = (...a) => console.log(DRY_RUN ? "[dry-run]" : "[apply]", ...a);

/**
 * Every distinct company id on the platform. Owners are the roots of the tenant
 * tree, so we take them from both collections that can carry one.
 */
async function findAllOwnerIds() {
  const [userOwners, employeeOwners, adminUsers] = await Promise.all([
    User.distinct("owner", { owner: { $ne: null } }),
    Employee.distinct("owner", { owner: { $ne: null } }),
    User.find({ role: { $in: ["admin", "super-admin"] } }).select("_id").lean(),
  ]);

  const ids = new Map();
  for (const list of [userOwners, employeeOwners, adminUsers.map((u) => u._id)]) {
    for (const raw of list) {
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (id) ids.set(String(id), id);
    }
  }
  return [...ids.values()];
}

async function migrateTaxConfig(owners) {
  const shared = await TaxConfig.find({ owner: { $exists: false } }).lean();
  log(`TaxConfig: ${shared.length} shared row(s) to fan out across ${owners.length} company/companies`);

  for (const cfg of shared) {
    const enabledFor = new Set((cfg.autoEnabledOwners || []).map(String));

    for (const owner of owners) {
      const wasEnabled = enabledFor.has(String(owner));
      const copy = {
        ...cfg,
        owner,
        // Preserve current behaviour: auto-tax stays on only for the companies
        // that had actually switched it on.
        autoApplyEnabled: !!cfg.autoApplyEnabled && wasEnabled,
        autoEnabledOwners: wasEnabled ? [owner] : [],
      };
      delete copy._id;

      log(`  ${cfg.fiscalYear} -> owner ${owner} (autoApplyEnabled=${copy.autoApplyEnabled})`);
      if (APPLY) {
        await TaxConfig.updateOne(
          { owner, fiscalYear: cfg.fiscalYear },
          { $setOnInsert: copy },
          { upsert: true }
        );
      }
    }

    log(`  removing shared row ${cfg._id}`);
    if (APPLY) await TaxConfig.deleteOne({ _id: cfg._id });
  }

  // The schema no longer declares `unique` on fiscalYear, but the index built by
  // the previous schema still exists in MongoDB and still enforces global
  // uniqueness. Drop it explicitly.
  if (APPLY) {
    try {
      await TaxConfig.collection.dropIndex("fiscalYear_1");
      log("TaxConfig: dropped legacy global index fiscalYear_1");
    } catch (err) {
      if (err.codeName === "IndexNotFound") {
        log("TaxConfig: legacy index fiscalYear_1 already absent");
      } else {
        throw err;
      }
    }
    await TaxConfig.syncIndexes();
    log("TaxConfig: indexes synced (owner+fiscalYear unique)");
  } else {
    log("TaxConfig: would drop legacy index fiscalYear_1 and sync indexes");
  }
}

async function migratePFSetting(owners) {
  // PF is read as "the most recently updated row", so only that row is live.
  const latest = await PFSetting.findOne({ owner: { $exists: false } })
    .sort({ updatedAt: -1 })
    .lean();

  if (!latest) {
    log("PFSetting: no shared rows, nothing to do");
    return;
  }

  log(`PFSetting: seeding every company from the shared row (pfRate=${latest.pfRate}, years=${latest.years})`);
  for (const owner of owners) {
    log(`  -> owner ${owner}`);
    if (APPLY) {
      const exists = await PFSetting.findOne({ owner }).lean();
      if (!exists) {
        await PFSetting.create({
          owner,
          pfRate: latest.pfRate,
          years: latest.years,
          updatedBy: latest.updatedBy,
        });
      }
    }
  }

  const staleCount = await PFSetting.countDocuments({ owner: { $exists: false } });
  log(`PFSetting: removing ${staleCount} shared row(s)`);
  if (APPLY) await PFSetting.deleteMany({ owner: { $exists: false } });
}

async function migrateAttendanceFlag(owners) {
  const shared = await AttendanceFlag.find({ owner: { $exists: false } }).lean();
  log(`AttendanceFlag: ${shared.length} shared flag(s) to fan out`);

  for (const flag of shared) {
    for (const owner of owners) {
      const copy = { ...flag, owner };
      delete copy._id;
      if (APPLY) await AttendanceFlag.create(copy);
    }
    if (APPLY) await AttendanceFlag.deleteOne({ _id: flag._id });
  }
  if (shared.length) log(`AttendanceFlag: fanned out to ${owners.length} company/companies`);
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to run.");
    process.exit(1);
  }
  if (APPLY && process.env.NODE_ENV === "production") {
    console.error(
      "NODE_ENV=production. Take a verified backup, then re-run with NODE_ENV unset to confirm you intend this."
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  log("connected");

  try {
    const owners = await findAllOwnerIds();
    if (!owners.length) {
      console.error("No company owners found — aborting rather than guessing.");
      process.exit(1);
    }
    log(`found ${owners.length} company/companies`);

    await migrateTaxConfig(owners);
    await migratePFSetting(owners);
    await migrateAttendanceFlag(owners);

    log("done");
    if (DRY_RUN) log("no changes were written — re-run with --apply to perform them");
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
