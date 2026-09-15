const User = require("../models/User");
const TravelRequest = require("../models/TravelRequest");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build Mongo filter clauses for reimbursement list query params.
 * Supports: status, search, submittedByEmail / requestedByEmail
 */
async function buildReimbursementFilters(query, user) {
  const filters = [];
  const canFilterByPerson = user.role === "admin" || user.role === "superadmin";

  if (query.status) {
    filters.push({ status: String(query.status).toLowerCase() });
  }

  const submittedByEmail = query.submittedByEmail || query.requestedByEmail;
  if (submittedByEmail && canFilterByPerson) {
    const email = String(submittedByEmail).trim().toLowerCase();
    const submitters = await User.find({
      email: { $regex: escapeRegex(email), $options: "i" },
    }).select("_id");

    if (!submitters.length) {
      return { _id: null };
    }

    filters.push({ submittedBy: { $in: submitters.map((u) => u._id) } });
  }

  if (query.search) {
    const pattern = {
      $regex: escapeRegex(String(query.search).trim()),
      $options: "i",
    };

    const matchingTravel = await TravelRequest.find({
      $or: [
        { "itinerary.destination": pattern },
        { "project.name": pattern },
        { purposeOfTrip: pattern },
      ],
    }).select("_id");

    const searchClauses = [
      { baseLocation: pattern },
      { department: pattern },
      { position: pattern },
      { employeeNumber: pattern },
    ];

    if (matchingTravel.length) {
      searchClauses.push({ travelRequest: { $in: matchingTravel.map((t) => t._id) } });
    }

    if (canFilterByPerson) {
      const matchingUsers = await User.find({
        $or: [{ name: pattern }, { email: pattern }],
      }).select("_id");

      if (matchingUsers.length) {
        searchClauses.push({ submittedBy: { $in: matchingUsers.map((u) => u._id) } });
      }
    }

    filters.push({ $or: searchClauses });
  }

  if (!filters.length) {
    return {};
  }

  if (filters.length === 1) {
    return filters[0];
  }

  return { $and: filters };
}

function mergeReimbursementScope(scope, queryFilters) {
  if (queryFilters && queryFilters._id === null) {
    return { _id: null };
  }

  if (!queryFilters || !Object.keys(queryFilters).length) {
    return scope || {};
  }

  if (!scope || !Object.keys(scope).length) {
    return queryFilters;
  }

  return { $and: [scope, queryFilters] };
}

module.exports = {
  buildReimbursementFilters,
  mergeReimbursementScope,
};
