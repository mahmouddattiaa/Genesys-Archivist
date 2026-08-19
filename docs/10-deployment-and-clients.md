# 10 — Deployment and Client Integration

## Recommended first deployment

Ship a signed internal package that installs:

- `genesys-docs` CLI.
- `genesys-docs-mcp` STDIO entry point.
- Versioned runtime dependencies.
- A diagnostic command.
- Default policies and schemas.

The product runs locally. No always-on server or web platform is required.

## Why STDIO first

- Broadly supported by desktop coding clients.
- No local TCP port, TLS certificate, reverse proxy, or web identity service.
- Customer credentials remain under the local user/IT secret boundary.
- The MCP client launches the approved executable.
- A single core package can be registered in several clients.

STDIO does not make the tool automatically available to every application. Each application keeps its own MCP configuration, but installation and secure profile setup need occur only once per machine/user. Client-specific registration should reference the same executable and profiles.

## Distribution options

### Preferred pilot

Internal versioned package or signed installer from an IST-controlled artifact repository. Pin the Node runtime or bundle it when support cost justifies it.

### Acceptable developer distribution

Private npm package with lockfile and install instructions. It is easy for developers but depends on a compatible local Node runtime and registry authentication.

### Docker

Useful in CI or remote hosting, but not the primary desktop path because workspace mounts, local SDK behavior, and OS secret-store access become harder.

### Single executable

Desirable later, after proving the Genesys SDK and native dependencies can be packaged reliably on supported Windows/macOS/Linux systems.

## One-time machine setup

1. Install the signed package.
2. Run `genesys-docs doctor`.
3. Run secure profile provisioning outside any AI conversation.
4. Validate organization identity and read-only permission coverage.
5. Select an approved private output root.
6. Register `genesys-docs-mcp` in each desired MCP client.
7. Run the client smoke test.

## Client configuration behavior

The exact syntax changes over time; release documentation must be generated from current vendor instructions. Conceptually every client registers the same local command:

```json
{
  "mcpServers": {
    "genesys-architect-docs": {
      "command": "genesys-docs-mcp",
      "args": ["--config", "<non-secret-config-path>"]
    }
  }
}
```

Do not put the Genesys client ID or secret in this configuration. The process resolves an opaque profile from its own secure setup.

### Claude Code

- Main supported client for the pilot.
- Use a user-level registration for all projects on the machine, or managed configuration when IST administers employee devices.
- Project-scoped MCP files may require workspace trust/approval and should not contain customer credentials.

### Cursor

- Global configuration makes the server available across Cursor projects.
- Cursor editor and CLI can share Cursor's MCP configuration.
- Team distribution does not remove the need for authentication/profile provisioning.

### Codex

- Register the STDIO command in Codex configuration.
- Codex CLI, IDE extension, and ChatGPT desktop on the same host can share Codex MCP configuration.
- This does not configure Claude Code, Cursor, Kimi, or ChatGPT web.

### Kimi Code CLI

- Register the same STDIO command in Kimi's MCP configuration.
- Kimi stores its own configuration and approvals.

## Configuration scopes

| Scope              | Use                                           | Risk                                                                           |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------ |
| User/global        | Same employee uses tool across projects       | All trusted projects can discover the tool; enforce profile/output policy      |
| Project            | Customer repository pins server configuration | Repo can influence launch args; require workspace trust and safe fixed command |
| Managed enterprise | IT distributes approved server and policy     | Vendor-specific; still needs local profile/secret provisioning                 |

## Updating the tool

- Release semantically versioned signed artifacts.
- Maintain a supported client/runtime/SDK matrix.
- Canary SDK and MCP changes in the sandbox.
- Run database/schema migrations with backup and rollback.
- Never auto-upgrade during a documentation run.
- Keep one previous supported version available for rollback.
- A version update that changes normalization or templates triggers a controlled documentation rebuild.

## Remote deployment decision gate

Move to remote Streamable HTTP only if the organization needs centralized scheduled execution, device-independent access, or centralized policy strongly enough to own the following:

- Hosting and availability.
- OAuth 2.1/SSO integration.
- Tenant authorization.
- Vault and key rotation.
- Database/object storage.
- Monitoring/on-call and incident response.
- Customer data residency and deletion.
- Per-client compatibility and public endpoint security.

Remote MCP is not a way to avoid security work; it increases it.

## Supportability

`genesys-docs doctor` must report, without secrets:

- Installed version and runtime.
- MCP mode.
- Config/profile availability.
- Secret-store health.
- Output-root access and safety.
- Genesys region/organization identity.
- Required permission categories.
- SDK source-provider capability.
- Last successful run and stale-run warnings.

Support bundles are opt-in, redacted, and previewed before export.
