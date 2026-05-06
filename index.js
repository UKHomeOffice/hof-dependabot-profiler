/**
 * CONFIG
 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const REPOS = [
  "UKHomeOfficeForms/hof",
  "UKHomeOffice/additional-security-checks",
  "UKHomeOffice/AppealRightsExhausted",
  "UKHomeOffice/brp_enquiry_forms",
  "UKHomeOffice/clue-resolver",
  "UKHomeOffice/coa",
  "UKHomeOffice/controlled-substance-licence",
  "UKHomeOffice/ecs",
  "UKHomeOffice/evisa-contact-form",
  "UKHomeOffice/evisa-error-correction",
  "UKHomeOffice/evisa-find-my-reference",
  "UKHomeOffice/eta",
  "UKHomeOffice/end-tenancy",
  "UKHomeOffice/explosives-precursors-poisons",
  "UKHomeOffice/file-vault",
  "UKHomeOffice/firearms",
  "UKHomeOffice/gro",
  "UKHomeOffice/hff",
  "UKHomeOffice/hof-forms-waf",
  "UKHomeOffice/hof-rds-api",
  "UKHomeOffice/hof-rds-api-lamp",
  "UKHomeOffice/homeoffice-countries",
  "UKHomeOffice/html-pdf-converter",
  "UKHomeOffice/icasework-resolver",
  "UKHomeOffice/ims-resolver",
  "UKHomeOffice/internal-allegation-referral",
  "UKHomeOffice/lamp",
  "UKHomeOffice/landlords-checking-service",
  "UKHomeOffice/lmr",
  "UKHomeOffice/ms-schema",
  "UKHomeOffice/modern-slavery",
  "UKHomeOffice/paf",
  "UKHomeOffice/refugee-integration-loan",
  "UKHomeOffice/return-of-documents",
  "UKHomeOffice/rotm",
  "UKHomeOffice/save-return-api",
  "UKHomeOffice/save-return-email-alerts",
  "UKHomeOffice/save-return-lookup-ui",
  "UKHomeOffice/ukvi-complaints",
  "UKHomeOffice/visa-processing-times-tool",
  "UKHomeOffice/web-messengers",
  "UKHomeOffice/eta-web-messenger",
  "UKHomeOffice/euss-web-messenger",
  "UKHomeOffice/evisa-web-messenger",
  "UKHomeOffice/visa-web-messenger"
];

// Max concurrent API calls
const CONCURRENCY = 5;
const DEFAULT_OUTPUT_MODE = "slack-json";
const VALID_OUTPUT_MODES = new Set(["console", "slack-json", "slack-post"]);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!GITHUB_TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const BASE_URL = "https://api.github.com";

function getOutputMode() {
  const arg = process.argv.find((value) => value.startsWith("--output="));
  const requestedMode = arg ? arg.split("=")[1] : process.env.OUTPUT_MODE || DEFAULT_OUTPUT_MODE;

  if (!VALID_OUTPUT_MODES.has(requestedMode)) {
    console.error(`Invalid output mode: ${requestedMode}`);
    console.error(`Valid output modes: ${Array.from(VALID_OUTPUT_MODES).join(", ")}`);
    process.exit(1);
  }

  return requestedMode;
}

function logStatus(message) {
  console.error(message);
}

function createEmptyStats() {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    total: 0,
    riskScore: 0
  };
}

/**
 * Simple concurrency limiter (no deps)
 */
function createLimiter(limit) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (queue.length === 0 || active >= limit) return;

    active++;
    const { fn, resolve, reject } = queue.shift();

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const limit = createLimiter(CONCURRENCY);

/**
 * Fetch alerts for one repo
 */

async function fetchRepoAlerts(fullName) {
  const [owner, repo] = fullName.split("/");

  let url = `${BASE_URL}/repos/${owner}/${repo}/dependabot/alerts?per_page=100&state=open`;
  let alerts = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!res.ok) {
      console.error(`❌ ${fullName}: ${res.status}`);
      break;
    }

    const data = await res.json();

    // Repo-scoped Dependabot responses can omit repository metadata.
    // Preserve the source repo so aggregation remains accurate.
    const enrichedData = data.map((alert) => ({
      ...alert,
      _sourceRepo: fullName
    }));

    alerts = alerts.concat(enrichedData);

    // ✅ Extract next page from Link header
    const linkHeader = res.headers.get("link");

    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  return alerts;
}


/**
 * Aggregate with totals + risk score
 */
