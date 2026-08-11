/**
 * Public routing module API — smart multi-account selection for any provider.
 */

const accountRouter = require("./accountRouter.cjs");
const limitDetect = require("./limitDetect.cjs");

module.exports = {
  ...accountRouter,
  classifyUpstreamError: limitDetect.classifyUpstreamError,
  fromUsageSnapshot: limitDetect.fromUsageSnapshot,
  isQuotaErrorMessage: limitDetect.isQuotaErrorMessage,
  shouldFailover: limitDetect.shouldFailover,
};
