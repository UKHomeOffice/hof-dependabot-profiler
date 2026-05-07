/**
 * CONFIG
 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const STATIC_REPOS = [
  "UKHomeOfficeForms/hof"
];

// Max concurrent API calls
const CONCURRENCY = 5;
const DEFAULT_OUTPUT_MODE = "slack-json";
const VALID_OUTPUT_MODES = new Set(["console", "slack-json", "slack-post"]);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DEFAULT_REPO_SEARCH_QUERY = "org:UKHomeOffice topic:hof-dep-scanner";
const REPO_SEARCH_QUERY = process.env.REPO_SEARCH_QUERY || DEFAULT_REPO_SEARCH_QUERY;

if (!GITHUB_TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const BASE_URL = "https://api.github.com";

async function fetchReposFromSearch(query) {
  const perPage = 100;
  let page = 1;
  const repos = [];

  while (true) {
    const url = `${BASE_URL}/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!res.ok) {
      throw new Error(`Repo search failed: ${res.status}`);
    }

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      if (item?.full_name) {
        repos.push(item.full_name);
      }
    }

    if (items.length < perPage) {
      break;
    }

    // GitHub search API caps results at 1000.
    if (page * perPage >= 1000) {
      break;
    }

    page += 1;
  }

  return Array.from(new Set(repos)).sort((a, b) => a.localeCompare(b));
}

async function resolveRepos() {
  logStatus(`Searching repos with query: ${REPO_SEARCH_QUERY}`);
  const searchedRepos = await fetchReposFromSearch(REPO_SEARCH_QUERY);

  const mergedRepos = Array.from(new Set([...searchedRepos, ...STATIC_REPOS])).sort((a, b) => a.localeCompare(b));

  if (searchedRepos.length === 0) {
    logStatus(`Repo search returned 0 repos for query: ${REPO_SEARCH_QUERY}; using static repos only.`);
  }

  if (mergedRepos.length === 0) {
    throw new Error("No repos available after combining search and static repo lists.");
  }

  logStatus(`Repo search returned ${searchedRepos.length} repos. Static repos: ${STATIC_REPOS.length}. Total merged repos: ${mergedRepos.length}.`);
  return mergedRepos;
}

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
    const repo = alert._sourceRepo || alert.repository?.full_name;
    const severity =
      alert.security_advisory?.severity ||
      alert.security_vulnerability?.severity

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

function buildDependabotAlertsUrl(repo) {
  return `https://github.com/${repo}/security/dependabot`;
}

function getAdvisoryAliases(advisory = {}) {
  const aliases = Array.isArray(advisory?.identifiers) ? advisory.identifiers : [];
  return aliases
    .map((id) => id?.value)
    .filter(Boolean);
}

function getAlertGroupKey(alert) {
  const advisory = alert.security_advisory || {};
  const cveId = advisory.cve_id;
  if (cveId) return `CVE:${cveId}`;

  const ghsa = advisory.ghsa_id;
  if (ghsa) return `GHSA:${ghsa}`;

  const aliases = getAdvisoryAliases(advisory);
  const cve = aliases.find((value) => value.startsWith("CVE-"));
  if (cve) return `CVE:${cve}`;

  if (aliases.length > 0) {
    return `ALIAS:${aliases[0]}`;
  }

  const summary = advisory.summary || advisory.description || "unknown-advisory";
  return `FALLBACK:${summary}`;
}

function buildDuplicateStats(allAlerts) {
  const groups = new Map();

  for (const alert of allAlerts) {
    const repo = alert._sourceRepo || alert.repository?.full_name;
    if (!repo) continue;

    const key = getAlertGroupKey(alert);
    const advisory = alert.security_advisory || {};
    const pkg = alert.security_vulnerability?.package || {};
    const vulnerable_version_range = alert.security_vulnerability?.vulnerable_version_range || null;
    const first_patched_version = alert.security_vulnerability?.first_patched_version?.identifier || null;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        cveId: advisory.cve_id || null,
        ghsaId: advisory.ghsa_id || null,
        aliases: getAdvisoryAliases(advisory),
        summary: advisory.summary || advisory.description || "No summary",
        alertCount: 0,
        repos: new Set(),
        packageNames: new Set(),
        vulnerableVersionRanges: new Set(),
        patchedVersions: new Set()
      });
    }

    const group = groups.get(key);
    group.alertCount += 1;
    group.repos.add(repo);
    if (pkg.name) group.packageNames.add(pkg.name);
    if (vulnerable_version_range) group.vulnerableVersionRanges.add(vulnerable_version_range);
    if (first_patched_version) group.patchedVersions.add(first_patched_version);
  }

  const grouped = Array.from(groups.values()).map((group) => ({
    ...group,
    repoCount: group.repos.size,
    repos: Array.from(group.repos).sort((a, b) => a.localeCompare(b)),
    packageNames: Array.from(group.packageNames).sort(),
    vulnerableVersionRanges: Array.from(group.vulnerableVersionRanges).sort(),
    patchedVersions: Array.from(group.patchedVersions).sort()
  }));

  grouped.sort((a, b) => {
    if (b.repoCount !== a.repoCount) return b.repoCount - a.repoCount;
    if (b.alertCount !== a.alertCount) return b.alertCount - a.alertCount;
    return a.key.localeCompare(b.key);
  });

  const uniqueIssues = grouped.length;
  const duplicateAlerts = Math.max(0, allAlerts.length - uniqueIssues);
  const crossRepoIssues = grouped.filter((group) => group.repoCount > 1).length;

  return {
    uniqueIssues,
    duplicateAlerts,
    crossRepoIssues,
    grouped,
    topRepeated: grouped.filter((group) => group.alertCount > 1).slice(0, 10)
  };
}

function summarizeSeverities(summary) {
  return summary.reduce((totals, entry) => {
    totals.critical += entry.critical;
    totals.high += entry.high;
    totals.medium += entry.medium;
    totals.low += entry.low;
    return totals;
  }, {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0
  });
}

function buildRepoLine(entry) {
    const repoLink = `<${buildDependabotAlertsUrl(entry.repo)}|${entry.repo}>`;

    return `• *${repoLink}* — ${entry.total} open (*${entry.critical}C/${entry.high}H/${entry.medium}M/${entry.low}L*), *risk ${entry.riskScore}*`;
}

function buildDuplicateLine(group) {
  const identifier =
    group.cveId ||
    group.aliases.find((value) => value.startsWith("CVE-")) ||
    group.ghsaId ||
    group.aliases[0] ||
    group.key;
  const summary = (group.summary || "No summary").replace(/\s+/g, " ").trim();
  const pkg = group.packageNames.length > 0 ? group.packageNames.join(", ") : "-";
  const vulnRange = group.vulnerableVersionRanges.length > 0 ? group.vulnerableVersionRanges.join(", ") : "-";
  const patched = group.patchedVersions.length > 0 ? group.patchedVersions.join(", ") : null;

  // Find NIST reference or fallback to GitHub advisory
  let referenceUrl = null;
  if (group.cveId) {
    referenceUrl = `https://nvd.nist.gov/vuln/detail/${group.cveId}`;
  }
  if (!referenceUrl && group.ghsaId) {
    referenceUrl = `https://github.com/advisories/${group.ghsaId}`;
  }
  // fallback: try aliases for CVE or GHSA
  if (!referenceUrl && group.aliases && Array.isArray(group.aliases)) {
    const cveAlias = group.aliases.find((id) => id.startsWith("CVE-"));
    if (cveAlias) {
      referenceUrl = `https://nvd.nist.gov/vuln/detail/${cveAlias}`;
    } else {
      const ghsaAlias = group.aliases.find((id) => id.startsWith("GHSA-"));
      if (ghsaAlias) {
        referenceUrl = `https://github.com/advisories/${ghsaAlias}`;
      }
    }
  }
  // fallback: nothing found
  if (!referenceUrl) {
    referenceUrl = "-";
  }

  let out = `*${identifier}* - ${group.alertCount} alerts across ${group.repoCount} repos\n`;
  out += `  - *Summary*: ${summary}\n`;
  out += `  - *Reference*: ${referenceUrl}\n`;
  out += `  - *Affected package*: ${pkg} (${vulnRange})\n`;
  if (patched) {
    out += `  - *First patched version*: ${patched}\n`;
  }
  return out.trim();
}

function buildRiskGroups(summary) {
  // Categorisation:
  // Critical: riskScore >= 100 OR at least 1 critical
  // High: riskScore >= 20 && < 100, no criticals
  // Medium: riskScore >= 5 && < 20, no criticals
  // Low: riskScore < 5, no criticals
  const critical = summary.filter((entry) => entry.critical > 0 || entry.riskScore >= 100);
  const high = summary.filter((entry) => entry.critical === 0 && entry.riskScore >= 20 && entry.riskScore < 100);
  const medium = summary.filter((entry) => entry.critical === 0 && entry.riskScore >= 5 && entry.riskScore < 20);
  const low = summary.filter((entry) => entry.critical === 0 && entry.riskScore < 5);

  const groups = [];
  if (critical.length > 0) {
    groups.push({ title: "🚨 Critical Risk Repos", repos: critical });
  }
  if (high.length > 0) {
    groups.push({ title: "⚠️ High Risk Repos", repos: high });
  }
  if (medium.length > 0) {
    groups.push({ title: "⚠️ Medium Risk Repos", repos: medium });
  }
  if (low.length > 0) {
    groups.push({ title: "ℹ️ Low Risk Repos", repos: low });
  }
  return groups;
}

function buildSlackPayload(summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames = [], duplicateStats) {
  const severityTotals = summarizeSeverities(summary);
  const riskGroups = buildRiskGroups(summary);
  const zeroAlertLines = zeroAlertRepoNames.map((repo) => `\* ${repo}`);

  // Calculate percentages
  const pct = (count) => totalAlerts > 0 ? Math.round((count / totalAlerts) * 100) : 0;
  const criticalPct = pct(severityTotals.critical);
  const highPct = pct(severityTotals.high);
  const mediumPct = pct(severityTotals.medium);
  const lowPct = pct(severityTotals.low);

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🚨 Dependabot Open Alert Summary 🚨"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Repos checked:* ${summary.length + zeroAlertRepoCount}`,
          `*Repos with alerts:* ${summary.length}`,
          `*Open alerts:* ${totalAlerts}`,
          `*Severity mix: ${severityTotals.critical} critical (${criticalPct}%), ${severityTotals.high} high (${highPct}%), ${severityTotals.medium} medium (${mediumPct}%), ${severityTotals.low} low (${lowPct}%)*`
        ].join("\n")
      }
    }
  ];

  if (zeroAlertRepoCount > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [`*✅ Repos with zero alerts:* ${zeroAlertRepoCount}`, ...zeroAlertLines].join("\n")
      }
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Repos with zero alerts:* 0"
      }
    });
  }

  if (duplicateStats) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Duplicate insight (by GHSA/CVE across all repos):*",
          `• Unique issues: ${duplicateStats.uniqueIssues}`,
          `• Duplicate alerts: ${duplicateStats.duplicateAlerts}`,
          `• Cross-repo repeated issues: ${duplicateStats.crossRepoIssues}`
        ].join("\n")
      }
    });

    if (duplicateStats.topRepeated.length > 0) {
      const duplicateLines = duplicateStats.topRepeated.map(buildDuplicateLine);
      const duplicateChunks = chunkLines(duplicateLines, 2800);

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Top repeated issues:* ${duplicateStats.topRepeated.length}`
        }
      });

      for (const chunk of duplicateChunks) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunk
          }
        });
      }
    }
  }

  if (summary.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No open Dependabot alerts across the configured repos."
      }
    });
  } else {
    for (const group of riskGroups) {
      const groupLines = group.repos.map(buildRepoLine);
      const groupChunks = chunkLines(groupLines, 2800);

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${group.title}:* ${group.repos.length}`
        }
      });

      for (const chunk of groupChunks) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunk
          }
        });
      }
    }
  }

  return {
    text: `Dependabot open alert summary: ${totalAlerts} open alerts across ${summary.length + zeroAlertRepoCount} repos (${zeroAlertRepoCount} clean)`,
    blocks
  };
}

async function outputResults(outputMode, summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames, duplicateStats) {
  if (outputMode === "console") {
    console.log("\n=== Sorted Risk Summary ===\n");
    console.table(summary);
    console.log(`Repos with zero alerts: ${zeroAlertRepoCount}`);

    for (const repo of zeroAlertRepoNames) {
      console.log(` * ${repo}`);
    }

    return;
  }

  const slackPayload = buildSlackPayload(summary, totalAlerts, zeroAlertRepoCount, zeroAlertRepoNames, duplicateStats);

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
  const repos = await resolveRepos();
  logStatus(`Repo discovery complete: query="${REPO_SEARCH_QUERY}", matched repos=${repos.length}`);

  logStatus(`Processing ${repos.length} repos (concurrency=${CONCURRENCY})...\n`);

  const results = await Promise.all(
    repos.map(repo =>
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

  const aggregated = aggregate(allAlerts, repos);
  const duplicateStats = buildDuplicateStats(allAlerts);

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
  await outputResults(
    outputMode,
    reposWithAlerts,
    allAlerts.length,
    zeroAlertRepoCount,
    zeroAlertRepoNames,
    duplicateStats
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
