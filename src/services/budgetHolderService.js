const xlsx = require("xlsx");
const BudgetHolder = require("../models/BudgetHolder");
const User = require("../models/User");
const HttpError = require("../utils/httpError");

function getCellValue(row, aliases) {
  const keys = new Set(aliases.map((alias) => alias.toLowerCase()));
  const key = Object.keys(row).find((column) => keys.has(String(column).trim().toLowerCase()));
  return key === undefined || row[key] == null ? "" : String(row[key]).trim();
}

function parseBudgetHolderRows(rows) {
  const holders = [];
  const errors = [];
  const seen = new Set();

  rows.forEach((row, index) => {
    const name = getCellValue(row, ["Budget Holder Name", "Name"]);
    const email = getCellValue(row, ["Budget Holder Email", "Email Address", "Email"]).toLowerCase();
    const fundCode = getCellValue(row, ["Fund Code ID", "Fund Code", "FundCode"]);
    if (!name && !email && !fundCode) return;

    if (!name || !email || !fundCode || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Row ${index + 2}: provide a valid name, email, and fund code.`);
      return;
    }

    const key = `${email}\u0000${fundCode.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    holders.push({ name, email, fundCode });
  });

  if (!holders.length && !errors.length) {
    errors.push("The spreadsheet contains no budget holder rows.");
  }
  if (errors.length) {
    throw new HttpError(400, errors.join(" "));
  }
  return holders;
}

async function importBudgetHoldersFromBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) {
    throw new HttpError(400, "The spreadsheet does not contain a worksheet.");
  }

  const rows = xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
  const holders = parseBudgetHolderRows(rows);
  const users = await User.find({
    email: { $in: holders.map((holder) => holder.email) },
    isActive: true,
    role: { $in: ["user", "admin"] },
  }).select("_id email");
  const usersByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));
  const missingAccounts = [...new Set(holders.filter((holder) => !usersByEmail.has(holder.email)).map((holder) => holder.email))];
  if (missingAccounts.length) {
    throw new HttpError(
      400,
      `Create or activate approvable system accounts for these budget holders before importing: ${missingAccounts.join(", ")}`
    );
  }

  let created = 0;
  let updated = 0;
  for (const holder of holders) {
    const user = usersByEmail.get(holder.email);
    const result = await BudgetHolder.updateOne(
      { email: holder.email, fundCode: holder.fundCode },
      { $set: { ...holder, user: user._id, isActive: true } },
      { upsert: true, runValidators: true }
    );
    if (result.upsertedCount) created += 1;
    else updated += 1;
  }

  return { received: holders.length, created, updated };
}

async function listBudgetHolders() {
  return BudgetHolder.find({ isActive: true })
    .populate({ path: "user", match: { isActive: true }, select: "email" })
    .sort({ name: 1, fundCode: 1 })
    .lean()
    .then((holders) => holders
      .filter((holder) => holder.user)
      .map(({ _id, name, email, fundCode }) => ({ _id, name, email, fundCode })));
}

module.exports = {
  parseBudgetHolderRows,
  importBudgetHoldersFromBuffer,
  listBudgetHolders,
};
