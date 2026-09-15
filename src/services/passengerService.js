const User = require("../models/User");
const HttpError = require("../utils/httpError");

const PASSENGER_SELECT =
  "_id name email employeeNumber position department office role isActive";

function idToString(value) {
  if (!value) {
    return null;
  }

  return value._id ? value._id.toString() : value.toString();
}

async function listEligiblePassengers() {
  return User.find({
    isActive: true,
    role: { $in: ["user", "admin"] },
  })
    .select(PASSENGER_SELECT)
    .sort({ name: 1 });
}

async function resolvePassengers(rawPassengers = []) {
  if (!Array.isArray(rawPassengers) || rawPassengers.length === 0) {
    throw new HttpError(400, "At least one passenger is required");
  }

  const orderedIds = [];
  const seen = new Set();

  for (const passenger of rawPassengers) {
    const userId = passenger?.user;

    if (!userId) {
      throw new HttpError(400, "Each passenger must be a selected employee");
    }

    const key = String(userId);
    if (seen.has(key)) {
      throw new HttpError(400, "Duplicate passengers are not allowed");
    }
    seen.add(key);
    orderedIds.push(userId);
  }

  const users = await User.find({
    _id: { $in: orderedIds },
    isActive: true,
    role: { $in: ["user", "admin"] },
  }).select(PASSENGER_SELECT);

  const byId = new Map(users.map((user) => [user._id.toString(), user]));

  return orderedIds.map((userId) => {
    const user = byId.get(String(userId));

    if (!user) {
      throw new HttpError(400, "Selected passenger was not found or is ineligible");
    }

    return {
      user: user._id,
      name: user.name,
      employeeNumber: user.employeeNumber || null,
    };
  });
}

function getPassengerUserIds(requestOrPassengers) {
  const passengers = Array.isArray(requestOrPassengers)
    ? requestOrPassengers
    : requestOrPassengers?.passengers || [];

  return [
    ...new Set(passengers.map((passenger) => idToString(passenger.user)).filter(Boolean)),
  ];
}

function isPassengerOnRequest(requestOrPassengers, userId) {
  const target = idToString(userId);
  if (!target) {
    return false;
  }

  return getPassengerUserIds(requestOrPassengers).includes(target);
}

function ensureApproverNotOnRequest(approverId, requesterId, passengers = []) {
  const approver = idToString(approverId);
  const requester = idToString(requesterId);

  if (approver && requester && approver === requester) {
    throw new HttpError(400, "Managers cannot approve their own travel request");
  }

  if (approver && isPassengerOnRequest(passengers, approver)) {
    throw new HttpError(
      400,
      "Managers cannot approve a travel request they are travelling on"
    );
  }
}

function ensureUserCanClaimReimbursement(travelRequest, userId) {
  if (!isPassengerOnRequest(travelRequest, userId)) {
    throw new HttpError(
      403,
      "You can only submit reimbursement for a trip you are listed on as a passenger"
    );
  }
}

async function loadPassengerUsers(request) {
  const ids = getPassengerUserIds(request);
  if (!ids.length) {
    return [];
  }

  return User.find({ _id: { $in: ids }, isActive: true }).select("-passwordHash");
}

module.exports = {
  idToString,
  listEligiblePassengers,
  resolvePassengers,
  getPassengerUserIds,
  isPassengerOnRequest,
  ensureApproverNotOnRequest,
  ensureUserCanClaimReimbursement,
  loadPassengerUsers,
};
