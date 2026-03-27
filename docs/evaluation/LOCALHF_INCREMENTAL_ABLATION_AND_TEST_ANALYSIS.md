# LocalHF Incremental Ablation And Test Analysis

## Imported result directories

Imported into `reports/evaluation/runs/incremental_system/` from `https://github.com/linlinlin-zhang/stream2graph_test.git`:

- `incremental_localhf_qwen35_gateft_plannerft_validation_public_clean`
- `incremental_localhf_qwen35_gateft_plannerbase_validation_public_clean`
- `incremental_localhf_qwen35_gatebase_plannerft_validation_public_clean`
- `incremental_localhf_qwen35_gatebase_plannerbase_validation_public_clean`
- `incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full_public_clean`

For the Gemini public-clean test comparison, the valid baseline is `incremental_gemini3flash_google_siliconflow_qwen35_4b_gate_test_full_public_clean_rerun2_official`, because the non-rerun `public_clean_official` directory in this workspace contains a failed run.

## Validation ablation summary

Split: `validation`, sample count `312`, error rows `0` in all four settings.

| Setting | Gate | Planner | Completed | Final Match | Canonicalized | Entity F1 | Gate ms | Planner ms | Total ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gateft_plannerft` | FT | FT | 0.9904 | 0.0865 | 0.0962 | 0.4567 | 2220.09 | 22576.57 | 85299.74 |
| `gateft_plannerbase` | FT | Base | 0.9904 | 0.0321 | 0.0577 | 0.3452 | 2163.85 | 10405.67 | 47711.85 |
| `gatebase_plannerft` | Base | FT | 0.9840 | 0.0737 | 0.0865 | 0.4385 | 3371.85 | 20814.60 | 82862.66 |
| `gatebase_plannerbase` | Base | Base | 0.9840 | 0.0224 | 0.0513 | 0.3325 | 3406.36 | 10153.83 | 51704.27 |

### Main effects

- Planner FT is the dominant quality driver.
  - Averaged over gate settings, planner FT improves `final_matches_reference` by `+5.29` points.
  - It improves `canonicalized_match` by `+3.68` points.
  - It improves `entity_semantic_f1` by `+0.1088`.
  - It also adds about `+34.37s` end-to-end model latency per sample.
- Gate FT is the dominant stability and gate-efficiency driver.
  - Averaged over planner settings, gate FT improves `completed_all_stages` by `+0.64` points.
  - It improves `stage_coverage_rate` by about `+0.0046`.
  - It reduces gate latency by about `1.20s`.
  - Its direct quality gain is smaller than planner FT, but still positive: `+1.12` points in strict final match and `+0.0155` in `entity_semantic_f1`.
- The best overall validation setting is the joint FT setting `gateft_plannerft`.
- `edge_semantic_f1` is `0.6218` in all four settings, which suggests this metric is largely insensitive to the ablated components on this split.

### Diagram-type readout

- `flowchart` is almost entirely controlled by planner FT: both planner-FT settings reach `0.1923` strict final match, while both planner-base settings are `0.0`.
- `mindmap` benefits from both modules, but especially planner FT: `0.3774` strict final match on the final full-test run later mirrors this trend.
- `architecture` shows a smaller but still meaningful gate effect on strict match.
- `ER` and `StateDiagram` remain the hardest types; strict final match stays `0.0` across all four validation ablations.

## Full public-clean test against strong general-model baselines

Split: `test_full_public_clean`, sample count `313`, error rows `0`.

| Model | Final Match | Canonicalized | Entity F1 | Total ms |
| --- | ---: | ---: | ---: | ---: |
| `LocalHF Qwen3.5-27B planner + Qwen3.5-4B gate` | 0.1086 | 0.1118 | 0.4584 | 76963.42 |
| `Claude Sonnet 4.5` | 0.0383 | 0.0415 | 0.2549 | 54485.00 |
| `Gemini 3 Flash rerun2` | 0.0415 | 0.0415 | 0.2768 | 91960.09 |
| `GPT-5.4 gateway` | 0.0383 | 0.0415 | 0.2711 | 47377.91 |
| `MiniMax M2.7` | 0.0256 | 0.0319 | 0.2703 | 59435.85 |
| `Moonshot K2.5` | 0.0415 | 0.0447 | 0.2710 | 181934.61 |
| `Qwen3.5-Plus` | 0.0383 | 0.0383 | 0.2861 | 40526.73 |
| `Qwen3.5-Plus thinking on` | 0.0415 | 0.0479 | 0.2753 | 239948.69 |
| `Qwen3.5-27B DashScope` | 0.0415 | 0.0415 | 0.2990 | 41654.88 |

### What the final model wins on

- Best strict exact match by a large margin.
  - `0.1086` versus the strongest baseline rate `0.0415`.
  - This is `+6.71` points, or about `2.62x` the best baseline exact-match rate.
- Best canonicalized match by a large margin.
  - `0.1118` versus the strongest baseline rate `0.0479`.
  - This is `+6.39` points, or about `2.33x` the best baseline canonicalized rate.
- Best semantic quality across every non-edge structural metric.
  - `node_semantic_f1 = 0.6714` versus best baseline `0.4246`.
  - `group_semantic_f1 = 0.8797` versus best baseline `0.8058`.
  - `attachment_semantic_f1 = 0.7444` versus best baseline `0.7219`.
  - `entity_semantic_f1 = 0.4584` versus best baseline `0.2990`, a gain of `+0.1594` or about `+53%`.
- Best gate latency among all compared systems.
  - `2129.79 ms` versus the next-best compared run above `3812.15 ms` from Gemini rerun2.

### What the final model does not win on

- It is not the fastest end-to-end system.
  - `Qwen3.5-Plus`, `Qwen3.5-27B DashScope`, and `GPT-5.4 gateway` are all faster overall.
  - The LocalHF final system sits in the middle of the latency pack: slower than the fastest commercial baselines, but still much faster than Moonshot, Gemini rerun2, and Qwen thinking-on.
- Planner latency is the main cost.
  - `24300.95 ms` is much higher than `Qwen3.5-27B DashScope` (`3096.60 ms`) and `Qwen3.5-Plus` (`4787.69 ms`).
- `edge_semantic_f1` stays at `0.6422`, identical to the compared baselines in this workspace, so the final gains come from node, group, and attachment quality rather than edge score improvements.

## Diagram-type comparison on the full test split

Strict final match:

- `architecture`: LocalHF final is the only compared system above zero (`0.0185`).
- `flowchart`: LocalHF final reaches `0.2115`; all compared baselines in this workspace are `0.0`.
- `mindmap`: LocalHF final reaches `0.3774`; the best baseline is `0.2453`.
- `sequence`: LocalHF final reaches `0.0392`; the compared baselines in this workspace are `0.0`.
- `ER` and `StateDiagram`: strict final match remains `0.0` for both the final model and the compared baselines.

Entity semantic F1:

- The LocalHF final model is best on all six diagram types in this workspace.
- The largest semantic gains are on `mindmap` (`0.7336`) and `flowchart` (`0.4967`).
- Even on the still-unsolved strict-match types, the final model improves semantic fidelity:
  - `ER = 0.4698`
  - `StateDiagram = 0.3876`

## Paper-facing takeaways

- The validation ablation cleanly supports a non-symmetric division of labor:
  - Gate FT improves stability and gate efficiency.
  - Planner FT improves final semantic quality and exact agreement.
- The final LocalHF system materially outperforms strong general-model baselines on the public-clean full test split, especially on strict and canonicalized graph agreement.
- The remaining difficulty is concentrated in `ER` and `StateDiagram`, so the most credible claim is not that the task is solved, but that the proposed staged FT system establishes a substantially stronger task-specific frontier.
