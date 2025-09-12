// routes/emailRoutes.js
const express = require("express");
const mailService = require("../services/newMailService");
const router = express.Router();

/* ---------- Debug ---------- */

router.get("/_debug/mailboxes", async (_req, res) => {
  try {
    const mailboxes = await mailService.listAllMailboxes();
    res.json({ mailboxes });
  } catch (err) {
    console.error("[IMAP] list mailboxes error:", err);
    res.status(500).json({ error: err?.message || "Failed to list mailboxes" });
  }
});

// GET /api/email/_debug/search?mailbox=INBOX&criteria=ALL
router.get("/_debug/search", async (req, res) => {
  try {
    const mailbox = String(req.query.mailbox || "INBOX");
    const raw = String(req.query.criteria || "ALL").trim();
    const criteria = raw.includes(" ") ? raw : [raw];
    const out = await mailService.rawSearch({ mailbox, criteria });
    res.json(out);
  } catch (err) {
    console.error("[IMAP] raw search error:", err);
    res.status(500).json({ error: err?.message || "Raw search failed" });
  }
});

/* ---------- Production ---------- */
/**
 * GET /api/email/inbox
 * Query:
 *   mailbox=INBOX
 *   limit=50            (ignored if all=1)
 *   all=1               (fetch all messages)
 *   since=2024-01-01
 *   unseen=1            (if present, only unseen)
 *   includeBody=1       (include previewText/previewHtml)
 */
router.get("/inbox", async (req, res) => {
  try {
    const mailbox = String(req.query.mailbox || "INBOX");
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const since = req.query.since ? String(req.query.since) : undefined;
    const unseen = String(req.query.unseen || "0") === "1";
    const includeBody = String(req.query.includeBody || "0") === "1";
    const all = String(req.query.all || "0") === "1";

    const items = await mailService.listMessages({
      mailbox,
      limit,
      since,
      unseen,
      includeBody,
      all,
    });

    res.json({ items });
  } catch (err) {
    console.error("[IMAP] inbox error:", err);
    res.status(500).json({ error: err?.message || "Failed to fetch inbox" });
  }
});

// GET /api/email/message/:uid?mailbox=INBOX
router.get("/message/:uid", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const mailbox = String(req.query.mailbox || "INBOX");
    if (!uid) return res.status(400).json({ error: "UID required" });

    const msg = await mailService.getMessage({ mailbox, uid });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    res.json(msg);
  } catch (err) {
    console.error("[IMAP] message error:", err);
    res.status(500).json({ error: err?.message || "Failed to fetch message" });
  }
});

// GET /api/email/message/:uid/attachment/:index/download?mailbox=INBOX
router.get("/message/:uid/attachment/:index/download", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const index = Number(req.params.index);
    const mailbox = String(req.query.mailbox || "INBOX");

    if (!uid || Number.isNaN(index)) {
      return res.status(400).json({ error: "UID and attachment index required" });
    }

    const result = await mailService.getAttachment({ mailbox, uid, index });
    if (!result) return res.status(404).json({ error: "Attachment not found" });

    if (result.filename) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(result.filename)}"`
      );
    }
    if (result.contentType) {
      res.setHeader("Content-Type", result.contentType);
    }
    result.stream.pipe(res);
  } catch (err) {
    console.error("[IMAP] attachment error:", err);
    res.status(500).json({ error: err?.message || "Failed to download attachment" });
  }
});

module.exports = router;
