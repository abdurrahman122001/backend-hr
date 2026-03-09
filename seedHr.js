// migration-ensure-hr-and-backfill-createdBy.js
require("dotenv").config();
const mongoose = require("mongoose");

// IMPORTANT: this must export a Mongoose *model*, not a schema.
// e.g. module.exports = mongoose.model("User", userSchema);
const User = require("./src/models/Users");

// ====== CONFIG ======
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/your_db";

// Fixed ObjectId that MUST be present in createdBy
// (24 hex chars — you asked to force this id)
const CREATED_BY_FIXED_HEX = "6838b0b708e8629ffab534ee";

// HR user credentials (can override via .env)
const HR_EMAIL = process.env.HR_EMAIL || "hr@gmail.com";
const HR_USERNAME = process.env.HR_USERNAME || "primary-hr";
const HR_PASSWORD = process.env.HR_PASSWORD || "Hr123!@#"; // your User model should hash via pre-save

// ====== HELPERS ======
function isValidObjectIdHex(s) {
  return typeof s === "string" && /^[0-9a-fA-F]{24}$/.test(s);
}

/**
 * Ensure the primary HR user exists (auto _id), role='hr', and createdBy is fixed.
 * Finds by email first (unique), then by username.
 */
async function ensureHrUserAutoId(fixedCreatedById) {
  let hrUser =
    (await User.findOne({ email: HR_EMAIL })) ||
    (await User.findOne({ username: HR_USERNAME }));

  if (!hrUser) {
    const doc = new User({
      username: HR_USERNAME,
      email: HR_EMAIL,
      password: HR_PASSWORD, // should be hashed by your model's pre('save')
      role: "hr",
      createdBy: fixedCreatedById,
    });
    await doc.save();
    console.log("✔ Created HR user with auto-generated _id (role=hr, createdBy fixed).");
    return doc;
  }

  let dirty = false;
  if (hrUser.role !== "hr") {
    hrUser.role = "hr";
    dirty = true;
  }
  if (!hrUser.createdBy || String(hrUser.createdBy) !== String(fixedCreatedById)) {
    hrUser.createdBy = fixedCreatedById;
    dirty = true;
  }

  if (dirty) {
    await hrUser.save();
    console.log("✔ Updated existing HR user (role/createdBy corrected).");
  } else {
    console.log("✔ HR user already correct.");
  }
  return hrUser;
}

/**
 * Force createdBy to the fixed id on ALL users.
 * This does a blanket set (overwrites any previous values).
 * If you want to only backfill missing/null, change the filter accordingly.
 */
async function forceCreatedByForAllUsers(fixedCreatedById) {
  const res = await User.updateMany(
    {}, // <- all documents
    { $set: { createdBy: fixedCreatedById } }
  );
  console.log(`✔ Set createdBy fixed for ${res.modifiedCount || 0} user(s).`);
}

async function ensureIndexes() {
  try {
    await User.collection.createIndex({ createdBy: 1 });
    console.log("✔ Ensured index on { createdBy: 1 }");
  } catch (e) {
    // If collection not yet created or index exists, just log
    console.log("ℹ Index ensure note:", e.message);
  }
}

// ====== MAIN ======
(async () => {
  try {
    if (!isValidObjectIdHex(CREATED_BY_FIXED_HEX)) {
      throw new Error(
        `CREATED_BY_FIXED_HEX "${CREATED_BY_FIXED_HEX}" must be a 24-char hex string`
      );
    }
    const FIXED_CREATED_BY = new mongoose.Types.ObjectId(CREATED_BY_FIXED_HEX);

    console.log("Connecting to MongoDB…");
    console.log(
      `→ Using URI host: ${MONGODB_URI.includes("@")
        ? MONGODB_URI.split("@")[1].split("/")[0]
        : MONGODB_URI
      }`
    );
    await mongoose.connect(MONGODB_URI);
    console.log("✔ Connected.");

    // 1) Ensure HR user exists & is normalized
    const hrUser = await ensureHrUserAutoId(FIXED_CREATED_BY);

    // 2) Force createdBy to the fixed id for ALL users (including HR)
    await forceCreatedByForAllUsers(FIXED_CREATED_BY);

    // 3) Ensure helpful index
    await ensureIndexes();

    console.log("🎉 Migration complete.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Migration error:", err);
    if (MONGODB_URI.startsWith("mongodb://localhost")) {
      console.error(
        "Hint: You're connecting to localhost. If you're using Atlas, set MONGODB_URI to your mongodb+srv string."
      );
    }
    process.exit(1);
  }
})();
