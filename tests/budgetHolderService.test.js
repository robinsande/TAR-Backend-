const xlsx = require("xlsx");
const mongoose = require("mongoose");
const BudgetHolder = require("../src/models/BudgetHolder");
const User = require("../src/models/User");
const {
  parseBudgetHolderRows,
  importBudgetHoldersFromBuffer,
  listBudgetHolders,
} = require("../src/services/budgetHolderService");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");

beforeAll(async () => {
  await startTestDatabase();
});

afterEach(async () => {
  await Promise.all([BudgetHolder.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

function workbookBuffer(rows) {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), "Budget Holders");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("budget holder imports", () => {
  it("parses supported spreadsheet columns and skips duplicate rows", () => {
    expect(parseBudgetHolderRows([
      { "Budget Holder Name": "Alex Holder", "Budget Holder Email": "ALEX@example.com", "Fund Code ID": "DEC16" },
      { Name: "Alex Holder", Email: "alex@example.com", "Fund Code": "DEC16" },
    ])).toEqual([
      { name: "Alex Holder", email: "alex@example.com", fundCode: "DEC16" },
    ]);
  });

  it("reports invalid rows instead of partially importing them", () => {
    expect(() => parseBudgetHolderRows([
      { Name: "Missing Code", Email: "holder@example.com" },
    ])).toThrow(/valid name, email, and fund code/i);
  });

  it("imports active account mappings and lists registered fund codes", async () => {
    const user = await User.create({
      name: "Alex Holder",
      email: "alex@example.com",
      role: "user",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("Password123!"),
    });
    const buffer = workbookBuffer([
      { "Budget Holder Name": "Alex Holder", "Budget Holder Email": user.email, "Fund Code ID": "DEC16" },
    ]);

    const result = await importBudgetHoldersFromBuffer(buffer);
    expect(result).toMatchObject({ received: 1, created: 1, updated: 0 });
    const holders = await listBudgetHolders();
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({
      name: "Alex Holder",
      email: user.email,
      fundCode: "DEC16",
    });
  });
});
