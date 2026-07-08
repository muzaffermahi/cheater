# Crypto / hash / security task

**Family:** `crypto-hash`

## Procedure

1. Use the standard library's proven primitives; never hand-roll a cipher or hash.
1. Match the EXACT algorithm, mode, and encoding (hex vs base64), and the byte order the task names.
1. For a crack/search, bound the search space and verify each candidate against the real check before claiming it.

## Verification (feeds the execution verifier)

- The produced digest/plaintext/signature validates against the task's exact check.
- The encoding and length match the specification.

## Classifier cues

`hash`, `sha`, `md5`, `hmac`, `encrypt`, `decrypt`, `cipher`, `crack`, `password`, `7z`, `aes`, `rsa`, `signature`, `digest`, `checksum`
