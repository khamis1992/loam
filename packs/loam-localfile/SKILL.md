# Loam Local File

Bind only files explicitly selected by the user. Copy-to-task is the default and never changes the source. Edit-in-place requires an exact user-selected absolute path.

Call `local_bind` before editing. `local_write_guarded` verifies the SHA-256 baseline, rejects external changes, writes a timestamped backup, and replaces the file atomically. Use `local_backup` to inspect or restore a backup explicitly. Never bypass the binding through shell or generic file tools.
