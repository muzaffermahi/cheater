# Stand up a server with a healthcheck

**Family:** `server-healthcheck`

## Procedure

1. Bind the EXACT host/port the task names; start the server in the background; POLL until it is ready (never sleep-and-hope).
1. Hit the EXACT endpoint path with curl and assert both the status code and the body shape.
1. Redirect stderr to a file so a startup crash is diagnosable instead of silent.

## Verification (feeds the execution verifier)

- curl to the exact endpoint returns the expected status and body.
- The process is actually listening on the exact port.

## Classifier cues

`server`, `endpoint`, `http`, `curl`, `port`, `listen`, `healthcheck`, `flask`, `nginx`, `route`, `serve`, `webserver`, `api`
