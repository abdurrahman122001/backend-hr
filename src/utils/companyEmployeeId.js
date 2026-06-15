const CompanyProfile = require("../models/CompanyProfile");

function getCompanySetupDate(company) {
  if (company?.createdAt) return new Date(company.createdAt);
  if (company?._id?.getTimestamp) return company._id.getTimestamp();
  return new Date();
}

function isValidCompanyOwnerIndex(ownerIndex, setupYear) {
  if (!ownerIndex) return false;
  const value = String(ownerIndex);
  if (!/^\d+$/.test(value) || !value.startsWith(String(setupYear))) {
    return false;
  }

  const companyNumber = Number(value.slice(String(setupYear).length));
  return Number.isInteger(companyNumber) && companyNumber > 0;
}

async function getNextCompanyOwnerIndex(setupYear) {
  const companies = await CompanyProfile.find({
    ownerIndex: { $exists: true, $ne: null },
  })
    .select("ownerIndex")
    .lean();

  const setupYearText = String(setupYear);
  const maxCompanyNumberForYear = companies.reduce((max, item) => {
    if (!isValidCompanyOwnerIndex(item.ownerIndex, setupYear)) return max;
    const companyNumber = Number(String(item.ownerIndex).slice(setupYearText.length));
    return Math.max(max, companyNumber);
  }, 0);

  return Number(`${setupYear}${maxCompanyNumberForYear + 1}`);
}

async function ensureCompanyOwnerIndex(companyOrId) {
  let company = typeof companyOrId === "object" && companyOrId?._id
    ? companyOrId
    : await CompanyProfile.findById(companyOrId).select("ownerIndex createdAt").lean();

  if (!company) {
    throw new Error("Company profile not found for employee ID generation");
  }

  const setupDate = getCompanySetupDate(company);
  const setupYear = setupDate.getFullYear();

  if (isValidCompanyOwnerIndex(company.ownerIndex, setupYear)) {
    return Number(company.ownerIndex);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nextOwnerIndex = await getNextCompanyOwnerIndex(setupYear);
    const ownerIndexCondition = company.ownerIndex == null
      ? { $or: [{ ownerIndex: { $exists: false } }, { ownerIndex: null }] }
      : { ownerIndex: company.ownerIndex };

    try {
      const updatedCompany = await CompanyProfile.findOneAndUpdate(
        { _id: company._id, ...ownerIndexCondition },
        { $set: { ownerIndex: nextOwnerIndex } },
        { new: true, projection: { ownerIndex: 1, createdAt: 1 } }
      ).lean();

      if (updatedCompany?.ownerIndex) {
        return Number(updatedCompany.ownerIndex);
      }
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    const latestCompany = await CompanyProfile.findById(company._id)
      .select("ownerIndex createdAt")
      .lean();

    if (latestCompany && isValidCompanyOwnerIndex(latestCompany.ownerIndex, setupYear)) {
      return Number(latestCompany.ownerIndex);
    }

    company = latestCompany || company;
  }

  throw new Error("Unable to generate company employee ID prefix");
}

async function generateEmployeeIdForCompany(companyOrId) {
  const company = typeof companyOrId === "object" && companyOrId?._id
    ? companyOrId
    : await CompanyProfile.findById(companyOrId).select("ownerIndex").lean();

  if (!company) {
    throw new Error("Company profile not found for employee ID generation");
  }

  if (!company.ownerIndex) {
    throw new Error("Company ownerIndex is required before employee ID generation");
  }

  const updatedCompany = await CompanyProfile.findOneAndUpdate(
    { _id: company._id },
    { $inc: { employeeIdSequence: 1 } },
    { new: true, projection: { ownerIndex: 1, employeeIdSequence: 1 } }
  ).lean();

  if (!updatedCompany?.ownerIndex) {
    throw new Error("Company ownerIndex is required before employee ID generation");
  }

  const employeeSequence = updatedCompany?.employeeIdSequence || 1;
  const employeeSequenceStr = String(employeeSequence).padStart(3, "0");

  return `${updatedCompany.ownerIndex}${employeeSequenceStr}`;
}

module.exports = {
  ensureCompanyOwnerIndex,
  generateEmployeeIdForCompany,
};
