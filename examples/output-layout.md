# Example Generated Output Layout

The output layout keeps customer documentation readable while separating private machine state.

```text
customer-documentation/
  README.md
  organizations/
    org_demo_001/
      index.md
      manifest.json
      changes/
        2026-08-19-run_demo_001.md
      flows/
        flow_demo_a/
          business.md
          technical.md
          change-log.md
          review.md
          analysis.json
          manifest.json
          diagrams/
            main-menu.mmd
            reusable-task-order-status.mmd
        flow_demo_b/
          business.md
          technical.md
          change-log.md
          review.md
          analysis.json
          manifest.json
  .genesys-docs/
    state/
      runs/
        run_demo_001.json
    cache/
      org_demo_001/
        flow_demo_a/
          <content-hash>/
            snapshot.json
            evidence.json
    locks/
```

## Repository policy

- `organizations/` is the reviewed documentation set.
- `.genesys-docs/cache/` is private machine state and ignored by Git by default.
- Raw SDK/YAML exports are not committed unless customer policy explicitly permits it.
- Run manifests may be committed only after their classification and path fields are safe.
- Customer organizations should use separate repositories when access boundaries differ.

## Organization index

The organization index contains:

- Verified organization ID/name/region.
- Discovery time and documentation freshness.
- Flow inventory by type/division/publication status.
- Completion/warning status.
- Changed, inaccessible, and retired flows.
- Link to the latest run/change report.

## Flow directory identity

Directory identity is the stable flow ID, not the display name. The document heading shows the current name. This prevents rename collisions and same-name flow merging.

## Example document header

```markdown
# Main Service IVR — Business Documentation

| Field              | Value                               |
| ------------------ | ----------------------------------- |
| Organization       | IST Sandbox (`org_demo_001`)        |
| Flow ID            | `flow_demo_a`                       |
| Flow type          | Inbound call                        |
| Documented version | Published version 12                |
| Source observed    | 2026-08-19 15:42 UTC                |
| Generated          | 2026-08-19 15:44 UTC                |
| Completeness       | Passed with 1 unresolved dependency |
| Review state       | Human review required               |
```

## Example change entry

```markdown
## Published version 11 → 12

- Behavioral: option 2 now routes to the Billing queue instead of General Service.
- Failure handling: the data-action timeout path now plays a fallback prompt before transfer.
- Dependency: one new user prompt was added.
- Unknown: the business reason for the queue change is not present in Architect configuration.

Evidence: `ev_menu_choice_2_target`, `ev_timeout_edge`, `ev_prompt_ref_44`.
```

The generator must not create claims like the example unless those evidence records exist in the selected snapshot.
