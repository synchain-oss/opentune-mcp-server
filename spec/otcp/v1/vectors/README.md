# Test vectors

Vectors are machine-readable examples of OTCP exchanges. A conforming server produces responses that match them; mocks, contract tests and client tests run them. Each file holds one vector; its shape is defined by `../schemas/vector.schema.json`.

Files are named `<area>/<slug>.json`, and the vector's `id` is `<area>/<slug>`. The area is the method namespace (`session`, `job`, …).

## Common members

| Member        | Meaning                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | `<area>/<slug>`, equal to the file path without `.json`.                                                                                                                                                                                                     |
| `type`        | `request` (one request and its response) or `scenario` (a sequence of steps).                                                                                                                                                                                |
| `description` | What the vector shows.                                                                                                                                                                                                                                       |
| `capability`  | Capability the vector needs. A runner skips a vector whose capability the instance does not report, and reports it as skipped with that reason.                                                                                                              |
| `since`       | Protocol version (`MAJOR.MINOR`) the vector applies from. A runner skips vectors newer than the session's version.                                                                                                                                           |
| `session`     | `authenticated`: before the vector starts, the runner opens the main connection and completes `session.hello` with the discovery token, using a request id different from those in the vector. `unauthenticated`: the runner only opens the main connection. |
| `given`       | Optional preconditions (below).                                                                                                                                                                                                                              |

## Request vectors

| Member            | Meaning                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `method`          | The method of `request`.                                                                                                  |
| `request`         | The request object to send. May contain `$ref` matchers, which the runner replaces by bound values.                       |
| `paramsValid`     | false when `request.params` deliberately violates the method's params schema. Default true.                               |
| `response`        | The expected response. May contain matchers.                                                                              |
| `connectionAfter` | `open`: the server keeps the connection open after the response. `closed`: the server closes it right after the response. |

The runner sends `request` as one line, reads one line, matches it against `response`, and then checks `connectionAfter`.

## Scenario vectors

A scenario has `steps`, run in order. Each step is an object with exactly one of these members, plus an optional `connection` naming the connection it applies to (default `main`, opened before the first step):

| Step                                       | Meaning                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{"connect": "<name>"}`                    | Open a new connection to the instance under that name. It starts unauthenticated.                                                                |
| `{"send": <value>}`                        | Send the value, after replacing `$ref` matchers, serialized as one compact JSON line followed by LF.                                             |
| `{"sendRaw": "<text>"}`                    | Send the text exactly as UTF-8 bytes, with no LF added. For malformed input.                                                                     |
| `{"expect": <value>}`                      | Read the next line on the connection and match it against the value.                                                                             |
| `{"expectClosed": {"noBytes": <boolean>}}` | The server closes the connection. With `noBytes` true, it sent no byte on this connection since the previous step. Runners wait up to 5 seconds. |
| `{"pauseMs": <n>}`                         | Wait n milliseconds.                                                                                                                             |

## Matchers

OTCP messages never contain member names that start with `$`. Inside `request`, `response`, `send` and `expect`, an object whose member names all start with `$` is a matcher; an object that mixes `$` names with other names is invalid. Values that are not matchers match by JSON equality (numbers by numeric value).

| Matcher                     | Matches                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"$any": true}`            | Any value, including null. The member must be present.                                                                                                                           |
| `{"$any": "<type>"}`        | Any value of that JSON type: `string`, `number`, `integer`, `boolean`, `object`, `array` or `null`.                                                                              |
| `{"$approx": x, "$tol": t}` | A number within t of x (inclusive). `$tol` defaults to 1e-6.                                                                                                                     |
| `{"$capture": "<name>"}`    | Any value; binds it to the name for later steps. May be combined with `$any` or `$approx` to constrain the value. Binding a name that is already bound makes the vector invalid. |
| `{"$ref": "<name>"}`        | In expected values: a value equal to the bound value. In values to send: replaced by the bound value. Referring to an unbound name makes the vector invalid.                     |

Matching rules:

1. An expected object matches an actual object when every expected member is present and matches. Members that are present only in the actual object are allowed, because newer minor versions may add members (PROTOCOL.md section 2.3); runners additionally validate every actual result against the method's result schema of the session's version.
2. Arrays match element by element and must have the same length.
3. Names are `[A-Za-z][A-Za-z0-9_]*`, optionally with one `.` part. Names with the prefixes `discovery.` and `runner.` are bound by the runner:
   - `discovery.<member>`: the member of the discovery file of the instance under test, for example `discovery.token`, `discovery.instanceId`, `discovery.build`.
   - `runner.wrongToken`: a value generated at run time with the same length as the discovery token, which differs from it. Vectors never contain real or fake secrets.

## Preconditions (`given`)

`given` describes state the runner establishes before the vector starts, by means specific to the target (a mock creates it directly; a real instance may need preparatory calls). A runner that cannot establish a precondition reports the vector as skipped with the reason.

| Member | Meaning                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs` | `[{bind, kind, state, cancellable}]`: a job of that kind exists in that state with that `cancellable` value; its `jobId` is bound to the name `bind`. A terminal job has a result of its kind. |

Later versions add precondition members together with the methods that need them.

## Reproducibility

Vectors are written so that they hold against any target: mock, a window-less test build of OpenTune, or a running OpenTune. Values that differ between runs (ids, timestamps, secrets) are matched with `$any`, `$capture` and `$ref`, never written as literals.

A mock used for contract tests SHOULD additionally be deterministic, so that its full transcripts can be compared byte for byte:

1. `--seed <n>` seeds every random choice the mock makes, except the token and the server proof, which always come from a cryptographically secure generator and are read from the discovery file.
2. A fixed `instanceId` can be configured, so that `contentId`, `undoId` and `jobId` values repeat.
3. `jobId` and `undoId` sequence numbers start at 1 and increase by 1.
4. The clock is injectable: timestamps and timeouts come from it, so that tests of waits and timeouts do not depend on real time.

## Coverage

1. Every method with a defined schema has at least one success vector.
2. Every error behaviour of the session layer (authentication, version negotiation, repeated hello, framing) has a vector.
3. Every error vector's kind and reason are registered, and its `code` and `message` follow PROTOCOL.md section 17.
