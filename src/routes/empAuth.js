// routes/empAuth.js
const express = require('express');
const jwt     = require('jsonwebtoken');
const Employee    = require('../models/Employees');
const requireAuth = require('../middleware/empAuth');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const authCtrl = require('../controllers/empAuthController');

router.post('/login', async (req, res) => {
  const { companyEmail, password } = req.body;
  try {
    const emp = await Employee.findOne({ companyEmail }).select('_id companyEmail password role owner name');
    if (!emp) return res.status(401).json({ error: 'Invalid credentials' });

    if (!emp.password || typeof emp.password !== 'string' || emp.password.trim() === '') {
      return res.status(403).json({
        error: 'Account not activated',
        message: 'Your employee account is not yet activated. Please contact your administrator or HR to complete activation.'
      });
    }

    const ok = await emp.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // ⬇️ include owner & role in JWT
    const token = jwt.sign(
      { id: emp._id, owner: emp.owner, role: emp.role },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    // ⬇️ also return them in the JSON response
    res.json({
      token,
      user: {
        id: emp._id,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,            // <= HERE
        name: emp.name || ''
      },
      expiresIn: 7200
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', requireAuth, authCtrl.getMe);

module.exports = router;
