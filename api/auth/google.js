const { startGoogleLogin } = require("../../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await startGoogleLogin(request, response);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Unknown server error." });
  }
};
