/**
 * protectedUploads.js
 *
 * Employee identity and HR documents used to be served by express.static with
 * `Access-Control-Allow-Origin: *` and no authentication, so a URL was the only
 * thing needed to read anyone's CNIC scan, CV, NDA, contract, or salary
 * certificate — for any company. The generated documents are worse than
 * "unguessable": they are named `nda_<employeeId>.pdf`, so knowing one employee
 * id yields the lot.
 *
 * This router is mounted at /uploads BEFORE the static handlers and intercepts
 * only the sensitive paths. Anything it does not recognise falls through to
 * express.static untouched, so avatars, chat attachments and task files keep
 * working exactly as before.
 *
 * Still public and NOT covered here (they are embedded as plain <img>/<a> URLs
 * across four frontends, so locking them down needs signed URLs — a separate
 * change): /uploads/photos, /uploads/chat-attachments, /uploads/assignments,
 * /uploads/tasks, /uploads/other.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");

const EmployeeDocument = require("../models/EmployeeDocument");
const { canAccessEmployeeDocs } = require("../middleware/employeeDocAccess");

const router = express.Router();

// The two upload roots this app writes to, in the order they are searched.
const SRC_UPLOADS = path.join(__dirname, "..", "uploads");
const ROOT_UPLOADS = path.join(__dirname, "..", "..", "uploads");

// Generated HR documents at the uploads root carry the employee id in the name.
const GENERATED_DOC = /^(nda|contract|salary_certificate|experience)_([0-9a-fA-F]{24})\.pdf$/;

/** Reject anything that tries to climb out of the upload directory. */
const safeSegment = (value) => {
  const base = path.basename(String(value || ""));
  return base && base !== "." && base !== ".." ? base : null;
};

function sendIfExists(res, next, ...candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // These are personal documents: never let a shared cache hold them.
      res.setHeader("Cache-Control", "private, no-store");
      return res.sendFile(candidate);
    }
  }
  return next();
}

async function gate(req, res, employeeId) {
  const result = await canAccessEmployeeDocs(req, employeeId);
  if (result.status !== 200) {
    res.status(result.status).json({ success: false, error: result.error });
    return false;
  }
  return true;
}

/* ---------- education certificates: /uploads/certificates/<id>/<type>/<file> ---------- */
router.get("/certificates/:employeeId/:type/:file", async (req, res, next) => {
  try {
    const type = safeSegment(req.params.type);
    const file = safeSegment(req.params.file);
    if (!type || !file) return res.status(400).json({ error: "Invalid path" });

    if (!(await gate(req, res, req.params.employeeId))) return;

    return sendIfExists(
      res,
      next,
      path.join(SRC_UPLOADS, "certificates", req.params.employeeId, type, file),
      path.join(ROOT_UPLOADS, "certificates", req.params.employeeId, type, file)
    );
  } catch (err) {
    console.error("[protectedUploads] certificate error:", err);
    return res.status(500).json({ error: "Failed to serve file" });
  }
});

/* ---------- CNIC and CV: flat folders, so the owner comes from the DB ---------- */
async function serveIdentityDoc(req, res, next, folder) {
  try {
    const file = safeSegment(req.params.file);
    if (!file) return res.status(400).json({ error: "Invalid path" });

    // Stored as a relative url, e.g. /uploads/cnic/cnicFront-1766748067262.pdf
    const relative = `/uploads/${folder}/${file}`;
    const record = await EmployeeDocument.findOne({
      $or: [
        { cnicFrontUrl: relative },
        { cnicBackUrl: relative },
        { resumeUrl: relative },
      ],
    })
      .select("employee")
      .lean();

    // An orphaned file has no owner to check against, so refuse rather than
    // fall through to the public static handler.
    if (!record) {
      return res.status(404).json({ error: "Not found" });
    }

    if (!(await gate(req, res, String(record.employee)))) return;

    return sendIfExists(
      res,
      next,
      path.join(SRC_UPLOADS, folder, file),
      path.join(ROOT_UPLOADS, folder, file)
    );
  } catch (err) {
    console.error("[protectedUploads] identity doc error:", err);
    return res.status(500).json({ error: "Failed to serve file" });
  }
}

router.get("/cnic/:file", (req, res, next) => serveIdentityDoc(req, res, next, "cnic"));
router.get("/cv/:file", (req, res, next) => serveIdentityDoc(req, res, next, "cv"));

/* ---------- generated HR documents at the uploads root ---------- */
router.get("/:file", async (req, res, next) => {
  const file = safeSegment(req.params.file);
  if (!file) return next();

  const match = GENERATED_DOC.exec(file);
  // Not a generated HR document — let express.static serve it as before.
  if (!match) return next();

  try {
    if (!(await gate(req, res, match[2]))) return;
    return sendIfExists(
      res,
      next,
      path.join(SRC_UPLOADS, file),
      path.join(ROOT_UPLOADS, file)
    );
  } catch (err) {
    console.error("[protectedUploads] generated doc error:", err);
    return res.status(500).json({ error: "Failed to serve file" });
  }
});

module.exports = router;
