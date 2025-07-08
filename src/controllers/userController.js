// backend/src/controllers/userController.js
exports.getMe = async (req,res) => {
  // req.user is set by your requireAuth middleware
  const { username, email, timeZone, tzMode } = req.user;
  res.json({ username, email, timeZone, tzMode });
};

exports.updateMe = async (req,res) => {
  const { timeZone, tzMode } = req.body;
  if (tzMode==='manual' && !timeZone)
    return res.status(400).json({ error:'manual mode requires timeZone' });
  req.user.timeZone = timeZone || req.user.timeZone;
  req.user.tzMode   = tzMode;
  await req.user.save();
  res.json({ timeZone: req.user.timeZone, tzMode: req.user.tzMode });
};
