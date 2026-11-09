# Security

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the plugin version, the DeepSeek Harness version, and steps to reproduce. Remove any private memories, session text and keys from your report.

## What this plugin touches

- It stores memories as Markdown under `$DSH_HOME/cc-memory/`, on your machine.
- It injects memories into model prompts. Treat imported memory files like code from their source: their text reaches the model.
- Dream sends session text and memories to the model provider you configured in DeepSeek Harness.
- Its HTTP API sits behind DeepSeek Harness's web authentication, accepts only loopback connections, and requires a per-profile token.
- The secret scan is a heuristic. It catches common key formats, not every secret.
