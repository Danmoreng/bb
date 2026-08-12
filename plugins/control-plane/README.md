# Control Plane

Production plugin scaffold for the human Control Plane. This CP-101 slice
contains only the installable/reloadable backend, diagnostics RPC, and nav
panel. Domain behavior enters through `@bb-private/control-plane-domain` and
will be added behind application services in later M1 tasks.

```sh
pnpm exec turbo run typecheck test build --filter=bb-plugin-control-plane
bb plugin install ./plugins/control-plane
bb plugin reload control-plane
```

The plugin is private and is not registered as an official bundled plugin.
