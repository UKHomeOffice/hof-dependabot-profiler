# hof-dependabot-profiler

Fetch and summarize open Dependabot alerts across multiple GitHub repositories, with output for Slack or CLI, and automated CI integration.

---

## Features

- Fetches open Dependabot alerts for repos discovered via GitHub Search (`org/topic` query) - using topic `hof-dep-scanner`
- Supports merging in a small static repo list for guaranteed inclusion
- Aggregates and scores alert severities per repo
- Output modes:
  - Console summary table
  - Slack webhook JSON payload (for direct posting or preview)
  - Direct Slack posting via webhook
- Reports all repos, including those with zero alerts (clean repos)
- Slack output lists clean repo names for easy visibility
- Slack output includes severity mix with both counts and percentages (e.g. `24 critical (2%), 408 high (40%)`)
- Slack output includes duplicate-vulnerability insight across repos (unique issues, duplicate alerts, cross-repo repeats)
- Slack output includes top repeated issues grouped by CVE/GHSA with:
  - Identifier
  - Alert and repo counts
  - Summary
  - Reference URL (NIST CVE page, or GitHub advisory fallback)
  - Affected package and vulnerable range
  - First patched version (when available)
- Only the four GitHub-supported severities are shown: critical, high, medium, low
- Concurrency-limited for efficient API usage
- GitHub Actions workflow for scheduled and manual CI runs

## Requirements

- Node.js 18+ (or 20+/24+ for native fetch)
- A GitHub personal access token with access to:
  - Dependabot alerts (`security_events:read`)
  - Repository search/read for the target org repos
- (Optional) Slack webhook URL for direct posting

## Configuration

Set the following environment variables:

- `GITHUB_TOKEN` (required): token used for GitHub API calls
- `REPO_SEARCH_QUERY` (optional): defaults to `org:UKHomeOffice topic:hof-dep-scanner`
- `SLACK_WEBHOOK_URL` (required only for `--output=slack-post`)

Repo discovery behavior:

- Repos are fetched from GitHub Search using `REPO_SEARCH_QUERY`
- A static list is merged in to guarantee inclusion of specific repos
- Duplicate repo names are de-duplicated automatically

## Usage

### Local/manual usage

1. **Install dependencies** (if using fetch):
   ```sh
   npm install node-fetch
   ```
   Or use Node.js 18+ with built-in fetch support.

2. **Run the script**
   - With default repo search query:
     ```sh
     GITHUB_TOKEN=... node index.js --output=console
     ```
   - With custom repo search query:
     ```sh
     GITHUB_TOKEN=... REPO_SEARCH_QUERY='org:UKHomeOffice topic:hof-dep-scanner' node index.js --output=slack-json
     ```
   - Console summary:
     ```sh
     node index.js --output=console
     ```
   - Slack JSON payload (for preview or piping):
     ```sh
     node index.js --output=slack-json
     ```
   - Post directly to Slack:
     ```sh
     SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... node index.js --output=slack-post
     ```

### Automated CI usage (GitHub Actions)

This repo includes a composite GitHub Action and a sample workflow to run the profiler on a schedule and send results to Slack.

**.github/workflows/dependabot-profiler.yml** (example):

```yaml
name: Daily Dependabot Profiler

on:
  schedule:
    - cron: '0 8 * * *'  # Every day at 08:00 UTC
  workflow_dispatch:      # Allows manual runs

jobs:
  profile-dependabot:
    runs-on: ubuntu-latest
    steps:
      - name: Use composite action
        uses: ./.github/actions
        with:
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
        env:
          GITHUB_TOKEN: ${{ secrets.DEPENDABOT_PAT }}
```

**How it works:**
- Runs automatically every day at 8am UTC, or manually via the Actions tab.
- Posts a summary to your Slack channel via webhook.

**Required secrets:**
- `SLACK_WEBHOOK_URL`: Your Slack incoming webhook URL
- `DEPENDABOT_PAT`: A GitHub personal access token with permissions to read Dependabot alerts and search/read target repos

**Manual run:**
- Go to the Actions tab, select the workflow, and click "Run workflow".

## Output Modes

- `console`: Prints a table of repos and alert counts to the terminal
- `slack-json`: Prints a Slack-formatted JSON payload to stdout (for preview or manual posting)
- `slack-post`: Posts the payload directly to the Slack webhook URL in `SLACK_WEBHOOK_URL`

## Slack Output Example

- Only repos with open alerts are shown in the table
- Names of all repos with zero alerts are listed in the header
- Severity mix in the summary includes both the count and percentage of each severity:

  > Severity mix: 24 critical (2%), 408 high (40%), 434 medium (43%), 154 low (15%)

- Only the four GitHub-supported severities are included (critical, high, medium, low)
- Duplicate insight section includes:
  - Unique issues count
  - Duplicate alerts count
  - Cross-repo repeated issues count
- Top repeated issues include:
  - CVE/GHSA identifier
  - `X alerts across Y repos`
  - Summary
  - Reference URL (NIST preferred, GitHub advisory fallback)
  - Affected package and vulnerable range
  - First patched version when available
