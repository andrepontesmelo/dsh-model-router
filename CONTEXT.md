# Glossary

## Virtual route

A user-selected router identity that chooses among one or more concrete model candidates. It remains visible as the configured origin of a model request.

## Model attempt

One dispatch of a model request to a concrete provider and model. An attempt is either in progress, failed with a safe error summary and code, or completed.

## Model provenance

The durable, ordered attempt chain for an assistant turn, beginning with its virtual route and ending with the concrete model that completed it. Tool activity belongs to the surrounding assistant turn but is not itself model-generated.
