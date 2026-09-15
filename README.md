# London residential completions dashboard

A lightweight, static recreation of the former Greater London Authority residential completions dashboard. Filtering, charts, table search and CSV export run in the browser; the checked-in artifact makes the site usable without a backend.

## Run locally

```sh
npm run dev
```

Then open `http://localhost:4173`. The sample artifact is marked as `demo` in `site/data/data.json`.

## Build live data

The historical PLD backfill is build-time only:

```sh
PLD_EXPORT_URL='https://your-verified-pld-export' npm run build:data
```

The endpoint must return either `{ "records": [...] }` or an Elasticsearch response with `hits.hits`. Confirm the PLD technical documentation and field mapping before using this in production. The worker never attempts a full backfill; it serves a KV baseline and performs only a bounded, configured refresh.

## Deploy the refresh worker

Create a KV namespace, put its ID in `worker/wrangler.toml`, seed `data/data.json` under the `data/data.json` key, and deploy with Wrangler. Set `PLD_INCREMENTAL_URL` only to a verified incremental export. A stale request returns the last-known-good artifact immediately while one short-lived lock holder attempts the refresh.

See [`spec.md`](spec.md), [`docs/methodology.md`](docs/methodology.md), and [`docs/validation-benchmarks.md`](docs/validation-benchmarks.md) for provenance and known limitations.
