const AuditLog = require("../models/AuditLog");

async function createAuditLog({
  action,
  performedBy,
  targetRequest = null,
  targetReimbursement = null,
  metadata = {},
}) {
  return AuditLog.create({
    action,
    performedBy,
    targetRequest,
    targetReimbursement,
    metadata,
  });
}

module.exports = {
  createAuditLog,
};
