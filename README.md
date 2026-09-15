# London residential completions dashboard

A lightweight, static recreation of the former Greater London Authority residential completions dashboard. Filtering, charts, table search and CSV export run in the browser; the checked-in artifact makes the site usable without a backend.

## Run locally

```sh
npm run dev
```

Then open `http://localhost:4173`. The dashboard uses a checked-in, pre-aggregated local artifact. Visitors never query the PLD API when filtering or redrawing a chart.

## Build live data

The historical PLD backfill is build-time only and queries the public Planning London Datahub API directly:

```sh
PLD_FIRST_YEAR=2019 PLD_LAST_YEAR=2025 npm run build:data
```

The API endpoint and required public-read header have safe defaults. `PLD_EXPORT_URL` and `PLD_API_ALLOW_REQUEST` are available only if the API contract changes. The importer compresses dwelling records into authority-year aggregates and site summaries before writing the local artifact. The worker never attempts a full backfill; it serves a KV baseline and performs only a bounded, configured refresh.

## Deploy the refresh worker

Create a KV namespace, put its ID in `worker/wrangler.toml`, seed `data/data.json` under the `data/data.json` key, and deploy with Wrangler. Set `PLD_INCREMENTAL_URL` only to a verified incremental export. A stale request returns the last-known-good artifact immediately while one short-lived lock holder attempts the refresh.

See [`spec.md`](spec.md), [`docs/methodology.md`](docs/methodology.md), and [`docs/validation-benchmarks.md`](docs/validation-benchmarks.md) for provenance and known limitations.
