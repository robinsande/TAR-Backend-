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
    if (!name && !email) return;

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Row ${index + 2}: provide a valid name and email.`);
      return;
    }

    if (seen.has(email)) return;
    seen.add(email);
    holders.push({ name, email });
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
    role: "approver_budget_holder",
  }).select("_id email");
  const usersByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));
  const missingAccounts = [...new Set(holders.filter((holder) => !usersByEmail.has(holder.email)).map((holder) => holder.email))];
  if (missingAccounts.length) {
    throw new HttpError(
      400,
      `Assign the Approver / Budget Holder role to active system accounts before importing: ${missingAccounts.join(", ")}`
    );
  }

  let created = 0;
  let updated = 0;
  for (const holder of holders) {
    const user = usersByEmail.get(holder.email);
    const result = await BudgetHolder.updateOne(
      { email: holder.email },
      { $set: { ...holder, user: user._id, isActive: true } },
      { upsert: true, runValidators: true }
    );
    if (result.upsertedCount) created += 1;
    else updated += 1;
  }

  return { received: holders.length, created, updated };
}

async function listBudgetHolders() {
  const users = await User.find({
    isActive: true,
    role: "approver_budget_holder",
  }).select("_id name email").sort({ name: 1, email: 1 }).lean();
  if (!users.length) return [];

  const userIds = users.map((user) => user._id);
  const userById = new Map(users.map((user) => [String(user._id), user]));

  await BudgetHolder.bulkWrite(
    users.map((user) => ({
      updateOne: {
        filter: { email: user.email },
        update: {
          $set: {
            name: user.name,
            email: user.email,
            user: user._id,
            isActive: true,
          },
        },
        upsert: true,
      },
    }))
  );

  const holders = await BudgetHolder.find({
    user: { $in: userIds },
    isActive: true,
  }).select("_id user").lean();
  const holderByUserId = new Map();
  holders.forEach((holder) => {
    const userId = String(holder.user);
    if (!holderByUserId.has(userId)) holderByUserId.set(userId, holder);
  });

  return users
    .map((user) => {
      const holder = holderByUserId.get(String(user._id));
      return holder ? { _id: holder._id, name: user.name, email: user.email } : null;
    })
    .filter(Boolean);
}

module.exports = {
  parseBudgetHolderRows,
  importBudgetHoldersFromBuffer,
  listBudgetHolders,
};
