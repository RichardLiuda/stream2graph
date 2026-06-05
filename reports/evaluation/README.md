# Evaluation Outputs

Use this directory with two different purposes:

- `reports/evaluation/runs/`
  - large raw experiment outputs produced locally or on cloud machines
  - ignored by git
- `reports/evaluation/published/`
  - curated bundles that should be committed and pushed back from cloud runs
  - intended for experiment manifests, prediction files, summaries, and benchmark reports

Recommended workflow:

1. Run experiments under `reports/evaluation/runs/`.
2. Export only the bundle you want to keep with `tools/eval/export_run_bundle.py`
   or `tools/eval/run_openai_benchmark.py --publish-bundle`.
3. Commit the resulting folder under `reports/evaluation/published/`.
