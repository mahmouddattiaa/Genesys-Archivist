# 15 — Official Sources and Research Notes

Sources were checked on 19 August 2026. Re-verify them when implementation begins or dependencies are upgraded.

## Genesys Cloud

### Architect Scripting SDK

- [Architect Scripting documentation](https://mypurecloud.github.io/purecloud-flow-scripting-api-sdk-javascript/index.html)

Why it matters: official Genesys documentation describes automated Architect scripting, OAuth client credentials for unattended use, required permission behavior, and flow object capabilities. The generated API index includes flow methods such as `loadAsync`, `traverse`, `exportToDirAsync`, and `exportToObjectAsync`, plus flow information/version objects.

Implementation note: method names are evidence that the approach is plausible, not a substitute for a pinned SDK integration spike. Record exact signatures from the installed version.

### Genesys OAuth client

- [Create an OAuth client](https://help.genesys.cloud/articles/create-an-oauth-client/)

Why it matters: client credentials are intended for non-user applications. The tool should not automate a human username/password login.

### Architect flows

- [Architect flows overview](https://help.genesys.cloud/articles/call-flows/)
- [Architect overview](https://help.genesys.cloud/articles/architect-overview/)
- [View previous versions of a flow](https://help.genesys.cloud/articles/view-version-history-call-flow/)

Why they matter: establish that Architect flows contain caller options, logic, responses, transfers, and published versions.

### Import/export and YAML

- [Define Architect flows using YAML](https://help.genesys.cloud/articles/define-architect-flows-using-yaml/)
- [Import or export a flow](https://help.genesys.cloud/articles/import-export-call-flow/)

Why they matter: YAML export is an official, reviewable comparison artifact. The documentation notes that some visual sequence builders are represented as equivalent expressions, which is a fidelity limitation the generator must disclose.

### Platform API and limits

- [Architect API section](https://developer.genesys.cloud/api/rest/v2/architect/index.html)
- [API rate limiting](https://developer.genesys.cloud/api/rest/rate_limits.html)
- [Genesys Cloud limitations](https://help.genesys.cloud/faqs/what-are-the-genesys-cloud-limitations/)

Why they matter: flow discovery, dependency resolution, pagination, and rate behavior must use current official API/SDK contracts. Dynamic API Explorer pages may not render well in static research tools; implementation must verify generated SDK methods and live sandbox behavior.

## Model Context Protocol

- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Understanding authorization in MCP](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization)

Why they matter: tool discovery/invocation, transport behavior, authorization expectations, origin validation, and security boundaries. The local first release uses STDIO; a future HTTP release must follow current authorization and transport requirements and support tested client protocol versions.

## Client integration references

- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
- [Kimi Code CLI MCP documentation](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html)
- [Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)

Why they matter: each client supports MCP but stores configuration independently. Client setup is generally once per application/user/machine, not once per chat session. The local STDIO server should avoid optional client-specific behavior for its core workflow.

## Research cautions

- Vendor documentation and SDKs evolve. Pin and record versions.
- Community posts can reveal operational experience but are not authoritative contracts; production decisions in this blueprint rely on official sources or required live spikes.
- Do not copy example permissions blindly. The sandbox permission matrix is the release evidence.
- Do not assume a flow's stable identifier is an API secret.
- Do not assume UI YAML, SDK object export, and Platform API metadata have identical shapes.
