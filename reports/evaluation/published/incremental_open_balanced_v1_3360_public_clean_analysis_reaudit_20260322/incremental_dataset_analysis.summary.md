# Incremental Dataset Analysis

- Generated at (UTC): 2026-03-22T03:41:55Z
- Run root: `E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean`

## Overview

| Metric | Value |
| --- | --- |
| sample_count | 3199 |
| load_error_count | 0 |
| boundary_exact_rate | 1.0 |
| monotonic_graph_rate | 1.0 |
| stage_count_match_rate | 1.0 |
| preview_present_rate | 1.0 |
| nonempty_delta_stage_rate | 1.0 |

## Core Numeric Metrics

| Metric | Mean | P50 | P95 | Min | Max |
| --- | --- | --- | --- | --- | --- |
| turn_count | 11.8984 | 10.0 | 23.0 | 1.0 | 69.0 |
| stage_count | 2.5714 | 2.0 | 5.0 | 1.0 | 5.0 |
| turn_tokens_per_dialogue | 527.0125 | 461.0 | 1082.3 | 0.0 | 2735.0 |
| turn_tokens_per_turn | 44.2927 | 42.0 | 79.0 | 0.0 | 249.0 |
| final_nodes | 7.4542 | 5.0 | 28.0 | 0.0 | 93.0 |
| final_edges | 2.3698 | 0.0 | 8.0 | 0.0 | 73.0 |
| final_groups | 1.1791 | 0.0 | 7.0 | 0.0 | 25.0 |
| final_entities | 11.0031 | 7.0 | 37.0 | 1.0 | 128.0 |
| turns_per_stage | 5.408 | 4.6667 | 11.0 | 1.0 | 34.0 |
| delta_ops_per_stage | 4.279 | 3.0 | 11.0 | 1.0 | 43.0 |
| actual_entity_growth_per_stage | 4.279 | 3.0 | 11.0 | 1.0 | 43.0 |
| final_edge_density | 0.3735 | 0.0 | 1.2536 | 0.0 | 11.75 |

## By Diagram Type

| Diagram Type | Count | Avg Turns | Avg Stages | Avg Final Entities | Avg Delta Ops/Stage | Avg Actual Growth/Stage | Boundary Exact Rate | Monotonic Graph Rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| architecture | 538 | 14.4405 | 3.329 | 15.9201 | 4.4277 | 4.4277 | 1.0 | 1.0 |
| er | 533 | 10.8537 | 2.5891 | 7.2158 | 2.708 | 2.708 | 1.0 | 1.0 |
| flowchart | 537 | 12.1769 | 2.6872 | 10.6853 | 3.0174 | 3.0174 | 1.0 | 1.0 |
| mindmap | 538 | 10.539 | 2.1859 | 8.4721 | 3.0179 | 3.0179 | 1.0 | 1.0 |
| sequence | 531 | 9.2034 | 1.0 | 5.6347 | 5.6347 | 5.6347 | 1.0 | 1.0 |
| statediagram | 522 | 14.2011 | 3.6494 | 18.1992 | 4.5227 | 4.5227 | 1.0 | 1.0 |

## Split Distribution

| Split | Count |
| --- | --- |
| train | 2574 |
| test | 313 |
| validation | 312 |

## Diagram Distribution

| Diagram Type | Count |
| --- | --- |
| architecture | 538 |
| mindmap | 538 |
| flowchart | 537 |
| er | 533 |
| sequence | 531 |
| statediagram | 522 |
