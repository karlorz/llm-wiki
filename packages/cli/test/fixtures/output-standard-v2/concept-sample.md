---
title: Output Standard Concept Sample
created: 2026-10-16
updated: 2026-10-16
type: concept
tags:
  - documentation
sources:
  - raw/articles/output-standard-v2-concept.md
confidence: high
provenance: research
output_standard: v2
---

# Output Standard Concept Sample

> **TL;DR:** v2 pages use STE text and add a Mermaid diagram for structure.

## Overview

v2 pages use short active sentences.

Use at most 20 words for each instruction. Use at most 25 words for each description.

## Structure

Add one Mermaid diagram when the page shows flow or hierarchy.

Keep a text summary beside the diagram.

```mermaid
flowchart TD
  stamp[Stamp v2] --> write[Write STE text]
  write --> diagram[Add diagram if structure]
```

**Least certain:**
- `stamp --> write` edge: this arrow is an interpretive grouping of stamp and write as one sequence
- `Write STE text` label: this node is a simplified step for the whole STE pass
- `write --> diagram` edge: this arrow omits the case where the page has no structure

## Sources

^[raw/articles/output-standard-v2-concept.md]
