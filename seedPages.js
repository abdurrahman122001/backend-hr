require('dotenv').config();
const mongoose = require('mongoose');
const Page = require('./src/models/Pages');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hrm';
const DEFAULT_PERMISSIONS = {
  "super-admin": "edit",
  "admin": "view",
  "hr": "view",
  "employee": "hidden"
};
const pages = [
  {
    name: 'Dashboard',
    pageId: 'dashboard',
    // Optionally override permissions:
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'view', employee: 'view' }
  },
  {
    name: 'Settings',
    pageId: 'settings',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit' }
  },
  {
    name: 'Attendance',
    pageId: 'attendance',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit', employee: 'view' }
  },
  {
    name: 'Salary Slip',
    pageId: 'salary-slip',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit', employee: 'view' }
  },
  {
    name: 'Employees',
    pageId: 'employees',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  {
    name: 'Onboarding Form',
    pageId: 'onboarding',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  {
    name: 'Manual Onboarding',
    pageId: 'manual-onboarding',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  {
    name: 'Offer Letter',
    pageId: 'offer-letter',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  {
    name: 'Request CNIC/CV',
    pageId: 'request-cnic-cv',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  {
    name: 'Salary Features',
    pageId: 'salary-features',
    permissions: { ...DEFAULT_PERMISSIONS, 'super-admin': 'edit', admin: 'edit', hr: 'edit' }
  },
  // Add more as needed...
];
const defaultPerms = {
  "super-admin": "edit",
  "admin": "view",
  "hr": "view",
  "employee": "hidden"
};

async function seed() {
  await mongoose.connect(MONGO_URI);

  for (const p of pages) {
    const exists = await Page.findOne({ pageId: p.pageId });
    if (!exists) {
      await Page.create({
        name: p.name,
        pageId: p.pageId,
        permissions: { ...defaultPerms }
      });
      console.log(`Added: ${p.name}`);
    } else {
      console.log(`Exists: ${p.name}`);
    }
  }
  await mongoose.disconnect();
}
seed();
