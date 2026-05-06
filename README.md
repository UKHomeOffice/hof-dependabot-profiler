# hof-dependabot-profiler

Fetch and summarize open Dependabot alerts across multiple GitHub repositories, with output for Slack or CLI, and automated CI integration.

---

## Features

- Fetches open Dependabot alerts for a configurable list of GitHub repos
- Aggregates and scores alert severities per repo
- Output modes:
  - Console summary table
  - Slack webhook JSON payload (for direct posting or preview)
  - Direct Slack posting via webhook
- Reports all repos, including those with zero alerts (clean repos)
- Slack output lists clean repo names for easy visibility
- Concurrency-limited for efficient API usage
- GitHub Actions workflow for scheduled and manual CI runs

## Requirements

- Node.js 18+ (or 20+/24+ for native fetch)
- A GitHub personal access token with `security_events:read` scope (set as `GITHUB_TOKEN` env var)
- (Optional) Slack webhook URL for direct posting

## Configuration

Edit `index.js` to set your list of repos in the `REPOS` array.
Set your GitHub token as an environment variable: `export GITHUB_TOKEN=...`

## Usage

### Local/manual usage

1. **Install dependencies** (if using fetch):
   ```sh
   npm install node-fetch
   ```
   Or use Node.js 18+ with built-in fetch support.

2. **Run the script**
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
- `DEPENDABOT_PAT`: A GitHub personal access token with `security_events:read` scope

**Manual run:**
- Go to the Actions tab, select the workflow, and click "Run workflow".

## Output Modes

- `console`: Prints a table of repos and alert counts to the terminal
- `slack-json`: Prints a Slack-formatted JSON payload to stdout (for preview or manual posting)
- `slack-post`: Posts the payload directly to the Slack webhook URL in `SLACK_WEBHOOK_URL`

## Slack Output Example

- Only repos with open alerts are shown in the table
- Names of all repos with zero alerts are listed in the header
