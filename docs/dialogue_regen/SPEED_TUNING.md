# Dialogue Regen Speed Tuning

This note covers the throughput controls for `tools/dialogue_regen/run_generation.py` and the current Moonshot-specific guidance for Kimi-based regeneration runs.

## New Runner Controls

`run_generation.py` now supports these rate controls:

- `max_concurrency`: maximum in-flight requests the runner will issue at once
- `requests_per_minute`: global request start rate limit across all workers
- `provider_rate_tier`: provider preset for official rate ceilings

Current built-in presets:

- `tier0`: concurrency `1`, RPM `3`
- `tier1`: concurrency `50`, RPM `200`
- `tier2`: concurrency `100`, RPM `500`
- `tier3`: concurrency `200`, RPM `5000`
- `tier4`: concurrency `400`, RPM `5000`
- `tier5`: concurrency `1000`, RPM `10000`

The runner uses a shared request-start limiter, so these limits apply across all worker threads rather than per thread.

## Moonshot Official Limits

Moonshot's official limits are based on cumulative recharge amount. The official limits page lists:

- `Tier0` (`CNY 0`): concurrency `1`, RPM `3`
- `Tier1` (`CNY 50`): concurrency `50`, RPM `200`
- `Tier2` (`CNY 100`): concurrency `100`, RPM `500`
- `Tier3` (`CNY 500`): concurrency `200`, RPM `5000`
- `Tier4` (`CNY 5000`): concurrency `400`, RPM `5000`
- `Tier5` (`CNY 20000`): concurrency `1000`, RPM `10000`

Source:

- Moonshot limits: `https://platform.moonshot.cn/docs/pricing/limits`

## Kimi K2.5 Notes

Moonshot's official K2.5 quickstart states:

- model name: `kimi-k2.5`
- OpenAI-compatible endpoint: `https://api.moonshot.cn/v1/chat/completions`
- `thinking` is enabled by default
- for non-thinking mode, send `"thinking": {"type": "disabled"}`
- for K2.5 series models, parameter values such as `temperature` are constrained

For dialogue regeneration, we currently prefer non-thinking mode because JSON stability is more important than chain-of-thought richness.

Source:

- Kimi K2.5 quickstart: `https://platform.moonshot.cn/docs/guide/kimi-k2-5-quickstart`

## Recommended Starting Points

Use a conservative starting point before pushing toward the full tier ceiling.

### Kimi K2.5 quality-first

Config example:

- [kimi_k25_parallel_tier1_safe.example.json](/E:/Desktop/stream2graph/configs/dialogue_regen/kimi_k25_parallel_tier1_safe.example.json)
- [kimi_k25_parallel_tier1.example.json](/E:/Desktop/stream2graph/configs/dialogue_regen/kimi_k25_parallel_tier1.example.json)

Recommended initial settings:

- Safe start:
  - `provider_rate_tier: "tier1"`
  - `max_concurrency: 8`
  - `requests_per_minute: 120`
- Fast Tier1 profile:
  - `provider_rate_tier: "tier1"`
  - `max_concurrency: 24`
  - `requests_per_minute: 200`

### Kimi K2 Turbo speed-first

Config example:

- [kimi_k2_turbo_parallel_tier1.example.json](/E:/Desktop/stream2graph/configs/dialogue_regen/kimi_k2_turbo_parallel_tier1.example.json)

Recommended initial settings:

- `provider_rate_tier: "tier1"`
- `max_concurrency: 12`
- `requests_per_minute: 160`

Moonshot's K2.5 guide lists `kimi-k2-turbo-preview` as a high-speed option within the K2.5 family.

## Practical Guidance

- If you are still on `Tier0`, parallelism will not materially help; the account ceiling is too low.
- If you are at least `Tier1`, concurrency is the main lever for speed.
- Lowering `request_interval_sec` alone is not enough when single-request latency is already tens of seconds.
- Long, structure-heavy diagrams still tend to dominate total runtime, so sharding by complexity is often helpful.
- When parse failures cluster on long outputs, try improving structure constraints before pushing concurrency even higher.
- For `kimi-k2.5`, if average single-request latency stays around `50-60s`, `RPM 200` is not the binding limit. In that regime, raising concurrency gives much more benefit than shaving request intervals.

## Empirical Tier1 Probe

Using `kimi-k2.5` in non-thinking mode on a Tier1 account:

- prior serial pilot: `100` validation samples, average latency about `58.4s/request`
- Tier1-safe parallel probe: `8` validation samples, `max_concurrency=8`, `requests_per_minute=120`
- measured wall-clock: `140.38s`
- estimated serial wall-clock for the same `8` samples at the prior average: about `467s`

That probe is roughly a `3.3x` wall-clock speedup even before pushing toward the full Tier1 ceiling.

The probe's failures were still `json_decode_error` on long outputs, so parallelism improved throughput without changing the main quality bottleneck.

## Example Command

```bash
python tools/dialogue_regen/run_generation.py \
  --config configs/dialogue_regen/kimi_k25_parallel_tier1.example.json
```
