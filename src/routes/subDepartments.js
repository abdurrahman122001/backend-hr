const router = require('express').Router();
const {
  getSubDepartments,
  createSubDepartment,
  updateSubDepartment,
  deleteSubDepartment,
  reorderSubDepartments,
} = require('../controllers/subDepartmentsController');

router.get('/', getSubDepartments);
router.post('/', createSubDepartment);
router.put('/:id', updateSubDepartment);
router.delete('/:id', deleteSubDepartment);
router.post('/reorder', reorderSubDepartments);

module.exports = router;
