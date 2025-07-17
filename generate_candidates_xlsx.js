const XLSX = require('xlsx');

const data = [
  {
    candidateName: 'John Doe',
    candidateEmail: 'john.doe@example.com',
    position: 'Software Engineer',
    startDate: '2025-07-20',
    reportingTime: '09:00',
    confirmationDeadlineDate: '2025-07-18',
    probationDays: 90,
    basic: 50000,
    bonus: 0,
    houseRentAllowance: 10000,
    medicalAllowance: 5000,
    department: 'Engineering',
  },
  {
    candidateName: 'Jane Smith',
    candidateEmail: 'jane.smith@example.com',
    position: 'Product Manager',
    startDate: '2025-07-22',
    reportingTime: '10:00',
    confirmationDeadlineDate: '2025-07-20',
    probationDays: 180,
    basic: 60000,
    bonus: 5000,
    houseRentAllowance: 15000,
    medicalAllowance: 7000,
    department: 'Product',
  },
  {
    candidateName: 'Alice Brown',
    candidateEmail: 'alice.brown@example.com',
    position: 'Data Analyst',
    startDate: '2025-07-21',
    reportingTime: '08:30',
    confirmationDeadlineDate: '2025-07-19',
    probationDays: 120,
    basic: 45000,
    bonus: 2000,
    houseRentAllowance: 8000,
    medicalAllowance: 4000,
    department: 'Analytics',
  },
];

const ws = XLSX.utils.json_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Candidates');
XLSX.writeFile(wb, 'candidates.xlsx');
