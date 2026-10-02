# Restart continuity

V5 stores one synchronously replaced, gitignored continuity snapshot per broker account under `state/paper-accounts/<account-hash>/v5-active-state.json`. It contains per-fill identity, option symbol, actual entry basis, remaining quantity, profit floor, SELL latch, and logical/current SELL identity.

At startup, broker positions decide whether exposure exists. A flat broker clears stale state. Matching exposure restores every saved fill. Missing, corrupt, incompatible, or quantity-mismatched state creates a lost-place recovery trade that uses the normal persistent SELL path for broker-known quantity without inventing a basis or floor; after broker-confirmed flat, local state is cleared and cooldown resumes.

State is replaced before dependent transitions: confirmed BUY fill, protection arm/re-arm, SELL latch/order identity, partial SELL, and confirmed FLAT. The snapshot is best effort across a process crash and deliberately has no database, Valkey, history reconstruction, or aggregate-price substitution.
