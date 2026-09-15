/** TER (Travel Expense Report) line-item categories used for forms and PDF classification. */
const EXPENSE_CATEGORIES = [
  "PER DIEM (M&I)",
  "BREAKFAST",
  "LUNCH",
  "DINNER",
  "INCIDENTALS",
  "HOTEL ROOM & TAXES",
  "AIRPORT TAXES & VISA FEES",
  "TAXI/LOCAL TRANSPORTATION",
  "VEHICLE FUEL",
  "OTHER EXPENSES",
];

const EXPENSE_CATEGORY_SET = new Set(EXPENSE_CATEGORIES);

function isValidExpenseCategory(value) {
  return EXPENSE_CATEGORY_SET.has(String(value || "").trim());
}

module.exports = {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_SET,
  isValidExpenseCategory,
};
