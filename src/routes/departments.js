// src/routes/departments.js
const router = require('express').Router();
const {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  reorderDepartments,
} = require('../controllers/departmentsController');

router.get('/', getDepartments);
router.post('/', createDepartment);
router.put('/:id', updateDepartment);
router.delete('/:id', deleteDepartment);
router.post('/reorder', reorderDepartments); 

module.exports = router;