function aggregate(allAlerts, repos = []) {
  const result = {};

  // Pre-seed configured repos so they appear even when they have zero alerts.
  for (const repo of repos) {
    result[repo] = createEmptyStats();
  }

  for (const alert of allAlerts) {
    const repo = alert._sourceRepo || alert.repository?.full_name || "unknown";
    const severity =
      alert.security_advisory?.severity ||
      alert.security_vulnerability?.severity ||
      "unknown";

    if (!result[repo]) {
      result[repo] = createEmptyStats();
    }

    result[repo][severity] =
      (result[repo][severity] || 0) + 1;

    result[repo].total++;
  }

  /**
   * Compute weighted risk score
   */
  for (const repo of Object.keys(result)) {
    const r = result[repo];

    r.riskScore =
      r.critical * 10 +
      r.high * 5 +
      r.medium * 2 +
      r.low * 1;
  }

  return result;
}

function pad(value, width) {
  return String(value).padStart(width, " ");
}

function chunkLines(lines, maxLength) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + line.length + 1;

    if (current.length > 0 && nextLength > maxLength) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLength = line.length;
      continue;
    }

    current.push(line);
    currentLength = nextLength;
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

function buildSlackPayload(summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames = []) {
  const header = [
    "repo".padEnd(42, " "),
    "total",
    "crit",
    "high",
    "med",
    "low",
    "risk"
  ].join(" ");

  const rows = summary.map((entry) => [
    entry.repo.padEnd(42, " "),
    pad(entry.total, 5),
    pad(entry.critical, 4),
    pad(entry.high, 4),
    pad(entry.medium, 3),
    pad(entry.low, 3),
    pad(entry.riskScore, 4)
  ].join(" "));

  const tableChunks = chunkLines([header, ...rows], 2800);
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Dependabot Open Alert Summary"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Repos checked:* ${summary.length + zeroAlertRepoCount}`,
          `*Repos with alerts:* ${summary.length}`,
          zeroAlertRepoCount > 0
            ? `*Repos with zero alerts:* ${zeroAlertRepoCount} (${zeroAlertRepoNames.join(", ")})`
            : `*Repos with zero alerts:* 0`,
          `*Open alerts:* ${totalAlerts}`
        ].join("\n")
      }
    }
  ];

  if (tableChunks.length === 1 && rows.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No open Dependabot alerts across the configured repos."
      }
    });
  } else {
    for (const chunk of tableChunks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`${chunk}\`\`\``
        }
      });
    }
  }

  return {
    text: `Dependabot open alert summary: ${totalAlerts} open alerts across ${summary.length + zeroAlertRepoCount} repos (${zeroAlertRepoCount} clean)`,
    blocks
  };
}

async function outputResults(outputMode, summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames) {
  if (outputMode === "console") {
    console.log("\n=== Sorted Risk Summary ===\n");
    console.table(summary);
    console.log(`Repos with zero alerts: ${zeroAlertRepoCount}`);
    return;
  }

  const slackPayload = buildSlackPayload(summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames);

  if (outputMode === "slack-json") {
    console.log(JSON.stringify(slackPayload, null, 2));
    return;
  }

  if (!SLACK_WEBHOOK_URL) {
    throw new Error("SLACK_WEBHOOK_URL is required when --output=slack-post");
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(slackPayload)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Slack webhook failed: ${response.status} ${responseText}`);
  }

  console.log("Slack webhook post sent successfully.");
}

/**
 * MAIN
 */
async function main() {
  const outputMode = getOutputMode();

  logStatus(`Processing ${REPOS.length} repos (concurrency=${CONCURRENCY})...\n`);

  const results = await Promise.all(
    REPOS.map(repo =>
      limit(async () => {
        logStatus(`Fetching ${repo}...`);
        const alerts = await fetchRepoAlerts(repo);
        logStatus(`→ ${repo}: ${alerts.length} alerts`);
        return alerts;
      })
    )
  );

  const allAlerts = results.flat();

  logStatus(`\nTotal open alerts fetched: ${allAlerts.length}`);

  const aggregated = aggregate(allAlerts, REPOS);

  /**
   * Optional: sorted summary table
   */
  const summary = Object.entries(aggregated)
    .map(([repo, stats]) => ({
      repo,
      total: stats.total,
      critical: stats.critical,
      high: stats.high,
      medium: stats.medium,
      low: stats.low,
      riskScore: stats.riskScore
    }))
    .sort((a, b) => b.riskScore - a.riskScore);

  const reposWithAlerts = summary.filter((entry) => entry.total > 0);
  const zeroAlertRepoCount = summary.length - reposWithAlerts.length;

  const zeroAlertRepoNames = summary.filter((entry) => entry.total === 0).map((entry) => entry.repo);
  await outputResults(outputMode, reposWithAlerts, allAlerts.length, zeroAlertRepoCount, zeroAlertRepoNames);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
