# DeepSeek V4 Flash Default Model

## Goal

Use `deepseek-v4-flash` as the default planning and execution model for newly created Codevil sessions across web and Slack. Because Codevil exposes one shared default configuration, fresh CLI configurations will use the same model as well.

## Design

Change `DEFAULT_CONFIG.plan_model` and `DEFAULT_CONFIG.exec_model` in the shared package from `kimi-k2.6` to `deepseek-v4-flash`. Keep the provider as `opencode-go`; the shared runnable-model catalog already includes `deepseek-v4-flash` for that provider.

Web and Slack session creation both flow through Worker normalization, which fills omitted model fields from `DEFAULT_CONFIG`. The CLI also imports this constant when creating a new local configuration. No entry point should hardcode a separate default.

## Compatibility

The change applies only when model fields are omitted. Explicit model selections continue to win. Existing sessions retain their stored plan and execution models, and existing CLI configuration files remain unchanged.

## Verification

Update the shared default-config test to assert both new model values. Update the CLI config test to assert that a fresh config inherits the new shared defaults. Run the targeted shared and CLI test suites, followed by the repository verification gate if the targeted tests pass.
