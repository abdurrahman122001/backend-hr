// controllers/extraFieldsController.js

const ExtraField = require('../models/Extrafields');
exports.getExtraFields = async (req, res) => {
  try {
    const owner = req.user._id;
    const fields = await ExtraField.find({ owner }).sort({ createdAt: 1 });
    res.json(fields);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch extra fields.' });
  }
};


const slugify = (str) =>
  str
    .toLowerCase()
    .replace(/ /g, '_')
    .replace(/[^\w-]+/g, '');

exports.createExtraField = async (req, res) => {
  try {
    const { label, type, placeholder, options, isRequired, section } = req.body;
    if (!label || !type || !section) {
      return res.status(400).json({ error: 'label, type, and section are required.' });
    }

    const owner = req.user._id; // from auth middleware

    // auto-generate unique key
    let key = slugify(label);
    let exists = await ExtraField.findOne({ owner, key });
    let i = 1;
    while (exists) {
      key = slugify(label) + '_' + i;
      exists = await ExtraField.findOne({ owner, key });
      i++;
    }

    const extraField = await ExtraField.create({
      owner,
      key,
      label,
      type,
      placeholder,
      options: type === "select" ? options : [],
      isRequired: !!isRequired,
      section,
    });
    res.status(201).json(extraField);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create extra field.' });
  }
};

exports.deleteExtraField = async (req, res) => {
  try {
    const { id } = req.params;
    await ExtraField.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete extra field.' });
  }
};
