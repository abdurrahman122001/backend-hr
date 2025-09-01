const mongoose = require("mongoose");
const Handlebars = require("handlebars");
const nodemailer = require("nodemailer");
const EmailTemplate = require("../models/EmailTemplate");

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: Number(process.env.MAIL_PORT) === 465,
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
});

// ---------- CRUD ----------
exports.list = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const { key } = req.query;
    const q = { owner };
    if (key) q.key = key;
    const items = await EmailTemplate.find(q).sort({ updatedAt: -1 }).lean();
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const doc = await EmailTemplate.findOne({ _id: req.params.id, owner }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch template" });
  }
};

exports.create = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const { key, name, subject, html, isActive = true } = req.body;
    if (!key || !name || !subject || !html) {
      return res.status(400).json({ error: "key, name, subject, html required" });
    }
    const doc = await EmailTemplate.create({ owner, key, name, subject, html, isActive });
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create template" });
  }
};

exports.update = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const { name, subject, html, isActive } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (subject !== undefined) update.subject = subject;
    if (html !== undefined) update.html = html;
    if (isActive !== undefined) update.isActive = isActive;

    const doc = await EmailTemplate.findOneAndUpdate(
      { _id: req.params.id, owner },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update template" });
  }
};

exports.remove = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const out = await EmailTemplate.deleteOne({ _id: req.params.id, owner });
    res.json({ ok: out.deletedCount === 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete template" });
  }
};

// ---------- Render only (server preview) ----------
exports.render = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const { templateId, context = {} } = req.body;
    if (!templateId) return res.status(400).json({ error: "templateId required" });

    const tpl = await EmailTemplate.findOne({ _id: templateId, owner, isActive: true }).lean();
    if (!tpl) return res.status(404).json({ error: "Template not found" });

    const subject = Handlebars.compile(tpl.subject)(context);
    const html = Handlebars.compile(tpl.html)(context);
    res.json({ subject, html });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to render template" });
  }
};

// ---------- Render & send ----------
exports.renderAndSend = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.req_id);
    const { templateId, to, context = {} } = req.body;
    if (!templateId || !to) return res.status(400).json({ error: "templateId and to required" });

    const tpl = await EmailTemplate.findOne({ _id: templateId, owner, isActive: true }).lean();
    if (!tpl) return res.status(404).json({ error: "Template not found" });

    const subject = Handlebars.compile(tpl.subject)(context);
    const html = Handlebars.compile(tpl.html)(context);
    const text = html.replace(/<[^>]+>/g, " ");

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to,
      subject,
      html,
      text,
    });

    res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to send email" });
  }
};
