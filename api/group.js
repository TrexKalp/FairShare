const { getGroup } = require("../lib/fairshare-db.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const tripId = Array.isArray(request.query.tripId) ? request.query.tripId[0] : request.query.tripId;
    response.status(200).json(await getGroup(tripId));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
