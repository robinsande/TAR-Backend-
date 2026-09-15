const xlsx = require("xlsx");
const User = require("../models/User");
const {
  generateInviteToken,
  getInviteTokenExpiry,
} = require("./inviteTokenService");
const { sendActivationEmail } = require("./emailService");

function getCellValue(row, key) {
  const value = row[key];
  return typeof value === "string" ? value.trim() : value;
}

function buildUserPayload(row) {
  const firstName = getCellValue(row, "First Name") || "";
  const lastName = getCellValue(row, "Last Name") || "";
  const email = String(getCellValue(row, "CARE Email Address") || "").toLowerCase();

  return {
    employeeNumber: getCellValue(row, "No.") ? String(getCellValue(row, "No.")) : null,
    name: `${firstName} ${lastName}`.trim(),
    email,
    position: getCellValue(row, "Job Title") || null,
    department: getCellValue(row, "Department") || null,
    managerEmail:
      String(getCellValue(row, "Manager's CARE email address") || "").toLowerCase() || null,
  };
}

function deriveManagerEmails(rows) {
  return new Set(
    rows
      .map((row) => String(getCellValue(row, "Manager's CARE email address") || "").toLowerCase())
      .filter(Boolean)
  );
}

function deriveRoleForEmail(email, managerEmails, existingRole) {
  if (existingRole === "superadmin") {
    return "superadmin";
  }

  if (managerEmails.has(email)) {
    return "admin";
  }

  return existingRole || "user";
}

function rowsFromWorkbookBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
}

function rowsFromWorkbookFile(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
}

async function importEmployeeRows(rows, { sendInvites = true } = {}) {
  if (!rows.length) {
    throw new Error("No employee rows found in the provided spreadsheet.");
  }

  const managerEmails = deriveManagerEmails(rows);
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    invitesSent: 0,
    errors: [],
  };

  for (const row of rows) {
    const payload = buildUserPayload(row);

    if (!payload.email || !payload.name) {
      summary.skipped += 1;
      continue;
    }

    try {
      const existingUser = await User.findOne({ email: payload.email });
      const inviteToken = generateInviteToken();
      const inviteTokenExpires = getInviteTokenExpiry();

      if (!existingUser) {
        await User.create({
          ...payload,
          role: deriveRoleForEmail(payload.email, managerEmails),
          isActive: true,
          mustSetPassword: true,
          passwordHash: null,
          inviteToken,
          inviteTokenExpires,
        });
        summary.created += 1;

        if (sendInvites) {
          const createdUser = await User.findOne({ email: payload.email });
          const sent = await sendActivationEmail(createdUser, inviteToken);
          if (sent) {
            summary.invitesSent += 1;
          }
        }

        continue;
      }

      const profileUpdate = {
        employeeNumber: payload.employeeNumber,
        name: payload.name,
        position: payload.position,
        department: payload.department,
        managerEmail: payload.managerEmail,
        isActive: true,
      };

      if (existingUser.role !== "superadmin") {
        profileUpdate.role = deriveRoleForEmail(
          payload.email,
          managerEmails,
          existingUser.role
        );
      }

      if (!existingUser.passwordHash || existingUser.mustSetPassword) {
        profileUpdate.mustSetPassword = true;
        profileUpdate.inviteToken = inviteToken;
        profileUpdate.inviteTokenExpires = inviteTokenExpires;
        profileUpdate.passwordHash = null;

        if (sendInvites) {
          const sent = await sendActivationEmail(existingUser, inviteToken);
          if (sent) {
            summary.invitesSent += 1;
          }
        }
      }

      await User.updateOne({ _id: existingUser._id }, { $set: profileUpdate });
      summary.updated += 1;
    } catch (error) {
      summary.errors.push({ email: payload.email, message: error.message });
    }
  }

  for (const row of rows) {
    const email = String(getCellValue(row, "CARE Email Address") || "").toLowerCase();
    const managerEmail = String(
      getCellValue(row, "Manager's CARE email address") || ""
    ).toLowerCase();

    if (!email) {
      continue;
    }

    const user = await User.findOne({ email });

    if (!user) {
      continue;
    }

    if (!managerEmail) {
      user.managerId = null;
      await user.save();
      continue;
    }

    const manager = await User.findOne({ email: managerEmail });
    user.managerId = manager ? manager._id : null;
    await user.save();
  }

  return summary;
}

async function importEmployeesFromFile(filePath, options = {}) {
  const rows = rowsFromWorkbookFile(filePath);
  return importEmployeeRows(rows, options);
}

async function importEmployeesFromBuffer(buffer, options = {}) {
  const rows = rowsFromWorkbookBuffer(buffer);
  return importEmployeeRows(rows, options);
}

module.exports = {
  buildUserPayload,
  deriveManagerEmails,
  deriveRoleForEmail,
  importEmployeeRows,
  importEmployeesFromFile,
  importEmployeesFromBuffer,
};
