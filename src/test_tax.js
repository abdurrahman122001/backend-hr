
function calculateTax(basic, conv, med, inc, loanBenefits, leave, late) {
    const gross = basic + conv + med + inc + loanBenefits;
    const taxable = gross - leave - late;
    const tax = Math.round((taxable / 110) * 10);
    return { gross, taxable, tax };
}

// Test case from spreadsheet row 30
// Basic 80000, Conv 20000, Medical -10000 (but user said "include" so let's check both)
// Spreadsheet result for 89100 is 8100.
// 89100 / 11 = 8100.

console.log("Scenario 1: Medical as -10000 (as in spreadsheet value)");
console.log(calculateTax(80000, 20000, -10000, 10000, 100, 10000, 1000));

console.log("\nScenario 2: Medical as 10000 (if 'Don't minus' means it should be positive)");
console.log(calculateTax(80000, 20000, 10000, 10000, 100, 10000, 1000));
