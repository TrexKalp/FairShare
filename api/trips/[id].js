const { updateTripDetails } = require("../../lib/fairshare-db.cjs");
const { requireUser } = require("../../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "PATCH") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const user = await requireUser(request, response);
    if (!user) return;
    const id = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id;
    response.status(200).json(await updateTripDetails({ tripId: id, name: request.body?.name, currency: request.body?.currency, user }));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
