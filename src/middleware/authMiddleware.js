const User = require("../models/User");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { verifyToken } = require("../services/jwtService");

const authenticate = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "Authentication required");
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    throw new HttpError(401, "Invalid or expired token");
  }

  const user = await User.findById(payload.userId).select(
    "-passwordHash -inviteToken -inviteTokenExpires"
  );

  if (!user || !user.isActive) {
    throw new HttpError(401, "User account is unavailable");
  }

  req.user = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    name: user.name,
  };

  req.currentUser = user;
  next();
});

function requireRole(...allowedRoles) {
  return function roleGuard(req, res, next) {
    if (!req.user) {
      return next(new HttpError(401, "Authentication required"));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new HttpError(403, "You do not have access to this resource"));
    }

    return next();
  };
}

module.exports = {
  authenticate,
  requireRole,
};
