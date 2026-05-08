const { addExpense } = require("../lib/fairshare-db.cjs");
const { requireUser } = require("../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const user = await requireUser(request, response);
    if (!user) return;
    response.status(200).json(await addExpense(request.body, user));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
