const { deleteExpense } = require("../../lib/fairshare-db.cjs");
const { requireUser } = require("../../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "DELETE") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    if (!(await requireUser(request, response))) return;
    const id = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id;
    const tripId = Array.isArray(request.query.tripId) ? request.query.tripId[0] : request.query.tripId;
    response.status(200).json(await deleteExpense({ tripId, expenseId: id }));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
