const { getGroup } = require("../lib/fairshare-db.cjs");
const { requireUser } = require("../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const user = await requireUser(request, response);
    if (!user) return;
    const tripId = Array.isArray(request.query.tripId) ? request.query.tripId[0] : request.query.tripId;
    response.status(200).json(await getGroup(tripId, user));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
