# Incremental Dataset Analysis

- Generated at (UTC): 2026-03-21T17:37:59Z
- Run root: `E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean`

## Overview

| Metric | Value |
| --- | --- |
| sample_count | 3199 |
| load_error_count | 565 |
| boundary_exact_rate | 1.0 |
| monotonic_graph_rate | 1.0 |
| stage_count_match_rate | 1.0 |
| preview_present_rate | 1.0 |
| nonempty_delta_stage_rate | 1.0 |

## Core Numeric Metrics

| Metric | Mean | P50 | P95 | Min | Max |
| --- | --- | --- | --- | --- | --- |
| turn_count | 12.0615 | 11.0 | 24.0 | 1.0 | 69.0 |
| stage_count | 2.5953 | 2.0 | 5.0 | 1.0 | 5.0 |
| turn_tokens_per_dialogue | 530.6587 | 465.0 | 1077.35 | 0.0 | 2735.0 |
| turn_tokens_per_turn | 43.9961 | 42.0 | 79.0 | 0.0 | 249.0 |
| final_nodes | 7.4951 | 5.0 | 27.0 | 0.0 | 93.0 |
| final_edges | 2.3557 | 0.0 | 8.0 | 0.0 | 73.0 |
| final_groups | 1.1648 | 0.0 | 7.0 | 0.0 | 25.0 |
| final_entities | 11.0156 | 7.0 | 37.0 | 1.0 | 128.0 |
| turns_per_stage | 5.4439 | 4.6667 | 11.0 | 1.0 | 34.0 |
| delta_ops_per_stage | 4.2444 | 3.0 | 10.0 | 1.0 | 43.0 |
| actual_entity_growth_per_stage | 4.2444 | 3.0 | 10.0 | 1.0 | 43.0 |
| final_edge_density | 0.376 | 0.0 | 1.2857 | 0.0 | 11.75 |

## By Diagram Type

| Diagram Type | Count | Avg Turns | Avg Stages | Avg Final Entities | Avg Delta Ops/Stage | Avg Actual Growth/Stage | Boundary Exact Rate | Monotonic Graph Rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| architecture | 438 | 14.6644 | 3.3425 | 15.9817 | 4.4267 | 4.4267 | 1.0 | 1.0 |
| er | 446 | 11.0179 | 2.6099 | 7.37 | 2.7314 | 2.7314 | 1.0 | 1.0 |
| flowchart | 442 | 12.3597 | 2.7195 | 10.8235 | 3.0312 | 3.0312 | 1.0 | 1.0 |
| mindmap | 435 | 10.7586 | 2.2161 | 8.6184 | 3.0385 | 3.0385 | 1.0 | 1.0 |
| sequence | 433 | 9.4088 | 1.0 | 5.6467 | 5.6467 | 5.6467 | 1.0 | 1.0 |
| statediagram | 440 | 14.1273 | 3.6568 | 17.6136 | 4.4096 | 4.4096 | 1.0 | 1.0 |

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

## Load Error Examples

- `hf_ms13k_er_06116`: `[Errno 2] No such file or directory: 'E:\\Desktop\\stream2graph\\data\\incremental_dataset\\runs\\incremental_open_balanced_v1_3360_public_clean\\agent_cluster\\sample_outputs\\hf_ms13k_er_06116.json'`
- `hf_ms13k_mindmap_08743`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\hf_ms13k_mindmap_08743.json`
- `hf_ms13k_er_12103`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\hf_ms13k_er_12103.json`
- `hf_ms13k_er_11547`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\hf_ms13k_er_11547.json`
- `gh_architecture_01337`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\gh_architecture_01337.json`
- `gh_architecture_01388`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\gh_architecture_01388.json`
- `hf_ms13k_statediagram_09589`: `Missing agent sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\agent_cluster\sample_outputs\hf_ms13k_statediagram_09589.json`
- `hf_ms13k_statediagram_00628`: `Missing structure sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\structure\samples\hf_ms13k_statediagram_00628.json`
- `hf_ms13k_statediagram_09354`: `Missing structure sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\structure\samples\hf_ms13k_statediagram_09354.json`
- `hf_ms13k_er_03705`: `Missing structure sample: E:\Desktop\stream2graph\data\incremental_dataset\runs\incremental_open_balanced_v1_3360_public_clean\structure\samples\hf_ms13k_er_03705.json`
