const { deleteExpense, updateExpense } = require("../../lib/fairshare-db.cjs");
const { requireUser } = require("../../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "DELETE" && request.method !== "PATCH") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const user = await requireUser(request, response);
    if (!user) return;
    const id = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id;
    const tripId = Array.isArray(request.query.tripId) ? request.query.tripId[0] : request.query.tripId;

    if (request.method === "PATCH") {
      response.status(200).json(await updateExpense({ ...request.body, tripId: request.body?.tripId || tripId, expenseId: id, user }));
      return;
    }

    response.status(200).json(await deleteExpense({ tripId, expenseId: id, user }));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
