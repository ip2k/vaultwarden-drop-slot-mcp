# Changelog

## Unreleased

### Added

- `vault-drop <name>`: a terminal command that stores one new secret through the
  drop slot and waits until the importer verifies it in the vault, then prints
  one line.
  - Input: a hidden prompt (paste, then Enter) or piped stdin.
  - Options: `--username`, `--url`, `--note`, `--timeout`, `--no-wait`,
    `--status`.
  - A failure names its stage and exits with its own code.
  - The secret never goes in argv, environment variables or output.
- `DepositClient.forget(requestId)` removes a spooled envelope once its receipt
  is `imported`. `vault-drop` calls it after verification, so a verified deposit
  leaves no ciphertext behind on the producer.
