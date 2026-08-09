# Cached TB2 campaign

`prepare-manifest.mjs` discovers only the twelve Harbor task directories named in the plan and asks
the local WSL Docker daemon for each image ID. A missing image is an error; it never calls `pull`.
When the 17.2.7 OMP Linux asset is not staged, the manifest still records its pinned release digest,
but `run-cached.sh` remains intentionally unschedulable until that asset is supplied.

The campaign is sequential and resumable. Set `TB2_CLEANUP_STALE=1` only after the run if the five
exact stopped-container names in the script are still present; their logs are exported before removal.
The script does not remove images, volumes, or VHDs.

The host credential proxy is `../credential-proxy.mjs`. Containers receive `TB2_MODEL_ENDPOINT` and a
dummy key; the proxy strips incoming credentials and injects the real key while streaming SSE bodies.

