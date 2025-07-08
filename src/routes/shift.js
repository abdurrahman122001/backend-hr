const router      = require('express').Router();
const {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
  getAllowMultipleShifts,
  setAllowMultipleShifts,
} = require('../controllers/shiftController');

router.get('/',       getShifts);
router.post('/',      createShift);
router.put('/:id',    updateShift);
router.delete('/:id', deleteShift);
router.post("/allow-multiple-shifts", setAllowMultipleShifts);
router.get("/allow-multiple-shifts", getAllowMultipleShifts);


module.exports = router;
