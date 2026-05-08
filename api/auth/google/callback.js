const { handleGoogleCallback } = require("../../../lib/fairshare-auth.cjs");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await handleGoogleCallback(request, response);
  } catch (error) {
    response.statusCode = 302;
    response.setHeader("Location", `/?auth=failed&message=${encodeURIComponent(error instanceof Error ? error.message : "Unknown error")}`);
    response.end();
  }
};
