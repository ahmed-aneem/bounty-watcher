# Bounty Watcher

Every 15 minutes this checks [Algora](https://algora.io/bounties) for new cash bounties in your stack. For each new one it opens an issue in this repo, which GitHub sends to your email and the GitHub mobile app.

Each issue carries a traffic light, so you can decide from your phone in seconds:

| Light | Meaning |
|---|---|
| 🟢 go now | Nobody has commented `/attempt` yet |
| 🟡 maybe | 1–2 people have started |
| 🔴 skip | 3+ attempts, a `/claim` already in, or someone is assigned |
| ⚪ check | Couldn't read the issue; look by hand |

Closed issues are never announced. The first run posts one digest of everything already open instead of dozens of issues.

## Setup (about 5 minutes, works from a phone browser)

1. Create a **public** repository named `bounty-watcher`. Public repos get unlimited free Actions minutes; a private one would use about 2,900 of its 2,000 free minutes a month at this schedule.
2. Add these files to it.
3. Open **Actions**, enable workflows if asked, then **Watch Algora bounties → Run workflow** once to post the first digest.
4. Install the **GitHub** mobile app and turn on notifications. You watch your own repo by default, so new issues reach you.

## Settings

Change these under **Settings → Secrets and variables → Actions → Variables**. No code edits needed.

| Variable | Default | What it does |
|---|---|---|
| `TECH` | `typescript,javascript` | Tags to match, comma-separated. Untagged bounties are always shown. |
| `MIN_USD` | `50` | Smallest reward worth a notification |
| `ALGORA_ORGS` | a list of known bounty orgs | Only used if Algora's global list ever requires an org. Unknown names are skipped. |

## When a 🟢 issue arrives

1. Open the bounty issue and read it.
2. Paste the link to Claude: *"Assess this bounty: can it be done in a few hours, and what's the fix?"*
3. If yes, comment `/attempt #<issue number>` on the bounty issue **before** you start, so others see it's taken.
4. Build the fix with Claude Code, review it yourself, open the PR with `/claim #<issue number>` in the description.
5. Close the watcher issue here when you're done with it.

## Good to know

- GitHub pauses scheduled workflows in repos with no commits for 60 days. It emails you first; re-enable with one click in the Actions tab.
- If Algora is unreachable, the run fails and GitHub emails you, instead of silently reporting zero bounties.
- Tests: `npm test`.
