# London residential completions explorer

An independent, experimental reconstruction of part of the withdrawn Greater London Authority Residential Completions Dashboard. It was prompted by the aim of making the underlying public data easier to explore. It is not affiliated with or endorsed by the GLA, is not an official GLA product, and does not reproduce the former dashboard's methodology exactly.

Source data: Greater London Authority, Planning London Datahub (PLD). The GLA cannot warrant the source data's quality or accuracy. This site's data, classifications, calculations and visualisations are also provided without warranty or representation of accuracy, completeness or fitness for a particular purpose. They should not be relied upon for statutory monitoring, planning decisions, financial decisions or other consequential uses. Consult the GLA's source material and published statistics before relying on a figure. Reuse of source material remains subject to the [London Datastore terms](https://data.london.gov.uk/about/terms-and-conditions/).

## What is implemented

- A static GitHub Pages dashboard with no runtime backend or public update endpoint.
- Browser-side filtering by authority, financial year, affordability, unit type and inferred use class.
- Stacked composition charts, London-wide target context, borough comparisons and CSV export.
- A checked-in summary index plus address-grouped detail files split by financial year.
- An offline PLD importer and structural validator suitable for an external weekly VPS job.

The current measure covers self-contained records from the PLD `residential_units` collection. It excludes non-conventional accommodation and does not implement the complete London Plan housing-supply measure. See [the methodology](docs/methodology.md) and [validation status](docs/validation-benchmarks.md) before interpreting the results.

## Run locally

The project has no third-party npm dependencies. It requires a current Node.js release for the data scripts and Python 3 for the convenience development server.

```sh
npm run dev
```

Then open `http://localhost:4173`. All filtering and chart updates use checked-in files; visitors do not query the PLD API.

## Rebuild the snapshot

`build:data` queries each financial year separately. With no environment overrides it requests 2004/05 through the most recently completed financial year:

```sh
npm run build:data
npm run validate:data
```

`PLD_FIRST_YEAR` and `PLD_LAST_YEAR` accept financial-year start years, so `PLD_LAST_YEAR=2025` means 2025/26. `PLD_OUTPUT_DIR`, `PLD_EXPORT_URL`, `PLD_SCROLL_URL` and `PLD_API_ALLOW_REQUEST` are available for controlled build environments.

The repository paths are `site/data/index.json` and `site/data/years/*.json`. The browser initially downloads the summary index and loads detail files only when the underlying-data panel is opened.

The validator checks the schema version, continuous year coverage, shard inventory and size, required fields, duplicate address groups, summary cubes, address-group totals and London totals. It also prints several historical reference comparisons. Those comparisons are informational because the former GLA methodology has not yet been reproduced; they are not release gates.

## Publication architecture

The repository's [GitHub Pages workflow](.github/workflows/pages.yml) publishes `site/` after relevant changes reach `main`. The weekly data schedule and its write credential remain isolated on the VPS.

An external `/usr/local/sbin/refresh-house-completions` can contain:

```bash
#!/usr/bin/env bash
set -euo pipefail

exec 9>/var/lock/house-completions-refresh.lock
flock -n 9 || exit 0

cd /srv/house-completions
test -z "$(git status --porcelain)"
git pull --ff-only origin main

snapshot_dir=$(mktemp -d)
trap 'rm -rf "$snapshot_dir"' EXIT
PLD_OUTPUT_DIR="$snapshot_dir" npm run build:data
PLD_OUTPUT_DIR="$snapshot_dir" npm run validate:data
rsync -a --delete "$snapshot_dir"/ site/data/

git add site/data
if git diff --cached --quiet; then
  exit 0
fi
git commit -m "data: refresh PLD snapshot"
git push origin HEAD:main
```

For example, the VPS root crontab can run it each Monday at 04:17:

```cron
17 4 * * 1 /usr/local/sbin/refresh-house-completions >> /var/log/house-completions-refresh.log 2>&1
```

The VPS needs Git, Node.js, npm, `flock`, `rsync`, a configured Git author and a repository-scoped deploy key with write access. A failed retrieval or validation does not replace the published GitHub Pages snapshot.

## Project documents

- [Implementation specification and remaining work](spec.md)
- [Methodology and limitations](docs/methodology.md)
- [Validation status and reference comparisons](docs/validation-benchmarks.md)
- [MIT licence and warranty exclusion](LICENSE)
