# Incremental Dataset Analysis

- Generated at (UTC): 2026-03-20T16:18:41Z
- Run root: `E:\Desktop\stream2graph\data\incremental_dataset\runs\minimax_m27_incremental_full_v1`

## Overview

| Metric | Value |
| --- | --- |
| sample_count | 3000 |
| load_error_count | 0 |
| boundary_exact_rate | 0.9803 |
| monotonic_graph_rate | 1.0 |
| stage_count_match_rate | 0.9717 |
| preview_present_rate | 1.0 |
| nonempty_delta_stage_rate | 0.8817 |

## Core Numeric Metrics

| Metric | Mean | P50 | P95 | Min | Max |
| --- | --- | --- | --- | --- | --- |
| turn_count | 10.1933 | 8.0 | 23.0 | 1.0 | 62.0 |
| stage_count | 1.9757 | 1.0 | 5.0 | 1.0 | 5.0 |
| turn_tokens_per_dialogue | 475.607 | 402.0 | 1043.05 | 0.0 | 2240.0 |
| turn_tokens_per_turn | 46.6586 | 44.0 | 84.0 | 0.0 | 526.0 |
| final_nodes | 6.4203 | 4.0 | 29.0 | 0.0 | 93.0 |
| final_edges | 0.1147 | 0.0 | 0.0 | 0.0 | 17.0 |
| final_groups | 1.4623 | 0.0 | 8.0 | 0.0 | 25.0 |
| final_entities | 7.9973 | 4.0 | 36.0 | 0.0 | 93.0 |
| turns_per_stage | 6.1331 | 5.0 | 12.0 | 0.3333 | 27.0 |
| delta_ops_per_stage | 4.0479 | 3.0 | 11.0 | 0.0 | 24.0 |
| actual_entity_growth_per_stage | 4.0479 | 3.0 | 11.0 | 0.0 | 24.0 |
| final_edge_density | 0.0047 | 0.0 | 0.0 | 0.0 | 0.6667 |

## By Diagram Type

| Diagram Type | Count | Avg Turns | Avg Stages | Avg Final Entities | Avg Delta Ops/Stage | Avg Actual Growth/Stage | Boundary Exact Rate | Monotonic Graph Rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| architecture | 645 | 14.8155 | 3.4171 | 16.8636 | 4.5607 | 4.5607 | 0.969 | 1.0 |
| er | 75 | 6.04 | 1.0533 | 0.28 | 0.1867 | 0.1867 | 0.9867 | 1.0 |
| flowchart | 645 | 10.769 | 2.355 | 9.1504 | 2.7392 | 2.7392 | 0.9798 | 1.0 |
| mindmap | 347 | 11.1931 | 2.4092 | 10.5043 | 3.3271 | 3.3271 | 0.9798 | 1.0 |
| sequence | 644 | 9.2345 | 1.0 | 5.4425 | 5.4425 | 5.4425 | 0.9845 | 1.0 |
| statediagram | 644 | 5.8913 | 1.0016 | 0.0652 | 0.0621 | 0.0621 | 0.9876 | 1.0 |

## Split Distribution

| Split | Count |
| --- | --- |
| train | 2395 |
| validation | 305 |
| test | 300 |

## Diagram Distribution

| Diagram Type | Count |
| --- | --- |
| architecture | 645 |
| flowchart | 645 |
| sequence | 644 |
| statediagram | 644 |
| mindmap | 347 |
| er | 75 |
