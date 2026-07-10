# Parse / transform a data format

**Family:** `data-format`

## Procedure

1. Pin the exact input and output formats (delimiters, encoding, headers, key names, ordering) from the task before coding.
1. Handle the edge rows (empty, quoted delimiters, unicode, trailing newline) — that is where format tasks fail.
1. Round-trip: parse then re-emit and diff against the spec; do not eyeball the output.

## Verification (feeds the execution verifier)

- The output matches the required format EXACTLY (columns/keys/order/encoding).
- A parse→emit round-trip is stable.

## Classifier cues

`csv`, `tsv`, `json`, `jsonl`, `yaml`, `xml`, `parse`, `serialize`, `transform`, `format`, `encode`, `decode`, `columns`, `delimiter`
