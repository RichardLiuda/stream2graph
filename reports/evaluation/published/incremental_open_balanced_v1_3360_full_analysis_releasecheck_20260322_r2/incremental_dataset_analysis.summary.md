# Incremental Dataset Analysis

- Generated at (UTC): 2026-03-21T16:37:14Z
- Run root: `E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_fullbuild`

## Overview

| Metric | Value |
| --- | --- |
| sample_count | 3360 |
| load_error_count | 0 |
| boundary_exact_rate | 0.9702 |
| monotonic_graph_rate | 1.0 |
| stage_count_match_rate | 0.9798 |
| preview_present_rate | 1.0 |
| nonempty_delta_stage_rate | 1.0 |

## Core Numeric Metrics

| Metric | Mean | P50 | P95 | Min | Max |
| --- | --- | --- | --- | --- | --- |
| turn_count | 11.9027 | 10.0 | 24.0 | 0.0 | 69.0 |
| stage_count | 2.5833 | 2.0 | 5.0 | 1.0 | 5.0 |
| turn_tokens_per_dialogue | 524.7488 | 459.0 | 1085.0 | 0.0 | 2735.0 |
| turn_tokens_per_turn | 44.0866 | 42.0 | 79.0 | 0.0 | 249.0 |
| final_nodes | 7.5488 | 5.0 | 28.0 | 0.0 | 93.0 |
| final_edges | 2.4631 | 0.0 | 8.05 | 0.0 | 73.0 |
| final_groups | 1.1985 | 0.0 | 7.0 | 0.0 | 25.0 |
| final_entities | 11.2104 | 7.0 | 38.0 | 1.0 | 128.0 |
| turns_per_stage | 5.4323 | 4.6667 | 11.0 | 0.0 | 34.0 |
| delta_ops_per_stage | 4.3395 | 3.0 | 11.0 | 1.0 | 43.0 |
| actual_entity_growth_per_stage | 4.3395 | 3.0 | 11.0 | 1.0 | 43.0 |
| final_edge_density | 0.3803 | 0.0 | 1.2857 | 0.0 | 11.75 |

## By Diagram Type

| Diagram Type | Count | Avg Turns | Avg Stages | Avg Final Entities | Avg Delta Ops/Stage | Avg Actual Growth/Stage | Boundary Exact Rate | Monotonic Graph Rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| architecture | 560 | 14.5536 | 3.35 | 16.3696 | 4.5245 | 4.5245 | 0.9732 | 1.0 |
| er | 560 | 10.8125 | 2.5857 | 7.2375 | 2.717 | 2.717 | 0.9571 | 1.0 |
| flowchart | 560 | 12.1446 | 2.7107 | 10.9804 | 3.075 | 3.075 | 0.9714 | 1.0 |
| mindmap | 560 | 10.475 | 2.175 | 8.3946 | 2.9987 | 2.9987 | 0.975 | 1.0 |
| sequence | 560 | 9.3732 | 1.0 | 5.6768 | 5.6768 | 5.6768 | 0.9875 | 1.0 |
| statediagram | 560 | 14.0571 | 3.6786 | 18.6036 | 4.5839 | 4.5839 | 0.9571 | 1.0 |

## Split Distribution

| Split | Count |
| --- | --- |
| train | 2700 |
| validation | 330 |
| test | 330 |

## Diagram Distribution

| Diagram Type | Count |
| --- | --- |
| statediagram | 560 |
| architecture | 560 |
| flowchart | 560 |
| er | 560 |
| mindmap | 560 |
| sequence | 560 |
