const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/auth");
const DecryptionKey = require("../models/DecryptionKey");
const router = express.Router();
const crypto = require("crypto");
const SalarySlip = require("../models/SalarySlip");
const Salary = require("../models/Salaries");
const { encrypt, decrypt, clearCache } = require("../utils/encryption");

// Legacy decryption function for hex-encoded data
function decryptLegacyData(text, key) {
  if (!text) return null;
  try {
    const textParts = text.split(":");
    if (textParts.length < 2)
      throw new Error("Invalid format: missing IV separator");
    const iv = Buffer.from(textParts.shift(), "hex");
    if (iv.length !== 16) throw new Error(`Invalid IV length: ${iv.length}`);
    const encryptedText = textParts.join(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(key),
      iv
    );
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.error(`Legacy decryption error: ${error.message}`);
    return null;
  }
}

// Add or Rotate Key with automatic data re-encryption
router.post("/add", requireAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { key, aesKey, oldPin } = req.body;
    if (!key || !aesKey || aesKey.length !== 32 || !Buffer.isBuffer(Buffer.from(aesKey))) {
      return res
        .status(400)
        .json({ error: "New PIN and valid 32-byte AES key are required." });
    }

    const existingKey = await DecryptionKey.findOne({
      owner: req.user._id,
    }).session(session);

    if (existingKey) {
      // Key rotation flow
      if (!oldPin) {
        return res
          .status(400)
          .json({ error: "Old PIN required to rotate key." });
      }

      const isMatch = await bcrypt.compare(oldPin, existingKey.hash);
      if (!isMatch) {
        return res.status(401).json({ error: "Old PIN is incorrect." });
      }

      // Store the old key and previous key for re-encryption
      const oldKey = existingKey.currentAesKey;
      const previousKey = existingKey.previousAesKey;
      const newKeyVersion = (existingKey.keyVersion || 1) + 1;

      // Update to new key
      existingKey.hash = await bcrypt.hash(key, 10);
      existingKey.previousAesKey = oldKey;
      existingKey.currentAesKey = aesKey;
      existingKey.keyVersion = newKeyVersion;
      existingKey.active = true;

      // Re-encrypt all data with the new key
      await reencryptAllData(
        req.user._id,
        oldKey,
        previousKey,
        aesKey,
        newKeyVersion,
        session
      );

      await existingKey.save({ session });
      await session.commitTransaction();

      // Clear cache after all operations
      clearCache();

      return res.json({
        success: true,
        rotated: true,
        key: {
          _id: existingKey._id,
          keyVersion: existingKey.keyVersion,
          active: existingKey.active,
        },
      });
    } else {
      // First time key creation
      const hash = await bcrypt.hash(key, 10);
      const newKey = await DecryptionKey.create(
        [
          {
            owner: req.user._id,
            hash,
            currentAesKey: aesKey,
            keyVersion: 1,
            active: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      clearCache();

      return res.json({
        success: true,
        created: true,
        key: {
          _id: newKey[0]._id,
          keyVersion: newKey[0].keyVersion,
          active: newKey[0].active,
        },
      });
    }
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
});

// Helper function to re-encrypt all data
async function reencryptAllData(
  userId,
  oldKey,
  previousKey,
  newKey,
  newKeyVersion,
  session
) {
  try {
    // Re-encrypt Salary data
    await reencryptCollection(
      Salary,
      { owner: userId },
      [
        "basic",
        "dearnessAllowance",
        "houseRentAllowance",
        "conveyanceAllowance",
        "medicalAllowance",
        "utilityAllowance",
        "overtimeCompensation",
        "dislocationAllowance",
        "leaveEncashment",
        "bonus",
        "arrears",
        "autoAllowance",
        "incentive",
        "fuelAllowance",
        "othersAllowances",
        "grossSalary",
      ],
      oldKey,
      previousKey,
      newKey,
      newKeyVersion,
      session
    );

    // Re-encrypt SalarySlip data for the specific user
    await reencryptCollection(
      SalarySlip,
      { owner: userId },
      [
        "basic",
        "dearnessAllowance",
        "houseRentAllowance",
        "conveyanceAllowance",
        "medicalAllowance",
        "utilityAllowance",
        "overtimeCompensation",
        "dislocationAllowance",
        "leaveEncashment",
        "bonus",
        "arrears",
        "autoAllowance",
        "incentive",
        "fuelAllowance",
        "othersAllowances",
        "grossSalary",
        "leaveDeductions",
        "lateDeductions",
        "eobiDeduction",
        "sessiDeduction",
        "providentFundDeduction",
        "gratuityFundDeduction",
        "loanDeductions",
        "advanceSalaryDeductions",
        "medicalInsurance",
        "lifeInsurance",
        "penalties",
        "othersDeductions",
        "taxDeduction",
        "totalAllowances",
        "totalDeductions",
        "netPayable",
      ],
      oldKey,
      previousKey,
      newKey,
      newKeyVersion,
      session
    );
  } catch (error) {
    console.error("Error in reencryptAllData:", error);
    throw error;
  }
}

// Re-encrypt collection function
async function reencryptCollection(
  Model,
  query,
  fields,
  oldKey,
  previousKey,
  newKey,
  newKeyVersion,
  session
) {
  const docs = await Model.find(query).session(session);
  const bulkOps = [];

  for (const doc of docs) {
    const update = {};
    let needsUpdate = false;

    for (const field of fields) {
      if (!doc[field]) {
        console.warn(
          `Field ${field} in ${Model.modelName} is empty or undefined`
        );
        continue;
      }

      if (typeof doc[field] !== "string" || !doc[field].includes(":")) {
        console.warn(
          `Field ${field} in ${Model.modelName} does not appear to be encrypted: ${doc[field]}`
        );
        continue;
      }

      let decrypted = null;

      // Try decrypting with base64 using oldKey (previous currentAesKey)
      try {
        decrypted = await decrypt(doc[field], oldKey);
        if (decrypted === "[Decryption Error]") decrypted = null;
        else
          console.log(`Successfully decrypted ${field} with oldKey (base64)`);
      } catch (error) {
        console.error(
          `Base64 decryption failed with oldKey for ${Model.modelName} field ${field}: ${error.message}, data: ${doc[field]}`
        );
      }

      // If base64 decryption with oldKey fails, try with previousKey (previousAesKey)
      if (!decrypted && previousKey) {
        try {
          decrypted = await decrypt(doc[field], previousKey);
          if (decrypted === "[Decryption Error]") decrypted = null;
          else
            console.log(
              `Successfully decrypted ${field} with previousKey (base64)`
            );
        } catch (error) {
          console.error(
            `Base64 decryption failed with previousKey for ${Model.modelName} field ${field}: ${error.message}, data: ${doc[field]}`
          );
        }
      }

      // If base64 decryption fails, try legacy hex format with oldKey
      if (!decrypted) {
        try {
          decrypted = decryptLegacyData(doc[field], oldKey);
          if (decrypted)
            console.log(`Successfully decrypted ${field} with oldKey (hex)`);
        } catch (error) {
          console.error(
            `Legacy hex decryption failed with oldKey for ${Model.modelName} field ${field}: ${error.message}, data: ${doc[field]}`
          );
        }
      }

      // If still not decrypted, try legacy hex format with previousKey
      if (!decrypted && previousKey) {
        try {
          decrypted = decryptLegacyData(doc[field], previousKey);
          if (decrypted)
            console.log(
              `Successfully decrypted ${field} with previousKey (hex)`
            );
        } catch (error) {
          console.error(
            `Legacy hex decryption failed with previousKey for ${Model.modelName} field ${field}: ${error.message}, data: ${doc[field]}`
          );
        }
      }

      // If decryption succeeded, re-encrypt with new key (new currentAesKey)
      if (decrypted) {
        try {
          const reencrypted = await encrypt(decrypted, newKey);
          update[field] = reencrypted;
          needsUpdate = true;
          console.log(`Successfully re-encrypted ${field} with newKey`);

          // Verify re-encrypted data can be decrypted with newKey
          const verifyDecrypted = await decrypt(reencrypted, newKey);
          if (verifyDecrypted !== decrypted) {
            console.error(
              `Verification failed for ${field} in ${Model.modelName}: re-encrypted data does not match`
            );
          } else {
            console.log(
              `Verification successful for ${field} in ${Model.modelName}`
            );
          }
        } catch (error) {
          console.error(
            `Error re-encrypting ${Model.modelName} field ${field}: ${error.message}`
          );
          continue; // Skip this field if encryption fails
        }
      } else {
        console.warn(
          `Skipping field ${field} in ${Model.modelName} due to decryption failure, data: ${doc[field]}`
        );
      }
    }

    if (needsUpdate || doc.encryptedWithKeyVersion !== newKeyVersion) {
      update.encryptedWithKeyVersion = newKeyVersion;
      update.updatedAt = new Date();

      bulkOps.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: update },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    console.log(`Updating ${bulkOps.length} ${Model.modelName} documents`);
    await Model.bulkWrite(bulkOps, { session });
  } else {
    console.log(`No updates needed for ${Model.modelName} documents`);
  }
}

// Get Key Info (show only your key)
router.get("/list", requireAuth, async (req, res) => {
  try {
    // Employee-fallback tokens: key belongs to the owner admin User
    const ownerId = req.user.isEmployeeFallback ? req.user.owner : req.user._id;
    const key = await DecryptionKey.findOne({ owner: ownerId }).select(
      "_id keyVersion currentAesKey previousAesKey createdAt active"
    );
    res.json({ success: true, keys: key ? [key] : [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete key
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await DecryptionKey.deleteOne({ _id: req.params.id, owner: req.user._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify PIN (for UI or testing)
router.post("/verify", requireAuth, async (req, res) => {
  try {
    const { key } = req.body;
    const k = await DecryptionKey.findOne({ owner: req.user._id });
    let match = false,
      keyId = null,
      aesKey = null;
    if (k && (await bcrypt.compare(key, k.hash))) {
      match = true;
      keyId = k._id;
      aesKey = k.currentAesKey;
    }
    res.json({ success: match, keyId, aesKey });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test decryption endpoint for debugging
router.get("/test-decrypt", requireAuth, async (req, res) => {
  try {
    const key = await DecryptionKey.findOne({ owner: req.user._id });
    if (!key) {
      return res.status(404).json({ error: "No key found" });
    }

    const doc = await Salary.findOne({ owner: req.user._id });
    if (!doc) {
      return res.status(404).json({ error: "No salary document found" });
    }

    const decrypted = await decrypt(doc.basic, key.currentAesKey);
    res.json({ success: true, decrypted });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;