// services/newMailService.js
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const dotenv = require("dotenv");
const { Readable } = require("stream");

dotenv.config();

const host = process.env.IMAP_HOST;
const port = Number(process.env.IMAP_PORT || 993);
const user = process.env.IMAP_USER;
const password = process.env.IMAP_PASSWORD;
const secure = String(process.env.IMAP_SECURE ?? "true") === "true";
const defaultLimit = Number(process.env.IMAP_DEFAULT_LIMIT || 50);

if (!host || !port || !user || !password) {
  console.error("[IMAP] Missing env vars: IMAP_HOST/PORT/USER/PASSWORD");
}

function flagHas(flags, name) {
  if (!flags) return false;
  if (typeof flags.has === "function") return flags.has(name);
  if (Array.isArray(flags)) return flags.includes(name);
  try { return Array.from(flags || []).includes(name); } catch { return false; }
}

function findTextParts(struct) {
  if (!struct) return { plain: null, html: null };
  const stack = [struct];
  let plain = null;
  let html = null;
  while (stack.length) {
    const p = stack.pop();
    if (p.type === "text") {
      const sub = String(p.subtype || "").toLowerCase();
      if (sub === "plain" && !plain) plain = p.part;
      if (sub === "html" && !html) html = p.part;
    }
    if (Array.isArray(p.childNodes)) stack.push(...p.childNodes);
  }
  return { plain, html };
}

const EXCLUDE_SPECIAL = new Set(["\\Sent", "\\Trash", "\\Junk", "\\Drafts", "\\Spam"]);

class MailService {
  constructor() {
    this.client = null;
    this.connecting = null;
  }

