// routes/empAuth.js
const express = require('express');
const jwt     = require('jsonwebtoken');
const Employee    = require('../models/Employees');
const requireAuth = require('../middleware/empAuth'); // Make sure this is correct
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const authCtrl = require('../controllers/empAuthController');


router.post('/login', async (req, res) => {
    const { companyEmail, password } = req.body;
  try {
    const emp = await Employee.findOne({ companyEmail });
     if (!emp) {
       return res.status(401).json({ error: 'Invalid credentials' });
     }
   
     // NEW: block login when the account has no active password
     if (!emp.password || typeof emp.password !== 'string' || emp.password.trim() === '') {
       return res.status(403).json({
         error: 'Account not activated',
         message:
           'Your employee account is not yet activated. Please contact your administrator or HR to complete activation.'
       });
     }
   
     // Proceed with password verification
     const ok = await emp.comparePassword(password);
     if (!ok) {
       return res.status(401).json({ error: 'Invalid credentials' });
     }
    const token = jwt.sign({ id: emp._id }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ token, user: { id: emp._id, companyEmail: emp.companyEmail }, expiresIn: 7200 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
router.get('/me', requireAuth, authCtrl.getMe);

module.exports = router;