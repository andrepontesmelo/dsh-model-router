# Glossary

## Virtual route

A user-selected router identity that chooses among one or more concrete model candidates. It remains visible as the configured origin of a model request.

## Model attempt

One dispatch of a model request to a concrete provider and model. An attempt is either in progress, failed with a safe error summary and code, or completed.

## Model provenance

The durable, ordered attempt chain for an assistant turn, beginning with its virtual route and ending with the concrete model that completed it. Tool activity belongs to the surrounding assistant turn but is not itself model-generated.

## Global cooldown

Cross-route suppression of a failed concrete candidate (`provider\0model` key), shared by every route of one plugin instance; it starts at 30 seconds and only a successful dispatch of that same candidate clears it.

## Sleep window

The remaining quiet period of a failed candidate's global cooldown, shown on failure annotations and exhaustion errors; it starts at 30 seconds, doubles per successive failure, and caps at eight hours.

## Dispatch slot

The claim a request takes on its chosen candidate at FIRST dispatch, before the stream starts; retries within the same request never consume another one.
