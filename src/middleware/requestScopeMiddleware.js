const HttpError = require("../utils/httpError");
const { buildRequestScope } = require("../services/requestAccessService");
const { buildRequestFilters } = require("../services/requestFilterService");
const asyncHandler = require("../utils/asyncHandler");

const scopeRequestQuery = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new HttpError(401, "Authentication required");
  }

  const scope = await buildRequestScope(req.user, req.query.scope);
  const filters = await buildRequestFilters(req.query, req.user);

  if (filters._id === null) {
    req.requestScope = { _id: null };
    return next();
  }

  if (!Object.keys(scope).length) {
    req.requestScope = filters;
    return next();
  }

  if (!Object.keys(filters).length) {
    req.requestScope = scope;
    return next();
  }

  req.requestScope = { $and: [scope, filters] };
  return next();
});

module.exports = {
  scopeRequestQuery,
};