  createClient() {
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      logger: false,
      tls: { servername: host },
    });
    client.on("error", (err) => console.error("[IMAP] Client error:", err?.message || err));
    client.on("close", () => console.warn("[IMAP] Connection closed"));
    return client;
  }

  async ensureConnected() {
    if (this.client && this.client.closed === false) return;
    if (this.connecting) return this.connecting;
    this.client = this.createClient();
    this.connecting = (async () => {
      await this.client.connect();
      await this.client.noop();
      console.log("[IMAP] Connected and authenticated");
    })();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  /* ---------------- Debug ---------------- */
  async listAllMailboxes() {
    await this.ensureConnected();
    const out = [];
    for await (const box of this.client.list()) {
      let exists = null;
      try {
        const st = await this.client.status(box.path, { messages: true });
        exists = st.messages ?? null;
      } catch {}
      out.push({
        path: box.path,
        name: box.name,
        flags: box.flags || [],
        specialUse: box.specialUse || null,
        delimiter: box.delimiter,
        exists,
      });
    }
    return out;
  }

  async rawSearch({ mailbox = "INBOX", criteria = ["ALL"] } = {}) {
    await this.ensureConnected();
    const info = await this.client.mailboxOpen(mailbox, { readOnly: true });
    const uids = await this.client.search(criteria, { uid: true });
    return { mailbox, exists: info.exists, criteria, totalUids: uids.length, sample: uids.slice(-10) };
  }

  /* -------------- Public: list messages (multi-mailbox + previews) -------------- */
  /**
   * listMessages({ mailbox, scope, limit, since, unseen, includeBody, all })
   * - mailbox: string (default "INBOX"); or "ALL" to include all non-sent/non-trash boxes
   * - scope: "all" (same as mailbox=ALL)
   * - limit: max items per mailbox; ignored if all=true
   * - all: if true, fetch all UIDs in each mailbox (be careful with huge mailboxes)
   * - includeBody: include previewText/previewHtml using parts, then safe fallback parsing
   */
  async listMessages(opts = {}) {
    await this.ensureConnected();
    const {
      mailbox = "INBOX",
      scope,
      limit,
      since,
      unseen,
      includeBody,
      all,
    } = opts;

    const mailboxesToScan = await this._resolveMailboxesToScan(mailbox, scope);

    // Collect { mailboxPath, items[] } then flatten + sort
    const allItems = [];
    for (const mbox of mailboxesToScan) {
      const items = await this._listMessagesSingleBox({
        mailbox: mbox,
        limit,
        since,
        unseen,
        includeBody,
        all,
      });
      // tag mailbox for clarity if you want to show which folder it came from
      for (const it of items) allItems.push({ ...it, mailbox: mbox });
    }

    // De-dup (same message can appear in “All Mail” and folder); prefer INBOX copy
    const seenByUidPerBox = new Set();
    const uniq = [];
    for (const it of allItems.sort((a,b)=> new Date(b.date||0)-new Date(a.date||0))) {
      const key = `${it.mailbox}:${it.uid}`;
      if (seenByUidPerBox.has(key)) continue;
      seenByUidPerBox.add(key);
      uniq.push(it);
    }
    return uniq;
  }

  async _resolveMailboxesToScan(mailbox, scope) {
    if (scope === "all" || String(mailbox).toUpperCase() === "ALL") {
      const boxes = await this.listAllMailboxes();
      const chosen = boxes
        .filter(b => !EXCLUDE_SPECIAL.has(String(b.specialUse || "")))
        .map(b => b.path);
      // Put Inbox-ish folders first
      chosen.sort((a, b) => {
        const A = /inbox/i.test(a) ? -1 : 0;
        const B = /inbox/i.test(b) ? -1 : 0;
        return A - B;
      });
      return chosen;
    }
    return [mailbox];
  }

  async _listMessagesSingleBox({ mailbox, limit, since, unseen, includeBody, all }) {
    const opened = await this.client.mailboxOpen(mailbox, { readOnly: true });
    const total = opened.exists || 0;
    console.log(`[IMAP] Opened "${mailbox}" with ${total} messages`);

    const criteria = [];
    if (unseen) criteria.push("UNSEEN");
    if (since) {
      const d = new Date(since);
      if (!isNaN(d.getTime())) criteria.push(["SINCE", d]);
    }
    if (!criteria.length) criteria.push("ALL");

    const uids = await this.client.search(criteria, { uid: true });
    console.log(`[IMAP] [${mailbox}] matched ${uids.length} messages`);
    if (!uids.length) return [];

    const selected = all ? uids : uids.slice(-Math.min(Math.max(1, limit || defaultLimit), 200));

    // 1) metadata + structure
    const basics = [];
    const structByUid = new Map();
    for await (const msg of this.client.fetch({ uid: selected }, {
      envelope: true,
      flags: true,
      uid: true,
      bodyStructure: true,
      internalDate: true,
    })) {
      const env = msg.envelope || {};
      const uidNum = Number(msg.uid);
      basics.push({
        uid: uidNum,
        subject: env.subject || "(no subject)",
        from: (env.from || []).map(a => ({ name: a.name, address: a.address })),
        to: (env.to || []).map(a => ({ name: a.name, address: a.address })),
        date: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        seen: flagHas(msg.flags, "\\Seen"),
        flagged: flagHas(msg.flags, "\\Flagged"),
        hasAttachments: this._hasAttachments(msg.bodyStructure),
      });
      structByUid.set(uidNum, msg.bodyStructure);
    }

    if (!includeBody) {
      return basics
        .map(it => ({ ...it, snippet: this._buildSnippet(it.subject, "") }))
        .sort((a,b)=> new Date(b.date||0)-new Date(a.date||0));
    }

    // 2) try fast bodyParts fetch
    const previews = await this._fetchBodyPreviews(selected, structByUid);

    // 3) fallback parse: if a uid has no text/html from bodyParts, parse source for a small batch
    const missing = selected.filter(uid => {
      const p = previews.get(Number(uid));
      return !p || (!p.text && !p.html);
    });
    if (missing.length) {
      await this._fallbackParseForPreviews(mailbox, missing.slice(-50), previews); // cap fallback batch
    }

    const items = basics.map(it => {
      const prev = previews.get(it.uid) || { text: "", html: "" };
      return {
        ...it,
        snippet: this._buildSnippet(it.subject, prev.text || prev.html || ""),
        previewText: prev.text || null,
        previewHtml: prev.html || null,
      };
    });

    items.sort((a,b)=> new Date(b.date||0)-new Date(a.date||0));
    return items;
  }

  _hasAttachments(struct) { return this._messageHasAttachments(struct); }
  _messageHasAttachments(struct) {
    if (!struct) return false;
    const stack = Array.isArray(struct.childNodes) ? [...struct.childNodes] : [];
    while (stack.length) {
      const part = stack.pop();
      const disp = (part.disposition || "").toUpperCase();
      if (disp === "ATTACHMENT" || (part.filename && disp !== "INLINE")) return true;
      if (part.childNodes?.length) stack.push(...part.childNodes);
    }
    return false;
  }

  _buildSnippet(subject, text) {
    const s = [subject || "", text || ""].join(" ").replace(/\s+/g, " ").trim();
    return s.length > 180 ? s.slice(0, 180) + "…" : s;
  }

  async _fetchBodyPreviews(selectedUids, structByUid) {
    const previews = new Map();
    const BATCH = 50;
    const MAX_PART = 262144; // 256KB

    for (let i = 0; i < selectedUids.length; i += BATCH) {
      const chunk = selectedUids.slice(i, i + BATCH);
      const partsNeededPerUid = new Map();
      const partsSet = new Set();

      for (const uid of chunk) {
        const s = structByUid.get(Number(uid));
        const ids = findTextParts(s);
        partsNeededPerUid.set(Number(uid), ids);
        if (ids.plain) partsSet.add(ids.plain);
        if (ids.html) partsSet.add(ids.html);
      }

      const bodyParts = Array.from(partsSet);
      if (!bodyParts.length) {
        for (const uid of chunk) previews.set(Number(uid), { text: "", html: "" });
        continue;
      }

      for await (const msg of this.client.fetch({ uid: chunk }, {
        uid: true,
        bodyParts,
        bodyPartMaxLength: MAX_PART,
      })) {
        const uidNum = Number(msg.uid);
        const ids = partsNeededPerUid.get(uidNum) || {};
        let text = "", html = "";

        if (ids.plain) {
          const part = msg.bodyParts?.get(ids.plain);
          if (part?.content) text = part.content.toString("utf8");
        }
        if (!text && ids.html) {
          const part = msg.bodyParts?.get(ids.html);
          if (part?.content) html = part.content.toString("utf8");
        }

        const maxChars = 5000;
        if (text && text.length > maxChars) text = text.slice(0, maxChars) + "…";
        if (html && html.length > maxChars) html = html.slice(0, maxChars) + "…";

        previews.set(uidNum, { text, html });
      }
    }
    return previews;
  }

  // Fallback: parse raw for a small batch when parts fetch yields nothing
  async _fallbackParseForPreviews(mailbox, uids, previewsMap) {
    if (!uids.length) return;
    console.log(`[IMAP] Fallback preview parse for ${uids.length} messages in ${mailbox}`);
    for await (const msg of this.client.fetch({ uid: uids }, { uid: true, source: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const uidNum = Number(msg.uid);
        let text = parsed.text || "";
        let html = parsed.html ? String(parsed.html) : "";
        const maxChars = 5000;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
        if (html.length > maxChars) html = html.slice(0, maxChars) + "…";
        previewsMap.set(uidNum, { text, html });
      } catch (e) {
        // leave empty on failure
      }
    }
  }

  /* -------------- Full message -------------- */
  async getMessage({ mailbox = "INBOX", uid }) {
    await this.ensureConnected();
    await this.client.mailboxOpen(mailbox, { readOnly: true });

    const cursor = await this.client.fetch({ uid }, {
      envelope: true,
      flags: true,
      uid: true,
      source: true,
      internalDate: true,
      bodyStructure: true,
    });

    const first = await cursor.next();
    if (!first || !first.value) return null;
    const msg = first.value;

    const parsed = await simpleParser(msg.source);

    const attachments = (parsed.attachments || []).map((att, idx) => ({
      index: idx,
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      contentId: att.cid || null,
    }));

    const env = msg.envelope || {};
    const headers = {};
    (parsed.headerLines || []).forEach(({ key, line }) => { headers[key] = line; });

    return {
      uid: Number(msg.uid),
      subject: env.subject || "(no subject)",
      from: (env.from || []).map(a => ({ name: a.name, address: a.address })),
      to: (env.to || []).map(a => ({ name: a.name, address: a.address })),
      cc: (env.cc || []).map(a => ({ name: a.name, address: a.address })),
      bcc: (env.bcc || []).map(a => ({ name: a.name, address: a.address })),
      date: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
      seen: flagHas(msg.flags, "\\Seen"),
      flagged: flagHas(msg.flags, "\\Flagged"),
      text: parsed.text || null,
      html: parsed.html ? String(parsed.html) : null,
      attachments,
      headers,
    };
  }

  /* -------------- Attachment -------------- */
  async getAttachment({ mailbox = "INBOX", uid, index }) {
    await this.ensureConnected();
    await this.client.mailboxOpen(mailbox, { readOnly: true });

    const cursor = await this.client.fetch({ uid }, { source: true });
    const first = await cursor.next();
    if (!first || !first.value) return null;

    const parsed = await simpleParser(first.value.source);
    const att = (parsed.attachments || [])[index];
    if (!att) return null;

    return {
      stream: Readable.from(att.content),
      filename: att.filename || "attachment",
      contentType: att.contentType || "application/octet-stream",
    };
  }
}

const service = new MailService();

// graceful shutdown
process.on("SIGINT", async () => {
  try { if (service.client && !service.client.closed) await service.client.logout(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try { if (service.client && !service.client.closed) await service.client.logout(); } catch {}
  process.exit(0);
});

module.exports = service;
