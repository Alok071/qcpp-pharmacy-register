// Vercel serverless function: triggers the "Refresh pharmacy data" GitHub Actions
// workflow on demand, instead of scraping JASANZ directly from the browser
// (that scrape takes minutes and the API isn't meant for public/CORS access).
const OWNER = "Alok071";
const REPO = "qcpp-pharmacy-register";
const WORKFLOW_FILE = "refresh-data.yml";
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "error", message: "Use POST." });
    return;
  }

  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    res.status(500).json({ status: "error", message: "Server missing GH_DISPATCH_TOKEN." });
    return;
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "qcpp-pharmacy-register-refresh-button",
  };

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`,
      { headers: ghHeaders }
    );
    if (runsRes.ok) {
      const runsData = await runsRes.json();
      const last = runsData.workflow_runs && runsData.workflow_runs[0];
      if (last) {
        if (last.status === "in_progress" || last.status === "queued") {
          res.status(202).json({ status: "already-running", message: "A refresh is already in progress." });
          return;
        }
        const elapsed = Date.now() - new Date(last.created_at).getTime();
        if (elapsed < COOLDOWN_MS) {
          const minsLeft = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
          res.status(429).json({ status: "cooldown", message: `Data was refreshed recently. Try again in ${minsLeft} min.` });
          return;
        }
      }
    }

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "master" }),
      }
    );

    if (dispatchRes.status !== 204) {
      const detail = await dispatchRes.text();
      res.status(502).json({ status: "error", message: "Failed to start refresh.", detail });
      return;
    }

    res.status(202).json({ status: "started", message: "Refresh started — new data will appear on the site in a few minutes." });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
};
